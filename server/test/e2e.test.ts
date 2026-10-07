import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReferenceDevice } from "./reference-bridge";
import { startMockModel } from "./mock-model";

const DIST = process.env.SERVER_DIST ?? join(__dirname, "..", "dist", "index.js");
const GROQ_KEY = "gsk_TEST_SECRET_KEY_do_not_leak_0001";
const ADMIN = "admin-secret-token-0123456789-abcdef";

const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

interface Srv { proc: ChildProcess; port: number; http: string; ws: string; out: () => string; stop(): Promise<void> }
async function startServer(env: Record<string, string>): Promise<Srv> {
	const port = await freePort();
	let out = "";
	const proc = spawn(process.execPath, [DIST], { env: { PATH: process.env.PATH ?? "", PORT: String(port), GROQ_API_KEY: GROQ_KEY, SERVER_AUTH_TOKEN: ADMIN, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	proc.stdout!.on("data", (d) => (out += d)); proc.stderr!.on("data", (d) => (out += d));
	await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`server start timeout:\n${out}`)), 30_000); const i = setInterval(() => { if (out.includes("listening")) { clearInterval(i); clearTimeout(t); res(); } }, 50); proc.on("exit", () => rej(new Error(`server exited:\n${out}`))); });
	return { proc, port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, out: () => out, stop: () => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode !== null) return r(); proc.once("exit", () => r()); proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 8000); }) };
}

