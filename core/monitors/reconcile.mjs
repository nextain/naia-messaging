/**
 * Reconciliation monitor — generic, report-only.
 *
 * A monitor that also fixes things hides the divergence it was meant to
 * surface. This one only reports: it compares the surfaces that should agree
 * about a work item — a local tracker, the upstream work item, the conversation
 * thread, the messaging binding — and lists where they disagree. It changes
 * nothing.
 *
 * Two lessons from the source instances are encoded here:
 *   - A divergence a person deliberately resolved is not a divergence. If a
 *     tracker row carries a `closedBy` marker, an open work item is expected,
 *     not a mismatch.
 *   - When a seed source and a runtime source can disagree, the report must say
 *     which one it read (`sourcePath`), so nobody debugs the wrong file.
 *
 * Genericised from naia-pj-adk ops/gateway (audit) and the followups tracker
 * contract. Host, guild, and issue specifics stay in the instances.
 */

/**
 * @typedef {object} TrackerItem
 * @property {string} key         `<repo>#<number>`
 * @property {string} state       new|dispatched|awaiting_*|blocked|completed|closed
 * @property {string} [threadId]
 * @property {string} [closedBy]  set when a person deliberately resolved it
 */

/**
 * @param {object} args
 * @param {TrackerItem[]} args.trackerItems       rows the instance is tracking
 * @param {Set<string>|string[]} args.openWorkItems keys the upstream still shows open
 * @param {Set<string>|string[]} args.liveThreadIds thread ids that still exist
 * @param {string} args.sourcePath                which file these rows were read from
 * @returns {{sourcePath:string, mismatches:Array<{key:string, kind:string, detail:string}>, ok:boolean}}
 */
export function reconcile({ trackerItems, openWorkItems, liveThreadIds, sourcePath }) {
	if (!Array.isArray(trackerItems)) throw new Error("trackerItems must be an array");
	if (typeof sourcePath !== "string" || !sourcePath) throw new Error("sourcePath is required so the reader is known");
	const open = openWorkItems instanceof Set ? openWorkItems : new Set(openWorkItems ?? []);
	const liveThreads = liveThreadIds instanceof Set ? liveThreadIds : new Set(liveThreadIds ?? []);
	const closedStates = new Set(["completed", "closed"]);
	const mismatches = [];

	for (const item of trackerItems) {
		// A deliberately-resolved item is never a mismatch.
		if (item.closedBy) continue;

		if (closedStates.has(item.state) && open.has(item.key)) {
			mismatches.push({ key: item.key, kind: "tracker_closed_upstream_open", detail: "tracker shows done but the work item is still open" });
		}
		if (!closedStates.has(item.state) && !open.has(item.key)) {
			mismatches.push({ key: item.key, kind: "tracker_open_upstream_closed", detail: "tracker still active but the work item is not open upstream" });
		}
		if (item.threadId && !liveThreads.has(item.threadId)) {
			// A dangling thread id is a real hazard: a monitor that then queries a
			// deleted thread gets a 404 and dies. Report it; never keep querying it.
			mismatches.push({ key: item.key, kind: "thread_missing", detail: "bound thread no longer exists" });
		}
	}

	return { sourcePath, mismatches, ok: mismatches.length === 0 };
}
