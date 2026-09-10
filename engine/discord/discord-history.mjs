import { sanitizeFinalResponse, sanitizeSummary } from "./sanitize.mjs";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";
import { postDiscordMessage } from "./discord-delivery.mjs";
import { describeDiscordAttachments } from "./discord-attachments.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;

async function readBoundedText(response, maxBytes = 1024 * 1024) {
	const declared = response.headers?.get?.("content-length");
	if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("Discord response exceeded the safe limit");
	if (!response.body || typeof response.body.getReader !== "function") throw new Error("Discord response body is not streamable");
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("response_size_limit");
				throw new Error("Discord response exceeded the safe limit");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total).toString("utf8");
}

function targetChannel(binding) {
	return binding.kind === "thread" ? binding.threadId : binding.channelId;
}

export function authorizeHistoryRequest({ config, channelId, authorId = null }) {
	if (!SNOWFLAKE.test(channelId ?? "") || /^0+$/.test(channelId)) throw new Error("history channel must be a Discord snowflake");
	if (!config.role.allowedActions.includes("read")) throw new Error("history requires the read role");
	const bindings = config.discord.bindings.filter((candidate) =>
		candidate.operatorActions === true && targetChannel(candidate) === channelId);
	if (bindings.length !== 1) throw new Error("history binding is not uniquely authorized");
	const [binding] = bindings;
	const operators = new Set(config.discord.operatorUserIds);
	const allowedAuthors = new Set(binding.allowedUserIds.filter((id) => operators.has(id)));
	if (allowedAuthors.size === 0) throw new Error("history binding has no authorized operator");
	if (authorId !== null) {
		if (!SNOWFLAKE.test(authorId) || /^0+$/.test(authorId)) throw new Error("history author must be a Discord snowflake");
		if (!allowedAuthors.has(authorId)) throw new Error("history author is not authorized");
	}
	return { binding, allowedAuthors, authorId };
}

export function authorizeReplyRequest({ config, channelId }) {
	if (!SNOWFLAKE.test(channelId ?? "") || /^0+$/.test(channelId)) throw new Error("reply channel must be a Discord snowflake");
	if (!config.role.allowedActions.includes("reply")) throw new Error("reply requires the reply role");
	const bindings = config.discord.bindings.filter((candidate) =>
		candidate.operatorActions === true && targetChannel(candidate) === channelId);
	if (bindings.length !== 1) throw new Error("reply binding is not uniquely authorized");
	return bindings[0];
}

