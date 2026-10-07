/**
 * Reference DEVICE-SIDE bridge client (what the Android app must implement).
 * Executes protocol ops confined to one project directory. It deliberately
 * re-validates every path itself (never trusting the server) and refuses
 * symlink escapes via realpath. No shell is ever used for RUN_COMMAND.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { WebSocket } from "ws";

class Denied extends Error { code = "DENIED"; }
class NotFound extends Error { code = "NOT_FOUND"; }

export class ReferenceDevice {
	ws!: WebSocket;
	readonly log: Array<{ op: string; args: unknown }> = [];
	constructor(private readonly root: string) {}

	private async safe(rel: unknown, mustExist = true): Promise<string> {
		if (typeof rel !== "string" || rel.includes("\0") || rel.startsWith("/") || rel.split("/").includes("..")) throw new Denied("bad path");
		const base = await realpath(this.root);
		const full = resolve(base, rel);
		if (full !== base && !full.startsWith(base + sep)) throw new Denied("outside project");
		// Resolve symlinks on the deepest existing ancestor and re-check containment.
		let probe = full;
		for (;;) {
			try { const real = await realpath(probe); if (real !== base && !real.startsWith(base + sep)) throw new Denied("symlink escape"); break; }
			catch (e) { if (e instanceof Denied) throw e; if (probe === base) break; probe = dirname(probe); }
		}
		if (mustExist) { try { await lstat(full); } catch { throw new NotFound("not found"); } }
		return full;
	}

	private async walk(dir: string, out: string[], base: string): Promise<void> {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			if (e.name === ".git" || e.name === "node_modules" || e.isSymbolicLink()) continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) await this.walk(p, out, base); else out.push(p.slice(base.length + 1));
		}
	}

	private async handle(op: string, a: any): Promise<unknown> {
		switch (op) {
			case "READ_FILE": {
				const p = await this.safe(a.path);
				const st = await stat(p);
				if (st.size > 1024 * 1024) { const e: any = new Error("too large"); e.code = "TOO_LARGE"; throw e; }
				return { content: await readFile(p, "utf8"), size: st.size };
			}
			case "WRITE_FILE": {
				const p = await this.safe(a.path, false);
				await mkdir(dirname(p), { recursive: true });
				await writeFile(p, a.content);
				return { bytesWritten: Buffer.byteLength(a.content) };
			}
			case "PATCH": {
				for (const c of a.changes) await this.safe(c.path, false); // validate ALL before applying ANY
				for (const c of a.changes) {
					const p = await this.safe(c.path, false);
					if (c.action === "delete") await rm(p, { force: true });
					else { await mkdir(dirname(p), { recursive: true }); await writeFile(p, c.content); }
				}
				return { applied: a.changes.length };
			}
			case "SEARCH": {
				const base = await realpath(this.root);
				const files: string[] = []; await this.walk(base, files, base);
				const re = a.pattern ? new RegExp(a.pattern) : undefined;
				const matches: Array<{ path: string; line?: number; text?: string }> = [];
				for (const f of files) {
					if (matches.length >= a.maxResults) break;
					if (!re) { matches.push({ path: f }); continue; }
					const lines = (await readFile(join(base, f), "utf8").catch(() => "")).split("\n");
					lines.forEach((t, i) => { if (re.test(t) && matches.length < a.maxResults) matches.push({ path: f, line: i + 1, text: t.slice(0, 500) }); });
				}
				return { matches, truncated: matches.length >= a.maxResults };
			}
			case "RUN_COMMAND": {
				const base = await realpath(this.root);
				return await new Promise((res) => {
					// Minimal env: NOTHING inherited from the host process.
					const child = spawn(a.argv[0], a.argv.slice(1), { cwd: base, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base }, shell: false });
					let stdout = "", stderr = "", timedOut = false;
					const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, a.timeoutMs);
					child.stdout.on("data", (d) => { if (stdout.length < a.maxOutputBytes) stdout += d; });
					child.stderr.on("data", (d) => { if (stderr.length < a.maxOutputBytes) stderr += d; });
					child.on("error", (e) => { clearTimeout(t); res({ exitCode: 127, stdout, stderr: String(e.message), timedOut }); });
					child.on("close", (code) => { clearTimeout(t); res({ exitCode: code, stdout, stderr, timedOut }); });
				});
			}
			default: { const e: any = new Error("unsupported"); e.code = "UNSUPPORTED"; throw e; }
		}
	}

	connect(url: string, token: string, projectId: string): Promise<void> {
		return new Promise((resolveP, rejectP) => {
			this.ws = new WebSocket(`${url}/v1/bridge?projectId=${projectId}`, "cline-bridge.v1", { headers: { authorization: `Bearer ${token}` } });
			this.ws.on("error", rejectP);
			this.ws.on("unexpected-response", (_req, res) => rejectP(new Error(`HTTP ${res.statusCode} ${res.headers["x-cline-error"] ?? ""}`.trim())));
			this.ws.on("message", async (data) => {
				const f = JSON.parse(data.toString());
				if (f.type === "hello") { this.ws.send(JSON.stringify({ v: 1, type: "hello", client: "reference-device", ops: f.ops })); return resolveP(); }
				if (f.type !== "request") return;
				this.log.push({ op: f.op, args: f.args });
				try { this.ws.send(JSON.stringify({ v: 1, type: "response", id: f.id, ok: true, result: await this.handle(f.op, f.args) })); }
				catch (e: any) { this.ws.send(JSON.stringify({ v: 1, type: "response", id: f.id, ok: false, error: { code: e.code ?? "IO", message: String(e.message).slice(0, 200) } })); }
			});
		});
	}
	close() { this.ws?.close(); }
}
