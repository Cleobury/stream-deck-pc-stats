import {
	action,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	PropertyInspectorDidAppearEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isNetworkMetricKey, NETWORK_DOWNLOAD_KEY, NETWORK_UPLOAD_KEY, sampleNetworkMetrics } from "../network-stats";

const SIDECAR_EXE_NAME = "AfterburnerReader.exe";
const SVG_SIZE = 144;
const CARD_RADIUS = 18;
const MAX_REASONABLE_METRIC_ABS = 1_000_000_000;

@action({ UUID: "com.lee-cleobury.afterburner-display.increment" })
export class IncrementCounter extends SingletonAction<DisplaySettings> {
	private readonly settingsByActionId = new Map<string, NormalizedDisplaySettings>();
	private readonly historyByActionId = new Map<string, number[]>();
	private readonly secondaryHistoryByActionId = new Map<string, number[]>();
	private pollTimer: NodeJS.Timeout | undefined;
	private sidecarBootPromise: Promise<void> | undefined;

	override async onWillAppear(ev: WillAppearEvent<DisplaySettings>): Promise<void> {
		const settings = normalizeSettings(ev.payload.settings);
		this.settingsByActionId.set(ev.action.id, settings);
		void this.ensureSidecarRunningIfNeeded(settings.endpointUrl);

		if (JSON.stringify(ev.payload.settings) !== JSON.stringify(settings)) {
			await ev.action.setSettings(settings);
		}

		await ev.action.setTitle("");
		await ev.action.setImage(renderStatusCard("Connecting", "Loading", "#8be9fd"));
		this.ensurePolling();
	}

	override onWillDisappear(ev: WillDisappearEvent<DisplaySettings>): void {
		this.settingsByActionId.delete(ev.action.id);
		this.historyByActionId.delete(ev.action.id);
		this.secondaryHistoryByActionId.delete(ev.action.id);
		if (this.settingsByActionId.size === 0 && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DisplaySettings>): void {
		this.settingsByActionId.set(ev.action.id, normalizeSettings(ev.payload.settings));
		this.ensurePolling();
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<DisplaySettings>): void {
		const settings = this.settingsByActionId.get(ev.action.id) ?? DEFAULT_SETTINGS;
		void this.sendMetricsListToInspector(settings.endpointUrl);
	}

	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, DisplaySettings>): void {
		if (!isRequestMetricsPayload(ev.payload)) {
			return;
		}

		void this.sendMetricsListToInspector(ev.payload.endpointUrl ?? DEFAULT_SETTINGS.endpointUrl);
	}

	override async onKeyDown(ev: KeyDownEvent<DisplaySettings>): Promise<void> {
		await this.pollAndRender();
		await ev.action.showOk();
	}

	private ensurePolling(): void {
		if (this.settingsByActionId.size === 0) {
			return;
		}

		const fastestRefreshMs = Math.min(...Array.from(this.settingsByActionId.values()).map((settings) => settings.refreshMs));

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
		}

		this.pollTimer = setInterval(() => {
			void this.pollAndRender();
		}, fastestRefreshMs);

		void this.pollAndRender();
	}

	private async pollAndRender(): Promise<void> {
		const actions = Array.from(this.actions).filter((action): action is KeyAction<DisplaySettings> => action.isKey());
		if (actions.length === 0) {
			return;
		}

		const groups = new Map<string, KeyAction<DisplaySettings>[]>();
		for (const action of actions) {
			const settings = this.settingsByActionId.get(action.id) ?? normalizeSettings({});
			const list = groups.get(settings.endpointUrl) ?? [];
			list.push(action);
			groups.set(settings.endpointUrl, list);
		}

		for (const [endpointUrl, endpointActions] of groups.entries()) {
			try {
				const metrics = await this.fetchMetricsWithBootstrap(endpointUrl);
				await Promise.all(endpointActions.map(async (action) => {
					const settings = this.settingsByActionId.get(action.id) ?? normalizeSettings({ endpointUrl });
					await this.renderMetricForAction(action, settings, metrics);
				}));
			} catch (error) {
				const message = error instanceof Error ? error.message : "No data";
				// Network speeds come from the OS, so tiles showing only those keep working when the sidecar is down.
				const networkMetrics = await sampleNetworkMetrics();
				await Promise.all(endpointActions.map(async (action) => {
					const settings = this.settingsByActionId.get(action.id) ?? normalizeSettings({ endpointUrl });
					if (usesOnlyNetworkMetrics(settings) && Object.keys(networkMetrics).length > 0) {
						await this.renderMetricForAction(action, settings, networkMetrics);
						return;
					}
					const label = settings.label || shortMetricLabel(settings.metricKey);
					await action.setTitle("");
					await action.setImage(renderStatusCard(label, "ERR", "#ff6b6b", message));
				}));
			}
		}
	}

	private async renderMetricForAction(action: KeyAction<DisplaySettings>, settings: NormalizedDisplaySettings, metrics: Record<string, number | string | boolean | null>): Promise<void> {
		if (settings.displayMode === "dual") {
			const primaryMetricKey = settings.metricKey;
			const secondaryMetricKey = settings.secondaryMetricKey;
			const primaryRawValue = metrics[primaryMetricKey];
			const secondaryRawValue = metrics[secondaryMetricKey];
			const primaryValue = typeof primaryRawValue === "number" ? sanitizeMetricNumber(primaryRawValue) : undefined;
			const secondaryValue = typeof secondaryRawValue === "number" ? sanitizeMetricNumber(secondaryRawValue) : undefined;
			const histories = this.pushDualHistory(action.id, primaryValue, secondaryValue, settings.lineSamples);
			const primaryMetric = metricLineFromPayload(metrics, primaryMetricKey, settings.label || shortMetricLabel(primaryMetricKey), settings.decimals, resolveDualAccent(settings, primaryMetricKey, "primary"));
			const secondaryMetric = metricLineFromPayload(metrics, secondaryMetricKey, settings.secondaryLabel || shortMetricLabel(secondaryMetricKey), settings.decimals, resolveDualAccent(settings, secondaryMetricKey, "secondary"));
			await action.setTitle("");
			await action.setImage(renderDualMetricCard(settings, primaryMetric, secondaryMetric, histories.primary, histories.secondary, primaryValue, secondaryValue, primaryMetricKey, secondaryMetricKey));
			return;
		}

		const label = settings.label || shortMetricLabel(settings.metricKey);
		const rawValue = metrics[settings.metricKey];

		if (rawValue === undefined || rawValue === null) {
			await action.setTitle("");
			await action.setImage(renderStatusCard(label, "N/A", "#f2c94c"));
			return;
		}

		if (typeof rawValue !== "number") {
			await action.setTitle("");
			await action.setImage(renderStatusCard(label, String(rawValue), "#8be9fd"));
			return;
		}

		const numericValue = sanitizeMetricNumber(rawValue);
		const history = this.pushHistory(action.id, numericValue, settings.lineSamples);
		const image = renderMetricCard(settings, settings.metricKey, label, numericValue, history);
		await action.setTitle("");
		await action.setImage(image);
	}

	private pushHistory(actionId: string, value: number, maxSamples: number): number[] {
		const safeCurrentHistory = sanitizeSeries(this.historyByActionId.get(actionId) ?? []);
		const safeValue = sanitizeMetricNumber(value);
		const nextHistory = [...safeCurrentHistory, safeValue].slice(-maxSamples);
		this.historyByActionId.set(actionId, nextHistory);
		return nextHistory;
	}

	private pushDualHistory(actionId: string, primaryValue: number | undefined, secondaryValue: number | undefined, maxSamples: number): { primary: number[]; secondary: number[] } {
		const currentPrimary = sanitizeSeries(this.historyByActionId.get(actionId) ?? []);
		const currentSecondary = sanitizeSeries(this.secondaryHistoryByActionId.get(actionId) ?? []);
		const safePrimary = primaryValue === undefined ? undefined : sanitizeMetricNumber(primaryValue);
		const safeSecondary = secondaryValue === undefined ? undefined : sanitizeMetricNumber(secondaryValue);
		const nextPrimary = safePrimary === undefined ? currentPrimary.slice(-maxSamples) : [...currentPrimary, safePrimary].slice(-maxSamples);
		const nextSecondary = safeSecondary === undefined ? currentSecondary.slice(-maxSamples) : [...currentSecondary, safeSecondary].slice(-maxSamples);
		this.historyByActionId.set(actionId, nextPrimary);
		this.secondaryHistoryByActionId.set(actionId, nextSecondary);
		return { primary: nextPrimary, secondary: nextSecondary };
	}

	private async sendMetricsListToInspector(endpointUrl: string): Promise<void> {
		const payload: MetricsListToInspector = { type: "metrics-list", endpointUrl, keys: [] };
		try {
			const metrics = await this.fetchMetricsWithBootstrap(endpointUrl);
			payload.keys = Object.keys(metrics).sort((left, right) => left.localeCompare(right));
		} catch (error) {
			payload.error = error instanceof Error ? error.message : "Unable to load metrics";
		}
		await streamDeck.ui.sendToPropertyInspector(payload);
	}

	private async fetchMetricsWithBootstrap(endpointUrl: string): Promise<Record<string, number | string | boolean | null>> {
		const [sidecarMetrics, networkMetrics] = await Promise.all([this.fetchSidecarMetricsWithBootstrap(endpointUrl), sampleNetworkMetrics()]);
		return { ...sidecarMetrics, ...networkMetrics };
	}

	private async fetchSidecarMetricsWithBootstrap(endpointUrl: string): Promise<Record<string, number | string | boolean | null>> {
		const normalizedEndpointUrl = normalizeEndpointUrl(endpointUrl);
		try {
			return await fetchMetrics(normalizedEndpointUrl);
		} catch (error) {
			if (!shouldAttemptSidecarBoot(normalizedEndpointUrl)) {
				throw error;
			}
			await this.ensureSidecarRunningIfNeeded(normalizedEndpointUrl);
			await delay(5000);
			return fetchMetrics(normalizedEndpointUrl);
		}
	}

	private async ensureSidecarRunningIfNeeded(endpointUrl: string): Promise<void> {
		if (process.platform !== "win32" || !shouldAttemptSidecarBoot(endpointUrl)) {
			return;
		}
		if (this.sidecarBootPromise) {
			await this.sidecarBootPromise;
			return;
		}
		this.sidecarBootPromise = this.ensureSidecarRunningInternal();
		try {
			await this.sidecarBootPromise;
		} finally {
			this.sidecarBootPromise = undefined;
		}
	}

	private async ensureSidecarRunningInternal(): Promise<void> {
		if (await isAfterburnerReaderRunning()) {
			return;
		}
		const exePath = await resolveAfterburnerReaderPath();
		if (!exePath) {
			streamDeck.logger.error("AfterburnerReader.exe not found in plugin output folder.");
			return;
		}
		try {
			const child = spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: true });
			child.unref();
		} catch (error) {
			streamDeck.logger.error(`Failed to start AfterburnerReader.exe: ${String(error)}`);
		}
	}
}