async function api(srv: Srv, method: string, path: string, token?: string, body?: unknown, raw = false) {
	const res = await fetch(`${srv.http}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, text, json: !raw && text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined, headers: res.headers };
}
const mint = async (srv: Srv, userId: string) => (await api(srv, "POST", "/v1/admin/user-tokens", ADMIN, { userId })).json.token as string;
const sse = (text: string) => text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
const toolResults = (req: any): string[] => req.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.stringify(m.content));

type Step = { tool?: { name: string; args: unknown }; text?: string };
let plan: Step[][] = [];

describe("e2e: Render-style server + bridge + Cline agent (mock OpenAI-compatible model)", () => {
	let model: Awaited<ReturnType<typeof startMockModel>>;
	let srv: Srv; let dataDir: string; let devRoot: string; let outside: string;
	let alice = ""; let bob = ""; let projectId = ""; let sessionId = ""; let device: ReferenceDevice;

	beforeAll(async () => {
		if (!existsSync(DIST)) throw new Error("Run `bun run build:server` first");
		model = await startMockModel(({ step }) => plan[step] ?? [{ text: "done" }]);
		dataDir = mkdtempSync(join(tmpdir(), "cas-data-"));
		const base = mkdtempSync(join(tmpdir(), "cas-dev-"));
		devRoot = join(base, "project"); outside = join(base, "outside");
		mkdirSync(devRoot); mkdirSync(outside);
		writeFileSync(join(devRoot, "hello.txt"), "hello world\nline two\n");
		writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE-PROJECT");
		symlinkSync(outside, join(devRoot, "escape")); // symlink pointing out of the project
		// Explicit overrides: this suite exercises the busy-session (409) path, which the Render Free defaults (1/1) would pre-empt with 503.
		srv = await startServer({ CLINE_DATA_DIR: dataDir, BASE_URL: model.url, MODEL_ID: "llama-3.3-70b-versatile", MAX_BODY_BYTES: "131072", COMMAND_TIMEOUT_MS: "20000", MAX_CONCURRENT_TURNS: "4", MAX_CONCURRENT_TURNS_PER_USER: "2" });
	}, 60_000);
	afterAll(async () => { device?.close(); await srv?.stop(); await model?.close(); });

	it("health, PORT handling, and auth gates", async () => {
		expect((await api(srv, "GET", "/healthz")).json).toEqual({ ok: true });
		expect(srv.out()).toContain(`0.0.0.0:${srv.port}`);
		expect((await api(srv, "GET", "/v1/info")).status).toBe(401);
		expect((await api(srv, "GET", "/v1/info", "v1.fake.token")).status).toBe(401);
		expect((await api(srv, "GET", "/v1/info", ADMIN)).status).toBe(401); // admin secret is not a user token
		expect((await api(srv, "POST", "/v1/admin/user-tokens", "wrong", { userId: "a" })).status).toBe(401);
		expect((await api(srv, "POST", "/v1/admin/user-tokens", ADMIN, { userId: "../etc" })).status).toBe(400);
		alice = await mint(srv, "alice"); bob = await mint(srv, "bob");
		expect((await api(srv, "GET", "/v1/info", alice)).status).toBe(200);
	});

	it("project ownership and cross-user isolation", async () => {
		const p = await api(srv, "POST", "/v1/projects", alice, { name: "demo" });
		expect(p.status).toBe(201); projectId = p.json.projectId;
		expect((await api(srv, "GET", "/v1/projects", bob)).json.projects).toEqual([]);
		expect((await api(srv, "POST", `/v1/projects/${projectId}/sessions`, bob)).status).toBe(404);
		expect((await api(srv, "DELETE", `/v1/projects/${projectId}`, bob)).status).toBe(404);
		// bob cannot attach a device to alice's project
		const hijack = new ReferenceDevice(devRoot);
		await expect(hijack.connect(srv.ws, bob, projectId)).rejects.toThrow(/404/);
		await expect(hijack.connect(srv.ws, "nope", projectId)).rejects.toThrow(/401/);
		// unauthenticated websocket
		await expect(new Promise((res, rej) => { const w = new WebSocket(`${srv.ws}/v1/bridge?projectId=${projectId}`, "cline-bridge.v1"); w.on("open", res); w.on("error", rej); w.on("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`))); })).rejects.toThrow(/401/);
		// path-like project ids never reach the filesystem
		expect((await api(srv, "POST", `/v1/projects/..%2F..%2Fetc/sessions`, alice)).status).toBe(404);
	});

	it("no device connected -> turn is refused cleanly", async () => {
		const s = await api(srv, "POST", `/v1/projects/${projectId}/sessions`, alice);
		expect(s.status).toBe(201); sessionId = s.json.sessionId;
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "hi" });
		expect(r.status).toBe(409); expect(r.text).toContain("bridge_offline");
	}, 30_000);

	it("agent reads a file through the bridge; SSE streams; Groq key is the bearer upstream", async () => {
		device = new ReferenceDevice(devRoot);
		await device.connect(srv.ws, alice, projectId);
		plan = [[{ tool: { name: "read_files", args: { files: [{ path: "/workspace/hello.txt" }] } } }], [{ text: "The file says hello." }]];
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "first message: read hello.txt" }, true);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/event-stream");
		const events = sse(r.text);
		expect(events.at(-1)).toEqual({ type: "done", ok: true });
		expect(events.some((e) => e.type === "agent_event")).toBe(true);
		expect(device.log.find((l) => l.op === "READ_FILE")?.args).toEqual({ path: "hello.txt" }); // virtual root stripped
		expect(model.auth.every((a) => a === `Bearer ${GROQ_KEY}`)).toBe(true);
		expect(toolResults(model.requests.at(-1)).join()).toContain("hello world");
	}, 60_000);

	it("editor, search, and commands work through the bridge", async () => {
		plan = [
			[{ tool: { name: "editor", args: { path: "/workspace/new/dir/file.txt", new_text: "created\n" } } }],
			[{ tool: { name: "editor", args: { path: "/workspace/hello.txt", old_text: "hello", new_text: "HELLO" } } }],
			[{ tool: { name: "search_codebase", args: { queries: ["HELLO"] } } }],
			[{ tool: { name: "run_commands", args: { commands: ["ls /workspace"] } } }],
			[{ text: "all done" }],
		];
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "do edits" }, true);
		expect(sse(r.text).at(-1)).toEqual({ type: "done", ok: true });
		expect(readFileSync(join(devRoot, "new/dir/file.txt"), "utf8")).toBe("created\n");
		expect(readFileSync(join(devRoot, "hello.txt"), "utf8")).toContain("HELLO world");
		const results = toolResults(model.requests.at(-1)).join("\n");
		expect(results).toContain("/workspace/hello.txt:1"); // search results are shown as virtual paths
		expect(results).toMatch(/hello\.txt/); expect(results).toContain("Exit code: 0");
	}, 60_000);

	it("path traversal and escapes are blocked (server-side) and symlinks by the device", async () => {
		const before = device.log.length;
		plan = [
			[{ tool: { name: "read_files", args: { files: [{ path: "/etc/passwd" }] } } }],
			[{ tool: { name: "read_files", args: { files: [{ path: "/workspace/../outside/secret.txt" }] } } }],
			[{ tool: { name: "read_files", args: { files: [{ path: "../outside/secret.txt" }] } } }],
			[{ tool: { name: "editor", args: { path: "/etc/cron.d/evil", new_text: "x" } } }],
			[{ tool: { name: "editor", args: { path: "/workspace/.git/hooks/pre-commit", new_text: "#!/bin/sh\nid" } } }],
			[{ tool: { name: "run_commands", args: { commands: ["cat /etc/passwd"] } } }],
			[{ tool: { name: "run_commands", args: { commands: ["cat hello.txt | sh"] } } }],
			[{ tool: { name: "run_commands", args: { commands: ["curl http://example.com"] } } }],
			[{ tool: { name: "read_files", args: { files: [{ path: "/workspace/escape/secret.txt" }] } } }], // symlink: reaches device, device must refuse
			[{ text: "tried everything" }],
		];
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "escape attempts" }, true);
		expect(sse(r.text).at(-1)?.type).toBe("done");
		const blocked = device.log.slice(before);
		// Only the symlink read may have reached the device; every other attempt died on the server.
		expect(blocked.map((l) => l.op)).toEqual(["READ_FILE"]);
		expect(blocked[0].args).toEqual({ path: "escape/secret.txt" });
		const allResults = model.requests.flatMap(toolResults).join("\n");
		expect(allResults).not.toContain("TOP-SECRET-OUTSIDE-PROJECT");
		expect(JSON.stringify(model.requests)).not.toContain("TOP-SECRET-OUTSIDE-PROJECT");
		expect(existsSync(join(devRoot, ".git"))).toBe(false);
		expect(allResults).toMatch(/DENIED|symlink escape|outside project/); // the device itself refused the symlink
		expect(allResults).toContain("Path traversal is not allowed");
		expect(allResults).toContain("is not allowed. Allowed:");
	}, 90_000);

	it("device environment is isolated from server secrets", async () => {
		plan = [[{ tool: { name: "run_commands", args: { commands: [`node -e "console.log('KEY=' + String(process.env.GROQ_API_KEY) + ' TOKEN=' + String(process.env.SERVER_AUTH_TOKEN))"`] } } }], [{ text: "ok" }]];
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "print env" }, true);
		expect(sse(r.text).at(-1)).toEqual({ type: "done", ok: true });
		expect(toolResults(model.requests.at(-1)).join()).toContain("KEY=undefined TOKEN=undefined");
	}, 60_000);

	it("secrets and server paths never reach the client or the model", async () => {
		const all = JSON.stringify(model.requests);
		expect(all).not.toContain(GROQ_KEY); expect(all).not.toContain(ADMIN); expect(all).not.toContain(dataDir);
		plan = [[{ text: `echoing ${GROQ_KEY} and ${ADMIN}` }]];
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "leak?" }, true);
		expect(r.text).not.toContain(GROQ_KEY); expect(r.text).not.toContain(ADMIN);
		expect(srv.out()).not.toContain(GROQ_KEY); expect(srv.out()).not.toContain(ADMIN);
	}, 60_000);

	it("other users cannot touch the session; request size limits hold", async () => {
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, bob, { prompt: "hi" })).status).toBe(404);
		expect((await api(srv, "DELETE", `/v1/sessions/${sessionId}`, bob)).status).toBe(404);
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "x".repeat(200_000) })).status).toBe(413);
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "x".repeat(40_000) })).status).toBe(413);
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "" })).status).toBe(400);
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, "{not json")).status).toBe(400);
	});

	it("client disconnect aborts the turn and frees the session; concurrent turns are refused", async () => {
		model.delay.ms = 2500; plan = [[{ text: "slow answer" }]];
		const ac = new AbortController();
		const slow = fetch(`${srv.http}/v1/sessions/${sessionId}/messages`, { method: "POST", signal: ac.signal, headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "slow" }) }).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 600));
		const second = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "parallel" });
		expect(second.status).toBe(409);
		ac.abort(); await slow;
		let free = false;
		for (let i = 0; i < 40 && !free; i++) { await new Promise((r) => setTimeout(r, 250)); free = (await api(srv, "GET", "/v1/info", alice)).json.activeTurns === 0; }
		expect(free).toBe(true);
		model.delay.ms = 0; plan = [[{ text: "fast again" }]];
		const ok = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "after abort" }, true);
		expect(sse(ok.text).at(-1)).toEqual({ type: "done", ok: true });
	}, 60_000);

	it("restart: ephemeral metadata is lost cleanly (no corruption, no fake resume); device re-authenticates", async () => {
		device.close(); await new Promise((r) => setTimeout(r, 300));
		const offline = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "device gone" });
		expect(offline.status).toBe(409);
		const oldInstance = (await api(srv, "GET", "/v1/info", alice)).json.instanceId;
		await srv.stop();
		// Same scratch base as before: a restarted process must NOT pick up anything from the previous one.
		srv = await startServer({ CLINE_DATA_DIR: dataDir, BASE_URL: model.url, MODEL_ID: "llama-3.3-70b-versatile" });
		const info = (await api(srv, "GET", "/v1/info", alice)).json; // stateless user token still verifies
		expect(info.instanceId).not.toBe(oldInstance); expect(info.storage).toBe("ephemeral");
		expect((await api(srv, "GET", "/v1/projects", alice)).json.projects).toEqual([]);
		// Old ids give a clear, recoverable 404 (same shape as a foreign/missing id) - never a partial session.
		const gone = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "after restart" });
		expect(gone.status).toBe(404); expect(gone.json.error).toMatch(/expired|restart/); expect(gone.json.code).toBe("session_not_found");
		expect((await api(srv, "POST", `/v1/projects/${projectId}/sessions`, alice)).status).toBe(404);
		// The device's reconnect re-authenticates normally and is refused for the vanished project id.
		await expect(new ReferenceDevice(devRoot).connect(srv.ws, alice, projectId)).rejects.toThrow(/HTTP 404 project_not_found/); // machine-readable: device knows to recreate, not retry
		await expect(new ReferenceDevice(devRoot).connect(srv.ws, "bad.token", projectId)).rejects.toThrow(/HTTP 401/); // a bad token is distinguishable from a stale project
		expect(readdirSync(dataDir).every((n) => n.startsWith("run-"))).toBe(true); // no projects.json / sessions.json anywhere
		// Recovery path: recreate project + session, reconnect the device; the old transcript is NOT replayed.
		projectId = (await api(srv, "POST", "/v1/projects", alice, { name: "demo" })).json.projectId;
		sessionId = (await api(srv, "POST", `/v1/projects/${projectId}/sessions`, alice)).json.sessionId;
		device = new ReferenceDevice(devRoot); await device.connect(srv.ws, alice, projectId);
		const n = model.requests.length;
		plan = [[{ text: "fresh start." }]];
		const r = await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "second message after restart" }, true);
		expect(sse(r.text).at(-1)).toEqual({ type: "done", ok: true });
		// (an aborted "slow" request from an earlier test may still arrive late, so find ours by content)
		const body = JSON.stringify(model.requests.slice(n).find((q) => JSON.stringify(q).includes("second message after restart")));
		expect(body).toContain("second message after restart");
		expect(body).not.toContain("first message: read hello.txt");
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, bob, { prompt: "x" })).status).toBe(404);
	}, 90_000);

	it("deleting a project removes its sessions and disconnects the device", async () => {
		expect((await api(srv, "DELETE", `/v1/projects/${projectId}`, alice)).status).toBe(204);
		expect((await api(srv, "POST", `/v1/sessions/${sessionId}/messages`, alice, { prompt: "x" })).status).toBe(404);
		await new Promise((r) => setTimeout(r, 300));
		expect(device.ws.readyState).not.toBe(WebSocket.OPEN);
	}, 30_000);
});

