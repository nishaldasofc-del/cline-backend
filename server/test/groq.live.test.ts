/**
 * Live integration test against the REAL Groq API. Skipped unless GROQ_API_KEY is set:
 *   GROQ_API_KEY=gsk_... bun x vitest run test/groq.live.test.ts
 * Uses the production bundle (server/dist) and the reference device bridge.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReferenceDevice } from "./reference-bridge";

const key = process.env.GROQ_API_KEY;
const ADMIN = "live-admin-token-0123456789-abcdef";
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

describe.skipIf(!key)("live Groq (real OpenAI-compatible endpoint)", () => {
	it("agent reads a project file through the bridge using the real model", async () => {
		const port = await freePort();
		let out = "";
		const proc = spawn(process.execPath, [process.env.SERVER_DIST ?? join(__dirname, "..", "dist", "index.js")], {
			env: { PATH: process.env.PATH ?? "", PORT: String(port), GROQ_API_KEY: key!, SERVER_AUTH_TOKEN: ADMIN, CLINE_DATA_DIR: mkdtempSync(join(tmpdir(), "live-data-")), MODEL_ID: process.env.MODEL_ID ?? "llama-3.3-70b-versatile" },
		});
		proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
		try {
			for (let i = 0; i < 100 && !out.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
			const http = `http://127.0.0.1:${port}`;
			const j = async (m: string, p: string, t: string, b?: unknown) => (await fetch(http + p, { method: m, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }));
			const tok = (await (await j("POST", "/v1/admin/user-tokens", ADMIN, { userId: "live" })).json()).token;
			const pid = (await (await j("POST", "/v1/projects", tok, {})).json()).projectId;
			const sid = (await (await j("POST", `/v1/projects/${pid}/sessions`, tok)).json()).sessionId;
			const root = mkdtempSync(join(tmpdir(), "live-proj-"));
			writeFileSync(join(root, "secret-word.txt"), "The magic word is PINEAPPLE-42.\n");
			const dev = new ReferenceDevice(root); await dev.connect(`ws://127.0.0.1:${port}`, tok, pid);
			const res = await j("POST", `/v1/sessions/${sid}/messages`, tok, { prompt: "Use your read_files tool to read /workspace/secret-word.txt and tell me the magic word." });
			const text = await res.text();
			expect(text).toContain('"type":"done","ok":true');
			expect(dev.log.some((l) => l.op === "READ_FILE")).toBe(true);
			expect(text).toContain("PINEAPPLE-42");
			expect(text).not.toContain(key!);
			dev.close();
		} finally { proc.kill("SIGTERM"); }
	}, 120_000);
});