type DisplaySettings = {
	endpointUrl?: string;
	displayMode?: DisplayMode;
	dualViewStyle?: DualViewStyle;
	dualValueLayout?: DualValueLayout;
	dualValueOpacity?: number;
	dualPrimaryLabelX?: number;
	dualPrimaryLabelY?: number;
	dualSecondaryLabelX?: number;
	dualSecondaryLabelY?: number;
	metricKey?: string;
	label?: string;
	secondaryMetricKey?: string;
	secondaryLabel?: string;
	primaryAccentColor?: string;
	secondaryAccentColor?: string;
	primaryLabelColor?: string;
	secondaryLabelColor?: string;
	hideLabel?: boolean;
	labelX?: number;
	labelY?: number;
	labelSize?: number;
	labelStrokeColor?: string;
	labelStrokeWidth?: number;
	valueX?: number;
	valueY?: number;
	valueSize?: number;
	valueStrokeColor?: string;
	valueStrokeWidth?: number;
	suffixMode?: SuffixMode;
	useCustomScale?: boolean;
	scaleMin?: number;
	scaleMax?: number;
	decimals?: number;
	refreshMs?: number;
	viewStyle?: ViewStyle;
	lineThickness?: number;
	gradientLevel?: number;
	graphBaselineOffset?: number;
	lineFillStrength?: number;
	fontSize?: number;
	fontFamily?: string;
	lineSamples?: number;
	theme?: Theme;
	customBg0?: string;
	customBg1?: string;
	customBorderColor?: string;
	customLabelColor?: string;
	customValueColor?: string;
	customAccentColor?: string;
	customTrackColor?: string;
};

type Theme = "default" | "neon" | "minimal" | "retro" | "custom";

type DisplayMode = "single" | "dual";

type DualViewStyle = "split" | "multi-line" | "multi-dot";

type DualValueLayout = "top-bottom" | "left-right";

type ViewStyle = "value" | "line" | "line-filled" | "gauge" | "dot-matrix";

type SuffixMode = "off" | "inline" | "below";

type NormalizedDisplaySettings = Required<DisplaySettings>;

type SidecarPayload = {
	status?: string;
	metrics?: Record<string, number | string | boolean | null>;
	error?: string | null;
};

type RequestMetricsPayload = {
	type: "request-metrics-list";
	endpointUrl?: string;
};

type MetricsListToInspector = {
	type: "metrics-list";
	endpointUrl: string;
	keys: string[];
	error?: string;
};

const DEFAULT_SETTINGS: NormalizedDisplaySettings = {
	endpointUrl: "http://localhost:9696/metrics",
	displayMode: "single",
	dualViewStyle: "split",
	dualValueLayout: "top-bottom",
	dualValueOpacity: 0.9,
	dualPrimaryLabelX: 72,
	dualPrimaryLabelY: 30,
	dualSecondaryLabelX: 72,
	dualSecondaryLabelY: 74,
	metricKey: "gpu1_temperature",
	label: "GPU1 Temp",
	secondaryMetricKey: "cpu_usage",
	secondaryLabel: "CPU Usage",
	primaryAccentColor: "",
	secondaryAccentColor: "",
	primaryLabelColor: "#cbd5e1",
	secondaryLabelColor: "#cbd5e1",
	hideLabel: false,
	labelX: 72,
	labelY: 34,
	labelSize: 14,
	labelStrokeColor: "#000000",
	labelStrokeWidth: 0,
	valueX: 72,
	valueY: 86,
	valueSize: 48,
	valueStrokeColor: "#000000",
	valueStrokeWidth: 0,
	suffixMode: "inline",
	useCustomScale: false,
	scaleMin: 0,
	scaleMax: 100,
	decimals: 0,
	refreshMs: 1000,
	viewStyle: "value",
	lineThickness: 3,
	gradientLevel: 1,
	graphBaselineOffset: 0,
	lineFillStrength: 0.65,
	fontSize: 48,
	fontFamily: "Segoe UI",
	lineSamples: 30,
	theme: "default",
	customBg0: "#0f172a",
	customBg1: "#1e293b",
	customBorderColor: "#ffffff20",
	customLabelColor: "#cbd5e1",
	customValueColor: "#f8fafc",
	customAccentColor: "#22d3ee",
	customTrackColor: "#334155",
};