describe("e2e: apply_patch tool path (model id containing 'gpt' routes to apply_patch)", () => {
	let model: Awaited<ReturnType<typeof startMockModel>>; let srv: Srv; let device: ReferenceDevice; let root: string;
	let tok = ""; let sid = ""; let pid = "";
	beforeAll(async () => {
		model = await startMockModel(({ step }) => plan[step] ?? [{ text: "done" }]);
		root = mkdtempSync(join(tmpdir(), "cas-patch-")); writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n"); writeFileSync(join(root, "old.txt"), "bye\n");
		srv = await startServer({ CLINE_DATA_DIR: mkdtempSync(join(tmpdir(), "cas-data2-")), BASE_URL: model.url, MODEL_ID: "openai/gpt-oss-120b", COMMANDS_MODE: "off" });
		tok = await mint(srv, "carol"); pid = (await api(srv, "POST", "/v1/projects", tok, {})).json.projectId;
		sid = (await api(srv, "POST", `/v1/projects/${pid}/sessions`, tok)).json.sessionId;
		device = new ReferenceDevice(root); await device.connect(srv.ws, tok, pid);
	}, 60_000);
	afterAll(async () => { device?.close(); await srv?.stop(); await model?.close(); });

	it("applies a real Cline patch via PATCH, blocks escapes, and hides disabled tools", async () => {
		const patch = ["*** Begin Patch", "*** Update File: /workspace/a.txt", "@@", " one", "-two", "+TWO", " three", "*** Add File: /workspace/sub/b.txt", "+new file", "*** Delete File: /workspace/old.txt", "*** End Patch"].join("\n");
		const evil = ["*** Begin Patch", "*** Add File: /etc/evil", "+x", "*** End Patch"].join("\n");
		const evil2 = ["*** Begin Patch", "*** Add File: /workspace/../../evil", "+x", "*** End Patch"].join("\n");
		plan = [[{ tool: { name: "apply_patch", args: { input: patch } } }], [{ tool: { name: "apply_patch", args: { input: evil } } }], [{ tool: { name: "apply_patch", args: { input: evil2 } } }], [{ tool: { name: "run_commands", args: { commands: ["ls"] } } }], [{ text: "patched" }]];
		const r = await api(srv, "POST", `/v1/sessions/${sid}/messages`, tok, { prompt: "patch it" }, true);
		expect(sse(r.text).at(-1)).toEqual({ type: "done", ok: true });
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
		expect(readFileSync(join(root, "sub/b.txt"), "utf8")).toContain("new file");
		expect(existsSync(join(root, "old.txt"))).toBe(false);
		expect(device.log.filter((l) => l.op === "PATCH")).toHaveLength(1); // the two evil patches never reached the device
		expect(existsSync("/etc/evil")).toBe(false);
		const tools = model.requests[0].tools.map((t: any) => t.function.name);
		expect(tools).toContain("apply_patch"); expect(tools).not.toContain("run_commands"); expect(tools).not.toContain("fetch_web_content");
	}, 90_000);
});

