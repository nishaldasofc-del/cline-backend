import { BridgeError, type BridgeErrorCode, type BridgeOp, type OpArgs, type OpResult } from "./protocol";
import type { SandboxHub } from "./sandbox-hub";
import type { SandboxResponse } from "./sandbox-protocol";

/** sunset-sandbox-v1 error code -> the Cline bridge error vocabulary the tool executors already understand. */
export function mapSandboxError(code: string): BridgeErrorCode {
	switch (code) {
		case "FILE_NOT_FOUND": return "NOT_FOUND";
		case "PATH_OUTSIDE_SANDBOX": case "COMMAND_FORBIDDEN": case "UNAUTHORIZED": case "FILE_ALREADY_EXISTS": return "DENIED";
		case "FILE_TOO_LARGE": case "WRITE_LIMIT_EXCEEDED": case "PAYLOAD_TOO_LARGE": return "TOO_LARGE";
		case "COMMAND_TIMEOUT": case "BRIDGE_TIMEOUT": return "TIMEOUT";
		case "DEVICE_OFFLINE": case "DEVICE_NOT_FOUND": case "DEVICE_AMBIGUOUS": return "OFFLINE";
		case "DEVICE_BUSY": return "BUSY";
		case "INVALID_REQUEST": case "UNKNOWN_OPERATION": return "BAD_REQUEST";
		case "BAD_RESPONSE": return "BAD_RESPONSE";
		default: return "IO";
	}
}

const MAX_SEARCH_FILES = 300;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv"]);
const AGENT_MAX_CMD_MS = 120_000;

function globToRegExp(glob: string): RegExp {
	const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
	return new RegExp(`^${esc}$`);
}

/**
 * Translates the five Cline bridge ops into sunset-sandbox-v1 operations on ONE named device. It never selects a device
 * itself and never sees a token: the (already authorised) deviceId comes from the router. Every call goes through
 * SandboxHub.route(), so pre-validation, command policy, timeouts, payload caps and the agent's own jail all still apply.
 *
 * READ_FILE -> read_file      WRITE_FILE -> write_file(createDirs)     PATCH -> write_file / delete_file per change
 * RUN_COMMAND -> run_command  SEARCH -> list_files(recursive) + read_file, matched here (the agent has no grep op)
 */
export class SunsetBridgeAdapter {
	constructor(private readonly hub: SandboxHub) {}

	isConnected(deviceId: string): boolean { return this.hub.isConnected(deviceId); }

	private op(deviceId: string, call: Record<string, unknown>): Promise<SandboxResponse> {
		return this.hub.route(call, { deviceId });
	}
	private must(r: SandboxResponse): unknown {
		if (r.ok) return r.data;
		throw new BridgeError(mapSandboxError(r.error?.code ?? ""), r.error?.message ?? "device error");
	}

	async call<O extends BridgeOp>(deviceId: string, op: O, args: OpArgs[O]): Promise<OpResult<O>> {
		switch (op) {
			case "READ_FILE": {
				const a = args as OpArgs["READ_FILE"];
				const content = this.must(await this.op(deviceId, { type: "read_file", path: a.path })) as string;
				return { content, size: Buffer.byteLength(content, "utf8") } as OpResult<O>;
			}
			case "WRITE_FILE": {
				const a = args as OpArgs["WRITE_FILE"];
				const d = this.must(await this.op(deviceId, { type: "write_file", path: a.path, content: a.content, createDirs: true })) as { bytesWritten: number };
				return { bytesWritten: d.bytesWritten } as OpResult<O>;
			}
			case "PATCH": {
				const a = args as OpArgs["PATCH"];
				let applied = 0;
				for (const c of a.changes) {
					if (c.action === "write") this.must(await this.op(deviceId, { type: "write_file", path: c.path, content: c.content, createDirs: true }));
					else this.must(await this.op(deviceId, { type: "delete_file", path: c.path }));
					applied++;
				}
				return { applied } as OpResult<O>;
			}
			case "RUN_COMMAND": {
				const a = args as OpArgs["RUN_COMMAND"];
				const [command, ...rest] = a.argv;
				const r = await this.op(deviceId, { type: "run_command", command, ...(rest.length ? { args: rest } : {}), timeoutMs: Math.min(a.timeoutMs, AGENT_MAX_CMD_MS) });
				if (!r.ok && r.error?.code === "COMMAND_TIMEOUT") {
					const d = (r.error.details ?? {}) as { stdout?: string; stderr?: string };
					return { exitCode: null, stdout: String(d.stdout ?? ""), stderr: String(d.stderr ?? ""), timedOut: true } as OpResult<O>;
				}
				const d = this.must(r) as { exitCode: number | null; stdout: string; stderr: string };
				return { exitCode: d.exitCode, stdout: d.stdout, stderr: d.stderr, timedOut: false } as OpResult<O>;
			}
			case "SEARCH": return (await this.search(deviceId, args as OpArgs["SEARCH"])) as OpResult<O>;
			default: throw new BridgeError("UNSUPPORTED", `Unsupported operation ${String(op)}`);
		}
	}

	private async search(deviceId: string, a: OpArgs["SEARCH"]): Promise<OpResult<"SEARCH">> {
		let re: RegExp | undefined;
		if (a.pattern) { try { re = new RegExp(a.pattern); } catch { throw new BridgeError("BAD_REQUEST", "Invalid regular expression"); } }
		const globRe = a.glob ? globToRegExp(a.glob) : undefined;
		const base = a.path && a.path !== "." ? a.path : undefined;
		const listed = this.must(await this.op(deviceId, { type: "list_files", recursive: true, ...(base ? { path: base } : {}) })) as Array<{ path: string; isDirectory: boolean; size: number }>;
		const files = listed
			.filter((f) => !f.isDirectory && !f.path.split("/").some((s) => SKIP_DIRS.has(s)) && (!globRe || globRe.test(f.path) || globRe.test(f.path.split("/").pop() ?? "")))
			.slice(0, 5000);
		const matches: OpResult<"SEARCH">["matches"] = [];
		let truncated = files.length >= 5000;
		if (!re) {
			for (const f of files) { if (matches.length >= a.maxResults) { truncated = true; break; } matches.push({ path: f.path }); }
			return { matches, truncated };
		}
		let scanned = 0;
		for (const f of files) {
			if (matches.length >= a.maxResults) { truncated = true; break; }
			if (f.size > MAX_SEARCH_FILE_BYTES) continue;
			if (++scanned > MAX_SEARCH_FILES) { truncated = true; break; }
			const r = await this.op(deviceId, { type: "read_file", path: f.path });
			if (!r.ok || typeof r.data !== "string" || r.data.includes("\u0000")) continue;
			const lines = r.data.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				if (re.test(lines[i])) {
					matches.push({ path: f.path.slice(0, 1024), line: i + 1, text: lines[i].slice(0, 2000) });
					if (matches.length >= a.maxResults) break;
				}
			}
		}
		return { matches, truncated };
	}
}
