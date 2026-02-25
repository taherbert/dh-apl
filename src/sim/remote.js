// Remote EC2 spot instance management for sim offloading.
// SSH-based remote execution as drop-in replacement for local simc.
//
// CLI: node src/sim/remote.js start|stop|status|build-ami
//
// Kill switches:
//   1. shutdown -h +N in user-data (instance self-terminates at OS level)
//   2. Spot MaxPrice caps hourly cost (AWS terminates if price spikes)
//   3. AWS Budget alarm at $10/month (set up via scripts/aws-setup.sh)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { cpus, homedir } from "node:os";
import { ROOT, config } from "../engine/startup.js";

const execAsync = promisify(execFile);

const STATE_PATH = join(ROOT, "results", ".remote-state.json");
const FETCH_SENTINEL = join(ROOT, "results", ".simc-fetch-timestamp");
const FETCH_STALE_MS = 60 * 60 * 1000; // 1 hour
const REMOTE_DIR = "/tmp/sim";
const REMOTE_SIMC = "/opt/simc/engine/simc";

// c7i/c6i family vCPU counts — add other families as needed
const VCPU_MAP = {
  "c7i.large": 2,
  "c7i.xlarge": 4,
  "c7i.2xlarge": 8,
  "c7i.4xlarge": 16,
  "c7i.8xlarge": 32,
  "c7i.12xlarge": 48,
  "c7i.16xlarge": 64,
  "c7i.24xlarge": 96,
  "c7i.48xlarge": 192,
  "c6i.large": 2,
  "c6i.xlarge": 4,
  "c6i.2xlarge": 8,
  "c6i.4xlarge": 16,
  "c6i.8xlarge": 32,
  "c6i.12xlarge": 48,
  "c6i.16xlarge": 64,
  "c6i.24xlarge": 96,
  "c6i.48xlarge": 192,
};

function resolveVcpus(instanceType) {
  return VCPU_MAP[instanceType] ?? config.remote?.vCpus ?? 96;
}

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
];

function sshKeyArgs() {
  const raw = config.remote?.sshKeyPath;
  const keyPath = raw?.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  return keyPath ? ["-i", keyPath] : [];
}

function sshTarget(ip) {
  return `${config.remote?.sshUser || "ubuntu"}@${ip}`;
}

// --- SSH connection multiplexing ---

function controlPath(ip) {
  return `/tmp/ssh-remote-${ip.replace(/\./g, "-")}.sock`;
}

function controlOpts(ip) {
  return ["-o", `ControlPath=${controlPath(ip)}`, "-o", "ControlPersist=10m"];
}

async function openSshMaster(ip) {
  const t = sshTarget(ip);
  const ka = sshKeyArgs();
  const sock = controlPath(ip);

  if (existsSync(sock)) {
    try {
      await execAsync(
        "ssh",
        [...SSH_OPTS, ...ka, ...controlOpts(ip), "-O", "check", t],
        { timeout: 5000 },
      );
      return;
    } catch {
      // Dead socket — re-open
    }
  }

  await execAsync(
    "ssh",
    [
      ...SSH_OPTS,
      ...ka,
      "-o",
      `ControlPath=${sock}`,
      "-o",
      "ControlMaster=yes",
      "-o",
      "ControlPersist=10m",
      "-f",
      "-N",
      t,
    ],
    { timeout: 15000 },
  );
}

async function closeSshMaster(ip) {
  const t = sshTarget(ip);
  const ka = sshKeyArgs();
  try {
    await execAsync(
      "ssh",
      [...SSH_OPTS, ...ka, ...controlOpts(ip), "-O", "exit", t],
      { timeout: 5000 },
    );
  } catch {
    // Best effort
  }
}

// --- SimC version tracking ---

async function getLocalSimcCommit({ fetch = false } = {}) {
  if (fetch) {
    let skip = false;
    if (existsSync(FETCH_SENTINEL)) {
      const ts = parseInt(readFileSync(FETCH_SENTINEL, "utf-8").trim(), 10);
      if (Date.now() - ts < FETCH_STALE_MS) skip = true;
    }
    if (skip) {
      console.log("  (skipping git fetch — done within last hour)");
    } else {
      await execAsync("git", ["fetch", "origin", config.simc.branch], {
        cwd: config.simc.dir,
        timeout: 30000,
      });
      mkdirSync(join(ROOT, "results"), { recursive: true });
      writeFileSync(FETCH_SENTINEL, String(Date.now()));
    }
  }
  const { stdout } = await execAsync(
    "git",
    ["rev-parse", "--short", `origin/${config.simc.branch}`],
    { cwd: config.simc.dir },
  );
  return stdout.trim();
}