function normalizeSettings(input: DisplaySettings): NormalizedDisplaySettings {
	const normalizedValueSize = clampInt(input.valueSize ?? input.fontSize, 24, 72, DEFAULT_SETTINGS.valueSize);
	return {
		endpointUrl: normalizeEndpointUrl(input.endpointUrl),
		displayMode: normalizeDisplayMode(input.displayMode),
		dualViewStyle: normalizeDualViewStyle(input.dualViewStyle),
		dualValueLayout: normalizeDualValueLayout(input.dualValueLayout),
		dualValueOpacity: clampNumber(input.dualValueOpacity, 0.2, 1, DEFAULT_SETTINGS.dualValueOpacity),
		dualPrimaryLabelX: clampInt(input.dualPrimaryLabelX, 8, 128, DEFAULT_SETTINGS.dualPrimaryLabelX),
		dualPrimaryLabelY: clampInt(input.dualPrimaryLabelY, 12, 132, DEFAULT_SETTINGS.dualPrimaryLabelY),
		dualSecondaryLabelX: clampInt(input.dualSecondaryLabelX, 8, 128, DEFAULT_SETTINGS.dualSecondaryLabelX),
		dualSecondaryLabelY: clampInt(input.dualSecondaryLabelY, 12, 132, DEFAULT_SETTINGS.dualSecondaryLabelY),
		metricKey: input.metricKey?.trim() || DEFAULT_SETTINGS.metricKey,
		label: input.label !== undefined ? input.label.trim() : DEFAULT_SETTINGS.label,
		secondaryMetricKey: input.secondaryMetricKey?.trim() || DEFAULT_SETTINGS.secondaryMetricKey,
		secondaryLabel: input.secondaryLabel !== undefined ? input.secondaryLabel.trim() : DEFAULT_SETTINGS.secondaryLabel,
		primaryAccentColor: normalizeColor(input.primaryAccentColor, DEFAULT_SETTINGS.primaryAccentColor),
		secondaryAccentColor: normalizeColor(input.secondaryAccentColor, DEFAULT_SETTINGS.secondaryAccentColor),
		primaryLabelColor: normalizeColor(input.primaryLabelColor, DEFAULT_SETTINGS.primaryLabelColor),
		secondaryLabelColor: normalizeColor(input.secondaryLabelColor, DEFAULT_SETTINGS.secondaryLabelColor),
		hideLabel: input.hideLabel === true,
		labelX: clampInt(input.labelX, 8, 128, DEFAULT_SETTINGS.labelX),
		labelY: clampInt(input.labelY, 12, 132, DEFAULT_SETTINGS.labelY),
		labelSize: clampInt(input.labelSize, 10, 24, DEFAULT_SETTINGS.labelSize),
		labelStrokeColor: normalizeColor(input.labelStrokeColor, DEFAULT_SETTINGS.labelStrokeColor),
		labelStrokeWidth: clampNumber(input.labelStrokeWidth, 0, 6, DEFAULT_SETTINGS.labelStrokeWidth),
		valueX: clampInt(input.valueX, 8, 128, DEFAULT_SETTINGS.valueX),
		valueY: clampInt(input.valueY, 24, 132, DEFAULT_SETTINGS.valueY),
		valueSize: normalizedValueSize,
		valueStrokeColor: normalizeColor(input.valueStrokeColor, DEFAULT_SETTINGS.valueStrokeColor),
		valueStrokeWidth: clampNumber(input.valueStrokeWidth, 0, 6, DEFAULT_SETTINGS.valueStrokeWidth),
		suffixMode: normalizeSuffixMode(input.suffixMode),
		useCustomScale: input.useCustomScale === true,
		scaleMin: clampNumber(input.scaleMin, -100000, 100000, DEFAULT_SETTINGS.scaleMin),
		scaleMax: clampNumber(input.scaleMax, -100000, 100000, DEFAULT_SETTINGS.scaleMax),
		decimals: clampInt(input.decimals, 0, 3, DEFAULT_SETTINGS.decimals),
		refreshMs: clampInt(input.refreshMs, 500, 5000, DEFAULT_SETTINGS.refreshMs),
		viewStyle: normalizeViewStyle(input.viewStyle),
		lineThickness: clampNumber(input.lineThickness, 1, 8, DEFAULT_SETTINGS.lineThickness),
		gradientLevel: clampNumber(input.gradientLevel, 0, 1, DEFAULT_SETTINGS.gradientLevel),
		graphBaselineOffset: clampNumber(input.graphBaselineOffset, 0, 40, DEFAULT_SETTINGS.graphBaselineOffset),
		lineFillStrength: clampNumber(input.lineFillStrength, 0.1, 1, DEFAULT_SETTINGS.lineFillStrength),
		fontSize: normalizedValueSize,
		fontFamily: input.fontFamily?.trim() || DEFAULT_SETTINGS.fontFamily,
		lineSamples: clampInt(input.lineSamples, 10, 60, DEFAULT_SETTINGS.lineSamples),
		theme: normalizeTheme(input.theme),
		customBg0: normalizeColor(input.customBg0, DEFAULT_SETTINGS.customBg0),
		customBg1: normalizeColor(input.customBg1, DEFAULT_SETTINGS.customBg1),
		customBorderColor: normalizeColor(input.customBorderColor, DEFAULT_SETTINGS.customBorderColor),
		customLabelColor: normalizeColor(input.customLabelColor, DEFAULT_SETTINGS.customLabelColor),
		customValueColor: normalizeColor(input.customValueColor, DEFAULT_SETTINGS.customValueColor),
		customAccentColor: normalizeColor(input.customAccentColor, DEFAULT_SETTINGS.customAccentColor),
		customTrackColor: normalizeColor(input.customTrackColor, DEFAULT_SETTINGS.customTrackColor),
	};
}

function normalizeDisplayMode(value: string | undefined): DisplayMode {
	if (value === "dual") {
		return value;
	}
	return "single";
}

function normalizeDualViewStyle(value: string | undefined): DualViewStyle {
	if (value === "multi-line" || value === "multi-dot") {
		return value;
	}
	return "split";
}

function normalizeDualValueLayout(value: string | undefined): DualValueLayout {
	if (value === "left-right") {
		return value;
	}
	return "top-bottom";
}

function normalizeTheme(value: string | undefined): Theme {
	if (value === "neon" || value === "minimal" || value === "retro" || value === "custom") {
		return value;
	}
	return "default";
}

function normalizeSuffixMode(value: string | undefined): SuffixMode {
	if (value === "off" || value === "below") {
		return value;
	}
	return "inline";
}

function normalizeColor(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		return fallback;
	}
	return trimmed;
}

type ThemePalette = {
	bg0: string;
	bg1: string;
	borderColor: string;
	labelColor: string;
	valueColor: string;
	trackColor: string;
	fontFamily: string;
};

function themeFor(settings: NormalizedDisplaySettings): ThemePalette {
	switch (settings.theme) {
		case "neon":
			return {
				bg0: "#04030d",
				bg1: "#0d0d2b",
				borderColor: "#00ff9930",
				labelColor: "#6e6e9e",
				valueColor: "#e0e0ff",
				trackColor: "#1a1a3a",
				fontFamily: settings.fontFamily === "Segoe UI" ? "Consolas, Courier New" : settings.fontFamily,
			};
		case "minimal":
			return {
				bg0: "#000000",
				bg1: "#000000",
				borderColor: "#ffffff08",
				labelColor: "#71717a",
				valueColor: "#ffffff",
				trackColor: "#27272a",
				fontFamily: settings.fontFamily,
			};
		case "retro":
			return {
				bg0: "#000800",
				bg1: "#001200",
				borderColor: "#00cc0030",
				labelColor: "#007700",
				valueColor: "#00ee00",
				trackColor: "#002200",
				fontFamily: settings.fontFamily === "Segoe UI" ? "Courier New" : settings.fontFamily,
			};
		case "custom":
			return {
				bg0: settings.customBg0,
				bg1: settings.customBg1,
				borderColor: settings.customBorderColor,
				labelColor: settings.customLabelColor,
				valueColor: settings.customValueColor,
				trackColor: settings.customTrackColor,
				fontFamily: settings.fontFamily,
			};
		default:
			return {
				bg0: "#0f172a",
				bg1: "#1e293b",
				borderColor: "#ffffff20",
				labelColor: "#cbd5e1",
				valueColor: "#f8fafc",
				trackColor: "#334155",
				fontFamily: settings.fontFamily,
			};
	}
}

function themeAccentColor(settings: NormalizedDisplaySettings, metricKey: string): string {
	if (settings.theme === "custom") {
		return settings.customAccentColor;
	}
	if (settings.theme === "retro") {
		return "#00cc00";
	}
	if (settings.theme === "minimal") {
		return "#a1a1aa";
	}
	if (settings.theme === "neon") {
		if (metricKey.includes("temperature")) return "#ff6ec7";
		if (metricKey.includes("power")) return "#00ff99";
		if (metricKey.includes("clock")) return "#7b5ea7";
		if (metricKey.includes("fan")) return "#00d4ff";
		return "#00e5ff";
	}
	return accentColor(metricKey);
}

function resolveDualAccent(settings: NormalizedDisplaySettings, metricKey: string, slot: "primary" | "secondary"): string {
	const explicitColor = slot === "primary" ? settings.primaryAccentColor : settings.secondaryAccentColor;
	if (explicitColor) {
		return explicitColor;
	}
	if (settings.theme === "custom") {
		return settings.customAccentColor;
	}
	return accentColor(metricKey);
}

