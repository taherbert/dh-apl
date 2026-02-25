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
import { aplsDir } from "../engine/paths.js";

const execAsync = promisify(execFile);

const STATE_PATH = join(ROOT, "results", ".remote-state.json");
const FETCH_SENTINEL = join(ROOT, "results", ".simc-fetch-timestamp");
const FETCH_STALE_MS = 60 * 60 * 1000; // 1 hour
const REMOTE_DIR = "/tmp/sim";
const REMOTE_SIMC = "/opt/simc/engine/simc";

// vCPU counts for compute-optimized families (c6i, c7i, etc.)
// Pattern: "large" = 2, "xlarge" = 4, "{N}xlarge" = N*4, except 24xlarge = 96
const SIZE_VCPUS = {
  large: 2,
  xlarge: 4,
  "2xlarge": 8,
  "4xlarge": 16,
  "8xlarge": 32,
  "12xlarge": 48,
  "16xlarge": 64,
  "24xlarge": 96,
  "48xlarge": 192,
};

function resolveVcpus(instanceType) {
  const size = instanceType?.split(".")?.[1];
  return SIZE_VCPUS[size] ?? remoteConfig().vCpus ?? 96;
}

function remoteConfig() {
  return config.remote ?? {};
}

function region() {
  return remoteConfig().region || "us-east-1";
}

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
];

function sshKeyArgs() {
  const raw = remoteConfig().sshKeyPath;
  const keyPath = raw?.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  return keyPath ? ["-i", keyPath] : [];
}

function sshTarget(ip) {
  return `${remoteConfig().sshUser || "ubuntu"}@${ip}`;
}

// Common SSH args: base opts + key + multiplexing
function sshArgs(ip) {
  return [...SSH_OPTS, ...sshKeyArgs(), ...controlOpts(ip)];
}

// --- SSH connection multiplexing ---

// Cache SSH master health checks — avoids 8 redundant `ssh -O check` calls
// when concurrent sims all launch within the same batch window.
let sshMasterCheckedAt = 0;
const SSH_CHECK_TTL_MS = 30000; // 30s — masters persist for 10min

function controlPath(ip) {
  return `/tmp/ssh-remote-${ip.replace(/\./g, "-")}.sock`;
}

function controlOpts(ip) {
  return ["-o", `ControlPath=${controlPath(ip)}`, "-o", "ControlPersist=10m"];
}

async function openSshMaster(ip) {
  const sock = controlPath(ip);

  if (existsSync(sock)) {
    try {
      await execAsync("ssh", [...sshArgs(ip), "-O", "check", sshTarget(ip)], {
        timeout: 5000,
      });
      return;
    } catch {
      // Dead socket — re-open
    }
  }

  await execAsync(
    "ssh",
    [
      ...SSH_OPTS,
      ...sshKeyArgs(),
      "-o",
      `ControlPath=${sock}`,
      "-o",
      "ControlMaster=yes",
      "-o",
      "ControlPersist=10m",
      "-f",
      "-N",
      sshTarget(ip),
    ],
    { timeout: 15000 },
  );
}

async function closeSshMaster(ip) {
  try {
    await execAsync("ssh", [...sshArgs(ip), "-O", "exit", sshTarget(ip)], {
      timeout: 5000,
    });
  } catch {
    // Best effort
  }
}

// --- SimC version tracking ---

function isFetchStale() {
  if (!existsSync(FETCH_SENTINEL)) return true;
  const ts = parseInt(readFileSync(FETCH_SENTINEL, "utf-8").trim(), 10);
  return Date.now() - ts >= FETCH_STALE_MS;
}

