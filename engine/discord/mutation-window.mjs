import { assertOnlyKeys } from "./sanitize.mjs";

const WINDOW_KEYS = new Set(["timezone", "days", "start", "end"]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_BY_NAME = new Map([["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7]]);

function timeMinutes(value, label) {
	if (typeof value !== "string" || !TIME_PATTERN.test(value)) throw new Error(`${label} must be HH:mm`);
	const [hour, minute] = value.split(":").map(Number);
	return hour * 60 + minute;
}

function validIanaTimezone(value) {
	if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\0\r\n]/.test(value)) throw new Error("mutationWindow.timezone must be a valid IANA timezone");
	// Intl also accepts fixed offsets such as "+09:00". They do not carry the
	// DST and historical rules that this policy is meant to bind, so reject
	// explicit offset spellings before asking Intl to validate the zone.
	if (/^[+-]\d{2}(?::?\d{2})?$/.test(value)) throw new Error("mutationWindow.timezone must be a named IANA timezone");
	try {
		const formatter = new Intl.DateTimeFormat("en-US", { timeZone: value });
		formatter.format(new Date(0));
	} catch {
		throw new Error("mutationWindow.timezone must be a valid IANA timezone");
	}
	return value;
}

export function normalizeMutationWindow(value) {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mutationWindow must be an object");
	assertOnlyKeys(value, WINDOW_KEYS, "mutationWindow");
	const timezone = validIanaTimezone(value.timezone);
	if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 7 || value.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error("mutationWindow.days must contain ISO weekdays 1-7");
	if (new Set(value.days).size !== value.days.length) throw new Error("mutationWindow.days must be unique");
	const startMinutes = timeMinutes(value.start, "mutationWindow.start");
	const endMinutes = timeMinutes(value.end, "mutationWindow.end");
	if (startMinutes >= endMinutes) throw new Error("mutationWindow start must be before end; overnight windows are not supported");
	return { timezone, days: [...value.days].sort((left, right) => left - right), start: value.start, end: value.end };
}

function localClock(timezone, nowMs) {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
	const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	const weekday = WEEKDAY_BY_NAME.get(values.weekday);
	if (!weekday) throw new Error("mutationWindow timezone did not produce a weekday");
	return { weekday, minutes: Number(values.hour) * 60 + Number(values.minute) };
}

export function mutationWindowStatus(value, nowMs = Date.now()) {
	const window = normalizeMutationWindow(value);
	if (window === undefined) return { configured: false, allowed: true, reasonCode: null, window: null };
	if (!Number.isFinite(nowMs)) throw new Error("mutation window time must be finite");
	const local = localClock(window.timezone, nowMs);
	const start = timeMinutes(window.start, "mutationWindow.start");
	const end = timeMinutes(window.end, "mutationWindow.end");
	const allowed = window.days.includes(local.weekday) && local.minutes >= start && local.minutes < end;
	return { configured: true, allowed, reasonCode: allowed ? null : "mutation_window_closed", window, local };
}

export function canonicalMutationWindow(value) {
	return normalizeMutationWindow(value) ?? null;
}
