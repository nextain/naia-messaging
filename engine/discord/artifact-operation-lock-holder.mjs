import { isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const [readyPath, nonce] = process.argv.slice(2);
if (typeof readyPath !== "string" || !isAbsolute(readyPath) || resolve(readyPath) !== readyPath || typeof nonce !== "string" || !/^[0-9a-f-]{36}$/.test(nonce)) process.exit(2);
writeFileSync(readyPath, nonce, { flag: "wx", mode: 0o600 });
let cleaned = false;
const cleanup = () => {
	if (cleaned) return;
	if (existsSync(readyPath) && readFileSync(readyPath, "utf8") === nonce) unlinkSync(readyPath);
	cleaned = true;
};
const finish = () => { cleanup(); process.exit(0); };
process.stdin.resume();
process.stdin.on("end", finish);
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
