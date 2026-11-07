# Stream Deck PC Stats

A Windows Stream Deck plugin that shows live PC stats on key tiles, with no overlay and nothing else running.

It ships with a standalone sidecar, `StatsReader.exe`, built from `sidecar/`. The plugin reads metrics from the sidecar's local endpoint (default: `http://localhost:9696/metrics`), lets you choose which metric to render, and supports multiple visual styles with deep layout/theme customization.

## Install With Your PC's AI

Paste this into an AI coding agent running on the PC, such as Claude Code. Windows will ask you to approve the admin step once, unless the agent is already running as administrator.

```text
Install the Stream Deck PC Stats plugin on this Windows PC from
https://github.com/Cleobury/stream-deck-pc-stats

The Stream Deck app must already be installed. Stop and tell me if it is not.

1. Make sure Git, Node.js 24 and the .NET 10 SDK are installed. Use winget for anything missing.
2. Clone the repo into a permanent folder. It can't be moved after setup.
3. In the repo, run: npm install, npm run build, npm run build:sidecar
4. Link the plugin: npx streamdeck link com.lee-cleobury.pc-stats.sdPlugin
5. Read com.lee-cleobury.pc-stats.sdPlugin/bin/install-startup.ps1, then run it as
   administrator. If you are not elevated, launch it with
   Start-Process powershell -Verb RunAs -Wait -ArgumentList '-ExecutionPolicy Bypass -File "<full path>"'
6. Restart the plugin: npx streamdeck restart com.lee-cleobury.pc-stats
7. Check http://localhost:9696/metrics. Success means status is "ok", cpu_temperature is present
   and notes is empty.

Report the result, and if notes is not empty, tell me what it says.
```

To install by hand, follow [Requirements](#requirements) and [Setup](#setup).

## Metrics

| Metrics | Source |
| --- | --- |
| `cpu_usage`, `ram_usage` | Windows |
| `gpu_usage`, `gpu_temperature`, `power`, `memory_usage` (VRAM) | NVML, included with the NVIDIA driver |
| `cpu_temperature`, `cpu_power` | LibreHardwareMonitorLib, via the PawnIO driver |
| `framerate`, `framerate_1_low` | Windows frame events for the foreground app (DXGI, plus the kernel graphics layer for other APIs) |
| `network_download_mbps`, `network_upload_mbps` | Windows, read by the plugin itself |

Notes:

- Frame rates come from events Windows publishes, so nothing is injected into games.
- FPS covers DirectX, Vulkan and OpenGL. It reads `0` on the desktop and in apps that render in a separate process (such as browsers).
- 1% lows cover the last 30 seconds of the foreground app.
- GPU stats are NVIDIA only.

## Features

- Live metric polling from the local sidecar
- Metric picker in Property Inspector (auto-loads available metric keys)
- Visual styles:
  - Value only
  - Line chart
  - Filled line chart
  - Gauge
  - Dot matrix
- Single or dual metric tiles
- Theme presets (`default`, `neon`, `minimal`, `retro`) plus fully custom colors
- Independent label/value styling controls:
  - Position and size
  - Border color and border thickness
- Suffix display modes:
  - Beside value
  - Below value
  - Hidden
- Graph scaling controls:
  - Auto scale
  - Custom min/max range
- Polling interval and decimal precision controls
- Defensive value formatting (invalid or exponent output displays as `0`)
- Sidecar auto-start when the local endpoint is unreachable

## Requirements

To use:

- Windows 10 or later
- Stream Deck software `7.1+`
- An NVIDIA GPU, for GPU stats

To build:

- Node.js `24` (matches plugin manifest)
- .NET 10 SDK

## Setup

Install dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

Build the sidecar (stop any running `StatsReader.exe` first):

```bash
npm run build:sidecar
```

Load the `.sdPlugin` folder into Stream Deck, then run the one-time setup from an administrator PowerShell window, in the plugin's `bin` folder:

```powershell
.\install-startup.ps1
```

This installs the PawnIO driver if it is missing, then starts `StatsReader.exe` elevated at login. CPU temperature and power need it; without it they show N/A and everything else still works. To remove the login task:

```powershell
.\install-startup.ps1 -Uninstall
```

Watch mode (rebuild + restart plugin on changes):

```bash
npm run watch
```

## Using The Plugin

1. Add the **Metric Display** action to a key. The sidecar starts automatically if it is not already running.
2. Open Property Inspector and configure:
   - Endpoint URL
   - Metric
   - Style/theme
   - Label/value layout and borders
   - Suffix mode
   - Polling, decimals, graph scale

## Project Layout

- `src/plugin.ts`: plugin entry and action registration
- `src/actions/increment-counter.ts`: main telemetry action logic and SVG rendering
- `src/network-stats.ts`: network speed sampling
- `sidecar/`: source for `StatsReader.exe` (.NET 10, published as one self-contained exe)
- `sidecar/install-startup.ps1`: one-time setup, copied to `bin` by `npm run build:sidecar`
- `com.lee-cleobury.pc-stats.sdPlugin/manifest.json`: Stream Deck plugin manifest
- `com.lee-cleobury.pc-stats.sdPlugin/ui/increment-counter.html`: Property Inspector UI
- `rollup.config.mjs`: plugin build configuration

## Sidecar Endpoint

`GET /metrics` returns:

```json
{
  "timestampUtc": "2026-11-07T16:42:45+00:00",
  "status": "ok",
  "metrics": {
    "gpu_temperature": 62,
    "gpu_usage": 97
  },
  "notes": [],
  "error": null
}
```

`notes` lists any stats that are unavailable and why. Metrics that can't be read are left out, and their tiles show N/A.

## Development Notes

- Output bundle path: `com.lee-cleobury.pc-stats.sdPlugin/bin/plugin.js`
- In non-watch builds, output is minified.
- The plugin keeps its original `com.lee-cleobury.pc-stats` ID and folder name. Changing them would remove every tile from existing Stream Deck profiles.
- An elevated sidecar replaces a non-elevated one, so the login task and the plugin's auto-start can't conflict.

## Troubleshooting

- **Blank/ERR tile**
  - The plugin tries to start the sidecar itself. If the tile still shows an error, check the endpoint in a browser: `http://localhost:9696/metrics`
  - Confirm `StatsReader.exe` is present in `bin/` and was not blocked by antivirus
- **CPU temperature or power shows N/A**
  - Check `notes` in the endpoint response
  - Run the one-time setup, then confirm the `StatsReader` task exists in Task Scheduler
- **FPS shows 0 in a game**
  - Make sure the game is the foreground window
- **No metrics in dropdown**
  - Ensure the response has a `metrics` object
  - Check the endpoint URL in Property Inspector
- **Graph scale looks wrong**
  - Disable custom scale for auto-scaling, or set a valid min/max range
- **Unexpected large/exponent values**
  - Renderer falls back to `0` for invalid/scientific notation output

## License

MIT Innit