async function getLocalSimcCommit({ fetch = false } = {}) {
  if (fetch) {
    if (!isFetchStale()) {
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
  const desc = await awsJson([
    "ec2",
    "describe-images",
    "--image-ids",
    amiId,
    "--region",
    region(),
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
  const c = remoteConfig();
  console.log("Checking simc version...");
  const localCommit = await getLocalSimcCommit({ fetch: true });

  if (c.amiId) {
    const amiCommit = await getAmiSimcCommit(c.amiId);
    if (amiCommit === localCommit) {
      console.log(`AMI simc commit (${amiCommit}) matches local. OK.`);
      return;
    }
    console.log(
      `AMI simc commit (${amiCommit}) != local (${localCommit}). Rebuilding...`,
    );
  } else {
    console.log(`No AMI configured. Building for simc @ ${localCommit}...`);
  }

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

// --- AZ fallback for capacity errors ---

// Errors that indicate the specific AZ lacks capacity — retrying another AZ may succeed
const AZ_RETRIABLE_ERRORS = [
  "InsufficientInstanceCapacity",
  "Unsupported", // some AZs don't support certain instance types
];

function isCapacityError(e) {
  const msg = (e.stderr || "") + (e.message || "");
  return AZ_RETRIABLE_ERRORS.some((code) => msg.includes(code));
}

async function getAvailableAzs(regionName) {
  return awsJson([
    "ec2",
    "describe-availability-zones",
    "--region",
    regionName,
    "--filters",
    "Name=state,Values=available",
    "--query",
    "AvailabilityZones[].ZoneName",
  ]);
}

// Try launching an instance, cycling through AZs on capacity errors.
// If subnetId is set, skip AZ fallback (subnet pins to a specific AZ).
async function launchWithAzFallback(launchArgs, regionName, { subnetId } = {}) {
  try {
    return await awsJson(launchArgs);
  } catch (e) {
    if (!isCapacityError(e) || subnetId) throw e;
    console.log("No capacity in default AZ. Trying other zones...");
    let lastError = e;
    const azs = await getAvailableAzs(regionName);
    for (const az of azs) {
      try {
        console.log(`  Trying ${az}...`);
        const result = await awsJson([
          ...launchArgs,
          "--placement",
          `AvailabilityZone=${az}`,
        ]);
        console.log(`  ${az}: OK`);
        return result;
      } catch (azError) {
        if (!isCapacityError(azError)) throw azError;
        console.log(`  ${az}: no capacity`);
        lastError = azError;
      }
    }
    throw lastError;
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

// Returns active state or null, auto-clearing stale entries
function getActiveState() {
  const state = readState();
  if (!state) return null;
  const elapsed = (Date.now() - new Date(state.launchTime).getTime()) / 60000;
  if (elapsed > state.shutdownMinutes + 5) {
    clearState();
    return null;
  }
  return state;
}

export function isRemoteActive() {
  return getActiveState() !== null;
}

// Fidelity-aware routing: quick sims (te >= 0.5) stay local even when remote
// is active — the ~1.7s SCP overhead exceeds the sim time. Everything else
// (standard, confirm) goes remote for the core count advantage.
const QUICK_TE_THRESHOLD = 0.5;

export function shouldUseRemote(args) {
  if (!isRemoteActive()) return false;
  const teArg = args.find((a) => a.startsWith("target_error="));
  if (teArg) {
    const te = parseFloat(teArg.split("=")[1]);
    if (te >= QUICK_TE_THRESHOLD) return false;
  }
  return true;
}

export function getSimCores() {
  const state = getActiveState();
  if (!state) return cpus().length;
  return state.vcpus ?? resolveVcpus(state.instanceType);
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

  const { publicIp } = state;
  const sa = sshArgs(publicIp);
  const target = sshTarget(publicIp);

  // Re-establish multiplexed connection if master died (laptop sleep, network blip).
  // Cached to avoid redundant checks when 8 concurrent sims launch in a batch.
  if (Date.now() - sshMasterCheckedAt > SSH_CHECK_TTL_MS) {
    try {
      await execAsync("ssh", [...sa, "-O", "check", target], { timeout: 5000 });
    } catch {
      await openSshMaster(publicIp);
    }
    sshMasterCheckedAt = Date.now();
  }

  // Find the .simc input file — may not be args[0] due to ptr=1 unshift
  const simcIdx = args.findIndex((a) => a.endsWith(".simc"));
  if (simcIdx === -1) {
    throw new Error("No .simc file found in args");
  }
  let localSimcPath = args[simcIdx];
  const remoteSimcPath = `${REMOTE_DIR}/${basename(localSimcPath)}`;

  // Resolve input= directives so the uploaded file is self-contained.
  // Dynamic import avoids circular dependency (profilesets.js imports from remote.js).
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

  // Transform args: local paths -> remote paths, add remote-only flags
  const remoteArgs = args.map((arg, i) => {
    if (i === simcIdx) return remoteSimcPath;
    if (arg.startsWith("json2=") && remoteJsonPath)
      return `json2=${remoteJsonPath}`;
    return arg;
  });
  remoteArgs.push("report_progress=0");

  try {
    const t0 = performance.now();

    await execAsync(
      "scp",
      [...sa, localSimcPath, `${target}:${remoteSimcPath}`],
      { timeout: 30000 },
    );
    const t1 = performance.now();

    // NUMA interleaving for even memory distribution across sockets
    const cmd = [
      "numactl",
      "--interleave=all",
      REMOTE_SIMC,
      ...remoteArgs.map(shellEscape),
    ].join(" ");
    try {
      await execAsync("ssh", [...sa, target, cmd], {
        timeout: 1800000,
        maxBuffer: 100 * 1024 * 1024,
      });
    } catch (e) {
      if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
      throw new Error(`Remote SimC failed: ${e.message}`);
    }
    const t2 = performance.now();

    if (localJsonPath && remoteJsonPath) {
      await execAsync(
        "scp",
        [...sa, `${target}:${remoteJsonPath}`, localJsonPath],
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

// --- Shared EC2 launch helpers ---

function encodeUserData(script) {
  return Buffer.from(script).toString("base64");
}

function spotMarketOptions() {
  const c = remoteConfig();
  return JSON.stringify({
    MarketType: "spot",
    SpotOptions: {
      MaxPrice: c.spotMaxPrice || "1.50",
      SpotInstanceType: "one-time",
    },
  });
}

function tagSpec(name) {
  return JSON.stringify([
    {
      ResourceType: "instance",
      Tags: [
        { Key: "Name", Value: name },
        { Key: "project", Value: "dh-apl" },
      ],
    },
  ]);
}

// Build common EC2 run-instances args, then append optional spot/sg/subnet.
function buildLaunchArgs({
  imageId,
  instanceType,
  userData,
  tagName,
  onDemand,
  extraArgs = [],
}) {
  const c = remoteConfig();
  const args = [
    "ec2",
    "run-instances",
    "--image-id",
    imageId,
    "--instance-type",
    instanceType,
    "--key-name",
    c.keyPairName || "dh-apl",
    "--user-data",
    userData,
    "--tag-specifications",
    tagSpec(tagName),
    "--region",
    region(),
    "--count",
    "1",
    ...extraArgs,
  ];

  if (!onDemand) {
    args.push("--instance-market-options", spotMarketOptions());
  }
  if (c.securityGroup) {
    args.push("--security-group-ids", c.securityGroup);
  }
  if (c.subnetId) {
    args.push("--subnet-id", c.subnetId);
  }

  return args;
}

// Wait for instance to reach running state, return its public IP.
async function waitForPublicIp(instanceId) {
  await awsCmd(
    [
      "ec2",
      "wait",
      "instance-running",
      "--instance-ids",
      instanceId,
      "--region",
      region(),
    ],
    { timeout: 600000 },
  );

  const desc = await awsJson([
    "ec2",
    "describe-instances",
    "--instance-ids",
    instanceId,
    "--region",
    region(),
  ]);
  const publicIp = desc.Reservations[0].Instances[0].PublicIpAddress;
  if (!publicIp) {
    throw new Error(
      "Instance has no public IP. Check subnet/security group config.",
    );
  }
  return publicIp;
}

async function terminateById(instanceId) {
  await awsCmd([
    "ec2",
    "terminate-instances",
    "--instance-ids",
    instanceId,
    "--region",
    region(),
  ]);
}

// --- Instance lifecycle ---

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

  const c = remoteConfig();
  const actualType = instanceType || c.instanceType || "c7i.24xlarge";
  const shutdownMin = c.shutdownMinutes || 45;

  // Kill switch #1: OS-level self-destruct timer
  const userData = encodeUserData(
    `#!/bin/bash\nshutdown -h +${shutdownMin}\nmkdir -p ${REMOTE_DIR}\nchown ubuntu:ubuntu ${REMOTE_DIR}`,
  );

  const launchArgs = buildLaunchArgs({
    imageId: c.amiId,
    instanceType: actualType,
    userData,
    tagName: "dh-apl-sim",
    onDemand,
  });

  console.log(`Launching ${onDemand ? "on-demand" : "spot"} instance...`);
  const result = await launchWithAzFallback(launchArgs, region(), {
    subnetId: c.subnetId,
  });
  const instanceId = result.Instances[0].InstanceId;
  console.log(`Instance ${instanceId} launched. Waiting for running state...`);

  try {
    const publicIp = await waitForPublicIp(instanceId);

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
    await openSshMaster(publicIp);

    await execAsync(
      "ssh",
      [...sshArgs(publicIp), sshTarget(publicIp), `mkdir -p ${REMOTE_DIR}`],
      { timeout: 10000 },
    );

    console.log(
      `\nReady: ${instanceId} (${publicIp}) — ${actualType} (${vcpus} vCPUs)`,
    );
    console.log(`Auto-shutdown in ${shutdownMin} minutes`);
    return state;
  } catch (e) {
    console.error(`Launch failed: ${e.message}. Terminating ${instanceId}...`);
    await terminateById(instanceId).catch(() => {});
    clearState();
    throw e;
  }
}

async function terminateInstance() {
  const state = readState();

  if (!state) {
    // No local state -- check AWS for orphaned instances as safety net
    console.log("No local state. Checking AWS for running dh-apl instances...");
    try {
      const desc = await awsJson([
        "ec2",
        "describe-instances",
        "--filters",
        "Name=tag:project,Values=dh-apl",
        "Name=instance-state-name,Values=running,pending",
        "--region",
        region(),
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
        await terminateById(id);
      }
      console.log("Done.");
    } catch (e) {
      console.error(`AWS lookup failed: ${e.message}`);
    }
    return;
  }

  await closeSshMaster(state.publicIp);
  console.log(`Terminating ${state.instanceId}...`);
  await terminateById(state.instanceId);
  clearState();
  console.log("Instance terminated.");
}

async function getStatus() {
  const state = readState();
  if (!state) {
    console.log("No active instance.");
    return null;
  }

  try {
    const desc = await awsJson([
      "ec2",
      "describe-instances",
      "--instance-ids",
      state.instanceId,
      "--region",
      region(),
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
  const c = remoteConfig();

  console.log("Finding latest Ubuntu 24.04 AMI...");
  const baseAmi = await awsCmd([
    "ec2",
    "describe-images",
    "--region",
    region(),
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
    throw new Error("No Ubuntu 24.04 AMI found in " + region());
  }
  console.log(`Base AMI: ${baseAmi}`);

  const launchArgs = buildLaunchArgs({
    imageId: baseAmi,
    instanceType: buildInstanceType || c.instanceType || "c7i.24xlarge",
    userData: encodeUserData("#!/bin/bash\nshutdown -h +30"),
    tagName: "dh-apl-ami-build",
    onDemand,
    extraArgs: [
      "--block-device-mappings",
      JSON.stringify([
        { DeviceName: "/dev/sda1", Ebs: { VolumeSize: 20, VolumeType: "gp3" } },
      ]),
    ],
  });

  console.log("Launching build instance...");
  const result = await launchWithAzFallback(launchArgs, region(), {
    subnetId: c.subnetId,
  });
  const instanceId = result.Instances[0].InstanceId;

  try {
    const publicIp = await waitForPublicIp(instanceId);
    console.log(`Build instance ready at ${publicIp}`);
    await waitSsh(publicIp);

    // Resolve repo URL and branch HEAD from the local simc checkout
    const { stdout: repoUrlRaw } = await execAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: config.simc.dir },
    );
    // Normalize SSH URLs to HTTPS — the EC2 instance has no GitHub SSH keys
    const repoUrl = repoUrlRaw
      .trim()
      .replace(/^git@github\.com:/, "https://github.com/");
    const { stdout: commitRaw } = await execAsync(
      "git",
      ["rev-parse", "--short", `origin/${config.simc.branch}`],
      { cwd: config.simc.dir },
    );
    const simcCommit = commitRaw.trim();

    // PGO (Profile-Guided Optimization) three-pass build:
    //   1. Instrumented build with -fprofile-generate (GCC)
    //   2. Run representative workload to collect profile data
    //   3. Optimized rebuild with -fprofile-use (uses branch/layout data)
    //
    // Base flags from `make optimized`: -O3, -DNDEBUG, -ffast-math,
    // -fomit-frame-pointer, -march=native (AVX-512 on c7i)
    // LTO_AUTO=1 adds -flto=auto, SC_NO_NETWORKING=1 drops libcurl
    const branch = shellEscape(config.simc.branch);
    const cloneUrl = shellEscape(repoUrl);
    const makeBase =
      "cd /tmp/simc-build/engine && make optimized LTO_AUTO=1 SC_NO_NETWORKING=1";

    // Upload a self-contained APL profile for PGO training
    const target = sshTarget(publicIp);
    const ka = sshKeyArgs();
    let pgoProfile = null;
    const aplPath = join(aplsDir(), "vengeance.simc");
    if (existsSync(aplPath)) {
      const { resolveInputDirectives } = await import("./profilesets.js");
      const raw = readFileSync(aplPath, "utf-8");
      const resolved = resolveInputDirectives(raw, dirname(resolve(aplPath)));
      const tmpProfile = join(ROOT, "results", ".pgo-profile.simc");
      writeFileSync(tmpProfile, resolved);
      pgoProfile = tmpProfile;
    }

    const buildCmds = [
      "sudo apt-get update -qq",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential git numactl",
      `git clone --depth 1 --branch ${branch} ${cloneUrl} /tmp/simc-build`,
    ];

    if (pgoProfile) {
      // Pass 1: instrumented build
      buildCmds.push(`${makeBase} 'OPTS=-fprofile-generate' -j$(nproc)`);
      // Upload APL profile for training run
      console.log("  Uploading PGO training profile...");
      await execAsync(
        "scp",
        [...SSH_OPTS, ...ka, pgoProfile, `${target}:/tmp/pgo-training.simc`],
        { timeout: 30000 },
      );
      // Pass 2: run representative workload (quick sim, enough to train branches)
      buildCmds.push(
        "/tmp/simc-build/engine/simc /tmp/pgo-training.simc target_error=0.5 threads=$(nproc) report_progress=0 json2=/dev/null ptr=1",
      );
      // Pass 3: clean objects (preserves .gcda profile data), rebuild with PGO
      buildCmds.push(
        "cd /tmp/simc-build/engine && make clean",
        `${makeBase} 'OPTS=-fprofile-use -fprofile-correction' -j$(nproc)`,
      );
    } else {
      // No APL available — single-pass optimized build
      buildCmds.push(`${makeBase} -j$(nproc)`);
    }

    buildCmds.push(
      "sudo mkdir -p /opt/simc/engine",
      "sudo cp /tmp/simc-build/engine/simc /opt/simc/engine/simc",
      "mkdir -p /tmp/sim",
      "rm -rf /tmp/simc-build",
    );

    for (const cmd of buildCmds) {
      console.log(`  ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`);
      await execAsync("ssh", [...SSH_OPTS, ...ka, target, cmd], {
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      });
    }

    // Clean up local temp file
    if (pgoProfile) {
      try {
        unlinkSync(pgoProfile);
      } catch {}
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
      region(),
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
        region(),
      ],
      { timeout: 900000 },
    );

    console.log(`\nAMI ready: ${amiId}`);
    updateConfigAmiId(amiId);
    console.log(`Updated config.json remote.amiId -> ${amiId}`);
    return amiId;
  } finally {
    console.log(`Terminating build instance ${instanceId}...`);
    await terminateById(instanceId).catch(() => {});
  }
}

// --- CLI ---

function parseCliArgs() {
  const extra = process.argv.slice(3);
  return {
    positional: extra.find((a) => !a.startsWith("--")),
    onDemand: extra.includes("--on-demand"),
  };
}

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
        const { positional, onDemand } = parseCliArgs();
        await launchInstance({ instanceType: positional, onDemand });
        break;
      }
      case "stop":
        await terminateInstance();
        break;
      case "status":
        await getStatus();
        break;
      case "build-ami": {
        const { positional, onDemand } = parseCliArgs();
        await buildAmi({ buildInstanceType: positional, onDemand });
        break;
      }
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
