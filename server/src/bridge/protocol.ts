import { z } from "zod";

/**
 * Cline Bridge Protocol v1 — see docs/BRIDGE_PROTOCOL.md.
 * Transport: WebSocket (subprotocol "cline-bridge.v1"), JSON text frames.
 * The PHONE connects OUT to the server; the server then sends `request` frames.
 * All paths are project-relative POSIX paths ("" or "." = project root).
 */
export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = "cline-bridge.v1";
export const OPS = ["READ_FILE", "SEARCH", "WRITE_FILE", "PATCH", "RUN_COMMAND"] as const;
export type BridgeOp = (typeof OPS)[number];

export const ERROR_CODES = ["NOT_FOUND", "DENIED", "TOO_LARGE", "TIMEOUT", "IO", "UNSUPPORTED", "BAD_REQUEST"] as const;
export type BridgeErrorCode = (typeof ERROR_CODES)[number] | "OFFLINE" | "BAD_RESPONSE" | "BUSY";

export class BridgeError extends Error {
	constructor(public code: BridgeErrorCode, message: string) {
		super(message.slice(0, 500));
	}
}

// ---- request args (server -> phone) ----
export interface ReadFileArgs { path: string }
export interface SearchArgs { pattern?: string; glob?: string; path?: string; maxResults: number }
export interface WriteFileArgs { path: string; content: string }
export type PatchChange =
	| { action: "write"; path: string; content: string }
	| { action: "delete"; path: string };
export interface PatchArgs { changes: PatchChange[] }
export interface RunCommandArgs { argv: string[]; timeoutMs: number; maxOutputBytes: number }

export interface OpArgs {
	READ_FILE: ReadFileArgs;
	SEARCH: SearchArgs;
	WRITE_FILE: WriteFileArgs;
	PATCH: PatchArgs;
	RUN_COMMAND: RunCommandArgs;
}

// ---- results (phone -> server), validated before use ----
export const ResultSchemas = {
	READ_FILE: z.object({ content: z.string(), size: z.number().int().nonnegative() }),
	SEARCH: z.object({
		matches: z.array(z.object({ path: z.string().max(1024), line: z.number().int().positive().optional(), text: z.string().max(2000).optional() })).max(1000),
		truncated: z.boolean(),
	}),
	WRITE_FILE: z.object({ bytesWritten: z.number().int().nonnegative() }),
	PATCH: z.object({ applied: z.number().int().nonnegative() }),
	RUN_COMMAND: z.object({
		exitCode: z.number().int().nullable(),
		stdout: z.string(),
		stderr: z.string(),
		timedOut: z.boolean(),
	}),
} as const;
export type OpResult<O extends BridgeOp> = z.infer<(typeof ResultSchemas)[O]>;

export const ClientFrame = z.discriminatedUnion("type", [
	z.object({ v: z.literal(1), type: z.literal("hello"), client: z.string().max(100), ops: z.array(z.string()).max(20) }),
	z.object({
		v: z.literal(1),
		type: z.literal("response"),
		id: z.string().max(64),
		ok: z.boolean(),
		result: z.unknown().optional(),
		error: z.object({ code: z.string().max(32), message: z.string().max(500) }).optional(),
	}),
]);