describe("e2e: Render Free contract (ephemeral storage, limits, reconnect, shutdown)", () => {
	let model: Awaited<ReturnType<typeof startMockModel>>; let srv: Srv; let root: string; let base: string;
	const dirs = () => (existsSync(base) ? readdirSync(base) : []);
	beforeAll(async () => {
		model = await startMockModel(({ step }) => plan[step] ?? [{ text: "done" }]);
		root = mkdtempSync(join(tmpdir(), "cas-free-")); writeFileSync(join(root, "a.txt"), "alpha\n");
		// A scratch base that does not exist yet (and no /var/data anywhere): the server must create it itself.
		base = join(mkdtempSync(join(tmpdir(), "cas-empty-")), "nested", "does-not-exist-yet");
		srv = await startServer({ CLINE_DATA_DIR: base, BASE_URL: model.url, MODEL_ID: "llama-3.3-70b-versatile", SESSION_IDLE_MS: "1000" });
	}, 60_000);
	afterAll(async () => { await srv?.stop(); await model?.close(); });

	it("starts on an empty filesystem without /var/data; /healthz needs no auth and never touches model or device", async () => {
		expect(srv.out()).not.toContain("/var/data");
		expect(dirs().filter((n) => n.startsWith("run-"))).toHaveLength(1);
		const t0 = Date.now(); const before = model.requests.length;
		const h = await api(srv, "GET", "/healthz");
		expect(h.status).toBe(200); expect(h.json).toEqual({ ok: true }); expect(Date.now() - t0).toBeLessThan(500);
		expect(model.requests.length).toBe(before);
	});

	it("defaults to conservative concurrency (1 turn globally, 1 per user) and reports ephemeral storage", async () => {
		const tok = await mint(srv, "dave");
		const info = (await api(srv, "GET", "/v1/info", tok)).json;
		expect(info).toMatchObject({ storage: "ephemeral", maxConcurrentTurns: 1, maxConcurrentTurnsPerUser: 1 });
		expect(JSON.stringify(info)).not.toContain(base);
	});

	it("concurrency caps hold: second turn (same or other user) gets 503 while one runs", async () => {
		const [u1, u2] = [await mint(srv, "erin"), await mint(srv, "frank")];
		const mk = async (u: string) => {
			const pid = (await api(srv, "POST", "/v1/projects", u, {})).json.projectId;
			const sid = (await api(srv, "POST", `/v1/projects/${pid}/sessions`, u)).json.sessionId;
			const d = new ReferenceDevice(root); await d.connect(srv.ws, u, pid);
			return { pid, sid, d };
		};
		const a = await mk(u1); const a2 = await mk(u1); const b = await mk(u2);
		model.delay.ms = 2500; plan = [[{ text: "slow" }]];
		const ac = new AbortController();
		const slow = fetch(`${srv.http}/v1/sessions/${a.sid}/messages`, { method: "POST", signal: ac.signal, headers: { authorization: `Bearer ${u1}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "slow" }) }).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 600));
		expect((await api(srv, "POST", `/v1/sessions/${a2.sid}/messages`, u1, { prompt: "x" })).status).toBe(503); // per-user cap
		expect((await api(srv, "POST", `/v1/sessions/${b.sid}/messages`, u2, { prompt: "x" })).status).toBe(503); // global cap
		ac.abort(); await slow; model.delay.ms = 0;
		for (let i = 0; i < 40; i++) { if ((await api(srv, "GET", "/v1/info", u1)).json.activeTurns === 0) break; await new Promise((r) => setTimeout(r, 250)); }
		plan = [[{ text: "ok" }]];
		expect(sse((await api(srv, "POST", `/v1/sessions/${b.sid}/messages`, u2, { prompt: "now free" }, true)).text).at(-1)).toEqual({ type: "done", ok: true });
		for (const x of [a, a2, b]) x.d.close();
	}, 90_000);

	it("a newer bridge connection replaces the stale one; ops only reach the live device", async () => {
		const u = await mint(srv, "gina");
		const pid = (await api(srv, "POST", "/v1/projects", u, {})).json.projectId;
		const sid = (await api(srv, "POST", `/v1/projects/${pid}/sessions`, u)).json.sessionId;
		const d1 = new ReferenceDevice(root); await d1.connect(srv.ws, u, pid);
		const closed = new Promise<number>((r) => d1.ws.once("close", (code) => r(code)));
		const d2 = new ReferenceDevice(root); await d2.connect(srv.ws, u, pid);
		expect(await closed).toBe(4000);
		expect((await api(srv, "GET", "/v1/projects", u)).json.projects[0].bridgeConnected).toBe(true);
		plan = [[{ tool: { name: "read_files", args: { files: [{ path: "/workspace/a.txt" }] } } }], [{ text: "read" }]];
		expect(sse((await api(srv, "POST", `/v1/sessions/${sid}/messages`, u, { prompt: "read a" }, true)).text).at(-1)).toEqual({ type: "done", ok: true });
		expect(d1.log.length).toBe(0); expect(d2.log.some((l) => l.op === "READ_FILE")).toBe(true);
		d2.close(); await new Promise((r) => setTimeout(r, 300));
		expect((await api(srv, "GET", "/v1/projects", u)).json.projects[0].bridgeConnected).toBe(false);
		const d3 = new ReferenceDevice(root); await d3.connect(srv.ws, u, pid); // plain reconnect after a drop
		expect((await api(srv, "GET", "/v1/projects", u)).json.projects[0].bridgeConnected).toBe(true);
		d3.close();
	}, 60_000);

	it("idle sessions are evicted from memory and re-opened from the in-process transcript (active-turn path needs no persistent disk)", async () => {
		const u = await mint(srv, "hank");
		const pid = (await api(srv, "POST", "/v1/projects", u, {})).json.projectId;
		const sid = (await api(srv, "POST", `/v1/projects/${pid}/sessions`, u)).json.sessionId;
		const d = new ReferenceDevice(root); await d.connect(srv.ws, u, pid);
		plan = [[{ text: "noted: the codeword is pelican" }]];
		expect(sse((await api(srv, "POST", `/v1/sessions/${sid}/messages`, u, { prompt: "remember pelican" }, true)).text).at(-1)).toEqual({ type: "done", ok: true });
		for (let i = 0; i < 40 && (await api(srv, "GET", "/v1/info", u)).json.liveSessions > 0; i++) await new Promise((r) => setTimeout(r, 500)); // reaper evicts (idle 1s)
		expect((await api(srv, "GET", "/v1/info", u)).json.liveSessions).toBe(0);
		const n = model.requests.length; plan = [[{ text: "pelican" }]];
		expect(sse((await api(srv, "POST", `/v1/sessions/${sid}/messages`, u, { prompt: "what was the codeword?" }, true)).text).at(-1)).toEqual({ type: "done", ok: true });
		expect(JSON.stringify(model.requests[n])).toContain("remember pelican");
		d.close();
	}, 90_000);

	it("SIGTERM during a turn ends the SSE stream cleanly (server_restarting), closes the bridge and removes scratch data", async () => {
		const u = await mint(srv, "ivy");
		const pid = (await api(srv, "POST", "/v1/projects", u, {})).json.projectId;
		const sid = (await api(srv, "POST", `/v1/projects/${pid}/sessions`, u)).json.sessionId;
		const d = new ReferenceDevice(root); await d.connect(srv.ws, u, pid);
		const devClosed = new Promise<number>((r) => d.ws.once("close", (code) => r(code)));
		model.delay.ms = 6000; plan = [[{ text: "never delivered" }]];
		const res = fetch(`${srv.http}/v1/sessions/${sid}/messages`, { method: "POST", headers: { authorization: `Bearer ${u}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "long" }) }).then((r) => r.text());
		await new Promise((r) => setTimeout(r, 800));
		const t0 = Date.now(); await srv.stop();
		const events = sse(await res);
		expect(Date.now() - t0).toBeLessThan(12_000);
		expect(events.some((e) => e.type === "error" && /server_restarting/.test(e.message))).toBe(true);
		expect(events.at(-1)).toEqual({ type: "done", ok: false });
		expect(await devClosed).toBe(1001);
		expect(dirs().filter((n) => n.startsWith("run-"))).toHaveLength(0);
		model.delay.ms = 0;
	}, 60_000);
});

