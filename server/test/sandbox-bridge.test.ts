import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SandboxHub, type SandboxHubOptions } from "../src/bridge/sandbox-hub";
import { loadConfig, DEFAULT_ALLOWLIST } from "../src/config";
import { ProjectStore } from "../src/store";
import { UserTokens } from "../src/auth";

const BRIDGE = "bridge-secret-token-0123456789-abcdef";
const ADMIN = "admin-secret-token-0123456789-abcdef";
const GROQ = "gsk_TEST_SECRET_KEY_do_not_leak_0001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

// ---------------------------------------------------------------------------------------------------------------------
// A fake Termux agent that speaks exactly what the real agent speaks (termux-sandbox-bridge src/agent.ts):
// token in Authorization + x-bridge-token + ?token=, device in x-device-id + ?device_id=, no subprotocol, `reg_ack_*` frame
// first, then request frames answered with {protocol,id,ok,data|error,deviceId,sessionId}.
// ---------------------------------------------------------------------------------------------------------------------
const SILENT = Symbol("silent");
type Reply = { data: unknown } | { error: { code: string; message: string } } | { raw: unknown } | typeof SILENT;
const DEFAULTS: Record<string, (r: any) => unknown> = {
	ping: () => ({ status: "pong", timestamp: Date.now(), workspace: "/sbx" }),
	list_files: () => [{ name: "a.txt", path: "a.txt", isDirectory: false, size: 3, mtimeMs: 1 }],
	read_file: () => "hello",
	write_file: (r) => ({ path: r.path, bytesWritten: Buffer.byteLength(r.content) }),
	delete_file: (r) => ({ path: r.path, deleted: true }),
	mkdir: (r) => ({ path: r.path, created: true }),
	run_command: () => ({ exitCode: 0, stdout: "out", stderr: "" }),
};

class FakeAgent {
	ws!: WebSocket;
	received: any[] = [];
	sessionId?: string;
	regAck?: any;
	closed?: { code: number; reason: string };
	handler: (req: any) => Reply | Promise<Reply> = (req) => ({ data: DEFAULTS[req.type](req) });
	private ready!: () => void;
	readonly registered = new Promise<void>((r) => { this.ready = r; });

	constructor(public deviceId: string) {}

	static async connect(base: string, deviceId: string, o: { token?: string; via?: "all" | "bearer" | "x-bridge" | "query"; autoPong?: boolean } = {}): Promise<FakeAgent> {
		const a = new FakeAgent(deviceId);
		const token = o.token ?? BRIDGE;
		const via = o.via ?? "all";
		const headers: Record<string, string> = { "x-device-id": deviceId };
		const url = new URL(`${base}/bridge`);
		url.searchParams.set("device_id", deviceId);
		if (via === "all" || via === "bearer") headers.authorization = `Bearer ${token}`;
		if (via === "all" || via === "x-bridge") headers["x-bridge-token"] = token;
		if (via === "all" || via === "query") url.searchParams.set("token", token);
		a.ws = new WebSocket(url.toString(), { headers, ...(o.autoPong === false ? { autoPong: false } : {}) });
		a.ws.on("message", async (data) => {
			const f = JSON.parse(data.toString());
			if (typeof f.id === "string" && f.id.startsWith("reg_ack_") && f.data?.sessionId) { a.sessionId = f.data.sessionId; a.regAck = f; a.ready(); return; }
			a.received.push(f);
			const r = await a.handler(f);
			if (r === SILENT || a.ws.readyState !== WebSocket.OPEN) return;
			const base = { protocol: "sunset-sandbox-v1", id: f.id, deviceId, sessionId: a.sessionId };
			if ("raw" in r) a.ws.send(JSON.stringify(r.raw));
			else if ("error" in r) a.ws.send(JSON.stringify({ ...base, ok: false, error: r.error }));
			else a.ws.send(JSON.stringify({ ...base, ok: true, data: r.data }));
		});
		a.ws.on("close", (code, reason) => { a.closed = { code, reason: reason.toString() }; });
		await Promise.race([a.registered, new Promise((_, rej) => { a.ws.on("error", rej); a.ws.on("unexpected-response", (_q, s) => rej(new Error(`HTTP ${s.statusCode}`))); a.ws.on("close", () => rej(new Error("closed before registration"))); })]);
		return a;
	}
	close() { try { this.ws.terminate(); } catch { /* */ } }
}

/** Attempts a connection and reports how the upgrade was answered. */
function probe(url: string, headers: Record<string, string> = {}): Promise<{ status?: number; error?: string; open?: boolean }> {
	return new Promise((resolve) => {
		const w = new WebSocket(url, { headers });
		w.on("unexpected-response", (_q, s) => { resolve({ status: s.statusCode, error: s.headers["x-cline-error"] as string | undefined }); w.terminate(); });
		w.on("open", () => { resolve({ open: true }); w.close(); });
		w.on("error", () => resolve({ error: "socket_error" })); // a handler that destroys the socket (resolve() is idempotent)
	});
}

