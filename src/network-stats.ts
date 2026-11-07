import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const NETWORK_DOWNLOAD_KEY = "network_download_mbps";
export const NETWORK_UPLOAD_KEY = "network_upload_mbps";

const SAMPLE_INTERVAL_MS = 1000;
// A reading older than this means the reader stalled, so report nothing rather than a frozen rate.
const STALE_READING_MS = 5000;
const RESPAWN_BACKOFF_MS = 10_000;
const TICKS_PER_MS = 10_000;

// Sums the 64-bit byte counters of physical adapters only. netstat -e also counts virtual switches and
// WAN miniports, which multiplies real traffic several times over. Adapters are re-queried each loop so
// plugging in a cable or toggling Wi-Fi is picked up, and the loop exits once the plugin process is gone.
const READER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while (Get-Process -Id ${process.pid}) {
	$names = @((Get-NetAdapter -Physical).Name)
	$stats = Get-NetAdapterStatistics | Where-Object { $names -contains $_.Name }
	$received = ($stats | Measure-Object -Property ReceivedBytes -Sum).Sum
	$sent = ($stats | Measure-Object -Property SentBytes -Sum).Sum
	$line = "{0} {1} {2}" -f [DateTime]::UtcNow.Ticks, [uint64]$received, [uint64]$sent
	[Console]::Out.WriteLine($line)
	[Console]::Out.Flush()
	Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}
}
`;

type ByteCounters = { received: number; sent: number; atMs: number };

let reader: ChildProcess | undefined;
let lastSpawnAt = 0;
let lastCounters: ByteCounters | undefined;
let lastRates: Record<string, number> | undefined;
let lastReadingAt = 0;

export function isNetworkMetricKey(metricKey: string): boolean {
	return metricKey === NETWORK_DOWNLOAD_KEY || metricKey === NETWORK_UPLOAD_KEY;
}

/**
 * Returns current download/upload rates in megabits per second, read from the OS rather than the sidecar.
 * Returns an empty object when the platform is unsupported or the reader has stopped reporting.
 */
export async function sampleNetworkMetrics(): Promise<Record<string, number>> {
	if (process.platform !== "win32") {
		return {};
	}
	ensureReader();
	if (!lastRates) {
		// Reader is warming up; report zeros so the keys still appear in the metric picker.
		return reader ? { [NETWORK_DOWNLOAD_KEY]: 0, [NETWORK_UPLOAD_KEY]: 0 } : {};
	}
	if (Date.now() - lastReadingAt > STALE_READING_MS) {
		return {};
	}
	return lastRates;
}

function ensureReader(): void {
	if (reader || Date.now() - lastSpawnAt < RESPAWN_BACKOFF_MS) {
		return;
	}
	lastSpawnAt = Date.now();
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", READER_SCRIPT], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
	reader = child;
	createInterface({ input: child.stdout! }).on("line", handleReading);
	child.on("error", () => resetReader(child));
	child.on("exit", () => resetReader(child));
}

function resetReader(child: ChildProcess): void {
	if (reader === child) {
		reader = undefined;
		lastCounters = undefined;
	}
}

function handleReading(line: string): void {
	const match = line.trim().match(/^(\d+) (\d+) (\d+)$/);
	if (!match) {
		return;
	}
	const counters: ByteCounters = { atMs: Number(match[1]) / TICKS_PER_MS, received: Number(match[2]), sent: Number(match[3]) };
	const previous = lastCounters;
	lastCounters = counters;
	lastReadingAt = Date.now();
	if (!previous) {
		return;
	}
	const elapsedSeconds = (counters.atMs - previous.atMs) / 1000;
	// Counters drop when an adapter disappears; skip that interval rather than report a negative rate.
	if (elapsedSeconds <= 0 || counters.received < previous.received || counters.sent < previous.sent) {
		return;
	}
	lastRates = {
		[NETWORK_DOWNLOAD_KEY]: bytesToMegabits(counters.received - previous.received) / elapsedSeconds,
		[NETWORK_UPLOAD_KEY]: bytesToMegabits(counters.sent - previous.sent) / elapsedSeconds,
	};
}

function bytesToMegabits(bytes: number): number {
	return (bytes * 8) / 1_000_000;
}

process.on("exit", () => reader?.kill());
