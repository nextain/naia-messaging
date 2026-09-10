/**
 * Confirmation requests — transport-neutral.
 *
 * When the engine cannot verify something itself and must ask a person, the
 * request has to name its target, or it lands on no one: a finished task then
 * stalls forever waiting on a confirmation nobody claimed. A confirmation
 * request therefore carries four required fields:
 *   - who               : the addressed person (an alias, not a platform id)
 *   - what              : the one thing to confirm
 *   - whereExactly      : the exact place to look
 *   - whereToReportBack  : where the answer should go
 * plus one optional field:
 *   - whyICouldNotCheck  : why the engine could not verify it itself
 *
 * A separate concern from an APPROVAL request, which instead needs the single
 * decision and the default taken if no answer arrives.
 */

const CONFIRMATION_FIELDS = ["who", "what", "whereExactly", "whereToReportBack"];
const APPROVAL_FIELDS = ["oneSentenceDecision", "defaultIfNoAnswer"];

/**
 * Validate and normalise a confirmation request. Returns the trimmed request;
 * throws naming the first missing field.
 */
export function buildConfirmationRequest(request) {
	if (!request || typeof request !== "object") throw new Error("confirmation request must be an object");
	const out = {};
	for (const field of CONFIRMATION_FIELDS) {
		const value = request[field];
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new Error(`confirmation request is missing '${field}' — an unaddressed request lands on no one`);
		}
		out[field] = value.trim();
	}
	if (request.whyICouldNotCheck !== undefined) {
		if (typeof request.whyICouldNotCheck !== "string") throw new Error("whyICouldNotCheck must be a string");
		const why = request.whyICouldNotCheck.trim();
		if (why) out.whyICouldNotCheck = why;
	}
	return out;
}

/** Validate an approval request: the decision and the default if unanswered. */
export function buildApprovalRequest(request) {
	if (!request || typeof request !== "object") throw new Error("approval request must be an object");
	const out = {};
	for (const field of APPROVAL_FIELDS) {
		const value = request[field];
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new Error(`approval request is missing '${field}'`);
		}
		out[field] = value.trim();
	}
	return out;
}

export { CONFIRMATION_FIELDS, APPROVAL_FIELDS };