interface Rig { hub: SandboxHub; server: http.Server; base: string; agents: FakeAgent[]; logs: string[]; agent(id: string, o?: Parameters<typeof FakeAgent.connect>[2]): Promise<FakeAgent> }
const rigs: Rig[] = [];
async function rig(over: Partial<SandboxHubOptions> = {}, withApp = false): Promise<Rig> {
	const logs: string[] = [];
	const hub = new SandboxHub({
		token: BRIDGE, opTimeoutMs: 2_000, commandTimeoutMs: 5_000, maxPayloadBytes: 1024 * 1024, maxDevices: 8, maxPendingPerDevice: 8,
		commands: { mode: "allowlist", allowlist: DEFAULT_ALLOWLIST }, log: (l) => logs.push(l), ...over,
	});
	let server: http.Server;
	if (withApp) {
		const config = loadConfig({ GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: ADMIN, BRIDGE_TOKEN: BRIDGE });
		server = createApp({ config, agent: { stats: () => ({}) } as never, hub: {} as never, sandboxHub: hub, projects: new ProjectStore(5), tokens: new UserTokens(ADMIN) }).listen(0, "127.0.0.1");
	} else {
		server = http.createServer((_q, s) => { s.statusCode = 404; s.end(); }).listen(0, "127.0.0.1");
	}
	await new Promise<void>((r) => server.once("listening", () => r()));
	hub.attach(server);
	const base = `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
	const r: Rig = { hub, server, base, agents: [], logs, agent: async (id, o) => { const a = await FakeAgent.connect(base, id, o); r.agents.push(a); return a; } };
	rigs.push(r);
	return r;
}
afterEach(async () => {
	for (const r of rigs.splice(0)) { r.agents.forEach((a) => a.close()); r.hub.close(); await new Promise((res) => { r.server.close(res); r.server.closeAllConnections?.(); }); }
});

// ---------------------------------------------------------------------------------------------------------------------
describe("/bridge authentication", () => {
	it("accepts BRIDGE_TOKEN via Authorization, x-bridge-token, and query (the agent sends all three)", async () => {
		const r = await rig();
		for (const via of ["all", "bearer", "x-bridge", "query"] as const) {
			const a = await r.agent(`dev-${via}`, { via });
			expect(a.sessionId).toMatch(/^sess_\d+_[0-9a-f]{8}$/);
		}
		expect(r.hub.listDevices().map((d) => d.deviceId).sort()).toEqual(["dev-all", "dev-bearer", "dev-query", "dev-x-bridge"]);
	});

	it("refuses missing and wrong tokens with 401 + X-Cline-Error, before any WebSocket exists", async () => {
		const r = await rig();
		const hdr = { "x-device-id": "d1" };
		expect(await probe(`${r.base}/bridge`, hdr)).toEqual({ status: 401, error: "bridge_unauthorized" });
		expect(await probe(`${r.base}/bridge`, { ...hdr, authorization: "Bearer wrong" })).toEqual({ status: 401, error: "bridge_unauthorized" });
		expect(await probe(`${r.base}/bridge?token=wrong&device_id=d1`)).toEqual({ status: 401, error: "bridge_unauthorized" });
		expect(await probe(`${r.base}/bridge`, { ...hdr, authorization: `Bearer ${BRIDGE.slice(0, -1)}` })).toEqual({ status: 401, error: "bridge_unauthorized" }); // prefix
		expect(await probe(`${r.base}/bridge`, { ...hdr, authorization: `Bearer ${BRIDGE}x` })).toEqual({ status: 401, error: "bridge_unauthorized" });
		expect(r.hub.listDevices()).toEqual([]);
	});

	it("never accepts SERVER_AUTH_TOKEN (or a user token) as the bridge credential", async () => {
		const r = await rig();
		expect((await probe(`${r.base}/bridge`, { authorization: `Bearer ${ADMIN}`, "x-device-id": "d1" })).status).toBe(401);
		const userToken = new UserTokens(ADMIN).mint("alice", 600).token;
		expect((await probe(`${r.base}/bridge`, { authorization: `Bearer ${userToken}`, "x-device-id": "d1" })).status).toBe(401);
	});

	it("requires a valid deviceId (400)", async () => {
		const r = await rig();
		const auth = { authorization: `Bearer ${BRIDGE}` };
		expect(await probe(`${r.base}/bridge`, auth)).toEqual({ status: 400, error: "bridge_bad_device_id" });
		expect((await probe(`${r.base}/bridge`, { ...auth, "x-device-id": "has space" })).status).toBe(400);
		expect((await probe(`${r.base}/bridge`, { ...auth, "x-device-id": "x".repeat(65) })).status).toBe(400);
		expect((await probe(`${r.base}/bridge`, { ...auth, "x-device-id": "../etc" })).status).toBe(400);
	});

	it("is disabled with 503 bridge_disabled when BRIDGE_TOKEN is unset, and never accepts an empty token", async () => {
		const r = await rig({ token: undefined });
		expect(r.hub.enabled).toBe(false);
		expect(await probe(`${r.base}/bridge`, { authorization: "Bearer ", "x-device-id": "d" })).toEqual({ status: 503, error: "bridge_disabled" });
		const r2 = await rig();
		expect((await probe(`${r2.base}/bridge`, { authorization: "Bearer ", "x-bridge-token": "", "x-device-id": "d" })).status).toBe(401);
	});

	it("does not touch other upgrade paths and never logs the token", async () => {
		const r = await rig();
		const seen: string[] = [];
		r.server.on("upgrade", (req, socket) => { if (req.url === "/other") { seen.push(req.url); socket.destroy(); } });
		await probe(`${r.base}/other`);
		expect(seen).toEqual(["/other"]); // SandboxHub ignored it (another handler owns it)
		await r.agent("d1");
		await probe(`${r.base}/bridge?token=wrong-token-value&device_id=d1`);
		expect(r.logs.join("\n")).not.toContain(BRIDGE);
		expect(r.logs.join("\n")).not.toContain("wrong-token-value");
	});

	it("rejects a new device with 503 at capacity, but lets an existing device reconnect", async () => {
		const r = await rig({ maxDevices: 2 });
		await r.agent("a"); await r.agent("b");
		expect(await probe(`${r.base}/bridge?token=${BRIDGE}&device_id=c`)).toEqual({ status: 503, error: "bridge_capacity" });
		const a2 = await r.agent("a"); // replacing an existing device does not need a free slot
		expect(a2.sessionId).toBeTruthy();
		expect(r.hub.listDevices()).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
describe("/bridge registration", () => {
	it("sends the reg_ack frame the agent expects, with a unique sessionId per connection", async () => {
		const r = await rig();
		const a = await r.agent("pixel-7");
		expect(a.regAck).toMatchObject({ protocol: "sunset-sandbox-v1", ok: true, data: { registered: true, deviceId: "pixel-7", sessionId: a.sessionId } });
		expect(a.regAck.id).toBe(`reg_ack_${a.sessionId}`);
		expect(typeof a.regAck.data.hubTimestamp).toBe("number");
		const b = await r.agent("pixel-8");
		const a2 = await r.agent("pixel-7");
		expect(new Set([a.sessionId, b.sessionId, a2.sessionId]).size).toBe(3);
		const info = r.hub.listDevices().find((d) => d.deviceId === "pixel-7")!;
		expect(info.sessionId).toBe(a2.sessionId);
		expect(info.connectedAt).toBeGreaterThan(0);
	});

	it("a reconnecting device replaces its old session: old socket closed 4009, its in-flight request fails, new session serves", async () => {
		const r = await rig();
		const old = await r.agent("pixel-7");
		old.handler = () => SILENT; // never answers
		const inflight = r.hub.route({ type: "ping" });
		await sleep(50);
		const fresh = await r.agent("pixel-7");
		const res = await inflight;
		expect(res).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" }, deviceId: "pixel-7" });
		await sleep(50);
		expect(old.closed?.code).toBe(4009);
		expect(r.hub.listDevices()).toHaveLength(1);
		expect(await r.hub.route({ type: "ping" })).toMatchObject({ ok: true, sessionId: fresh.sessionId });
		// the replaced socket closing late must not evict the live session
		old.close(); await sleep(50);
		expect(r.hub.isConnected("pixel-7")).toBe(true);
	});

	it("a late answer from a replaced session cannot resolve a request on the new session", async () => {
		const r = await rig();
		const old = await r.agent("pixel-7");
		let oldId = "";
		old.handler = (req) => { oldId = req.id; return SILENT; };
		const first = r.hub.route({ type: "ping" });
		await sleep(30);
		const fresh = await r.agent("pixel-7");
		await first;
		fresh.handler = async (req) => { await sleep(80); return { data: DEFAULTS.ping(req) }; };
		const second = r.hub.route({ type: "ping" });
		await sleep(20);
		if (old.ws.readyState === WebSocket.OPEN) old.ws.send(JSON.stringify({ protocol: "sunset-sandbox-v1", id: oldId, ok: true, data: "forged" }));
		const res = await second;
		expect(res).toMatchObject({ ok: true, sessionId: fresh.sessionId });
		expect((res.data as any).status).toBe("pong");
	});
});

// ---------------------------------------------------------------------------------------------------------------------
describe("/bridge routing and the seven operations", () => {
	it("round-trips every operation with the exact wire frames the real agent validates", async () => {
		const r = await rig();
		const a = await r.agent("pixel-7");
		const calls: Array<[any, unknown]> = [
			[{ type: "ping" }, { status: "pong" }],
			[{ type: "list_files", path: "src", recursive: true }, [{ name: "a.txt" }]],
			[{ type: "read_file", path: "src/a.txt", encoding: "base64" }, "hello"],
			[{ type: "write_file", path: "src/b.txt", content: "héllo", createDirs: false }, { path: "src/b.txt", bytesWritten: 6 }],
			[{ type: "delete_file", path: "src/b.txt", recursive: true }, { path: "src/b.txt", deleted: true }],
			[{ type: "mkdir", path: "src/new", recursive: true }, { path: "src/new", created: true }],
			[{ type: "run_command", command: "ls", args: ["-la", "src"], timeoutMs: 3000 }, { exitCode: 0, stdout: "out" }],
		];
		for (const [call, expected] of calls) {
			const res = await r.hub.route(call);
			expect(res, JSON.stringify(call)).toMatchObject({ protocol: "sunset-sandbox-v1", ok: true, deviceId: "pixel-7", sessionId: a.sessionId });
			expect(res.data).toMatchObject(expected as object);
		}
		expect(a.received.map((f) => f.type)).toEqual(["ping", "list_files", "read_file", "write_file", "delete_file", "mkdir", "run_command"]);
		for (const f of a.received) {
			expect(f.protocol).toBe("sunset-sandbox-v1");
			expect(f.id).toMatch(/^req_[0-9a-f-]{36}$/);
			expect(f.deviceId).toBe("pixel-7");
		}
		expect(a.received[1]).toMatchObject({ path: "src", recursive: true });
		expect(a.received[3]).toMatchObject({ path: "src/b.txt", content: "héllo", createDirs: false });
		expect(a.received[6]).toMatchObject({ command: "ls", args: ["-la", "src"], timeoutMs: 3000 });
	});

	it("uses the single connected device by default; reports offline / ambiguous / not found otherwise", async () => {
		const r = await rig();
		expect(await r.hub.route({ type: "ping" })).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
		await r.agent("a");
		expect(await r.hub.route({ type: "ping" })).toMatchObject({ ok: true, deviceId: "a" });
		await r.agent("b");
		const amb = await r.hub.route({ type: "ping" });
		expect(amb).toMatchObject({ ok: false, error: { code: "DEVICE_AMBIGUOUS" } });
		expect(amb.error!.message).toMatch(/a, b/);
		expect(await r.hub.route({ type: "ping" }, { deviceId: "zzz" })).toMatchObject({ ok: false, error: { code: "DEVICE_NOT_FOUND" } });
	});

	it("multi-device: an explicit deviceId reaches ONLY that device, and concurrent out-of-order answers never cross", async () => {
		const r = await rig();
		const a = await r.agent("a"); const b = await r.agent("b");
		a.handler = async (req) => { await sleep(120); return { data: `A:${req.path}` }; };
		b.handler = async (req) => ({ data: `B:${req.path}` });
		const [ra, rb, rb2] = await Promise.all([
			r.hub.route({ type: "read_file", path: "x" }, { deviceId: "a" }),
			r.hub.route({ type: "read_file", path: "y" }, { deviceId: "b" }),
			r.hub.route({ type: "read_file", path: "z" }, { deviceId: "b" }),
		]);
		expect(ra).toMatchObject({ ok: true, data: "A:x", deviceId: "a" });
		expect(rb).toMatchObject({ ok: true, data: "B:y", deviceId: "b" });
		expect(rb2).toMatchObject({ ok: true, data: "B:z", deviceId: "b" });
		expect(a.received.map((f) => f.path)).toEqual(["x"]);
		expect(b.received.map((f) => f.path)).toEqual(["y", "z"]);
	});

	it("echoes the caller's id but always uses a server-generated wire id", async () => {
		const r = await rig();
		const a = await r.agent("a");
		const res = await r.hub.route({ type: "ping" }, { id: "my-req-1" });
		expect(res.id).toBe("my-req-1");
		expect(a.received[0].id).not.toBe("my-req-1");
		expect(a.received[0].id).toMatch(/^req_/);
	});

	it("caps in-flight operations per device (DEVICE_BUSY) and recovers", async () => {
		const r = await rig({ maxPendingPerDevice: 2 });
		const a = await r.agent("a");
		const release: Array<() => void> = [];
		a.handler = (req) => new Promise((res) => release.push(() => res({ data: DEFAULTS.ping(req) })));
		const p1 = r.hub.route({ type: "ping" }); const p2 = r.hub.route({ type: "ping" });
		await sleep(40);
		expect(await r.hub.route({ type: "ping" })).toMatchObject({ ok: false, error: { code: "DEVICE_BUSY" } });
		release.forEach((f) => f());
		expect((await p1).ok && (await p2).ok).toBe(true);
		a.handler = (req) => ({ data: DEFAULTS.ping(req) });
		expect((await r.hub.route({ type: "ping" })).ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
describe("input validation and command policy: hostile input never reaches a device", () => {
	it("rejects traversal, absolute, home, NUL, backslash, empty and oversize paths; unknown ops; bad types", async () => {
		const r = await rig();
		const a = await r.agent("a");
		const bad: Array<[any, string]> = [
			[{ type: "read_file", path: "../../etc/passwd" }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "a/../../b" }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "/etc/passwd" }, "INVALID_REQUEST"],
			[{ type: "write_file", path: "~/x", content: "" }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "a\0b" }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "a\\b" }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "" }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "x".repeat(1025) }, "INVALID_REQUEST"],
			[{ type: "delete_file", path: "../x" }, "INVALID_REQUEST"],
			[{ type: "mkdir", path: "/abs" }, "INVALID_REQUEST"],
			[{ type: "list_files", path: "../" }, "INVALID_REQUEST"],
			[{ type: "write_file", path: "a" }, "INVALID_REQUEST"], // no content
			[{ type: "read_file", path: 5 }, "INVALID_REQUEST"],
			[{ type: "read_file", path: "a", encoding: "latin1" }, "INVALID_REQUEST"],
			[{ type: "run_command", command: "ls", timeoutMs: 999_999 }, "INVALID_REQUEST"],
			[{ type: "auth", token: "x" }, "UNKNOWN_OPERATION"], // frontend-only op: never forwarded
			[{ type: "format_disk" }, "UNKNOWN_OPERATION"],
			[{}, "INVALID_REQUEST"], [null, "INVALID_REQUEST"], ["ping", "INVALID_REQUEST"], [[], "INVALID_REQUEST"],
		];
		for (const [call, code] of bad) expect(await r.hub.route(call), JSON.stringify(call)).toMatchObject({ ok: false, error: { code } });
		expect(a.received).toEqual([]);
	});

	it("allows list_files on the root (empty / '.' / omitted path)", async () => {
		const r = await rig();
		await r.agent("a");
		for (const path of [undefined, "", "."]) expect((await r.hub.route({ type: "list_files", path })).ok).toBe(true);
	});

	it("applies COMMANDS_MODE / allowlist; a shell string can never be forwarded", async () => {
		const r = await rig();
		const a = await r.agent("a");
		const forbidden = [
			{ command: "ls; rm -rf /" }, { command: "ls | sh" }, { command: "ls && id" }, { command: "echo $(id)" }, { command: "echo `id`" },
			{ command: "cat > /tmp/x" }, { command: "curl", args: ["http://evil"] }, { command: "bash", args: ["-c", "id"] },
			{ command: "rm -rf /; ls", args: [] }, { command: "/bin/ls" }, { command: "../ls" }, { command: "ls", args: ["/etc"] },
			{ command: "ls", args: ["../.."] }, { command: "find", args: [".", "-exec", "id", "{}", ";"] }, { command: "git", args: ["-c", "core.pager=sh", "log"] },
		];
		for (const c of forbidden) expect(await r.hub.route({ type: "run_command", ...c }), JSON.stringify(c)).toMatchObject({ ok: false, error: { code: expect.stringMatching(/COMMAND_FORBIDDEN|INVALID_REQUEST/) } });
		expect(a.received).toEqual([]);
		// allowed: argv form and a simple tokenised string; both arrive as bare program + args array (never a shell line)
		expect((await r.hub.route({ type: "run_command", command: "ls", args: ["-la"] })).ok).toBe(true);
		expect((await r.hub.route({ type: "run_command", command: "grep -rn 'hello world' src" })).ok).toBe(true);
		expect((await r.hub.route({ type: "run_command", command: "pwd" })).ok).toBe(true);
		expect(a.received[0]).toMatchObject({ command: "ls", args: ["-la"], timeoutMs: 5000 });
		expect(a.received[1]).toMatchObject({ command: "grep", args: ["-rn", "hello world", "src"] });
		expect(a.received[2].command).toBe("pwd");
		expect(a.received[2].args).toBeUndefined();
	});

	it("COMMANDS_MODE=off disables run_command entirely; passthrough still refuses shell operators", async () => {
		const off = await rig({ commands: { mode: "off", allowlist: [] } });
		await off.agent("a");
		expect(await off.hub.route({ type: "run_command", command: "ls" })).toMatchObject({ ok: false, error: { code: "COMMAND_FORBIDDEN" } });
		expect((await off.hub.route({ type: "ping" })).ok).toBe(true); // file ops unaffected
		const pt = await rig({ commands: { mode: "passthrough", allowlist: [] } });
		await pt.agent("a");
		expect((await pt.hub.route({ type: "run_command", command: "curl", args: ["-V"] })).ok).toBe(true);
		expect(await pt.hub.route({ type: "run_command", command: "ls; id" })).toMatchObject({ ok: false, error: { code: "COMMAND_FORBIDDEN" } });
	});

	it("caps command timeout at the agent's 120 s maximum and uses COMMAND_TIMEOUT_MS by default", async () => {
		const r = await rig({ commandTimeoutMs: 7_000 });
		const a = await r.agent("a");
		await r.hub.route({ type: "run_command", command: "ls" });
		await r.hub.route({ type: "run_command", command: "ls", timeoutMs: 120_000 });
		expect(a.received.map((f) => f.timeoutMs)).toEqual([7000, 120000]);
	});

	it("refuses requests larger than the payload limit (PAYLOAD_TOO_LARGE) without sending them", async () => {
		const r = await rig({ maxPayloadBytes: 4096 });
		const a = await r.agent("a");
		expect(await r.hub.route({ type: "write_file", path: "big", content: "x".repeat(5000) })).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
		expect(a.received).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
describe("errors, timeouts, disconnects and misbehaving devices", () => {
	it("passes device-reported errors through unchanged (code, message, session)", async () => {
		const r = await rig();
		const a = await r.agent("a");
		a.handler = () => ({ error: { code: "PATH_OUTSIDE_SANDBOX", message: "Path traversal '../' outside sandbox workspace is forbidden" } });
		expect(await r.hub.route({ type: "read_file", path: "x" })).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_SANDBOX", message: expect.stringContaining("forbidden") }, deviceId: "a", sessionId: a.sessionId });
	});

	it("flags malformed results as BAD_RESPONSE instead of trusting them", async () => {
		const r = await rig();
		const a = await r.agent("a");
		a.handler = () => ({ data: { not: "a file list" } });
		expect(await r.hub.route({ type: "list_files" })).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
		a.handler = () => ({ data: 42 });
		expect(await r.hub.route({ type: "read_file", path: "a" })).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
		a.handler = () => ({ data: { exitCode: "0", stdout: "", stderr: "" } });
		expect(await r.hub.route({ type: "run_command", command: "ls" })).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
	});

	it("times out with BRIDGE_TIMEOUT, clears pending state, and ignores the late answer", async () => {
		const r = await rig({ opTimeoutMs: 150 });
		const a = await r.agent("a");
		a.handler = async (req) => { await sleep(300); return { data: DEFAULTS.ping(req) }; };
		const res = await r.hub.route({ type: "ping" });
		expect(res).toMatchObject({ ok: false, error: { code: "BRIDGE_TIMEOUT" } });
		expect(r.hub.listDevices()[0].pending).toBe(0);
		await sleep(250); // the late answer arrives and must be dropped without effect
		a.handler = (req) => ({ data: DEFAULTS.ping(req) });
		expect((await r.hub.route({ type: "ping" })).ok).toBe(true);
		expect(a.closed).toBeUndefined();
	});

	it("fails in-flight requests with DEVICE_OFFLINE when the device disconnects, and removes the device", async () => {
		const r = await rig();
		const a = await r.agent("a");
		a.handler = () => SILENT;
		const p = r.hub.route({ type: "read_file", path: "x" });
		await sleep(30);
		a.ws.terminate();
		expect(await p).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" }, deviceId: "a" });
		await sleep(30);
		expect(r.hub.listDevices()).toEqual([]);
		expect(r.hub.isConnected("a")).toBe(false);
		expect(await r.hub.route({ type: "ping" }, { deviceId: "a" })).toMatchObject({ ok: false, error: { code: "DEVICE_NOT_FOUND" } });
	});

	it("a disconnecting device does not disturb the other devices", async () => {
		const r = await rig();
		const a = await r.agent("a"); const b = await r.agent("b");
		a.ws.terminate(); await sleep(40);
		expect(r.hub.listDevices().map((d) => d.deviceId)).toEqual(["b"]);
		expect(await r.hub.route({ type: "ping" })).toMatchObject({ ok: true, deviceId: "b", sessionId: b.sessionId });
	});

	it("closes sockets that send garbage, non-protocol JSON, or binary; the session is removed and the hub keeps working", async () => {
		const r = await rig();
		const healthy = await r.agent("healthy");
		const cases: Array<[string, (w: WebSocket) => void, number]> = [
			["not json", (w) => w.send("}{ nope"), 1008],
			["wrong protocol", (w) => w.send(JSON.stringify({ protocol: "other", id: "x", ok: true })), 1008],
			["no id", (w) => w.send(JSON.stringify({ protocol: "sunset-sandbox-v1", ok: true })), 1008],
			["binary", (w) => w.send(Buffer.from([1, 2, 3])), 1003],
		];
		for (const [name, send, code] of cases) {
			const bad = await r.agent(`bad-${name.replace(/\W/g, "")}`);
			send(bad.ws);
			await sleep(60);
			expect(bad.closed?.code, name).toBe(code);
			expect(r.hub.isConnected(bad.deviceId), name).toBe(false);
		}
		expect(await r.hub.route({ type: "ping" }, { deviceId: "healthy" })).toMatchObject({ ok: true, sessionId: healthy.sessionId });
	});

	it("ignores answers with an unknown id", async () => {
		const r = await rig();
		const a = await r.agent("a");
		a.ws.send(JSON.stringify({ protocol: "sunset-sandbox-v1", id: "req_does-not-exist", ok: true, data: "x" }));
		await sleep(40);
		expect(a.closed).toBeUndefined();
		expect((await r.hub.route({ type: "ping" })).ok).toBe(true);
	});

	it("an oversized frame from the device closes only that device (1009)", async () => {
		const r = await rig({ maxPayloadBytes: 8192 });
		const a = await r.agent("a"); const b = await r.agent("b");
		a.ws.send(JSON.stringify({ protocol: "sunset-sandbox-v1", id: "x", ok: true, data: "y".repeat(20_000) }));
		await sleep(80);
		expect(a.closed?.code).toBe(1009);
		expect(r.hub.isConnected("b")).toBe(true);
		expect(b.closed).toBeUndefined();
	});

	it("heartbeat terminates a stale device that stops answering pings, failing its in-flight work", async () => {
		const r = await rig({ heartbeatMs: 60 });
		const live = await r.agent("live");
		const stale = await r.agent("stale", { autoPong: false });
		stale.handler = () => SILENT;
		const p = r.hub.route({ type: "ping" }, { deviceId: "stale" });
		await sleep(250);
		expect(await p).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
		expect(r.hub.isConnected("stale")).toBe(false);
		expect(r.hub.isConnected("live")).toBe(true);
		expect(live.closed).toBeUndefined();
		expect(r.logs.some((l) => l.includes("stale device=stale"))).toBe(true);
	});

	it("close() fails in-flight requests, closes sockets with 1001, and refuses new upgrades", async () => {
		const r = await rig();
		const a = await r.agent("a");
		a.handler = () => SILENT;
		const p = r.hub.route({ type: "ping" });
		await sleep(30);
		r.hub.close();
		expect(await p).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
		await sleep(50);
		expect(a.closed?.code).toBe(1001);
		expect(r.hub.listDevices()).toEqual([]);
	});

	it("disconnect(deviceId) drops just that device", async () => {
		const r = await rig();
		const a = await r.agent("a"); await r.agent("b");
		r.hub.disconnect("a"); await sleep(50);
		expect(a.closed?.code).toBe(4002);
		expect(r.hub.listDevices().map((d) => d.deviceId)).toEqual(["b"]);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
describe("admin REST: /v1/admin/bridge/*", () => {
	const call = async (r: Rig, method: string, path: string, token?: string, body?: unknown) => {
		const port = (r.server.address() as net.AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text();
		return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
	};

	it("requires SERVER_AUTH_TOKEN: no key, a user token, and BRIDGE_TOKEN are all refused", async () => {
		const r = await rig({}, true);
		await r.agent("a");
		const userToken = new UserTokens(ADMIN).mint("alice", 600).token;
		for (const t of [undefined, "wrong", BRIDGE, userToken]) {
			expect((await call(r, "GET", "/v1/admin/bridge/devices", t)).status, String(t)).toBe(401);
			expect((await call(r, "POST", "/v1/admin/bridge/execute", t, { type: "ping" })).status, String(t)).toBe(401);
		}
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "ping" })).status).toBe(200);
	});

	it("lists devices and executes operations; routing failures map to HTTP statuses, device errors stay 200", async () => {
		const r = await rig({}, true);
		expect((await call(r, "GET", "/v1/admin/bridge/devices", ADMIN)).json).toEqual({ enabled: true, devices: [] });
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "ping" })).status).toBe(409); // DEVICE_OFFLINE
		const a = await r.agent("a"); const b = await r.agent("b");
		const list = (await call(r, "GET", "/v1/admin/bridge/devices", ADMIN)).json;
		expect(list.devices.map((d: any) => d.deviceId).sort()).toEqual(["a", "b"]);
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "ping" })).status).toBe(409); // ambiguous
		const ok = await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "read_file", path: "a.txt", deviceId: "b", id: "client-1" });
		expect(ok.status).toBe(200);
		expect(ok.json).toMatchObject({ protocol: "sunset-sandbox-v1", id: "client-1", ok: true, data: "hello", deviceId: "b" });
		expect(a.received).toEqual([]); expect(b.received).toHaveLength(1);
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "ping", deviceId: "nope" })).status).toBe(404);
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "read_file", path: "../x", deviceId: "a" })).status).toBe(400);
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "run_command", command: "rm -rf / ; ls", deviceId: "a" })).status).toBe(403);
		expect((await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "bogus", deviceId: "a" })).status).toBe(400);
		a.handler = () => ({ error: { code: "FILE_NOT_FOUND", message: "nope" } });
		const dev = await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "read_file", path: "x", deviceId: "a" });
		expect(dev.status).toBe(200);
		expect(dev.json).toMatchObject({ ok: false, error: { code: "FILE_NOT_FOUND" } });
	});

	it("redacts BRIDGE_TOKEN / SERVER_AUTH_TOKEN if a device echoes them back", async () => {
		const r = await rig({}, true);
		const a = await r.agent("a");
		a.handler = () => ({ data: { exitCode: 0, stdout: `leak ${BRIDGE} and ${ADMIN} and ${GROQ}`, stderr: "" } });
		const res = await call(r, "POST", "/v1/admin/bridge/execute", ADMIN, { type: "run_command", command: "echo", args: ["x"] });
		expect(res.text).not.toContain(BRIDGE);
		expect(res.text).not.toContain(ADMIN);
		expect(res.text).not.toContain(GROQ);
		expect(res.text).toContain("[redacted]");
	});

	it("routes are not mounted without a sandboxHub (existing createApp callers are unaffected)", async () => {
		const config = loadConfig({ GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: ADMIN });
		const server = createApp({ config, agent: { stats: () => ({}) } as never, hub: {} as never, projects: new ProjectStore(5), tokens: new UserTokens(ADMIN) }).listen(0, "127.0.0.1");
		await new Promise<void>((res) => server.once("listening", () => res()));
		const port = (server.address() as net.AddressInfo).port;
		const res = await fetch(`http://127.0.0.1:${port}/v1/admin/bridge/devices`, { headers: { authorization: `Bearer ${ADMIN}` } });
		expect(res.status).toBe(401); // falls through to the normal per-user gate: not an admin route here
		await new Promise((r2) => server.close(r2));
	});
});

