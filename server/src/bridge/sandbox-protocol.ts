import { z } from "zod";

/**
 * sunset-sandbox-v1 — the wire protocol spoken by the Termux Sandbox Bridge agent
 * (termux-sandbox-bridge `src/protocol.ts`). See docs/SANDBOX_BRIDGE_PROTOCOL.md.
 *
 * Transport: the AGENT connects OUT to wss://<host>/bridge; this server then sends one JSON request frame per
 * operation and the agent answers with one response frame carrying the same `id`.
 */
export const SANDBOX_PROTOCOL = "sunset-sandbox-v1" as const;
export const SANDBOX_PATH = "/bridge";

export const SANDBOX_OPS = ["ping", "list_files", "read_file", "write_file", "delete_file", "mkdir", "run_command"] as const;
export type SandboxOp = (typeof SANDBOX_OPS)[number];

/** Codes the agent itself emits, plus the ones only the hub emits (DEVICE_*, BRIDGE_TIMEOUT, DEVICE_BUSY, BAD_RESPONSE). */
export type SandboxErrorCode =
	| "UNAUTHORIZED" | "INVALID_REQUEST" | "UNKNOWN_OPERATION" | "PATH_OUTSIDE_SANDBOX" | "FILE_NOT_FOUND"
	| "FILE_ALREADY_EXISTS" | "FILE_TOO_LARGE" | "WRITE_LIMIT_EXCEEDED" | "COMMAND_TIMEOUT" | "COMMAND_FAILED"
	| "COMMAND_FORBIDDEN" | "PAYLOAD_TOO_LARGE" | "INTERNAL_ERROR"
	| "DEVICE_NOT_FOUND" | "DEVICE_OFFLINE" | "DEVICE_AMBIGUOUS" | "BRIDGE_TIMEOUT" | "DEVICE_BUSY" | "BAD_RESPONSE";

/** Thrown for failures the hub itself detects. Never carries a secret. */
export class SandboxHubError extends Error {
	constructor(public code: SandboxErrorCode, message: string, public details?: unknown) {
		super(message.slice(0, 500));
	}
}

export interface SandboxResponse {
	protocol: typeof SANDBOX_PROTOCOL;
	id: string;
	ok: boolean;
	data?: unknown;
	error?: { code: string; message: string; details?: unknown };
	deviceId?: string;
	sessionId?: string;
}

// ---- caller -> hub: what an operation looks like (validated BEFORE anything reaches a device) ----

const MAX_PATH = 1024;

/**
 * Light pre-check only. The agent's own jail (realpath + symlink checks) is the security boundary; this just refuses
 * obviously hostile input early so it never crosses the wire. Paths are relative to the agent's sandbox root.
 */
function pathProblem(p: string, allowEmpty: boolean): string | undefined {
	if (p.length === 0) return allowEmpty ? undefined : "path is empty";
	if (p.length > MAX_PATH) return "path too long";
	if (p.includes("\0")) return "path contains a NUL byte";
	if (p.includes("\\")) return "path contains a backslash";
	if (p.startsWith("/")) return "absolute paths are not allowed (paths are relative to the sandbox root)";
	if (p.startsWith("~")) return "home-relative paths are not allowed";
	if (p.split("/").includes("..")) return "path traversal is not allowed";
	return undefined;
}
const relPath = z.string().superRefine((p, ctx) => { const m = pathProblem(p, false); if (m) ctx.addIssue({ code: "custom", message: m }); });
const relPathOrRoot = z.string().superRefine((p, ctx) => { const m = pathProblem(p, true); if (m) ctx.addIssue({ code: "custom", message: m }); });
const encoding = z.enum(["utf-8", "base64"]);

export const SandboxCall = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ping") }),
	z.object({ type: z.literal("list_files"), path: relPathOrRoot.optional(), recursive: z.boolean().optional() }),
	z.object({ type: z.literal("read_file"), path: relPath, encoding: encoding.optional() }),
	z.object({ type: z.literal("write_file"), path: relPath, content: z.string(), encoding: encoding.optional(), createDirs: z.boolean().optional() }),
	z.object({ type: z.literal("delete_file"), path: relPath, recursive: z.boolean().optional() }),
	z.object({ type: z.literal("mkdir"), path: relPath, recursive: z.boolean().optional() }),
	z.object({
		type: z.literal("run_command"),
		command: z.string().min(1).max(4000),
		args: z.array(z.string().max(4000)).max(64).optional(),
		timeoutMs: z.number().int().positive().max(120_000).optional(),
	}),
]);
export type SandboxCall = z.infer<typeof SandboxCall>;

/** Parse an untrusted object (REST body, internal caller) into a validated call; throws INVALID_REQUEST. */
export function parseSandboxCall(input: unknown): SandboxCall {
	if (typeof input === "object" && input !== null && typeof (input as { type?: unknown }).type === "string"
		&& !(SANDBOX_OPS as readonly string[]).includes((input as { type: string }).type)) {
		throw new SandboxHubError("UNKNOWN_OPERATION", `Unknown operation. Allowed: ${SANDBOX_OPS.join(", ")}`);
	}
	const r = SandboxCall.safeParse(input);
	if (!r.success) {
		const i = r.error.issues[0];
		throw new SandboxHubError("INVALID_REQUEST", `${i?.path.join(".") || "request"}: ${i?.message ?? "invalid"}`);
	}
	return r.data;
}

// ---- agent -> hub: what comes back (validated before it is handed to any caller) ----

const fileItem = z.looseObject({ name: z.string(), path: z.string(), isDirectory: z.boolean(), size: z.number(), mtimeMs: z.number() });
export const SandboxResultSchemas = {
	ping: z.looseObject({ status: z.literal("pong"), timestamp: z.number(), workspace: z.string() }),
	list_files: z.array(fileItem).max(100_000),
	read_file: z.string(),
	write_file: z.looseObject({ path: z.string(), bytesWritten: z.number().int().nonnegative() }),
	delete_file: z.looseObject({ path: z.string(), deleted: z.literal(true) }),
	mkdir: z.looseObject({ path: z.string(), created: z.literal(true) }),
	run_command: z.looseObject({ exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), stdoutTruncated: z.boolean().optional(), stderrTruncated: z.boolean().optional() }),
} as const satisfies Record<SandboxOp, z.ZodType>;

/** Any frame the agent may send. Anything else closes the socket. */
export const AgentFrame = z.looseObject({
	protocol: z.literal(SANDBOX_PROTOCOL),
	id: z.string().min(1).max(128),
	ok: z.boolean(),
	data: z.unknown().optional(),
	error: z.looseObject({ code: z.string().max(64), message: z.string(), details: z.unknown().optional() }).optional(),
});
