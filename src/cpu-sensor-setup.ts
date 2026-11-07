import streamDeck from "@elgato/streamdeck";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETUP_SCRIPT_NAME = "install-startup.ps1";
const CPU_TEMPERATURE_KEY = "cpu_temperature";
const CPU_USAGE_KEY = "cpu_usage";
// The login task can start after the plugin, so give it time to bring CPU temperature up before asking.
const MISSING_GRACE_MS = 20_000;

type GlobalSettings = { cpuSensorSetupPromptedFor?: string };

let missingSinceMs: number | undefined;
let promptChecked = false;

/**
 * CPU temperature needs admin rights once. The first time a working reader goes without it, shows the
 * Windows approval prompt for the setup script. Declining is remembered, so it never nags.
 */
export function promptForCpuSensorSetupIfNeeded(metrics: Record<string, unknown>): void {
	if (process.platform !== "win32" || promptChecked) {
		return;
	}
	if (CPU_TEMPERATURE_KEY in metrics) {
		missingSinceMs = undefined;
		return;
	}
	// A reader that has no CPU usage yet is still starting, so it says nothing about temperature.
	if (!(CPU_USAGE_KEY in metrics)) {
		return;
	}
	missingSinceMs ??= Date.now();
	if (Date.now() - missingSinceMs < MISSING_GRACE_MS) {
		return;
	}
	promptChecked = true;
	void promptOnce();
}

async function promptOnce(): Promise<void> {
	const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), SETUP_SCRIPT_NAME);
	try {
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		// Keyed by path, so moving the plugin asks again: the login task would point at the old folder.
		if (settings.cpuSensorSetupPromptedFor === scriptPath) {
			return;
		}
		await access(scriptPath);
		await streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...settings, cpuSensorSetupPromptedFor: scriptPath });
		runElevated(scriptPath);
	} catch (error) {
		streamDeck.logger.error(`CPU sensor setup was not started: ${String(error)}`);
	}
}

function runElevated(scriptPath: string): void {
	const quotedPath = scriptPath.replaceAll("'", "''");
	const command = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${quotedPath}"'`;
	const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", command], { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", (error) => streamDeck.logger.error(`CPU sensor setup failed to launch: ${String(error)}`));
	child.unref();
}