// ---------------------------------------------------------------------------------------------------------------------
describe("BRIDGE_TOKEN configuration", () => {
	const base = { GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: ADMIN };
	it("is optional: unset leaves the bridge disabled and everything else loading as before", () => {
		const c = loadConfig(base);
		expect(c.bridgeToken).toBeUndefined();
		expect(c.bridgeMaxDevices).toBe(16);
		expect(c.bridgeAgentMaxPayloadBytes).toBe(8 * 1024 * 1024);
		expect(loadConfig({ ...base, BRIDGE_TOKEN: "   " }).bridgeToken).toBeUndefined();
	});
	it("accepts a strong token and tunables", () => {
		const c = loadConfig({ ...base, BRIDGE_TOKEN: BRIDGE, BRIDGE_MAX_DEVICES: "3", BRIDGE_AGENT_MAX_PAYLOAD_BYTES: "1048576" });
		expect(c).toMatchObject({ bridgeToken: BRIDGE, bridgeMaxDevices: 3, bridgeAgentMaxPayloadBytes: 1048576 });
	});
	it("rejects weak, default, reused, or unsafe tokens at boot", () => {
		expect(() => loadConfig({ ...base, BRIDGE_TOKEN: "change-me" })).toThrow(/24/);
		expect(() => loadConfig({ ...base, BRIDGE_TOKEN: "short" })).toThrow(/24/);
		expect(() => loadConfig({ ...base, BRIDGE_TOKEN: ADMIN })).toThrow(/differ from SERVER_AUTH_TOKEN/);
		expect(() => loadConfig({ ...base, BRIDGE_TOKEN: "has a space in it 0123456789" })).toThrow(/printable/);
		expect(() => loadConfig({ ...base, BRIDGE_TOKEN: "quote\"in-token-0123456789abcd\n" + "x".repeat(2) })).toThrow();
		expect(() => loadConfig({ ...base, BRIDGE_TOKEN: BRIDGE, BRIDGE_MAX_DEVICES: "0" })).toThrow();
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// The shipped bundle: proves /bridge and the existing /v1/bridge coexist in ONE process (both hook the HTTP `upgrade` event).
// ---------------------------------------------------------------------------------------------------------------------
const DIST = process.env.SERVER_DIST ?? join(__dirname, "..", "dist", "index.js");
interface Srv { proc: ChildProcess; port: number; http: string; ws: string; out: () => string; stop(): Promise<void> }
async function startServer(env: Record<string, string>): Promise<Srv> {
	const port = await freePort();
	let out = "";
	const proc = spawn(process.execPath, [DIST], { env: { PATH: process.env.PATH ?? "", PORT: String(port), GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: ADMIN, CLINE_DATA_DIR: mkdtempSync(join(tmpdir(), "sbx-data-")), ...env }, stdio: ["ignore", "pipe", "pipe"] });
	proc.stdout!.on("data", (d) => (out += d)); proc.stderr!.on("data", (d) => (out += d));
	await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error(`start timeout:\n${out}`)), 30_000); const i = setInterval(() => { if (out.includes("listening")) { clearInterval(i); clearTimeout(t); res(); } }, 50); proc.on("exit", () => rej(new Error(`exited:\n${out}`))); });
	return { proc, port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, out: () => out, stop: () => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode !== null) return r(); proc.once("exit", () => r()); proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 8000); }) };
}
const exec = async (srv: Srv, body: unknown, key = ADMIN) => { const r = await fetch(`${srv.http}/v1/admin/bridge/execute`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };

describe("e2e: built server with /bridge enabled", () => {
	const live: Srv[] = [];
	afterEach(async () => { await Promise.all(live.splice(0).map((s) => s.stop())); });

	it("Termux agent -> wss /bridge -> backend -> REST; /v1/bridge, /healthz and the per-user gate are unchanged", async () => {
		if (!existsSync(DIST)) throw new Error("Run `bun run build:server` first");
		const srv = await startServer({ BRIDGE_TOKEN: BRIDGE }); live.push(srv);
		expect(srv.out()).toContain("[boot] sandbox-bridge enabled at /bridge");

		const agent = await FakeAgent.connect(srv.ws, "pixel-7-termux");
		const dev = await (await fetch(`${srv.http}/v1/admin/bridge/devices`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as any;
		expect(dev.devices).toHaveLength(1);
		expect(dev.devices[0]).toMatchObject({ deviceId: "pixel-7-termux", sessionId: agent.sessionId });
		expect((await exec(srv, { type: "write_file", path: "a/b.txt", content: "hi" })).json).toMatchObject({ ok: true, data: { bytesWritten: 2 } });
		expect((await exec(srv, { type: "run_command", command: "ls", args: ["-la"] })).json.ok).toBe(true);

		// the OLD hub still owns /v1/bridge (it is not swallowed by, nor does it swallow, /bridge)
		expect(await probe(`${srv.ws}/v1/bridge?projectId=p1`)).toEqual({ status: 400, error: undefined }); // no subprotocol -> its own 400
		expect((await probe(`${srv.ws}/v1/bridge?projectId=p1`, { "sec-websocket-protocol": "cline-bridge.v1" })).status).toBe(401); // its own per-user auth
		expect((await probe(`${srv.ws}/nope`)).status).toBe(404); // unknown paths still 404
		expect(await (await fetch(`${srv.http}/healthz`)).json()).toEqual({ ok: true });
		expect((await fetch(`${srv.http}/v1/info`)).status).toBe(401);
		expect((await fetch(`${srv.http}/v1/info`, { headers: { authorization: `Bearer ${BRIDGE}` } })).status).toBe(401); // BRIDGE_TOKEN is no user credential

		// graceful shutdown: the device sees a normal 1001 close and no secret reached the logs
		const stopped = srv.stop();
		await stopped;
		expect(agent.closed?.code).toBe(1001);
		expect(srv.out()).not.toContain(BRIDGE);
		expect(srv.out()).not.toContain(ADMIN);
		agent.close();
	}, 60_000);

	it("without BRIDGE_TOKEN the server boots normally and /bridge answers 503 bridge_disabled", async () => {
		const srv = await startServer({}); live.push(srv);
		expect(srv.out()).toContain("sandbox-bridge disabled");
		expect(await probe(`${srv.ws}/bridge`, { authorization: `Bearer ${BRIDGE}`, "x-device-id": "d" })).toEqual({ status: 503, error: "bridge_disabled" });
		expect(await (await fetch(`${srv.http}/healthz`)).json()).toEqual({ ok: true });
		expect((await exec(srv, { type: "ping" })).json).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
	}, 60_000);

	it("refuses to boot when BRIDGE_TOKEN is weak or equals SERVER_AUTH_TOKEN", async () => {
		for (const bad of ["change-me", ADMIN]) {
			const err = await startServer({ BRIDGE_TOKEN: bad }).then((s) => { live.push(s); return "started"; }, (e: Error) => e.message);
			expect(err).toMatch(/BRIDGE_TOKEN/);
		}
	}, 60_000);
});
