import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computePatchChanges, type ToolExecutors } from "@cline/sdk";
import type { BridgeHub } from "./bridge/hub";
import { assertWritable, toProjectPath, toVirtual, VIRTUAL_ROOT } from "./bridge/paths";
import { BridgeError, type PatchChange } from "./bridge/protocol";
import { prepareCommand } from "./command-policy";
import type { ServerConfig } from "./config";
import { fetchPublicText } from "./web-fetch";

/**
 * THE SANDBOX SEAM. Everything the agent can touch is defined by the executors a
 * WorkspaceProvider returns; the server never calls fs/child_process on user data.
 *
 * `cwd` handed to ClineCore is an EMPTY server-side scratch directory. It exists
 * only so Cline's own loaders have somewhere harmless to look; the agent is told
 * its workspace is the virtual root `/workspace` and every tool goes through the
 * bridge to the user's device.
 */
export interface WorkspaceHandle {
	cwd: string;
	virtualRoot: string;
	toolExecutors: ToolExecutors;
	dispose?(): Promise<void>;
}
export interface WorkspaceProvider {
	open(input: { userId: string; projectId: string; sessionKey: string }): Promise<WorkspaceHandle>;
}

type Limits = Pick<ServerConfig, "commandsMode" | "commandAllowlist" | "commandTimeoutMs" | "enableWebFetch" | "maxFileBytes" | "bridgeOpTimeoutMs">;

const MAX_READ_LINES = 2000;
const MAX_SEARCH_RESULTS = 200;
const MAX_OUTPUT_BYTES = 64 * 1024;

function detectEol(s: string): string { return s.includes("\r\n") ? "\r\n" : "\n"; }
function withEol(s: string, eol: string): string { return s.replace(/\r\n/g, "\n").replace(/\n/g, eol); }
function utf8Len(s: string): number { return Buffer.byteLength(s, "utf8"); }

export class BridgeWorkspaceProvider implements WorkspaceProvider {
	constructor(private readonly hub: BridgeHub, private readonly scratchRoot: string, private readonly limits: Limits) {}

