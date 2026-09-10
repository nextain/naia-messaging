/**
 * Contact window and re-ask limits — transport-neutral.
 *
 * A malfunction alert and a request to a person are different things. A
 * malfunction must be raised whenever it happens; "please confirm" only makes
 * sense while the person is working. An hourly nudge through the night does not
 * bring the answer forward — it teaches people to mute the channel.
 *
 * So a nudge or routine reminder is gated by a contact window (project-local
 * business hours in the project's own timezone), while a malfunction, a
 * delivery failure, or a reply owed to someone already waiting is never gated.
 * A re-ask counter bounds how many times the same item may be nudged inside a
 * window; time spent outside the window is not counted, so the item simply
 * returns in the next window rather than exhausting its budget overnight.
 *
 * Genericised from naia-pj-adk ops/gateway/contact-window.sh. The window VALUES
 * (timezone, hours, days, responder alias) are instance configuration and are
 * not shipped here.
 */

const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Kinds of outreach that a contact window is allowed to defer. */
export const GATED_KINDS = new Set(["thread_nudge", "routine_reminder"]);
/** Kinds that must always go out, regardless of the hour. */
export const NEVER_GATED_KINDS = new Set(["malfunction", "delivery_failure", "owed_reply"]);

function normaliseDays(days) {
	if (!Array.isArray(days) || days.length === 0) throw new Error("contact window days are required");
	return days.map((day) => {
		if (typeof day === "number" && day >= 0 && day <= 6) return day;
		const name = String(day).slice(0, 3).toLowerCase();
		if (name in DAY_NAMES) return DAY_NAMES[name];
		throw new Error(`unrecognised contact window day: ${day}`);
	});
}

/**
 * Validate a contact-window config shape (not its values). Returns a
 * normalised window. Throws on a missing or malformed field, deliberately
 * rather than flowing to a silent default — a window that changes silently
 * leaves a person unable to explain why the channel rang at night.
 */
export function normaliseContactWindow(config) {
	if (!config || typeof config !== "object") throw new Error("contact window config is required");
	const { timezone, days, startHour, endHour } = config;
	if (typeof timezone !== "string" || timezone.length === 0) throw new Error("contact window timezone is required");
	if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new Error("startHour must be 0..23");
	if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) throw new Error("endHour must be 1..24");
	if (endHour <= startHour) throw new Error("endHour must be after startHour");
	return { timezone, days: normaliseDays(days), startHour, endHour, defaultResponderAlias: config.defaultResponderAlias ?? null };
}

function localHourAndDay(timezone, at) {
	// Intl gives us the wall-clock hour and weekday in the target timezone
	// without depending on the host's TZ.
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour12: false,
		weekday: "short",
		hour: "2-digit",
	}).formatToParts(at);
	const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
	let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
	if (hour === 24) hour = 0;
	return { hour, day: DAY_NAMES[weekday.slice(0, 3).toLowerCase()] ?? -1 };
}

/**
 * Is `at` inside the window? Callers may force it open for tests with
 * `ignoreWindow: true`.
 */
export function withinContactWindow(window, at = new Date(), { ignoreWindow = false } = {}) {
	if (ignoreWindow) return true;
	const { hour, day } = localHourAndDay(window.timezone, at);
	if (!window.days.includes(day)) return false;
	return hour >= window.startHour && hour < window.endHour;
}

/**
 * Decide whether a piece of outreach may go out now.
 *
 * @param {object} args
 * @param {"thread_nudge"|"routine_reminder"|"malfunction"|"delivery_failure"|"owed_reply"} args.kind
 * @param {object} args.window            normalised contact window
 * @param {boolean} [args.urgent]         a per-item override that bypasses the window
 * @param {number} [args.timesAsked]      how many times this item was nudged in this window
 * @param {number} [args.maxReAsks]       re-ask budget per window (default 3)
 * @param {Date} [args.at]
 * @param {boolean} [args.ignoreWindow]
 * @returns {{send:boolean, reason:string}}
 */
export function shouldContact({ kind, window, urgent = false, timesAsked = 0, maxReAsks = 3, at = new Date(), ignoreWindow = false }) {
	if (NEVER_GATED_KINDS.has(kind)) return { send: true, reason: "never_gated" };
	if (!GATED_KINDS.has(kind)) throw new Error(`unknown outreach kind: ${kind}`);
	if (timesAsked >= maxReAsks) return { send: false, reason: "reask_budget_exhausted" };
	if (urgent) return { send: true, reason: "urgent_override" };
	if (!withinContactWindow(window, at, { ignoreWindow })) return { send: false, reason: "outside_window_deferred" };
	return { send: true, reason: "within_window" };
}
