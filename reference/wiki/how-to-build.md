# How to Build SimC

Source: https://github.com/simulationcraft/simc/wiki/HowToBuild

## macOS (Primary — CLI only)

```bash
cd /Users/tom/Documents/GitHub/simc/engine
make optimized
```

Requires XCode command line tools.

## Linux (CLI only)

```bash
sudo apt install build-essential libcurl-dev
cd your_simc_source_dir/engine
make optimized
```

Optional: `make optimized CXX=clang++` for clang. Use `SC_NO_NETWORKING=1` to skip libcurl.

## CMake (Cross-platform, preferred for GUI)

```bash
cd your_simc_source_dir
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF
cmake --build build
```

Options: `-DBUILD_GUI=OFF` (CLI only), `-DSC_NO_NETWORKING=ON` (no curl).

## Tips

- Use `make -j$(nproc) optimized` for parallel compilation
- LTO may fail with g++ on Linux when using curl networking — use clang or disable LTO
