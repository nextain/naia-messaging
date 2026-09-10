import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_SCHEMA_VERSION } from "./constants.mjs";
import { protectOwnerOnlyBatch } from "./platform-security.mjs";

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function assertSafePathComponents(directory) {
	const root = parse(directory).root;
	let cursor = root;
	for (const part of directory.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`state path contains a symbolic link: ${cursor}`);
	}
}

function assertOwnedRealDirectory(directory) {
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("session state directory must be a real directory");
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("session state directory owner mismatch");
}

function assertOwnedRealFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file${label === "SQLite sidecar" ? `: ${path}` : ""}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch${label === "SQLite sidecar" ? `: ${path}` : ""}`);
	return stat;
}

function inspectSidecars(databasePath, { harden = false } = {}) {
	const privateItems = [];
	for (const suffix of ["-wal", "-shm"]) {
		const path = `${databasePath}${suffix}`;
		if (!lstatOrNull(path)) continue;
		assertOwnedRealFile(path, "SQLite sidecar");
		if (harden) {
			chmodSync(path, 0o600);
			privateItems.push({ path, kind: "file", label: "SQLite sidecar" });
		}
	}
	return privateItems;
}

function preparePrivateDatabasePath(databasePath) {
	const resolvedPath = resolve(databasePath);
	const directory = dirname(resolvedPath);
	assertSafePathComponents(directory);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	assertOwnedRealDirectory(directory);
	chmodSync(directory, 0o700);
	if (!existsSync(resolvedPath)) {
		const fd = openSync(resolvedPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
		closeSync(fd);
	}
	assertOwnedRealFile(resolvedPath, "session database");
	chmodSync(resolvedPath, 0o600);
	protectOwnerOnlyBatch([
		{ path: directory, kind: "directory", label: "session state directory" },
		{ path: resolvedPath, kind: "file", label: "session database" },
		...inspectSidecars(resolvedPath, { harden: true }),
	]);
	return resolvedPath;
}

function inspectPrivateDatabasePath(databasePath) {
	const resolvedPath = resolve(databasePath);
	const directory = dirname(resolvedPath);
	assertSafePathComponents(directory);
	if (!existsSync(directory)) throw new Error("session state directory does not exist");
	assertOwnedRealDirectory(directory);
	if (!existsSync(resolvedPath)) throw new Error("session database does not exist");
	assertOwnedRealFile(resolvedPath, "session database");
	inspectSidecars(resolvedPath);
	return resolvedPath;
}

function assertSupportedSchema(db) {
	const metadataExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
	if (!metadataExists) return;
	const current = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
	if (!current) return;
	const version = Number(current.value);
	if (!Number.isSafeInteger(version) || version < 0) throw new Error("database schema version is invalid");
	if (version > DB_SCHEMA_VERSION) throw new Error("database schema is newer than this helper");
}

export function hardenSessionDatabaseFiles(databasePath) {
	const privateItems = [];
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${databasePath}${suffix}`;
		if (!lstatOrNull(path)) continue;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe SQLite state file: ${path}`);
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`SQLite state owner mismatch: ${path}`);
		chmodSync(path, 0o600);
		privateItems.push({ path, kind: "file", label: "SQLite state file" });
	}
	protectOwnerOnlyBatch(privateItems);
}

function migrate(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS service_state (
			id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL, status TEXT NOT NULL,
			pid INTEGER, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, boot_id TEXT,
			process_start_identity TEXT
		);
		CREATE TABLE IF NOT EXISTS jobs (
			job_id TEXT PRIMARY KEY, attempt_id TEXT, lifecycle TEXT NOT NULL, backend_id TEXT NOT NULL,
			revision TEXT NOT NULL, backend_capabilities_json TEXT NOT NULL, activity_detail TEXT NOT NULL,
			safe_summary TEXT NOT NULL, accepted_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL,
			last_progress_at TEXT, soft_silence_ms INTEGER NOT NULL, hard_deadline_at TEXT,
			current_activity TEXT, waiting_reason TEXT, retry_at TEXT, child_alive INTEGER NOT NULL DEFAULT 0,
			child_pid INTEGER, child_boot_id TEXT, child_start_identity TEXT, accepting_service_generation TEXT,
			executing_service_generation TEXT, execution_binding_json TEXT,
			delivery_state TEXT NOT NULL DEFAULT 'not_started', recovery_state TEXT NOT NULL DEFAULT 'none',
			latest_safe_error TEXT
		);
		CREATE TABLE IF NOT EXISTS job_events (
			ordinal INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL,
			job_id TEXT NOT NULL REFERENCES jobs(job_id), attempt_id TEXT, sequence INTEGER NOT NULL,
			kind TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL, safe_summary TEXT NOT NULL,
			metrics_json TEXT NOT NULL, redaction_level TEXT NOT NULL, UNIQUE(job_id, sequence),
			UNIQUE(job_id, dedupe_key)
		);
		CREATE TABLE IF NOT EXISTS required_checks (
			check_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id), kind TEXT NOT NULL,
			safe_label TEXT NOT NULL, required INTEGER NOT NULL, revision TEXT NOT NULL,
			allow_reuse INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id, check_id)
		);
		CREATE TABLE IF NOT EXISTS evidence (
			evidence_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), check_id TEXT NOT NULL,
			attempt_id TEXT, revision TEXT NOT NULL, kind TEXT NOT NULL, safe_label TEXT NOT NULL,
			required INTEGER NOT NULL, result TEXT NOT NULL, producer TEXT NOT NULL, verifier TEXT NOT NULL,
			observed_at TEXT NOT NULL, metrics_json TEXT NOT NULL,
			FOREIGN KEY(job_id, check_id) REFERENCES required_checks(job_id, check_id)
		);
		CREATE TABLE IF NOT EXISTS gateway_state (
			id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT, resume_url TEXT, sequence INTEGER,
			heartbeat_ack_at TEXT, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS ingress_messages (
			source_message_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, status TEXT NOT NULL, job_id TEXT,
			reason_code TEXT NOT NULL, dispatch_sequence INTEGER, received_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS delivery_attempts (
			delivery_key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), attempt_id TEXT NOT NULL,
			nonce TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT,
			started_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS job_recovery (
			job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE, iv TEXT NOT NULL,
			ciphertext TEXT NOT NULL, tag TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS discord_projections (
			scope_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS job_events_job_ordinal ON job_events(job_id, ordinal);
		CREATE INDEX IF NOT EXISTS jobs_updated_at ON jobs(updated_at DESC);
		CREATE INDEX IF NOT EXISTS jobs_operational_updated_at ON jobs(updated_at DESC)
			WHERE lifecycle IN ('queued', 'running', 'waiting_approval', 'retry_wait', 'result_ready', 'delivering');
		CREATE INDEX IF NOT EXISTS jobs_recovery_review_attention ON jobs(lifecycle)
			WHERE lifecycle = 'recovery_review';
		CREATE INDEX IF NOT EXISTS jobs_terminal_delivery_attention ON jobs(delivery_state)
			WHERE lifecycle IN ('completed', 'failed', 'cancelled', 'recovery_review')
				AND delivery_state IN ('unknown', 'failed');
		CREATE UNIQUE INDEX IF NOT EXISTS delivery_attempt_job ON delivery_attempts(job_id, attempt_id);
	`);
	const ensureColumn = (table, column, declaration) => {
		const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
		if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
	};
	ensureColumn("service_state", "boot_id", "TEXT");
	ensureColumn("service_state", "process_start_identity", "TEXT");
	ensureColumn("jobs", "child_pid", "INTEGER");
	ensureColumn("jobs", "child_boot_id", "TEXT");
	ensureColumn("jobs", "child_start_identity", "TEXT");
	ensureColumn("jobs", "scope_key", "TEXT");
	ensureColumn("jobs", "accepting_service_generation", "TEXT");
	ensureColumn("jobs", "executing_service_generation", "TEXT");
	ensureColumn("jobs", "execution_binding_json", "TEXT");
	db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)").run(String(DB_SCHEMA_VERSION));
}

export function openSessionDatabase(databasePath, { readOnly = false, busyTimeoutMs } = {}) {
	const resolvedPath = readOnly ? inspectPrivateDatabasePath(databasePath) : preparePrivateDatabasePath(databasePath);
	const previousUmask = process.umask(0o077);
	let db;
	try {
		db = new DatabaseSync(resolvedPath, { readOnly, timeout: busyTimeoutMs });
		db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
		assertSupportedSchema(db);
		if (!readOnly) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
	} catch (error) {
		db?.close();
		throw error;
	} finally {
		process.umask(previousUmask);
	}
	if (!readOnly) {
		hardenSessionDatabaseFiles(resolvedPath);
		migrate(db);
	}
	return { databasePath: resolvedPath, db };
}
