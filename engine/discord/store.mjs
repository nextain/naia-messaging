import { readBootId, readProcessStartIdentity } from "./projector.mjs";
import { hardenSessionDatabaseFiles, openSessionDatabase } from "./store-database.mjs";
import { SessionConversationWriter } from "./store-conversation-writer.mjs";
import { SessionEventWriter } from "./store-event-writer.mjs";
import { SessionJobWriter } from "./store-job-writer.mjs";
import { SessionStoreReader } from "./store-reader.mjs";

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export class SessionStore {
	#databasePath;
	#db;
	#events;
	#conversations;
	#jobs;
	#reader;

	constructor(databasePath, ownershipReader = {}, { readOnly = false, busyTimeoutMs = DEFAULT_SQLITE_BUSY_TIMEOUT_MS } = {}) {
		if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error("SQLite busy timeout must be between 0 and 60000 milliseconds");
		const ownershipBootId = ownershipReader.readBootId ?? readBootId;
		const ownershipProcessStartIdentity = ownershipReader.readProcessStartIdentity ?? readProcessStartIdentity;
		const opened = openSessionDatabase(databasePath, { readOnly, busyTimeoutMs });
		this.#databasePath = opened.databasePath;
		this.#db = opened.db;
		const hardenSidecars = () => hardenSessionDatabaseFiles(this.#databasePath);
		this.#events = new SessionEventWriter(this.#db, { hardenSidecars });
		this.#conversations = new SessionConversationWriter(this.#db, { eventWriter: this.#events, hardenSidecars });
		this.#jobs = new SessionJobWriter(this.#db, {
			eventWriter: this.#events,
			hardenSidecars,
			readBootId: ownershipBootId,
			readProcessStartIdentity: ownershipProcessStartIdentity,
		});
		this.#reader = new SessionStoreReader(this.#db, {
			loadGatewayState: () => this.loadGatewayState(),
			eventsAfter: (options) => this.eventsAfter(options),
		});
	}

	static openReadOnly(databasePath, ownershipReader = {}, options = {}) {
		return new SessionStore(databasePath, ownershipReader, { ...options, readOnly: true });
	}

	loadJobRecovery(jobId) { return this.#conversations.loadJobRecovery(jobId); }
	deleteJobRecovery(jobId) { return this.#conversations.deleteJobRecovery(jobId); }
	loadGatewayState() { return this.#conversations.loadGatewayState(); }
	saveGatewayState(patch, now) { return this.#conversations.saveGatewayState(patch, now); }
	clearGatewayResume(now) { return this.#conversations.clearGatewayResume(now); }
	loadDiscordProjection(scopeKey) { return this.#conversations.loadDiscordProjection(scopeKey); }
	saveDiscordProjection(input) { return this.#conversations.saveDiscordProjection(input); }
	reserveIngress(input) { return this.#conversations.reserveIngress(input); }
	acceptIngressAndCreateJob(input) { return this.#conversations.acceptIngressAndCreateJob(input); }
	reserveDelivery(input) { return this.#conversations.reserveDelivery(input); }
	startDelivery(input) { return this.#conversations.startDelivery(input); }
	finishDelivery(input) { return this.#conversations.finishDelivery(input); }
	recoverInterruptedWork(options) { return this.#conversations.recoverInterruptedWork(options); }

	close() { this.#db.close(); }

	heartbeatService(input) { return this.#jobs.heartbeatService(input); }
	createJob(input) { return this.#jobs.createJob(input); }
	reserveAttempt(jobId, options) { return this.#jobs.reserveAttempt(jobId, options); }
	attachAttempt(jobId, options) { return this.#jobs.attachAttempt(jobId, options); }
	startAttempt(jobId, options) { return this.#jobs.startAttempt(jobId, options); }
	failReservedAttempt(jobId, options) { return this.#jobs.failReservedAttempt(jobId, options); }
	failAttempt(jobId, options) { return this.#jobs.failAttempt(jobId, options); }

	recordEvent(input) { return this.#events.recordEvent(input); }
	recordEvidence(input) { return this.#events.recordEvidence(input); }
	eventsAfter(options) { return this.#events.eventsAfter(options); }

	operationalSnapshot(options = {}) { return this.#reader.operationalSnapshot(options); }
	status(options = {}) { return this.operationalSnapshot(options).status; }
	getServiceOwner() { return this.#reader.getServiceOwner(); }
	listJobs(options = {}) { return this.#reader.listJobs(options); }
	listOperationalJobs(options = {}) { return this.#reader.listOperationalJobs(options); }
	operationalJobCount() { return this.#reader.operationalJobCount(); }
	historicalAttentionCounts() { return this.#reader.historicalAttentionCounts(); }
	listJobsForScope(scopeKey, options = {}) { return this.#reader.listJobsForScope(scopeKey, options); }
	hasAcceptedIngressForJob(jobId) { return this.#reader.hasAcceptedIngressForJob(jobId); }
	getJob(jobId, options = {}) { return this.#reader.getJob(jobId, options); }
}
