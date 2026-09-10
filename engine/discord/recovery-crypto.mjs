import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";

function privateDirectory(path) {
	const resolved = resolve(path);
	const root = parse(resolved).root;
	let cursor = root;
	for (const part of resolved.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("recovery key path contains a symbolic link");
	}
	if (existsSync(resolved)) {
		const stat = lstatSync(resolved);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("recovery key directory must be an owner-only real directory");
		assertOwnerOnly(resolved, "directory", "recovery key directory");
		return;
	}
	mkdirSync(resolved, { recursive: true, mode: 0o700 });
	chmodSync(resolved, 0o700);
	protectOwnerOnly(resolved, "directory", "recovery key directory");
	assertOwnerOnly(resolved, "directory", "recovery key directory");
}

export function loadOrCreateRecoveryKey(path) {
	const resolved = resolve(path);
	privateDirectory(dirname(resolved));
	let created = false;
	if (!existsSync(resolved)) {
		const fd = openSync(resolved, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
		try { writeSync(fd, randomBytes(32)); } finally { closeSync(fd); }
		created = true;
	}
	const stat = lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("recovery key must be an owner-only real file");
	if (created) protectOwnerOnly(resolved, "file", "recovery key");
	assertOwnerOnly(resolved, "file", "recovery key");
	const readFd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let key;
	try { key = readFileSync(readFd); } finally { closeSync(readFd); }
	if (key.length !== 32) throw new Error("recovery key has an invalid length");
	return key;
}

export class RecoveryCodec {
	constructor(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("recovery key must contain 32 bytes"); this.key = Buffer.from(key); }
	seal(value) {
		if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 32 * 1024) throw new Error("recovery payload is invalid");
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return { iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
	}
	open(envelope) {
		const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64url"));
		decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
	}
}