export async function sendDiscordReply({
	config,
	token,
	channelId,
	contentPath,
	fetchImpl = fetch,
	signal,
}) {
	authorizeReplyRequest({ config, channelId });
	if (typeof contentPath !== "string" || !isAbsolute(contentPath)) throw new Error("reply content path must be absolute");
	const resolvedContent = resolve(contentPath);
	assertPhysicalPrivateDirectory(dirname(resolvedContent));
	const stat = lstatSync(resolvedContent);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("reply content must be a real file");
	if (realpathSync(resolvedContent).toLowerCase() !== resolvedContent.toLowerCase()) throw new Error("reply content must not traverse a reparse point");
	assertOwnerOnly(resolvedContent, "file", "Discord reply content");
	const fd = openSync(resolvedContent, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let content;
	try {
		if (!fstatSync(fd).isFile()) throw new Error("reply content must remain a real file");
		content = sanitizeFinalResponse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
	if (content.length === 0 || content.length > 2_000) throw new Error("Discord reply content length is invalid");
	return postDiscordMessage({
		token,
		channelId,
		content,
		nonce: randomUUID().replaceAll("-", "").slice(0, 24),
		botUserId: config.discord.botUserId,
		fetchImpl,
		signal,
	});
}

function safeHistoryMessage(message, allowedAuthors) {
	const authorId = message?.author?.id;
	if (!allowedAuthors.has(authorId) || message?.author?.bot === true || message?.webhook_id) return null;
	let content;
	try { content = sanitizeFinalResponse(String(message.content ?? "")); }
	catch { return null; }
	const display = String(message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? "Discord user");
	return {
		messageId: SNOWFLAKE.test(message.id ?? "") ? message.id : null,
		authorId,
		author: sanitizeSummary(display.slice(0, 80)),
		createdAt: typeof message.timestamp === "string" && Number.isFinite(Date.parse(message.timestamp))
			? new Date(message.timestamp).toISOString()
			: null,
		content,
		// 첨부 ID 를 여기서 내보내지 않으면 `attachment` 명령을 부를 방법이 없다.
		attachments: describeDiscordAttachments(message).attachments,
	};
}

export async function fetchDiscordHistory({
	config,
	token,
	channelId,
	authorId = null,
	limit = 20,
	mode = "history",
	fetchImpl = fetch,
	signal,
	timeoutMs = 15_000,
}) {
	if (typeof token !== "string" || token.length < 16) throw new Error("Discord credential is not ready");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("history limit must be between 1 and 100");
	if (!new Set(["history", "latest"]).has(mode)) throw new Error("unsupported history mode");
	const authorization = authorizeHistoryRequest({ config, channelId, authorId });
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("history timeout is invalid");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort("history_timeout"), timeoutMs);
	timer.unref?.();
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	}
	let response;
	let raw;
	try {
		response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`, {
			method: "GET",
			headers: { authorization: `Bot ${token}`, accept: "application/json" },
			signal: controller.signal,
		});
		if (response.ok) raw = await readBoundedText(response);
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) {
		if (response.status === 429) throw new Error("Discord history request was rate limited");
		throw new Error(`Discord history request failed with status ${response.status}`);
	}
	let payload;
	try { payload = JSON.parse(raw); } catch { throw new Error("Discord history response is invalid"); }
	if (!Array.isArray(payload)) throw new Error("Discord history response is invalid");
	const messages = payload
		.filter((message) => message?.channel_id === channelId)
		.map((message) => safeHistoryMessage(message, authorization.allowedAuthors))
		.filter((message) => message && (authorId === null || message.authorId === authorId))
		.sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0));
	return mode === "latest" ? messages.slice(0, 1) : messages;
}

async function getDiscordMessage({ config, token, channelId, messageId, fetchImpl, signal }) {
	const authorization = authorizeHistoryRequest({ config, channelId });
	if (!SNOWFLAKE.test(messageId ?? "") || /^0+$/.test(messageId)) throw new Error("message ID must be a Discord snowflake");
	const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
		method: "GET",
		headers: { authorization: `Bot ${token}`, accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`Discord message request failed with status ${response.status}`);
	const raw = await readBoundedText(response);
	let message;
	try { message = JSON.parse(raw); } catch { throw new Error("Discord message response is invalid"); }
	if (message?.id !== messageId || message?.channel_id !== channelId) throw new Error("Discord message identity mismatch");
	const authorId = message?.author?.id;
	if (authorId !== config.discord.botUserId && !authorization.allowedAuthors.has(authorId)) throw new Error("Discord message author is not authorized");
	if (!Array.isArray(message.attachments)) throw new Error("Discord message attachments are invalid");
	return message;
}

function assertPhysicalPrivateDirectory(path) {
	let current = resolve(path);
	const root = parse(current).root;
	for (;;) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attachment output path must not traverse a reparse point");
		if (current === root) break;
		current = dirname(current);
	}
	assertOwnerOnly(path, "directory", "attachment output directory");
}

async function readBoundedBody(response, expectedBytes, maxBytes) {
	const declared = response.headers?.get?.("content-length");
	if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== expectedBytes)) {
		throw new Error("attachment response size did not match Discord metadata");
	}
	if (!response.body || typeof response.body.getReader !== "function") throw new Error("attachment response body is not streamable");
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > expectedBytes || total > maxBytes) {
				await reader.cancel("attachment_size_limit");
				throw new Error("attachment response exceeded the safe size limit");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	if (total !== expectedBytes) throw new Error("attachment size did not match Discord metadata");
	return Buffer.concat(chunks, total);
}

async function downloadDiscordAttachmentCore({
	config,
	token,
	channelId,
	messageId,
	attachmentId,
	outputPath,
	expectedSha256 = null,
	fetchImpl = fetch,
	signal,
	maxBytes = 64 * 1024 * 1024,
}) {
	if (!SNOWFLAKE.test(attachmentId ?? "") || /^0+$/.test(attachmentId)) throw new Error("attachment ID must be a Discord snowflake");
	if (typeof outputPath !== "string" || !isAbsolute(outputPath)) throw new Error("attachment output path must be absolute");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error("attachment size limit is invalid");
	if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected SHA-256 is invalid");
	const message = await getDiscordMessage({ config, token, channelId, messageId, fetchImpl, signal });
	const attachment = message.attachments.find((item) => item?.id === attachmentId);
	if (!attachment) throw new Error("authorized attachment was not found");
	if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > maxBytes) throw new Error("attachment exceeds the safe size limit");
	const url = new URL(attachment.url);
	if (url.protocol !== "https:" || !new Set(["cdn.discordapp.com", "media.discordapp.net"]).has(url.hostname)) throw new Error("attachment URL is not trusted");
	const response = await fetchImpl(url.toString(), { method: "GET", headers: { accept: "application/octet-stream" }, redirect: "error", signal });
	if (!response.ok) throw new Error(`Discord attachment request failed with status ${response.status}`);
	const finalUrl = new URL(response.url);
	if (finalUrl.protocol !== "https:" || !new Set(["cdn.discordapp.com", "media.discordapp.net"]).has(finalUrl.hostname)) throw new Error("attachment response URL is not trusted");
	const bytes = await readBoundedBody(response, attachment.size, maxBytes);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (expectedSha256 && sha256 !== expectedSha256) throw new Error("attachment SHA-256 mismatch");
	const resolvedOutput = resolve(outputPath);
	const parent = dirname(resolvedOutput);
	assertPhysicalPrivateDirectory(parent);
	if (existsSync(resolvedOutput)) {
		const existingStat = lstatSync(resolvedOutput);
		if (!existingStat.isFile() || existingStat.isSymbolicLink()) throw new Error("attachment output must be a real file");
		const existingSha = createHash("sha256").update(readFileSync(resolvedOutput)).digest("hex");
		if (existingSha !== sha256) throw new Error("attachment output already exists with different content");
		protectOwnerOnly(resolvedOutput, "file", "Discord attachment");
		return { state: "reused", outputPath: resolvedOutput, bytes: bytes.length, sha256 };
	}
	writeFileSync(resolvedOutput, bytes, { flag: "wx", mode: 0o600 });
	protectOwnerOnly(resolvedOutput, "file", "Discord attachment");
	return { state: "downloaded", outputPath: resolvedOutput, bytes: bytes.length, sha256 };
}

export async function downloadDiscordAttachment(options) {
	const timeoutMs = options?.timeoutMs ?? 60_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("attachment timeout is invalid");
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) forwardAbort();
	else options.signal?.addEventListener("abort", forwardAbort, { once: true });
	const timer = setTimeout(() => controller.abort("attachment_timeout"), timeoutMs);
	timer.unref?.();
	try {
		return await downloadDiscordAttachmentCore({ ...options, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}
