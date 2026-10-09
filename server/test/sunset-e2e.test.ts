import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockModel } from "./mock-model";

// Real server (built dist) + real ClineCore + the REAL Termux agent (termux-sandbox-bridge/src/agent.ts) + real files.
// Only the LLM is scripted. Set TERMUX_BRIDGE_DIR to the unzipped termux-sandbox-bridge (with node_modules installed).
const TERMUX = process.env.TERMUX_BRIDGE_DIR;
const DIST = process.env.SERVER_DIST ?? join(__dirname, "..", "dist", "index.js");
const ADMIN = "admin-secret-token-0123456789-abcdef";
const BRIDGE = "bridge-secret-token-0123456789-abcdef";
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const PROMPT = "Create a file named cline-test.txt containing exactly:\nCline bridge integration works.";

describe.skipIf(!TERMUX)("e2e: ClineCore -> WorkspaceProvider -> SunsetBridgeAdapter -> /bridge -> Termux agent -> filesystem", () => {
	let model: Awaited<ReturnType<typeof startMockModel>>; let server: ChildProcess; let agent: ChildProcess; let sandbox: string; let url = ""; let out = ""; let agentOut = "";
	const api = async (method: string, path: string, token: string, body?: unknown) => {
		const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await r.text(); return { status: r.status, text, json: text.startsWith("{") ? JSON.parse(text) : undefined };
	};
	let plan: any[][] = [];

	beforeAll(async () => {
		if (!existsSync(DIST)) throw new Error("Run `bun run build:server` first");
		model = await startMockModel(({ step }) => plan[step] ?? [{ text: "done" }]);
		const port = await freePort(); url = `http://127.0.0.1:${port}`;
		const base = mkdtempSync(join(tmpdir(), "sunset-e2e-")); sandbox = join(base, "sunset-sandbox"); mkdirSync(sandbox);
		server = spawn(process.execPath, [DIST], { env: { PATH: process.env.PATH ?? "", PORT: String(port), GROQ_API_KEY: "gsk_TEST_KEY_not_real_000000", SERVER_AUTH_TOKEN: ADMIN, BRIDGE_TOKEN: BRIDGE, BRIDGE_DEVICE_USERS: JSON.stringify({ "e2e-phone": ["nishal-test"] }), BASE_URL: model.url, CLINE_DATA_DIR: join(base, "data") }, stdio: ["ignore", "pipe", "pipe"] });
		server.stdout!.on("data", (d) => (out += d)); server.stderr!.on("data", (d) => (out += d));
		await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`server start timeout:\n${out}`)), 30_000); const i = setInterval(() => { if (out.includes("listening")) { clearInterval(i); clearTimeout(t); res(); } }, 50); });
		agent = spawn(join(TERMUX!, "node_modules/.bin/tsx"), ["src/agent.ts"], { cwd: TERMUX, env: { PATH: process.env.PATH ?? "", HOME: base, RENDER_WSS_URL: `ws://127.0.0.1:${port}/bridge`, BRIDGE_TOKEN: BRIDGE, DEVICE_ID: "e2e-phone", SANDBOX_DIR: sandbox }, stdio: ["ignore", "pipe", "pipe"] });
		agent.stdout!.on("data", (d) => (agentOut += d)); agent.stderr!.on("data", (d) => (agentOut += d));
		await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`agent connect timeout:\n${agentOut}`)), 30_000); const i = setInterval(() => { if (agentOut.includes("Successfully connected")) { clearInterval(i); clearTimeout(t); res(); } }, 100); });
	}, 90_000);
	afterAll(async () => { agent?.kill("SIGTERM"); server?.kill("SIGTERM"); await model?.close(); });

	it("a real Cline turn creates cline-test.txt on the device with exact contents", async () => {
		const mint = await api("POST", "/v1/admin/user-tokens", ADMIN, { userId: "nishal-test" }); const tok = mint.json.token;
		expect((await api("POST", "/v1/projects", tok, { name: "x", deviceId: "other" })).status).toBe(403);
		const proj = await api("POST", "/v1/projects", tok, { name: "sunset-bridge-test", deviceId: "e2e-phone" }); expect(proj.status).toBe(201);
		const sess = await api("POST", `/v1/projects/${proj.json.projectId}/sessions`, tok); expect(sess.status).toBe(201);
		plan = [[{ tool: { name: "editor", args: { path: "/workspace/cline-test.txt", new_text: "Cline bridge integration works." } } }], [{ tool: { name: "run_commands", args: { commands: ["cat /workspace/cline-test.txt"] } } }], [{ text: "Created cline-test.txt." }]];
		const r = await api("POST", `/v1/sessions/${sess.json.sessionId}/messages`, tok, { prompt: PROMPT });
		expect(r.status).toBe(200);
		const events = r.text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
		expect(events.at(-1)).toEqual({ type: "done", ok: true });
		expect(readFileSync(join(sandbox, "cline-test.txt"), "utf8")).toBe("Cline bridge integration works."); // real file, real bytes
		expect(JSON.stringify(model.requests.at(-1).messages)).toContain("Cline bridge integration works.");
		expect(r.text + out).not.toContain(BRIDGE);
	}, 90_000);
});