async function getAmiSimcCommit(amiId) {
  const region = config.remote?.region || "us-east-1";
  const desc = await awsJson([
    "ec2",
    "describe-images",
    "--image-ids",
    amiId,
    "--region",
    region,
  ]);
  const tags = desc.Images?.[0]?.Tags || [];
  return tags.find((t) => t.Key === "simc-commit")?.Value || null;
}

function updateConfigAmiId(amiId) {
  const configPath = join(ROOT, "config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  raw.remote.amiId = amiId;
  writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
  config.remote.amiId = amiId;
}

async function ensureAmiCurrent({ onDemand, buildInstanceType } = {}) {
  const c = config.remote ?? {};
  console.log("Checking simc version...");
  const localCommit = await getLocalSimcCommit({ fetch: true });

  if (!c.amiId) {
    console.log(`No AMI configured. Building for simc @ ${localCommit}...`);
    const amiId = await buildAmi({ onDemand, buildInstanceType });
    updateConfigAmiId(amiId);
    return;
  }

  const amiCommit = await getAmiSimcCommit(c.amiId);
  if (amiCommit === localCommit) {
    console.log(`AMI simc commit (${amiCommit}) matches local. OK.`);
    return;
  }

  console.log(
    `AMI simc commit (${amiCommit}) != local (${localCommit}). Rebuilding...`,
  );
  const amiId = await buildAmi({ onDemand, buildInstanceType });
  updateConfigAmiId(amiId);
}

function syncLocalSimcBin() {
  const srcBin = join(config.simc.dir, "engine", "simc");
  const dstBin = join(ROOT, "bin", "simc");
  if (!existsSync(srcBin)) return;

  const srcMtime = statSync(srcBin).mtimeMs;
  const dstMtime = existsSync(dstBin) ? statSync(dstBin).mtimeMs : 0;

  if (srcMtime > dstMtime) {
    mkdirSync(join(ROOT, "bin"), { recursive: true });
    copyFileSync(srcBin, dstBin);
    chmodSync(dstBin, 0o755);
    console.log("Synced bin/simc from simc source build.");
  }
}

// --- State management ---

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(join(ROOT, "results"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function clearState() {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

async function awsCmd(args, opts = {}) {
  const { stdout } = await execAsync("aws", args, {
    timeout: 30000,
    ...opts,
  });
  return stdout.trim();
}

async function awsJson(args, opts = {}) {
  return JSON.parse(await awsCmd([...args, "--output", "json"], opts));
}

async function waitSsh(ip, attempts = 30) {
  const t = sshTarget(ip);
  const ka = sshKeyArgs();
  for (let i = 0; i < attempts; i++) {
    try {
      await execAsync("ssh", [...SSH_OPTS, ...ka, t, "echo ready"], {
        timeout: 10000,
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`SSH to ${ip} timed out after ${attempts * 5}s`);
}

export function isRemoteActive() {
  const state = readState();
  if (!state) return false;
  // Auto-clear stale state if shutdown timer has expired
  const elapsed = (Date.now() - new Date(state.launchTime).getTime()) / 60000;
  if (elapsed > state.shutdownMinutes + 5) {
    clearState();
    return false;
  }
  return true;
}

export function getSimCores() {
  if (!isRemoteActive()) return cpus().length;
  const state = readState();
  return state?.vcpus ?? resolveVcpus(state?.instanceType) ?? 96;
}

// Prevents metacharacters (|, &, etc.) from being interpreted by the remote shell.
function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function runSimcRemote(args) {
  const state = readState();
  if (!state) {
    throw new Error("No remote instance active. Run: npm run remote:start");
  }

  const t = sshTarget(state.publicIp);
  const ka = sshKeyArgs();

  // Re-establish multiplexed connection if master died (laptop sleep, network blip)
  try {
    await execAsync(
      "ssh",
      [...SSH_OPTS, ...ka, ...controlOpts(state.publicIp), "-O", "check", t],
      { timeout: 5000 },
    );
  } catch {
    await openSshMaster(state.publicIp);
  }

  // Find the .simc input file — may not be args[0] due to ptr=1 unshift
  const simcIdx = args.findIndex((a) => a.endsWith(".simc"));
  if (simcIdx === -1) {
    throw new Error("No .simc file found in args");
  }
  let localSimcPath = args[simcIdx];
  const remoteSimcPath = `${REMOTE_DIR}/${basename(localSimcPath)}`;

  // Resolve input= directives so the uploaded file is self-contained.
  // The remote instance doesn't have the local file tree. Dynamic import
  // avoids circular dependency (profilesets.js imports from remote.js).
  const { resolveInputDirectives } = await import("./profilesets.js");
  const raw = readFileSync(localSimcPath, "utf-8");
  const resolved = resolveInputDirectives(raw, dirname(resolve(localSimcPath)));
  let tempSimcPath = null;
  if (resolved !== raw) {
    const suffix = `_remote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tempSimcPath = localSimcPath.replace(/\.simc$/, `${suffix}.simc`);
    writeFileSync(tempSimcPath, resolved);
    localSimcPath = tempSimcPath;
  }

  const jsonArg = args.find((a) => a.startsWith("json2="));
  const localJsonPath = jsonArg ? jsonArg.split("=").slice(1).join("=") : null;
  const remoteJsonPath = localJsonPath
    ? `${REMOTE_DIR}/${basename(localJsonPath)}`
    : null;

  // Transform args: local paths → remote paths, add remote-only flags
  const remoteArgs = args.map((arg, i) => {
    if (i === simcIdx) return remoteSimcPath;
    if (arg.startsWith("json2=") && remoteJsonPath)
      return `json2=${remoteJsonPath}`;
    return arg;
  });
  remoteArgs.push("report_progress=0");

  const co = controlOpts(state.publicIp);

  try {
    const t0 = performance.now();

    // SCP input up (uses multiplexed connection)
    await execAsync(
      "scp",
      [...SSH_OPTS, ...ka, ...co, localSimcPath, `${t}:${remoteSimcPath}`],
      { timeout: 30000 },
    );
    const t1 = performance.now();

    // Execute remotely with NUMA interleaving for even memory distribution.
    const cmd = [
      "numactl",
      "--interleave=all",
      REMOTE_SIMC,
      ...remoteArgs.map(shellEscape),
    ].join(" ");
    try {
      await execAsync("ssh", [...SSH_OPTS, ...ka, ...co, t, cmd], {
        timeout: 1800000,
        maxBuffer: 100 * 1024 * 1024,
      });
    } catch (e) {
      if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
      throw new Error(`Remote SimC failed: ${e.message}`);
    }
    const t2 = performance.now();

    // SCP results back (uses multiplexed connection)
    if (localJsonPath && remoteJsonPath) {
      await execAsync(
        "scp",
        [...SSH_OPTS, ...ka, ...co, `${t}:${remoteJsonPath}`, localJsonPath],
        { timeout: 60000 },
      );
    }
    const t3 = performance.now();

    const upload = ((t1 - t0) / 1000).toFixed(1);
    const sim = ((t2 - t1) / 1000).toFixed(1);
    const download = ((t3 - t2) / 1000).toFixed(1);
    console.log(
      `  [remote] upload=${upload}s  sim=${sim}s  download=${download}s`,
    );
  } finally {
    if (tempSimcPath) {
      try {
        unlinkSync(tempSimcPath);
      } catch {}
    }
  }
}

async function launchInstance({ instanceType, onDemand } = {}) {
  // Prevent duplicate launches that orphan running instances
  const existing = readState();
  if (existing) {
    const elapsed =
      (Date.now() - new Date(existing.launchTime).getTime()) / 60000;
    if (elapsed < existing.shutdownMinutes) {
      throw new Error(
        `Instance ${existing.instanceId} already running (${Math.round(elapsed)} min elapsed). Run 'npm run remote:stop' first.`,
      );
    }
    clearState();
  }

  // Ensure AMI + local binary match origin/{branch}
  await ensureAmiCurrent({ onDemand });
  syncLocalSimcBin();

  const c = config.remote ?? {};
  const actualType = instanceType || c.instanceType || "c7i.24xlarge";
  const region = c.region || "us-east-1";
  const shutdownMin = c.shutdownMinutes || 45;

  // Kill switch #1: OS-level self-destruct timer
  const userData = Buffer.from(
    `#!/bin/bash\nshutdown -h +${shutdownMin}\nmkdir -p ${REMOTE_DIR}\nchown ubuntu:ubuntu ${REMOTE_DIR}`,
  ).toString("base64");

  const launchArgs = [
    "ec2",
    "run-instances",
    "--image-id",
    c.amiId,
    "--instance-type",
    actualType,
    "--key-name",
    c.keyPairName || "dh-apl",
    "--user-data",
    userData,
    "--tag-specifications",
    JSON.stringify([
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: "dh-apl-sim" },
          { Key: "project", Value: "dh-apl" },
        ],
      },
    ]),
    "--region",
    region,
    "--count",
    "1",
  ];

  // Kill switch #2: spot price ceiling (skip for on-demand)
  if (!onDemand) {
    launchArgs.push(
      "--instance-market-options",
      JSON.stringify({
        MarketType: "spot",
        SpotOptions: {
          MaxPrice: c.spotMaxPrice || "1.50",
          SpotInstanceType: "one-time",
        },
      }),
    );
  }

  if (c.securityGroup) {
    launchArgs.push("--security-group-ids", c.securityGroup);
  }
  if (c.subnetId) {
    launchArgs.push("--subnet-id", c.subnetId);
  }

  console.log(`Launching ${onDemand ? "on-demand" : "spot"} instance...`);
  const result = await awsJson(launchArgs);
  const instanceId = result.Instances[0].InstanceId;
  console.log(`Instance ${instanceId} launched. Waiting for running state...`);

  try {
    await awsCmd(
      [
        "ec2",
        "wait",
        "instance-running",
        "--instance-ids",
        instanceId,
        "--region",
        region,
      ],
      { timeout: 600000 },
    );

    const desc = await awsJson([
      "ec2",
      "describe-instances",
      "--instance-ids",
      instanceId,
      "--region",
      region,
    ]);
    const publicIp = desc.Reservations[0].Instances[0].PublicIpAddress;
    if (!publicIp) {
      throw new Error(
        "Instance has no public IP. Check subnet/security group config.",
      );
    }

    const vcpus = resolveVcpus(actualType);
    const state = {
      instanceId,
      publicIp,
      instanceType: actualType,
      vcpus,
      launchTime: new Date().toISOString(),
      amiId: c.amiId,
      shutdownMinutes: shutdownMin,
    };
    writeState(state);

    console.log(`Waiting for SSH at ${publicIp}...`);
    await waitSsh(publicIp);

    // Establish persistent SSH connection for multiplexing
    await openSshMaster(publicIp);

    const co = controlOpts(publicIp);
    await execAsync(
      "ssh",
      [
        ...SSH_OPTS,
        ...sshKeyArgs(),
        ...co,
        sshTarget(publicIp),
        `mkdir -p ${REMOTE_DIR}`,
      ],
      { timeout: 10000 },
    );

    console.log(
      `\nReady: ${instanceId} (${publicIp}) — ${actualType} (${vcpus} vCPUs)`,
    );
    console.log(`Auto-shutdown in ${shutdownMin} minutes`);
    return state;
  } catch (e) {
    console.error(`Launch failed: ${e.message}. Terminating ${instanceId}...`);
    await awsCmd([
      "ec2",
      "terminate-instances",
      "--instance-ids",
      instanceId,
      "--region",
      region,
    ]).catch(() => {});
    clearState();
    throw e;
  }
}

async function terminateInstance() {
  const state = readState();
  const region = config.remote?.region || "us-east-1";

  if (!state) {
    // No local state — check AWS for orphaned instances as safety net
    console.log("No local state. Checking AWS for running dh-apl instances...");
    try {
      const desc = await awsJson([
        "ec2",
        "describe-instances",
        "--filters",
        "Name=tag:project,Values=dh-apl",
        "Name=instance-state-name,Values=running,pending",
        "--region",
        region,
      ]);
      const orphans = desc.Reservations.flatMap((r) => r.Instances).map(
        (i) => i.InstanceId,
      );
      if (orphans.length === 0) {
        console.log("No running dh-apl instances found.");
        return;
      }
      for (const id of orphans) {
        console.log(`Terminating orphaned instance ${id}...`);
        await awsCmd([
          "ec2",
          "terminate-instances",
          "--instance-ids",
          id,
          "--region",
          region,
        ]);
      }
      console.log("Done.");
    } catch (e) {
      console.error(`AWS lookup failed: ${e.message}`);
    }
    return;
  }

  await closeSshMaster(state.publicIp);
  console.log(`Terminating ${state.instanceId}...`);
  await awsCmd([
    "ec2",
    "terminate-instances",
    "--instance-ids",
    state.instanceId,
    "--region",
    region,
  ]);
  clearState();
  console.log("Instance terminated.");
}

async function getStatus() {
  const state = readState();
  if (!state) {
    console.log("No active instance.");
    return null;
  }

  const region = config.remote?.region || "us-east-1";
  try {
    const desc = await awsJson([
      "ec2",
      "describe-instances",
      "--instance-ids",
      state.instanceId,
      "--region",
      region,
    ]);
    const inst = desc.Reservations[0]?.Instances[0];
    if (!inst) {
      console.log("Instance not found. Cleaning up state.");
      clearState();
      return null;
    }

    const awsState = inst.State.Name;
    const elapsed = Math.round(
      (Date.now() - new Date(state.launchTime).getTime()) / 60000,
    );
    const remaining = Math.max(0, state.shutdownMinutes - elapsed);

    console.log(`Instance: ${state.instanceId}`);
    console.log(
      `Type:     ${state.instanceType || "unknown"} (${state.vcpus || "?"} vCPUs)`,
    );
    console.log(`State:    ${awsState}`);
    console.log(`IP:       ${state.publicIp}`);
    console.log(`Elapsed:  ${elapsed} min`);
    console.log(`Shutdown: ~${remaining} min remaining`);

    if (awsState === "terminated" || awsState === "shutting-down") {
      clearState();
    }

    return { ...state, awsState, elapsed, remaining };
  } catch (e) {
    console.error(`Error checking status: ${e.message}`);
    return null;
  }
}

async function buildAmi({ buildInstanceType, onDemand = false } = {}) {
  const c = config.remote ?? {};
  const region = c.region || "us-east-1";

  console.log("Finding latest Ubuntu 24.04 AMI...");
  const baseAmi = await awsCmd([
    "ec2",
    "describe-images",
    "--region",
    region,
    "--owners",
    "099720109477",
    "--filters",
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
    "Name=state,Values=available",
    "--query",
    "sort_by(Images, &CreationDate)[-1].ImageId",
    "--output",
    "text",
  ]);
  if (!baseAmi || baseAmi === "None") {
    throw new Error("No Ubuntu 24.04 AMI found in " + region);
  }
  console.log(`Base AMI: ${baseAmi}`);

  // 30-min safety timer for the build instance
  const userData = Buffer.from("#!/bin/bash\nshutdown -h +30").toString(
    "base64",
  );
  const launchArgs = [
    "ec2",
    "run-instances",
    "--image-id",
    baseAmi,
    "--instance-type",
    buildInstanceType || c.instanceType || "c7i.24xlarge",
    "--key-name",
    c.keyPairName || "dh-apl",
    ...(onDemand
      ? []
      : [
          "--instance-market-options",
          JSON.stringify({
            MarketType: "spot",
            SpotOptions: {
              MaxPrice: c.spotMaxPrice || "1.50",
              SpotInstanceType: "one-time",
            },
          }),
        ]),
    "--user-data",
    userData,
    "--tag-specifications",
    JSON.stringify([
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: "dh-apl-ami-build" },
          { Key: "project", Value: "dh-apl" },
        ],
      },
    ]),
    "--region",
    region,
    "--block-device-mappings",
    JSON.stringify([
      { DeviceName: "/dev/sda1", Ebs: { VolumeSize: 20, VolumeType: "gp3" } },
    ]),
    "--count",
    "1",
  ];
  if (c.securityGroup) {
    launchArgs.push("--security-group-ids", c.securityGroup);
  }
  if (c.subnetId) {
    launchArgs.push("--subnet-id", c.subnetId);
  }

  console.log("Launching build instance...");
  const result = await awsJson(launchArgs);
  const instanceId = result.Instances[0].InstanceId;

  try {
    await awsCmd(
      [
        "ec2",
        "wait",
        "instance-running",
        "--instance-ids",
        instanceId,
        "--region",
        region,
      ],
      { timeout: 600000 },
    );

    const desc = await awsJson([
      "ec2",
      "describe-instances",
      "--instance-ids",
      instanceId,
      "--region",
      region,
    ]);
    const publicIp = desc.Reservations[0].Instances[0].PublicIpAddress;
    if (!publicIp) throw new Error("No public IP assigned to build instance");

    console.log(`Build instance ready at ${publicIp}`);
    await waitSsh(publicIp);

    // Resolve repo URL and branch HEAD from the local simc checkout
    const { stdout: repoUrl } = await execAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: config.simc.dir },
    );
    const { stdout: commitRaw } = await execAsync(
      "git",
      ["rev-parse", "--short", `origin/${config.simc.branch}`],
      { cwd: config.simc.dir },
    );
    const simcCommit = commitRaw.trim();

    // Full optimization build: -O3, -ffast-math, -march=native (AVX-512 on c7i),
    // -flto=auto, -DNDEBUG, no networking code
    const buildCmds = [
      "sudo apt-get update -qq",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential git numactl",
      `git clone --depth 1 --branch ${config.simc.branch} ${repoUrl.trim()} /tmp/simc-build`,
      "cd /tmp/simc-build/engine && make optimized LTO_AUTO=1 SC_NO_NETWORKING=1 -j$(nproc)",
      "sudo mkdir -p /opt/simc/engine",
      "sudo cp /tmp/simc-build/engine/simc /opt/simc/engine/simc",
      "mkdir -p /tmp/sim",
      "rm -rf /tmp/simc-build",
    ];

    const t = sshTarget(publicIp);
    const ka = sshKeyArgs();
    for (const cmd of buildCmds) {
      console.log(`  ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`);
      await execAsync("ssh", [...SSH_OPTS, ...ka, t, cmd], {
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      });
    }

    console.log("Creating AMI...");
    const amiName = `simc-${config.simc.branch}-${simcCommit}-${Date.now()}`;
    const ami = await awsJson([
      "ec2",
      "create-image",
      "--instance-id",
      instanceId,
      "--name",
      amiName,
      "--description",
      `SimC ${config.simc.branch} @ ${simcCommit}`,
      "--tag-specifications",
      JSON.stringify([
        {
          ResourceType: "image",
          Tags: [
            { Key: "project", Value: "dh-apl" },
            { Key: "simc-commit", Value: simcCommit },
            { Key: "simc-branch", Value: config.simc.branch },
          ],
        },
      ]),
      "--region",
      region,
    ]);

    const amiId = ami.ImageId;
    console.log(`Waiting for AMI ${amiId}...`);
    await awsCmd(
      [
        "ec2",
        "wait",
        "image-available",
        "--image-ids",
        amiId,
        "--region",
        region,
      ],
      { timeout: 900000 },
    );

    console.log(`\nAMI ready: ${amiId}`);
    updateConfigAmiId(amiId);
    console.log(`Updated config.json remote.amiId → ${amiId}`);
    return amiId;
  } finally {
    console.log(`Terminating build instance ${instanceId}...`);
    await awsCmd([
      "ec2",
      "terminate-instances",
      "--instance-ids",
      instanceId,
      "--region",
      region,
    ]).catch(() => {});
  }
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];

  if (!cmd || !["start", "stop", "status", "build-ami"].includes(cmd)) {
    console.log("Usage: node src/sim/remote.js <start|stop|status|build-ami>");
    console.log("");
    console.log("Commands:");
    console.log("  start      Launch a spot instance for remote sims");
    console.log("  stop       Terminate the active instance");
    console.log("  status     Show instance state and time remaining");
    console.log("  build-ami  Build a SimC AMI from current simc branch");
    process.exit(1);
  }

  try {
    switch (cmd) {
      case "start": {
        const startArgs = process.argv.slice(3);
        await launchInstance({
          instanceType: startArgs.find((a) => !a.startsWith("--")),
          onDemand: startArgs.includes("--on-demand"),
        });
        break;
      }
      case "stop":
        await terminateInstance();
        break;
      case "status":
        await getStatus();
        break;
      case "build-ami": {
        const extraArgs = process.argv.slice(3);
        await buildAmi({
          buildInstanceType: extraArgs.find((a) => !a.startsWith("--")),
          onDemand: extraArgs.includes("--on-demand"),
        });
        break;
      }
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
