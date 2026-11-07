export type RingMetric = {
	metricKey: string;
	valueText: string;
	accent: string;
	/** How full this metric's half of the ring is, from 0 to 1. */
	fraction: number;
};

export type RingCardStyle = {
	backgroundDefs: string;
	fontFamily: string;
};

const SIZE = 144;
const CENTER = SIZE / 2;
const RADIUS = 58;
const STROKE = 9;
const CARD_RADIUS = 18;
// Space left at the top and bottom, so the two halves read as separate meters.
const GAP_DEGREES = 10;
const HALF_SWEEP = 180 - GAP_DEGREES * 2;
const TRACK_OPACITY = 0.18;

const PRIMARY_ICON_Y = 34;
const PRIMARY_VALUE_BASELINE = 70;
const SECONDARY_VALUE_BASELINE = 100;
const SECONDARY_ICON_Y = 112;

/** Two half-ring meters filling upwards from the bottom, with values between an icon above and below. */
export function renderRingCardSvg(primary: RingMetric, secondary: RingMetric, style: RingCardStyle): string {
	const font = escapeXml(style.fontFamily);
	const leftStart = 180 + GAP_DEGREES;
	const rightStart = 180 - GAP_DEGREES;

	const meters = [
		arc(leftStart, HALF_SWEEP, primary.accent, TRACK_OPACITY),
		arc(rightStart, -HALF_SWEEP, secondary.accent, TRACK_OPACITY),
		arc(leftStart, HALF_SWEEP * clampFraction(primary.fraction), primary.accent, 1),
		arc(rightStart, -HALF_SWEEP * clampFraction(secondary.fraction), secondary.accent, 1),
	].join("");

	const readouts = [
		icon(primary, PRIMARY_ICON_Y, font),
		value(primary, PRIMARY_VALUE_BASELINE, font),
		value(secondary, SECONDARY_VALUE_BASELINE, font),
		icon(secondary, SECONDARY_ICON_Y, font),
	].join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><defs>${style.backgroundDefs}</defs><rect x="2" y="2" width="140" height="140" rx="${CARD_RADIUS}" fill="url(#bg)"/>${meters}${readouts}</svg>`;
}

function value(metric: RingMetric, baseline: number, font: string): string {
	return `<text x="${CENTER}" y="${baseline}" text-anchor="middle" fill="${escapeXml(metric.accent)}" font-family="${font}" font-size="${valueSize(metric.valueText)}" font-weight="700">${escapeXml(metric.valueText)}</text>`;
}

// Longer values shrink so they stay inside the ring.
function valueSize(valueText: string): number {
	if (valueText.length <= 4) {
		return 30;
	}
	return valueText.length === 5 ? 26 : 22;
}

function icon(metric: RingMetric, centerY: number, font: string): string {
	const color = escapeXml(metric.accent);
	const shape = iconShape(metric.metricKey, color, font);
	return `<g transform="translate(${CENTER} ${centerY})">${shape}</g>`;
}

function iconShape(metricKey: string, color: string, font: string): string {
	if (metricKey.includes("upload")) {
		return `<path d="M -13 7 L 0 -8 L 13 7 Z" fill="${color}"/>`;
	}
	if (metricKey.includes("download")) {
		return `<path d="M -13 -7 L 0 8 L 13 -7 Z" fill="${color}"/>`;
	}
	if (metricKey.includes("temperature")) {
		return `<rect x="-3" y="-11" width="6" height="15" rx="3" fill="${color}"/><circle cy="6" r="6" fill="${color}"/>`;
	}
	if (metricKey.includes("power")) {
		return `<path d="M 3 -11 L -8 2 L -1 2 L -3 11 L 8 -3 L 1 -3 Z" fill="${color}"/>`;
	}
	if (metricKey.includes("framerate")) {
		return `<text y="6" text-anchor="middle" fill="${color}" font-family="${font}" font-size="17" font-weight="700">FPS</text>`;
	}
	if (metricKey === "ram_usage" || metricKey === "memory_usage") {
		return `<rect x="-12" y="-7" width="24" height="4" rx="2" fill="${color}"/><rect x="-12" y="-1" width="24" height="4" rx="2" fill="${color}"/><rect x="-12" y="5" width="24" height="4" rx="2" fill="${color}"/>`;
	}
	if (metricKey.includes("usage")) {
		return `<rect x="-9" y="-9" width="18" height="18" rx="3" fill="none" stroke="${color}" stroke-width="3"/><rect x="-4" y="-4" width="8" height="8" rx="1" fill="${color}"/>`;
	}
	return `<circle r="6" fill="${color}"/>`;
}

function arc(startDegrees: number, sweepDegrees: number, color: string, opacity: number): string {
	if (sweepDegrees === 0) {
		return "";
	}
	const start = pointOnRing(startDegrees);
	const end = pointOnRing(startDegrees + sweepDegrees);
	const clockwise = sweepDegrees > 0 ? 1 : 0;
	return `<path d="M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 0 ${clockwise} ${end.x} ${end.y}" fill="none" stroke="${escapeXml(color)}" stroke-opacity="${opacity}" stroke-width="${STROKE}" stroke-linecap="round"/>`;
}

// Degrees run clockwise from the top of the ring.
function pointOnRing(degrees: number): { x: string; y: string } {
	const radians = (degrees * Math.PI) / 180;
	return {
		x: (CENTER + RADIUS * Math.sin(radians)).toFixed(2),
		y: (CENTER - RADIUS * Math.cos(radians)).toFixed(2),
	};
}

function clampFraction(fraction: number): number {
	return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
