import { execFile } from "node:child_process";

export const NETWORK_DOWNLOAD_KEY = "network_download_mbps";
export const NETWORK_UPLOAD_KEY = "network_upload_mbps";

// netstat -e reports 32-bit counters on some Windows builds, so a negative delta means the counter wrapped.
const COUNTER_WRAP = 2 ** 32;
// Polls closer together than this reuse the last rate instead of resampling, so the PI picker and render loop don't fight.
const MIN_SAMPLE_INTERVAL_MS = 500;

type ByteCounters = { received: number; sent: number; at: number };

let lastCounters: ByteCounters | undefined;
let lastRates: Record<string, number> = {};
let pendingSample: Promise<Record<string, number>> | undefined;

export function isNetworkMetricKey(metricKey: string): boolean {
	return metricKey === NETWORK_DOWNLOAD_KEY || metricKey === NETWORK_UPLOAD_KEY;
}

/**
 * Returns current download/upload rates in megabits per second, read from the OS rather than Afterburner.
 * Returns an empty object when the platform is unsupported or the counters can't be read.
 */
export async function sampleNetworkMetrics(): Promise<Record<string, number>> {
	if (process.platform !== "win32") {
		return {};
	}
	if (lastCounters && Date.now() - lastCounters.at < MIN_SAMPLE_INTERVAL_MS) {
		return lastRates;
	}
	pendingSample ??= takeSample().finally(() => {
		pendingSample = undefined;
	});
	return pendingSample;
}

async function takeSample(): Promise<Record<string, number>> {
	const counters = await readWindowsByteCounters();
	if (!counters) {
		return {};
	}
	const previous = lastCounters;
	lastCounters = counters;
	if (!previous) {
		lastRates = { [NETWORK_DOWNLOAD_KEY]: 0, [NETWORK_UPLOAD_KEY]: 0 };
		return lastRates;
	}
	const elapsedSeconds = Math.max(0.001, (counters.at - previous.at) / 1000);
	lastRates = {
		[NETWORK_DOWNLOAD_KEY]: bytesToMegabits(counterDelta(previous.received, counters.received)) / elapsedSeconds,
		[NETWORK_UPLOAD_KEY]: bytesToMegabits(counterDelta(previous.sent, counters.sent)) / elapsedSeconds,
	};
	return lastRates;
}

function counterDelta(previous: number, current: number): number {
	const delta = current - previous;
	return delta >= 0 ? delta : delta + COUNTER_WRAP;
}

function bytesToMegabits(bytes: number): number {
	return (bytes * 8) / 1_000_000;
}

function readWindowsByteCounters(): Promise<ByteCounters | undefined> {
	return new Promise((resolve) => {
		execFile("netstat", ["-e"], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			// The first row with two numeric columns is "Bytes  <received>  <sent>"; matching by shape avoids depending on the localized label.
			const bytesRow = stdout.split(/\r?\n/).map((line) => line.match(/\s(\d+)\s+(\d+)\s*$/)).find((match) => match !== null);
			if (!bytesRow) {
				resolve(undefined);
				return;
			}
			resolve({ received: Number(bytesRow[1]), sent: Number(bytesRow[2]), at: Date.now() });
		});
	});
}