function normalizeViewStyle(value: string | undefined): ViewStyle {
	if (value === "line" || value === "line-filled" || value === "gauge" || value === "dot-matrix") {
		return value;
	}
	return "value";
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

async function fetchMetrics(endpointUrl: string): Promise<Record<string, number | string | boolean | null>> {
	const response = await fetch(endpointUrl, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	const payload = (await response.json()) as SidecarPayload;
	if (payload.status && payload.status !== "ok") {
		throw new Error(payload.error || "Sidecar reported non-ok status");
	}
	if (!payload.metrics || typeof payload.metrics !== "object") {
		throw new Error("No metrics field in payload");
	}
	return payload.metrics;
}

function shortMetricLabel(metricKey: string): string {
	if (metricKey === "gpu1_temperature") {
		return "GPU1 Temp";
	}
	if (metricKey === "gpu2_temperature") {
		return "GPU2 Temp";
	}
	if (metricKey === "cpu_temperature") {
		return "CPU Temp";
	}
	if (metricKey === NETWORK_DOWNLOAD_KEY) {
		return "Download";
	}
	if (metricKey === NETWORK_UPLOAD_KEY) {
		return "Upload";
	}
	return metricKey;
}

function usesOnlyNetworkMetrics(settings: NormalizedDisplaySettings): boolean {
	if (!isNetworkMetricKey(settings.metricKey)) {
		return false;
	}
	return settings.displayMode !== "dual" || isNetworkMetricKey(settings.secondaryMetricKey);
}

function inferUnit(metricKey: string): string {
	if (isNetworkMetricKey(metricKey)) {
		return " Mbps";
	}
	if (metricKey.includes("temperature")) {
		return "C";
	}
	if (metricKey.includes("usage") || metricKey.includes("percent")) {
		return "%";
	}
	if (metricKey.includes("clock")) {
		return " MHz";
	}
	if (metricKey.includes("power") && !metricKey.includes("percent")) {
		return " W";
	}
	if (metricKey.includes("fan_tachometer")) {
		return " RPM";
	}
	if (metricKey.includes("memory_usage") || metricKey === "commit_charge") {
		return " MB";
	}
	if (metricKey.includes("frametime")) {
		return " ms";
	}
	if (metricKey.includes("framerate")) {
		return " FPS";
	}
	return "";
}

function formatMetricValue(value: number, decimals: number): string {
	const safeValue = sanitizeMetricNumber(value);
	if (Math.abs(safeValue) >= 1000) {
		const formatted = safeValue.toFixed(0);
		return isReasonableFormattedValue(formatted) ? formatted : "0";
	}
	const formatted = safeValue.toFixed(decimals);
	return isReasonableFormattedValue(formatted) ? formatted : "0";
}

type MetricLine = {
	label: string;
	valueText: string;
	unit: string;
	accent: string;
};

function metricLineFromPayload(
	metrics: Record<string, number | string | boolean | null>,
	metricKey: string,
	label: string,
	decimals: number,
	customAccentColor?: string,
): MetricLine {
	const rawValue = metrics[metricKey];
	if (rawValue === undefined || rawValue === null) {
		return { label, valueText: "N/A", unit: "", accent: "#f2c94c" };
	}
	if (typeof rawValue === "number") {
		const valueText = formatMetricValue(rawValue, decimals);
		const unit = inferUnit(metricKey).trim();
		return {
			label,
			valueText,
			unit,
			accent: customAccentColor || accentColor(metricKey),
		};
	}
	return {
		label,
		valueText: String(rawValue),
		unit: "",
		accent: customAccentColor || accentColor(metricKey),
	};
}

function renderDualMetricCard(
	settings: NormalizedDisplaySettings,
	primary: MetricLine,
	secondary: MetricLine,
	primaryHistory: number[],
	secondaryHistory: number[],
	primaryValue: number | undefined,
	secondaryValue: number | undefined,
	primaryMetricKey: string,
	secondaryMetricKey: string,
): string {
	if (settings.dualViewStyle === "multi-line") {
		return renderDualLineCard(settings, primary, secondary, primaryHistory, secondaryHistory, primaryValue, secondaryValue);
	}
	if (settings.dualViewStyle === "multi-dot") {
		return renderDualDotCard(settings, primary, secondary, primaryHistory, secondaryHistory, primaryValue, secondaryValue, primaryMetricKey, secondaryMetricKey);
	}
	return renderDualSplitCard(settings, primary, secondary);
}

function renderDualSplitCard(settings: NormalizedDisplaySettings, primary: MetricLine, secondary: MetricLine): string {
	const palette = themeFor(settings);
	const safeFont = escapeXml(palette.fontFamily);
	const layout = dualValueLayout(settings);
	const valueOpacity = clampNumber(settings.dualValueOpacity, 0.2, 1, 0.9).toFixed(2);
	const primaryLabelX = clampNumber(settings.dualPrimaryLabelX, 8, 128, layout.primaryX);
	const primaryLabelY = clampNumber(settings.dualPrimaryLabelY, 12, 132, layout.primaryLabelY);
	const secondaryLabelX = clampNumber(settings.dualSecondaryLabelX, 8, 128, layout.secondaryX);
	const secondaryLabelY = clampNumber(settings.dualSecondaryLabelY, 12, 132, layout.secondaryLabelY);
	const primaryLabel = escapeXml(primary.label);
	const primaryValue = escapeXml(dualInlineValue(settings.suffixMode, primary));
	const secondaryLabel = escapeXml(secondary.label);
	const secondaryValue = escapeXml(dualInlineValue(settings.suffixMode, secondary));
	const primaryAccent = escapeXml(primary.accent);
	const secondaryAccent = escapeXml(secondary.accent);
	const primarySuffixBelow = escapeXml(dualSuffixBelow(settings.suffixMode, primary));
	const secondarySuffixBelow = escapeXml(dualSuffixBelow(settings.suffixMode, secondary));
	const suffixSize = Math.max(11, Math.round(settings.valueSize * 0.4));
	const primaryLabelColor = escapeXml(resolveDualLabelColor(settings, "primary", palette.labelColor));
	const secondaryLabelColor = escapeXml(resolveDualLabelColor(settings, "secondary", palette.labelColor));
	const labelPrimaryEl = (!settings.hideLabel && primaryLabel)
		? `<text x="${primaryLabelX}" y="${primaryLabelY}" text-anchor="middle" fill="${primaryLabelColor}" font-family="${safeFont}" font-size="${Math.max(10, settings.labelSize - 1)}" font-weight="600">${primaryLabel}</text>`
		: "";
	const labelSecondaryEl = (!settings.hideLabel && secondaryLabel)
		? `<text x="${secondaryLabelX}" y="${secondaryLabelY}" text-anchor="middle" fill="${secondaryLabelColor}" font-family="${safeFont}" font-size="${Math.max(10, settings.labelSize - 1)}" font-weight="600">${secondaryLabel}</text>`
		: "";
	const primaryValueEl = renderTextWithOutline(
		layout.primaryX,
		layout.primaryY,
		"middle",
		primaryAccent,
		safeFont,
		settings.valueSize,
		"700",
		primaryValue,
		settings.valueStrokeColor,
		settings.valueStrokeWidth,
		` fill-opacity="${valueOpacity}"`,
	);
	const secondaryValueEl = renderTextWithOutline(
		layout.secondaryX,
		layout.secondaryY,
		"middle",
		secondaryAccent,
		safeFont,
		settings.valueSize,
		"700",
		secondaryValue,
		settings.valueStrokeColor,
		settings.valueStrokeWidth,
		` fill-opacity="${valueOpacity}"`,
	);
	const primarySuffixEl = primarySuffixBelow
		? renderTextWithOutline(layout.primaryX, Math.min(136, layout.primaryY + suffixSize), "middle", primaryAccent, safeFont, suffixSize, "600", primarySuffixBelow, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`)
		: "";
	const secondarySuffixEl = secondarySuffixBelow
		? renderTextWithOutline(layout.secondaryX, Math.min(136, layout.secondaryY + suffixSize), "middle", secondaryAccent, safeFont, suffixSize, "600", secondarySuffixBelow, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`)
		: "";
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/><rect x="14" y="16" width="116" height="112" rx="12" fill="#0000001a"/>${labelPrimaryEl}${labelSecondaryEl}${primaryValueEl}${secondaryValueEl}${primarySuffixEl}${secondarySuffixEl}</svg>`);
}

function renderDualLineCard(
	settings: NormalizedDisplaySettings,
	primary: MetricLine,
	secondary: MetricLine,
	primaryHistory: number[],
	secondaryHistory: number[],
	primaryValue: number | undefined,
	secondaryValue: number | undefined,
): string {
	const palette = themeFor(settings);
	const safeFont = escapeXml(palette.fontFamily);
	const layout = dualValueLayout(settings);
	const valueOpacity = clampNumber(settings.dualValueOpacity, 0.2, 1, 0.9).toFixed(2);
	const primaryLabel = escapeXml(primary.label);
	const secondaryLabel = escapeXml(secondary.label);
	const primaryValueText = escapeXml(dualInlineValue(settings.suffixMode, primary));
	const secondaryValueText = escapeXml(dualInlineValue(settings.suffixMode, secondary));
	const primaryAccent = escapeXml(primary.accent);
	const secondaryAccent = escapeXml(secondary.accent);
	const primarySuffixBelow = escapeXml(dualSuffixBelow(settings.suffixMode, primary));
	const secondarySuffixBelow = escapeXml(dualSuffixBelow(settings.suffixMode, secondary));
	const suffixSize = Math.max(10, Math.round(settings.valueSize * 0.36));
	const chartLeft = 12;
	const chartTop = 12;
	const chartWidth = 120;
	const chartHeight = 54;
	const lineThickness = clampNumber(settings.lineThickness, 1, 8, 3);

	const safePrimaryHistory = sanitizeSeries(primaryHistory.length > 1 ? primaryHistory : primaryValue === undefined ? [] : [primaryValue, primaryValue]);
	const safeSecondaryHistory = sanitizeSeries(secondaryHistory.length > 1 ? secondaryHistory : secondaryValue === undefined ? [] : [secondaryValue, secondaryValue]);
	const valuePool = [...safePrimaryHistory, ...safeSecondaryHistory];
	const autoMin = valuePool.length > 0 ? Math.min(...valuePool) : 0;
	const autoMax = valuePool.length > 0 ? Math.max(...valuePool) : 100;
	const { min, max } = resolveScaleRange(settings, autoMin, autoMax);
	const primaryPath = buildLinePath(safePrimaryHistory, min, max, chartLeft, chartTop, chartWidth, chartHeight, settings.graphBaselineOffset);
	const secondaryPath = buildLinePath(safeSecondaryHistory, min, max, chartLeft, chartTop, chartWidth, chartHeight, settings.graphBaselineOffset);
	const bottomLabelY = 130;
	const labelLeftX = 14;
	const labelRightX = 130;
	const primaryLabelColor = escapeXml(resolveDualLabelColor(settings, "primary", primary.accent));
	const secondaryLabelColor = escapeXml(resolveDualLabelColor(settings, "secondary", secondary.accent));
	const labelPrimaryEl = (!settings.hideLabel && primaryLabel)
		? `<text x="${labelLeftX}" y="${bottomLabelY}" text-anchor="start" fill="${primaryLabelColor}" font-family="${safeFont}" font-size="${Math.max(10, settings.labelSize - 1)}" font-weight="600">${primaryLabel}</text>`
		: "";
	const labelSecondaryEl = (!settings.hideLabel && secondaryLabel)
		? `<text x="${labelRightX}" y="${bottomLabelY}" text-anchor="end" fill="${secondaryLabelColor}" font-family="${safeFont}" font-size="${Math.max(10, settings.labelSize - 1)}" font-weight="600">${secondaryLabel}</text>`
		: "";
	const primaryValueEl = renderTextWithOutline(layout.primaryX, layout.primaryY, "middle", primaryAccent, safeFont, settings.valueSize, "700", primaryValueText, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`);
	const secondaryValueEl = renderTextWithOutline(layout.secondaryX, layout.secondaryY, "middle", secondaryAccent, safeFont, settings.valueSize, "700", secondaryValueText, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`);
	const primarySuffixEl = primarySuffixBelow
		? renderTextWithOutline(layout.primaryX, Math.min(136, layout.primaryY + suffixSize), "middle", primaryAccent, safeFont, suffixSize, "600", primarySuffixBelow, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`)
		: "";
	const secondarySuffixEl = secondarySuffixBelow
		? renderTextWithOutline(layout.secondaryX, Math.min(136, layout.secondaryY + suffixSize), "middle", secondaryAccent, safeFont, suffixSize, "600", secondarySuffixBelow, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`)
		: "";

	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/><rect x="12" y="12" width="120" height="54" rx="8" fill="#00000020"/>${primaryPath ? `<path d="${primaryPath}" fill="none" stroke="${primaryAccent}" stroke-width="${lineThickness}" stroke-linecap="round" stroke-linejoin="round"/>` : ""}${secondaryPath ? `<path d="${secondaryPath}" fill="none" stroke="${secondaryAccent}" stroke-width="${lineThickness}" stroke-linecap="round" stroke-linejoin="round"/>` : ""}${labelPrimaryEl}${labelSecondaryEl}${primaryValueEl}${secondaryValueEl}${primarySuffixEl}${secondarySuffixEl}</svg>`);
}

function renderDualDotCard(
	settings: NormalizedDisplaySettings,
	primary: MetricLine,
	secondary: MetricLine,
	primaryHistory: number[],
	secondaryHistory: number[],
	primaryValue: number | undefined,
	secondaryValue: number | undefined,
	primaryMetricKey: string,
	secondaryMetricKey: string,
): string {
	const palette = themeFor(settings);
	const safeFont = escapeXml(palette.fontFamily);
	const valueOpacity = clampNumber(settings.dualValueOpacity, 0.2, 1, 0.9).toFixed(2);
	const primaryLabel = escapeXml(primary.label);
	const secondaryLabel = escapeXml(secondary.label);
	const primaryValueText = escapeXml(dualInlineValue(settings.suffixMode, primary));
	const secondaryValueText = escapeXml(dualInlineValue(settings.suffixMode, secondary));
	const primaryAccent = escapeXml(primary.accent);
	const secondaryAccent = escapeXml(secondary.accent);
	const primarySuffixBelow = escapeXml(dualSuffixBelow(settings.suffixMode, primary));
	const secondarySuffixBelow = escapeXml(dualSuffixBelow(settings.suffixMode, secondary));
	const suffixSize = Math.max(10, Math.round(settings.valueSize * 0.34));
	const primaryProgress = computeDualProgress(settings, primaryMetricKey, primaryHistory, primaryValue);
	const secondaryProgress = computeDualProgress(settings, secondaryMetricKey, secondaryHistory, secondaryValue);
	const matrixTop = 12;
	const matrixHeight = 124;
	const matrixWidth = 64;
	const leftMatrixX = 8;
	const rightMatrixX = leftMatrixX + matrixWidth;
	const dotRadius = 2.5;
	const dotStep = dotRadius * 2;
	const cols = 12;
	const rows = 24;
	const leftGrid = renderDualDotGrid(leftMatrixX + 4.5, matrixTop + 4.5, cols, rows, dotStep, dotStep, primaryProgress, primaryAccent, palette.trackColor);
	const rightGrid = renderDualDotGrid(rightMatrixX + 4.5, matrixTop + 4.5, cols, rows, dotStep, dotStep, secondaryProgress, secondaryAccent, palette.trackColor);
	const leftCenterX = leftMatrixX + matrixWidth / 2;
	const rightCenterX = rightMatrixX + matrixWidth / 2;
	const centerY = matrixTop + matrixHeight / 2 + Math.round(settings.valueSize * 0.15);
	const labelY = matrixTop + Math.max(10, settings.labelSize);
	const primaryLabelColor = escapeXml(resolveDualLabelColor(settings, "primary", palette.labelColor));
	const secondaryLabelColor = escapeXml(resolveDualLabelColor(settings, "secondary", palette.labelColor));
	const labelPrimaryEl = (!settings.hideLabel && primaryLabel)
		? `<text x="${leftCenterX}" y="${labelY}" text-anchor="middle" fill="${primaryLabelColor}" font-family="${safeFont}" font-size="${Math.max(10, settings.labelSize - 1)}" font-weight="600">${primaryLabel}</text>`
		: "";
	const labelSecondaryEl = (!settings.hideLabel && secondaryLabel)
		? `<text x="${rightCenterX}" y="${labelY}" text-anchor="middle" fill="${secondaryLabelColor}" font-family="${safeFont}" font-size="${Math.max(10, settings.labelSize - 1)}" font-weight="600">${secondaryLabel}</text>`
		: "";
	const valueSize = Math.min(settings.valueSize, 36);
	const primaryValueEl = renderTextWithOutline(leftCenterX, centerY, "middle", primaryAccent, safeFont, valueSize, "700", primaryValueText, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`);
	const secondaryValueEl = renderTextWithOutline(rightCenterX, centerY, "middle", secondaryAccent, safeFont, valueSize, "700", secondaryValueText, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`);
	const primarySuffixEl = primarySuffixBelow
		? renderTextWithOutline(leftCenterX, Math.min(136, centerY + suffixSize), "middle", primaryAccent, safeFont, suffixSize, "600", primarySuffixBelow, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`)
		: "";
	const secondarySuffixEl = secondarySuffixBelow
		? renderTextWithOutline(rightCenterX, Math.min(136, centerY + suffixSize), "middle", secondaryAccent, safeFont, suffixSize, "600", secondarySuffixBelow, settings.valueStrokeColor, settings.valueStrokeWidth, ` fill-opacity="${valueOpacity}"`)
		: "";

	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/><line x1="72" y1="10" x2="72" y2="134" stroke="${palette.borderColor}" stroke-opacity="0.65"/>${leftGrid}${rightGrid}${labelPrimaryEl}${labelSecondaryEl}${primaryValueEl}${secondaryValueEl}${primarySuffixEl}${secondarySuffixEl}</svg>`);
}

function dualInlineValue(mode: SuffixMode, metric: MetricLine): string {
	if (mode === "off" || !metric.unit) {
		return metric.valueText;
	}
	if (mode === "inline") {
		return `${metric.valueText} ${metric.unit}`;
	}
	return metric.valueText;
}

function dualSuffixBelow(mode: SuffixMode, metric: MetricLine): string {
	if (mode !== "below" || !metric.unit) {
		return "";
	}
	return metric.unit;
}

function dualValueLayout(settings: NormalizedDisplaySettings): { primaryX: number; secondaryX: number; primaryY: number; secondaryY: number; primaryLabelY: number; secondaryLabelY: number } {
	const x = settings.valueX;
	if (settings.dualValueLayout === "left-right") {
		const horizontalGap = Math.max(22, Math.round(settings.valueSize * 1.3));
		const primaryX = clampNumber(x - horizontalGap / 2, 18, 126, x - horizontalGap / 2);
		const secondaryX = clampNumber(x + horizontalGap / 2, 18, 126, x + horizontalGap / 2);
		const y = clampNumber(settings.valueY, 30, 128, settings.valueY);
		const labelY = clampNumber(y - Math.max(14, Math.round(settings.valueSize * 0.7)), 12, 118, y - 20);
		return { primaryX, secondaryX, primaryY: y, secondaryY: y, primaryLabelY: labelY, secondaryLabelY: labelY };
	}
	const gap = Math.max(18, Math.round(settings.valueSize * 0.95));
	const primaryY = clampNumber(settings.valueY - gap / 2, 24, 120, settings.valueY - gap / 2);
	const secondaryY = clampNumber(settings.valueY + gap / 2, 36, 136, settings.valueY + gap / 2);
	const labelOffset = Math.max(14, Math.round(settings.valueSize * 0.7));
	const primaryLabelY = clampNumber(primaryY - labelOffset, 12, 118, primaryY - labelOffset);
	const secondaryLabelY = clampNumber(secondaryY - labelOffset, 16, 132, secondaryY - labelOffset);
	return { primaryX: x, secondaryX: x, primaryY, secondaryY, primaryLabelY, secondaryLabelY };
}

function sanitizeSeries(values: number[]): number[] {
	if (values.length === 0) {
		return values;
	}
	return values.map((value) => sanitizeMetricNumber(value));
}

function sanitizeMetricNumber(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	if (Math.abs(value) >= MAX_REASONABLE_METRIC_ABS) {
		return 0;
	}
	return value;
}

function buildLinePath(values: number[], min: number, max: number, left: number, top: number, width: number, height: number, baselineOffset = 0): string {
	if (values.length < 2) {
		return "";
	}
	const safeValues = sanitizeSeries(values);
	const span = Math.max(1, max - min);
	const clampedBaselineOffset = Math.max(0, Math.min(height - 2, baselineOffset));
	const chartBottom = top + height;
	return safeValues.map((point, index) => {
		const x = left + (index / Math.max(1, values.length - 1)) * width;
		const normalized = Math.max(0, Math.min(1, (point - min) / span));
		const y = Math.max(top, chartBottom - normalized * height - clampedBaselineOffset);
		return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
	}).join(" ");
}

function computeDualProgress(settings: NormalizedDisplaySettings, metricKey: string, history: number[], value: number | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const inferredRange = inferGaugeRange(metricKey, history, value);
	const { min, max } = resolveScaleRange(settings, inferredRange.min, inferredRange.max);
	return Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));
}