	async open(input: { userId: string; projectId: string; sessionKey: string }): Promise<WorkspaceHandle> {
		const { userId, projectId } = input; // bound here from server-validated values, never from model output
		const cwd = join(this.scratchRoot, "cwd", input.sessionKey);
		await mkdir(cwd, { recursive: true });
		const L = this.limits;
		const readText = async (rel: string): Promise<string> => {
			const r = (await this.hub.call(userId, projectId, "READ_FILE", { path: rel })) as { content: string; size: number };
			if (r.size > L.maxFileBytes || utf8Len(r.content) > L.maxFileBytes) throw new BridgeError("TOO_LARGE", `File exceeds ${L.maxFileBytes} bytes`);
			return r.content;
		};
		const writeText = async (rel: string, content: string) => {
			assertWritable(rel);
			if (utf8Len(content) > L.maxFileBytes) throw new BridgeError("TOO_LARGE", `Content exceeds ${L.maxFileBytes} bytes`);
			await this.hub.call(userId, projectId, "WRITE_FILE", { path: rel, content });
		};

		const toolExecutors: ToolExecutors = {
			readFile: async (req) => {
				const rel = toProjectPath(req.path);
				const lines = (await readText(rel)).split(/\r\n|\n/);
				const start = Math.max(1, Number(req.start_line ?? 1));
				const end = Math.min(lines.length, Number(req.end_line ?? lines.length), start + MAX_READ_LINES - 1);
				if (start > lines.length) throw new Error(`start_line ${start} is past end of file (${lines.length} lines)`);
				const w = String(end).length;
				const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(w, " ")} | ${l.length > 2000 ? `${l.slice(0, 2000)} [line truncated]` : l}`).join("\n");
				return end < lines.length ? `${body}\n[Showing lines ${start}-${end} of ${lines.length}. Use start_line/end_line to read more.]` : body;
			},

			search: async (query) => {
				if (typeof query !== "string" || query.length === 0 || query.length > 500) throw new Error("Invalid search pattern");
				try { new RegExp(query); } catch { throw new Error("Invalid regular expression"); }
				const r = (await this.hub.call(userId, projectId, "SEARCH", { pattern: query, maxResults: MAX_SEARCH_RESULTS })) as { matches: Array<{ path: string; line?: number; text?: string }>; truncated: boolean };
				if (r.matches.length === 0) return "No matches found.";
				const out = r.matches.map((m) => `${toVirtual(toProjectPath(m.path))}${m.line ? `:${m.line}` : ""}${m.text !== undefined ? `: ${m.text}` : ""}`);
				return out.join("\n") + (r.truncated ? `\n[Results truncated at ${MAX_SEARCH_RESULTS}]` : "");
			},

			bash: async (command) => {
				const argv = prepareCommand(command as string | { command: string; args?: string[] }, { mode: L.commandsMode, allowlist: L.commandAllowlist });
				const r = (await this.hub.call(userId, projectId, "RUN_COMMAND", { argv, timeoutMs: L.commandTimeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES }, L.commandTimeoutMs + 5_000)) as { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
				const clip = (s: string) => (s.length > MAX_OUTPUT_BYTES ? `${s.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]` : s);
				const head = r.timedOut ? `Command timed out after ${L.commandTimeoutMs}ms` : `Exit code: ${r.exitCode}`;
				return [head, r.stdout && `stdout:\n${clip(r.stdout)}`, r.stderr && `stderr:\n${clip(r.stderr)}`].filter(Boolean).join("\n");
			},

			editor: async (input) => {
				const rel = toProjectPath(input.path);
				assertWritable(rel);
				const shown = toVirtual(rel);
				let current: string | undefined;
				try { current = await readText(rel); } catch (e) { if (!(e instanceof BridgeError && e.code === "NOT_FOUND")) throw e; }
				if (input.insert_line != null) {
					if (current === undefined) throw new Error(`${shown} does not exist`);
					const eol = detectEol(current);
					const lines = current.split(/\r\n|\n/);
					const max = lines.length + 1;
					if (input.insert_line < 1 || input.insert_line > max) throw new Error(`Invalid insert_line: ${input.insert_line}. Must be 1-${max} (use ${max} to append).`);
					lines.splice(input.insert_line - 1, 0, ...input.new_text.split(/\r\n|\n/));
					await writeText(rel, lines.join(eol));
					return `Inserted content at line ${input.insert_line} in ${shown}.`;
				}
				if (current === undefined) {
					await writeText(rel, withEol(input.new_text, "\n"));
					return `File created successfully at: ${shown}`;
				}
				if (input.old_text == null) {
					throw new Error(`${shown} already exists, but \`old_text\` was ${input.old_text === null ? "null" : "omitted"}. Set \`old_text\` to the exact text to replace, or provide \`insert_line\`.`);
				}
				const eol = detectEol(current);
				const oldT = withEol(input.old_text, eol);
				const first = current.indexOf(oldT);
				if (first === -1) throw new Error(`No replacement performed: text not found in ${shown}.`);
				if (current.indexOf(oldT, first + 1) !== -1) throw new Error(`No replacement performed: multiple occurrences of text found in ${shown}.`);
				const updated = current.slice(0, first) + withEol(input.new_text ?? "", eol) + current.slice(first + oldT.length);
				await writeText(rel, updated);
				return `Edited ${shown}`;
			},

			applyPatch: async (input) => {
				// Reuse Cline's real patch parser/applier logic on a throwaway staging dir that
				// holds ONLY the files this patch references, then send explicit changes to the device.
				const rewritten: string[] = [];
				const reads = new Set<string>();
				for (const line of input.input.split(/\r?\n/)) {
					const m = line.match(/^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+)$/);
					if (!m) { rewritten.push(line); continue; }
					const rel = toProjectPath(m[2].trim());
					assertWritable(rel);
					if (!m[1].startsWith("*** Move to")) reads.add(rel);
					rewritten.push(`${m[1]}${rel}`);
				}
				if (reads.size > 50) throw new Error("Patch touches too many files");
				const stage = await mkdtemp(join(this.scratchRoot, "patch-"));
				try {
					for (const rel of reads) {
						try {
							const content = await readText(rel);
							await mkdir(dirname(join(stage, rel)), { recursive: true });
							await writeFile(join(stage, rel), content);
						} catch (e) { if (!(e instanceof BridgeError && e.code === "NOT_FOUND")) throw e; }
					}
					const { changes } = await computePatchChanges(rewritten.join("\n"), stage, { restrictToCwd: true });
					const out: PatchChange[] = [];
					for (const [path, ch] of Object.entries(changes)) {
						const rel = toProjectPath(path);
						assertWritable(rel);
						if (ch.type === "delete") { out.push({ action: "delete", path: rel }); continue; }
						if (ch.newContent === undefined) throw new Error(`No content for ${rel}`);
						if (utf8Len(ch.newContent) > L.maxFileBytes) throw new BridgeError("TOO_LARGE", `Content exceeds ${L.maxFileBytes} bytes`);
						if (ch.movePath) {
							const to = toProjectPath(ch.movePath);
							assertWritable(to);
							out.push({ action: "write", path: to, content: ch.newContent }, { action: "delete", path: rel });
						} else out.push({ action: "write", path: rel, content: ch.newContent });
					}
					if (out.length === 0) return "Patch produced no changes.";
					await this.hub.call(userId, projectId, "PATCH", { changes: out });
					return `Patch applied:\n${out.map((c) => `${toVirtual(c.path)}: [${c.action === "delete" ? "deleted" : "written"}]`).join("\n")}`;
				} finally {
					await rm(stage, { recursive: true, force: true });
				}
			},

			webFetch: async (url) => {
				if (!L.enableWebFetch) throw new Error("Web fetch is disabled on this deployment");
				return `Fetched ${url}\n\n${await fetchPublicText(url)}`;
			},
		};

		return {
			cwd,
			virtualRoot: VIRTUAL_ROOT,
			toolExecutors,
			dispose: async () => { await rm(cwd, { recursive: true, force: true }); },
		};
	}
}