describe("e2e: turn timeout", () => {
	let model: Awaited<ReturnType<typeof startMockModel>>; let srv: Srv; let root: string; let device: ReferenceDevice;
	let tok = ""; let sid = "";
	beforeAll(async () => {
		model = await startMockModel(({ step }) => plan[step] ?? [{ text: "done" }]);
		root = mkdtempSync(join(tmpdir(), "cas-to-")); writeFileSync(join(root, "a.txt"), "x\n");
		srv = await startServer({ CLINE_DATA_DIR: mkdtempSync(join(tmpdir(), "cas-to-data-")), BASE_URL: model.url, MODEL_ID: "llama-3.3-70b-versatile", TURN_TIMEOUT_MS: "1500" });
		tok = await mint(srv, "tim");
		const pid = (await api(srv, "POST", "/v1/projects", tok, {})).json.projectId;
		sid = (await api(srv, "POST", `/v1/projects/${pid}/sessions`, tok)).json.sessionId;
		device = new ReferenceDevice(root); await device.connect(srv.ws, tok, pid);
	}, 60_000);
	afterAll(async () => { device?.close(); await srv?.stop(); await model?.close(); });

	it("a turn that exceeds TURN_TIMEOUT_MS reports error turn_timeout then done{ok:false}, and the session is usable again", async () => {
		model.delay.ms = 8000; plan = [[{ text: "too slow" }]];
		const t0 = Date.now();
		const r = await api(srv, "POST", `/v1/sessions/${sid}/messages`, tok, { prompt: "slow turn" }, true);
		const events = sse(r.text);
		expect(Date.now() - t0).toBeLessThan(6000); // aborted by the timer, not by the model finishing
		const err = events.find((e) => e.type === "error");
		expect(err?.message).toMatch(/^turn_timeout/);
		expect(events.at(-1)).toEqual({ type: "done", ok: false });
		expect(events.filter((e) => e.type === "done")).toHaveLength(1);
		for (let i = 0; i < 40; i++) { if ((await api(srv, "GET", "/v1/info", tok)).json.activeTurns === 0) break; await new Promise((x) => setTimeout(x, 250)); }
		model.delay.ms = 0; plan = [[{ text: "fast" }]];
		const ok = await api(srv, "POST", `/v1/sessions/${sid}/messages`, tok, { prompt: "after timeout" }, true);
		expect(sse(ok.text).at(-1)).toEqual({ type: "done", ok: true }); // normal turns are unaffected
		expect(sse(ok.text).some((e) => e.type === "error")).toBe(false);
	}, 60_000);
});