function renderDualDotGrid(
	startX: number,
	startY: number,
	cols: number,
	rows: number,
	xStep: number,
	yStep: number,
	progress: number | undefined,
	accent: string,
	track: string,
): string {
	const total = cols * rows;
	const fillCount = progress === undefined ? 0 : Math.round(progress * total);
	return Array.from({ length: total }, (_, index) => {
		const col = index % cols;
		const rowFromBottom = Math.floor(index / cols);
		const row = rows - 1 - rowFromBottom;
		const x = startX + col * xStep;
		const y = startY + row * yStep;
		const filled = index < fillCount;
		const fill = filled ? accent : track;
		const opacity = filled ? 0.95 : 0.4;
		return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.5" fill="${fill}" fill-opacity="${opacity}"/>`;
	}).join("");
}

function isReasonableFormattedValue(valueText: string): boolean {
	if (!valueText) {
		return false;
	}
	// Exponential notation or non-numeric output should not be rendered on the key.
	if (/[eE]/.test(valueText)) {
		return false;
	}
	const parsed = Number(valueText);
	return Number.isFinite(parsed);
}

function renderMetricCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[]): string {
	if (settings.viewStyle === "line" || settings.viewStyle === "line-filled") {
		return renderLineChartCard(settings, metricKey, label, value, history, settings.viewStyle === "line-filled");
	}
	if (settings.viewStyle === "gauge") {
		return renderGaugeCard(settings, metricKey, label, value, history);
	}
	if (settings.viewStyle === "dot-matrix") {
		return renderDotMatrixCard(settings, metricKey, label, value, history);
	}
	return renderValueCard(settings, metricKey, label, value);
}

function renderValueCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number): string {
	const unit = inferUnit(metricKey).trim();
	const valueText = formatMetricValue(value, settings.decimals);
	const accent = themeAccentColor(settings, metricKey);
	const palette = themeFor(settings);
	const safeLabel = escapeXml(label);
	const safeValue = escapeXml(valueText);
	const safeUnit = escapeXml(unit);
	const safeFont = escapeXml(palette.fontFamily);
	const unitY = Math.min(136, settings.valueY + 22);
	const labelEl = (!settings.hideLabel && safeLabel)
		? renderTextWithOutline(
			settings.labelX,
			settings.labelY,
			"middle",
			palette.labelColor,
			safeFont,
			settings.labelSize,
			"600",
			safeLabel,
			settings.labelStrokeColor,
			settings.labelStrokeWidth,
		)
		: "";
	const neonGlow = settings.theme === "neon" ? `<filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : "";
	const glowAttr = settings.theme === "neon" ? ` filter="url(#glow)"` : "";
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 16, glowAttr);
	const valueEl = renderTextWithOutline(
		settings.valueX,
		settings.valueY,
		"middle",
		palette.valueColor,
		safeFont,
		settings.valueSize,
		"700",
		valueTextWithSuffix,
		settings.valueStrokeColor,
		settings.valueStrokeWidth,
		glowAttr,
	);
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}${neonGlow}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/>${labelEl}${valueEl}${belowSuffixEl}</svg>`);
}

function renderLineChartCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[], filled: boolean): string {
	const accent = themeAccentColor(settings, metricKey);
	const palette = themeFor(settings);
	const unit = inferUnit(metricKey).trim();
	const safeLabel = escapeXml(label);
	const safeValue = escapeXml(formatMetricValue(value, settings.decimals));
	const safeUnit = escapeXml(unit);
	const safeFont = escapeXml(palette.fontFamily);
	const unitY = Math.min(136, settings.valueY + 22);
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 14);
	const lineLabelEl = (!settings.hideLabel && safeLabel)
		? renderTextWithOutline(
			settings.labelX,
			settings.labelY,
			"middle",
			palette.labelColor,
			safeFont,
			settings.labelSize,
			"600",
			safeLabel,
			settings.labelStrokeColor,
			settings.labelStrokeWidth,
		)
		: "";
	const chartLeft = 12;
	const chartTop = 16;
	const chartWidth = 120;
	const chartHeight = 112;
	const lineThickness = clampNumber(settings.lineThickness, 1, 8, 3);
	const baselineOffset = clampNumber(settings.graphBaselineOffset, 0, 40, 0);
	const lineFillStrength = clampNumber(settings.lineFillStrength, 0.1, 1, 0.65);
	const values = sanitizeSeries(history.length > 1 ? history : [value, value]);
	const autoMin = Math.min(...values);
	const autoMax = Math.max(...values);
	const { min, max } = resolveScaleRange(settings, autoMin, autoMax);
	const span = Math.max(1, max - min);
	const clampedBaselineOffset = Math.max(0, Math.min(chartHeight - 2, baselineOffset));
	const chartBottom = chartTop + chartHeight;
	const points = values.map((point, index) => {
		const x = chartLeft + (index / Math.max(1, values.length - 1)) * chartWidth;
		const normalized = Math.max(0, Math.min(1, (point - min) / span));
		const y = Math.max(chartTop, chartBottom - normalized * chartHeight - clampedBaselineOffset);
		return { x, y };
	});
	const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
	const areaPath = `M${points[0].x.toFixed(2)},${chartBottom.toFixed(2)} ${linePath.replaceAll("M", "L")} L${points[points.length - 1].x.toFixed(2)},${chartBottom.toFixed(2)} Z`;
	const fillBottomOpacity = Math.max(0, Math.min(1, lineFillStrength * 0.1));
	const valueEl = renderTextWithOutline(
		settings.valueX,
		settings.valueY,
		"middle",
		palette.valueColor,
		safeFont,
		settings.valueSize,
		"700",
		valueTextWithSuffix,
		settings.valueStrokeColor,
		settings.valueStrokeWidth,
	);
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${accent}" stop-opacity="${lineFillStrength.toFixed(2)}"/><stop offset="100%" stop-color="${accent}" stop-opacity="${fillBottomOpacity.toFixed(2)}"/></linearGradient></defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/>${filled ? `<path d="${areaPath}" fill="url(#fill)"/>` : ""}<path d="${linePath}" fill="none" stroke="${accent}" stroke-width="${lineThickness}" stroke-linecap="round" stroke-linejoin="round"/>${lineLabelEl}${valueEl}${belowSuffixEl}</svg>`);
}

function resolveDualLabelColor(settings: NormalizedDisplaySettings, slot: "primary" | "secondary", fallback: string): string {
	const explicit = slot === "primary" ? settings.primaryLabelColor : settings.secondaryLabelColor;
	if (explicit) {
		return explicit;
	}
	return fallback;
}

function renderGaugeCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[]): string {
	const palette = themeFor(settings);
	const safeFont = escapeXml(palette.fontFamily);
	const safeLabel = escapeXml(label);
	const unit = inferUnit(metricKey).trim();
	const accent = themeAccentColor(settings, metricKey);
	const gaugeRange = inferGaugeRange(metricKey, history, value);
	const { min, max } = resolveScaleRange(settings, gaugeRange.min, gaugeRange.max);
	const progress = Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));
	// Draw a near-full ring and keep a deliberate gap centered at the bottom.
	const startAngle = 210;
	const endAngle = 510;
	const progressAngle = startAngle + (endAngle - startAngle) * progress;
	const center = 72;
	const radius = 60;
	const trackPath = describeArc(center, center, radius, startAngle, endAngle);
	const valuePath = describeArc(center, center, radius, startAngle, progressAngle);
	const safeUnit = escapeXml(unit);
	const safeValue = escapeXml(formatMetricValue(value, settings.decimals));
	const unitY = Math.min(136, settings.valueY + 20);
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 14);
	const gaugeLabelEl = (!settings.hideLabel && safeLabel)
		? renderTextWithOutline(
			settings.labelX,
			settings.labelY,
			"middle",
			palette.labelColor,
			safeFont,
			settings.labelSize,
			"600",
			safeLabel,
			settings.labelStrokeColor,
			settings.labelStrokeWidth,
		)
		: "";
	const valueEl = renderTextWithOutline(
		settings.valueX,
		settings.valueY,
		"middle",
		palette.valueColor,
		safeFont,
		settings.valueSize,
		"700",
		valueTextWithSuffix,
		settings.valueStrokeColor,
		settings.valueStrokeWidth,
	);
	const trackWidth = 16;
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/><path d="${trackPath}" fill="none" stroke="${palette.trackColor}" stroke-width="${trackWidth}" stroke-linecap="round"/><path d="${valuePath}" fill="none" stroke="${accent}" stroke-width="${trackWidth}" stroke-linecap="round"/>${gaugeLabelEl}${valueEl}${belowSuffixEl}</svg>`);
}

function renderDotMatrixCard(settings: NormalizedDisplaySettings, metricKey: string, label: string, value: number, history: number[]): string {
	const palette = themeFor(settings);
	const safeFont = escapeXml(palette.fontFamily);
	const safeLabel = escapeXml(label);
	const safeUnit = escapeXml(inferUnit(metricKey).trim());
	const safeValue = escapeXml(formatMetricValue(value, settings.decimals));
	const accent = themeAccentColor(settings, metricKey);
	const range = inferGaugeRange(metricKey, history, value);
	const { min, max } = resolveScaleRange(settings, range.min, range.max);
	const progress = Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));

	const gridLeft = 12;
	const gridTop = 12;
	const gridRight = 132;
	const gridBottom = 132;
	const cols = 12;
	const rows = 10;
	const totalDots = cols * rows;
	const filledDots = Math.round(progress * totalDots);
	const xStep = (gridRight - gridLeft) / Math.max(1, cols - 1);
	const yStep = (gridBottom - gridTop) / Math.max(1, rows - 1);
	const dotRadius = 3.8;

	const dotElements = Array.from({ length: totalDots }, (_, index) => {
		const col = index % cols;
		const rowFromBottom = Math.floor(index / cols);
		const row = rows - 1 - rowFromBottom;
		const x = gridLeft + col * xStep;
		const y = gridTop + row * yStep;
		const isFilled = index < filledDots;
		const fill = isFilled ? accent : palette.trackColor;
		const opacity = isFilled ? 0.95 : 0.4;
		return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${dotRadius}" fill="${fill}" fill-opacity="${opacity}"/>`;
	}).join("");

	const labelEl = (!settings.hideLabel && safeLabel)
		? renderTextWithOutline(
			settings.labelX,
			settings.labelY,
			"middle",
			palette.labelColor,
			safeFont,
			settings.labelSize,
			"600",
			safeLabel,
			settings.labelStrokeColor,
			settings.labelStrokeWidth,
		)
		: "";
	const valueTextWithSuffix = suffixTextWithMode(settings.suffixMode, safeValue, safeUnit, accent, settings.valueSize);
	const valueEl = renderTextWithOutline(
		settings.valueX,
		settings.valueY,
		"middle",
		palette.valueColor,
		safeFont,
		settings.valueSize,
		"700",
		valueTextWithSuffix,
		settings.valueStrokeColor,
		settings.valueStrokeWidth,
	);
	const unitY = Math.min(136, settings.valueY + 20);
	const belowSuffixEl = suffixBelowElement(settings.suffixMode, safeUnit, settings.valueX, unitY, accent, safeFont, 14);

	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs>${backgroundGradientDef(settings, palette)}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="${palette.borderColor}"/>${dotElements}${labelEl}${valueEl}${belowSuffixEl}</svg>`);
}

function backgroundGradientDef(settings: NormalizedDisplaySettings, palette: ThemePalette): string {
	const bottomColor = gradientBottomColor(settings, palette);
	return `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${palette.bg0}"/><stop offset="100%" stop-color="${bottomColor}"/></linearGradient>`;
}

