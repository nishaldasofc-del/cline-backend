import { BridgeError } from "./bridge/protocol";
import type { CommandsMode } from "./config";
import { VIRTUAL_ROOT } from "./bridge/paths";

/**
 * Commands are executed on the USER'S DEVICE, as an argv vector with NO shell
 * (so `;`, `|`, `$()`, redirects have no meaning and are rejected up front).
 *
 * This policy is defense in depth against accidents and obvious abuse. It is NOT
 * a security boundary: an allowed interpreter (node, python, npm scripts) can run
 * arbitrary code. The real boundary is the device-side executor (see
 * docs/BRIDGE_PROTOCOL.md "Device requirements").
 */
const MAX_ARGS = 64;
const MAX_CHARS = 4000;
const FORBIDDEN_ARGS: Record<string, string[]> = {
	find: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf"],
	git: ["-c", "--exec-path", "--upload-pack", "--receive-pack", "--git-dir", "--work-tree", "-C"],
	sed: ["-i", "--in-place"],
};
const FORBIDDEN_SED_SCRIPT = /(^|[;\s])[ew]\s/; // sed e/w commands execute or write files

export function tokenize(input: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let has = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (quote === '"' && c === "\\" && i + 1 < input.length) cur += input[++i];
			else cur += c;
			continue;
		}
		if (c === '"' || c === "'") { quote = c; has = true; continue; }
		if (c === "\n" || c === "\r") throw new BridgeError("DENIED", "Multi-line commands are not supported");
		if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
		if (";&|<>`".includes(c) || (c === "$" && input[i + 1] === "(")) {
			throw new BridgeError("DENIED", "Shell operators (; & | < > ` $()) are not supported: commands run without a shell. Run one simple command per call.");
		}
		cur += c;
	}
	if (quote) throw new BridgeError("BAD_REQUEST", "Unterminated quote in command");
	if (cur || has) out.push(cur);
	return out;
}

function checkArg(arg: string): string {
	if (arg.includes("\0")) throw new BridgeError("DENIED", "NUL in argument");
	if (arg.startsWith("~")) throw new BridgeError("DENIED", "Home-relative paths are not allowed");
	let a = arg;
	// Map the virtual root to the project root (commands always run with cwd = project root).
	a = a.replace(new RegExp(`(^|=)${VIRTUAL_ROOT}(/|$)`), (_m, pre, post) => `${pre}.${post}`);
	if (a.startsWith("/") || /=\//.test(a)) {
		throw new BridgeError("DENIED", `Absolute paths outside ${VIRTUAL_ROOT} are not allowed`);
	}
	if (a.split(/[/=]/).includes("..")) throw new BridgeError("DENIED", "Path traversal is not allowed");
	return a;
}

export function prepareCommand(
	input: string | { command: string; args?: string[] },
	policy: { mode: CommandsMode; allowlist: string[] },
): string[] {
	if (policy.mode === "off") throw new BridgeError("DENIED", "Command execution is disabled on this deployment");
	const raw = typeof input === "string" ? tokenize(input) : [input.command, ...(input.args ?? [])];
	if (raw.length === 0) throw new BridgeError("BAD_REQUEST", "Empty command");
	if (raw.length > MAX_ARGS || raw.join(" ").length > MAX_CHARS) throw new BridgeError("TOO_LARGE", "Command too long");
	const [cmd, ...args] = raw;
	if (!/^(\.\/)?[A-Za-z0-9._+-]+$/.test(cmd) || cmd.includes("..")) throw new BridgeError("DENIED", "Command must be a bare program name");
	if (policy.mode === "allowlist") {
		if (!policy.allowlist.includes(cmd)) {
			throw new BridgeError("DENIED", `Command "${cmd}" is not allowed. Allowed: ${policy.allowlist.join(", ")}`);
		}
		const bad = FORBIDDEN_ARGS[cmd];
		if (bad && args.some((a) => bad.includes(a))) throw new BridgeError("DENIED", `Option not allowed for ${cmd}`);
		if (cmd === "sed" && args.some((a) => FORBIDDEN_SED_SCRIPT.test(a))) throw new BridgeError("DENIED", "sed e/w commands are not allowed");
	}
	return [cmd, ...args.map(checkArg)];
}