function gradientBottomColor(settings: NormalizedDisplaySettings, palette: ThemePalette): string {
	const level = clampNumber(settings.gradientLevel, 0, 1, 1);
	if (level <= 0) {
		return palette.bg0;
	}
	if (level >= 1) {
		return palette.bg1;
	}
	return blendHexColors(palette.bg0, palette.bg1, level);
}

function blendHexColors(start: string, end: string, ratio: number): string {
	const startRgb = parseHexRgb(start);
	const endRgb = parseHexRgb(end);
	if (!startRgb || !endRgb) {
		return end;
	}
	const mix = (left: number, right: number): number => Math.round(left + (right - left) * ratio);
	return `#${toHex2(mix(startRgb.r, endRgb.r))}${toHex2(mix(startRgb.g, endRgb.g))}${toHex2(mix(startRgb.b, endRgb.b))}`;
}

function parseHexRgb(color: string): { r: number; g: number; b: number } | undefined {
	const normalized = color.trim().toLowerCase();
	const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(normalized);
	if (!match) {
		return undefined;
	}
	const hex = match[1];
	return {
		r: Number.parseInt(hex.slice(0, 2), 16),
		g: Number.parseInt(hex.slice(2, 4), 16),
		b: Number.parseInt(hex.slice(4, 6), 16),
	};
}

function toHex2(value: number): string {
	return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function suffixTextWithMode(mode: SuffixMode, safeValue: string, safeUnit: string, accent: string, valueSize: number): string {
	if (mode === "off" || !safeUnit) {
		return safeValue;
	}
	if (mode === "inline") {
		const suffixSize = Math.max(12, Math.round(valueSize * 0.45));
		return `<tspan>${safeValue}</tspan><tspan fill="${escapeXml(accent)}" font-size="${suffixSize}"> ${safeUnit}</tspan>`;
	}
	return safeValue;
}

function suffixBelowElement(mode: SuffixMode, safeUnit: string, x: number, y: number, accent: string, fontFamily: string, fontSize: number, extraAttrs = ""): string {
	if (mode !== "below" || !safeUnit) {
		return "";
	}
	return `<text x="${x}" y="${y}" text-anchor="middle" fill="${accent}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="600"${extraAttrs}>${safeUnit}</text>`;
}

function renderTextWithOutline(
	x: number,
	y: number,
	anchor: "start" | "middle" | "end",
	fillColor: string,
	fontFamily: string,
	fontSize: number,
	fontWeight: string,
	content: string,
	strokeColor: string,
	strokeWidth: number,
	extraAttrs = "",
): string {
	const baseAttrs = `x="${x}" y="${y}" text-anchor="${anchor}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}"`;
	if (strokeWidth <= 0) {
		return `<text ${baseAttrs} fill="${fillColor}"${extraAttrs}>${content}</text>`;
	}
	const safeStroke = escapeXml(strokeColor);
	const outlineWidth = (strokeWidth * 2).toFixed(2);
	const outlineEl = `<text ${baseAttrs} fill="none" stroke="${safeStroke}" stroke-width="${outlineWidth}" stroke-linejoin="round">${content}</text>`;
	const fillEl = `<text ${baseAttrs} fill="${fillColor}"${extraAttrs}>${content}</text>`;
	return `${outlineEl}${fillEl}`;
}

function resolveScaleRange(settings: NormalizedDisplaySettings, autoMin: number, autoMax: number): { min: number; max: number } {
	if (settings.useCustomScale) {
		const customMin = settings.scaleMin;
		const customMax = settings.scaleMax;
		if (customMax <= customMin) {
			return { min: customMin, max: customMin + 1 };
		}
		return { min: customMin, max: customMax };
	}
	if (!Number.isFinite(autoMin) || !Number.isFinite(autoMax)) {
		return { min: 0, max: 1 };
	}
	if (autoMax <= autoMin) {
		return { min: autoMin, max: autoMin + 1 };
	}
	return { min: autoMin, max: autoMax };
}

function svgToDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderStatusCard(label: string, message: string, accent: string, detail?: string): string {
	const safeLabel = escapeXml(label);
	const safeMessage = escapeXml(message);
	const safeDetail = escapeXml((detail ?? "").slice(0, 36));
	return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#111827"/><stop offset="100%" stop-color="#0b1220"/></linearGradient></defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/><rect x="8" y="8" width="128" height="128" rx="${CARD_RADIUS - 4}" fill="none" stroke="#ffffff16"/><text x="72" y="34" text-anchor="middle" fill="#cbd5e1" font-family="Segoe UI" font-size="13" font-weight="600">${safeLabel}</text><text x="72" y="80" text-anchor="middle" fill="${accent}" font-family="Segoe UI" font-size="28" font-weight="700">${safeMessage}</text><text x="72" y="104" text-anchor="middle" fill="#94a3b8" font-family="Segoe UI" font-size="11">${safeDetail}</text></svg>`);
}

function accentColor(metricKey: string): string {
	if (metricKey.includes("temperature")) return "#f59e0b";
	if (metricKey.includes("power")) return "#22c55e";
	if (metricKey.includes("clock")) return "#a78bfa";
	if (metricKey.includes("fan")) return "#38bdf8";
	if (isNetworkMetricKey(metricKey)) return "#34d399";
	return "#22d3ee";
}

function inferGaugeRange(metricKey: string, history: number[], value: number): { min: number; max: number } {
	if (metricKey.includes("usage") || metricKey.includes("percent")) return { min: 0, max: 100 };
	if (metricKey.includes("temperature")) return { min: 0, max: 120 };
	if (metricKey.includes("fan_tachometer")) return { min: 0, max: 3000 };
	if (metricKey.includes("framerate")) return { min: 0, max: 240 };
	if (metricKey.includes("clock")) return { min: 0, max: 8000 };
	if (metricKey.includes("power")) return { min: 0, max: 500 };
	const observedMin = Math.min(...history, value);
	const observedMax = Math.max(...history, value);
	if (observedMax <= observedMin) {
		return { min: observedMin, max: observedMin + 1 };
	}
	return { min: observedMin, max: Math.max(observedMax, observedMax * 1.2) };
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleDegrees: number): { x: number; y: number } {
	const angleRadians = ((angleDegrees - 90) * Math.PI) / 180;
	return { x: centerX + radius * Math.cos(angleRadians), y: centerY + radius * Math.sin(angleRadians) };
}

function describeArc(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number): string {
	const start = polarToCartesian(centerX, centerY, radius, startAngle);
	const end = polarToCartesian(centerX, centerY, radius, endAngle);
	const angleSpan = ((endAngle - startAngle) % 360 + 360) % 360;
	const largeArcFlag = angleSpan > 180 ? "1" : "0";
	return ["M", start.x, start.y, "A", radius, radius, 0, largeArcFlag, 1, end.x, end.y].join(" ");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function isRequestMetricsPayload(payload: unknown): payload is RequestMetricsPayload {
	if (!payload || typeof payload !== "object") return false;
	const requestPayload = payload as Partial<RequestMetricsPayload>;
	return requestPayload.type === "request-metrics-list";
}

function normalizeEndpointUrl(endpointUrl: string | undefined): string {
	const rawValue = endpointUrl?.trim();
	if (!rawValue) return DEFAULT_SETTINGS.endpointUrl;
	if (/^https?:\/\//i.test(rawValue)) return rawValue;
	return `http://${rawValue}`;
}

function shouldAttemptSidecarBoot(endpointUrl: string): boolean {
	try {
		const parsed = new URL(endpointUrl);
		if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) return false;
		return parsed.port === "" || parsed.port === "9696";
	} catch {
		return false;
	}
}

async function resolveAfterburnerReaderPath(): Promise<string | null> {
	const pluginBinDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [path.join(pluginBinDir, SIDECAR_EXE_NAME), path.join(pluginBinDir, "..", SIDECAR_EXE_NAME)];
	for (const candidatePath of candidates) {
		try {
			await access(candidatePath);
			return candidatePath;
		} catch {
			continue;
		}
	}
	return null;
}

async function isAfterburnerReaderRunning(): Promise<boolean> {
	try {
		const taskListResponse = await fetch(normalizeEndpointUrl(DEFAULT_SETTINGS.endpointUrl), { headers: { accept: "application/json" } });
		return taskListResponse.ok;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
