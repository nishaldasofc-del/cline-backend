import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserTokens } from "../src/auth";
import { createApp } from "../src/app";
import { ProjectBridgeRouter, deviceAllowed } from "../src/bridge/project-router";
import { SandboxHub } from "../src/bridge/sandbox-hub";
import { SunsetBridgeAdapter } from "../src/bridge/sunset-adapter";
import { DEFAULT_ALLOWLIST, loadConfig, parseDeviceUsers } from "../src/config";
import { ProjectStore } from "../src/store";
import { BridgeWorkspaceProvider } from "../src/workspace";

const BRIDGE = "bridge-secret-token-0123456789-abcdef";
const ADMIN = "admin-secret-token-0123456789-abcdef";
const GROQ = "gsk_TEST_SECRET_KEY_do_not_leak_0001";
const ACL = { "phone-1": ["alice"], "phone-2": ["bob"] };

/** Minimal Termux-agent stand-in: real sunset-sandbox-v1 framing, REAL filesystem + REAL child processes inside `root`. */
function startFakeAgent(base: string, deviceId: string, root: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${base}/bridge?device_id=${deviceId}`, { headers: { authorization: `Bearer ${BRIDGE}`, "x-bridge-token": BRIDGE, "x-device-id": deviceId } });
		const abs = (p: string) => { const a = join(root, p); if (relative(root, a).startsWith("..")) throw Object.assign(new Error("outside"), { code: "PATH_OUTSIDE_SANDBOX" }); return a; };
		const walk = (d: string): any[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => { const f = join(d, e.name); const st = statSync(f); const item = { name: e.name, path: relative(root, f), isDirectory: e.isDirectory(), size: st.size, mtimeMs: st.mtimeMs }; return e.isDirectory() ? [item, ...walk(f)] : [item]; });
		ws.on("message", (raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === undefined) return; // reg_ack
			const reply = (o: object) => ws.send(JSON.stringify({ protocol: "sunset-sandbox-v1", id: m.id, deviceId, ...o }));
			try {
				let data: unknown;
				switch (m.type) {
					case "ping": data = { status: "pong", timestamp: Date.now(), workspace: root }; break;
					case "read_file": data = readFileSync(abs(m.path), "utf8"); break;
					case "write_file": { const f = abs(m.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, m.content); data = { path: m.path, bytesWritten: Buffer.byteLength(m.content) }; break; }
					case "delete_file": rmSync(abs(m.path), { recursive: true, force: true }); data = { path: m.path, deleted: true }; break;
					case "list_files": data = walk(m.path ? abs(m.path) : root); break;
					case "run_command": { const out = execFileSync(m.command, m.args ?? [], { cwd: root, encoding: "utf8" }); data = { exitCode: 0, stdout: out, stderr: "" }; break; }
					default: throw Object.assign(new Error("unknown"), { code: "UNKNOWN_OPERATION" });
				}
				reply({ ok: true, data });
			} catch (e: any) {
				reply({ ok: false, error: { code: e.code === "ENOENT" ? "FILE_NOT_FOUND" : (e.code ?? "INTERNAL_ERROR"), message: String(e.message) } });
			}
		});
		ws.on("open", () => setTimeout(() => resolve(ws), 150));
		ws.on("error", reject);
	});
}

describe("Termux device behind ClineCore's WorkspaceProvider (sunset adapter + project binding)", () => {
	let server: http.Server; let base: string; let hub: SandboxHub; let projects: ProjectStore;
	let router: ProjectBridgeRouter; let provider: BridgeWorkspaceProvider;
	let rootA: string; let rootB: string; let scratch: string; let agentA: WebSocket; let agentB: WebSocket;
	const tokens = new UserTokens(ADMIN);
	const http$ = async (method: string, path: string, user: string | undefined, body?: unknown) => {
		const port = (server.address() as net.AddressInfo).port;
		const t = user ? tokens.mint(user, 600).token : undefined;
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await r.text(); return { status: r.status, text, json: text.startsWith("{") ? JSON.parse(text) : undefined };
	};

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), "sunset-adapter-"));
		rootA = join(scratch, "phone1"); rootB = join(scratch, "phone2"); mkdirSync(rootA); mkdirSync(rootB);
		writeFileSync(join(rootA, "hello.txt"), "hello world\nline two\n");
		const config = loadConfig({ GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: ADMIN, BRIDGE_TOKEN: BRIDGE, BRIDGE_DEVICE_USERS: JSON.stringify(ACL), COMMAND_ALLOWLIST: "echo,pwd,ls,cat" });
		hub = new SandboxHub({ token: BRIDGE, opTimeoutMs: 5_000, commandTimeoutMs: 5_000, maxPayloadBytes: 1 << 20, maxDevices: 8, maxPendingPerDevice: 8, commands: { mode: "allowlist", allowlist: ["echo", "pwd", "ls", "cat"] }, log: () => {} } as never);
		projects = new ProjectStore(10);
		router = new ProjectBridgeRouter(projects, { isConnected: () => false, call: async () => { throw new Error("android bridge must not be used"); } }, new SunsetBridgeAdapter(hub), config.bridgeDeviceUsers);
		provider = new BridgeWorkspaceProvider(router, join(scratch, "srv"), config);
		server = createApp({ config, agent: { stats: () => ({}) } as never, hub: { isConnected: () => false } as never, bridge: router, sandboxHub: hub, projects, tokens }).listen(0, "127.0.0.1");
		await new Promise<void>((r) => server.once("listening", () => r()));
		hub.attach(server);
		base = `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
		agentA = await startFakeAgent(base, "phone-1", rootA);
		agentB = await startFakeAgent(base, "phone-2", rootB);
	}, 30_000);
	afterAll(async () => { agentA?.close(); agentB?.close(); hub?.close(); await new Promise((r) => server?.close(r)); rmSync(scratch, { recursive: true, force: true }); });

	it("1. /bridge device registration is visible to the backend", () => {
		expect(hub.isConnected("phone-1")).toBe(true);
		expect(hub.listDevices().map((d) => d.deviceId).sort()).toEqual(["phone-1", "phone-2"]);
	});

	it("config: BRIDGE_DEVICE_USERS is strict (no wildcards, valid JSON, default = nobody)", () => {
		expect(parseDeviceUsers(undefined)).toEqual({});
		expect(() => parseDeviceUsers("{bad")).toThrow(/valid JSON/);
		expect(() => parseDeviceUsers('{"d":["*"]}')).toThrow(/valid user ids/);
		expect(deviceAllowed({}, "alice", "phone-1")).toBe(false);
		expect(deviceAllowed(ACL, "alice", "phone-1")).toBe(true);
		expect(deviceAllowed(ACL, "alice", "phone-2")).toBe(false);
		expect(deviceAllowed(ACL, "alice", "__proto__")).toBe(false);
	});

	let pAlice = ""; let pBob = "";
	it("2. project -> device association via API; 9. unauthorised device access is refused", async () => {
		const created = await http$("POST", "/v1/projects", "alice", { name: "t", deviceId: "phone-1" });
		expect(created.status).toBe(201); expect(created.json.deviceId).toBe("phone-1"); pAlice = created.json.projectId;
		expect((await http$("POST", "/v1/projects", "alice", { name: "x", deviceId: "phone-2" })).status).toBe(403); // someone else's device
		expect((await http$("POST", "/v1/projects", "alice", { name: "x", deviceId: "ghost" })).status).toBe(403);   // unknown: same answer, no probing
		expect((await http$("POST", "/v1/projects", "carol", { name: "x", deviceId: "phone-1" })).status).toBe(403);
		expect((await http$("POST", "/v1/projects", undefined, { name: "x", deviceId: "phone-1" })).status).toBe(401);
		expect((await http$("POST", "/v1/projects", "alice", { name: "x", deviceId: "../etc" })).status).toBe(400);
		const bob = await http$("POST", "/v1/projects", "bob", { name: "b" }); pBob = bob.json.projectId;
		expect((await http$("PUT", `/v1/projects/${pBob}/device`, "bob", { deviceId: "phone-1" })).status).toBe(403);
		expect((await http$("PUT", `/v1/projects/${pBob}/device`, "alice", { deviceId: "phone-1" })).status).toBe(404); // not alice's project
		const ok = await http$("PUT", `/v1/projects/${pBob}/device`, "bob", { deviceId: "phone-2" });
		expect(ok.status).toBe(200); expect(ok.json.bridgeConnected).toBe(true);
		const list = await http$("GET", "/v1/projects", "alice");
		expect(list.json.projects[0]).toMatchObject({ deviceId: "phone-1", bridgeConnected: true });
		expect(list.text).not.toContain(BRIDGE);
	});

	it("3-6. WorkspaceProvider executors -> adapter -> /bridge -> device filesystem (read, write, edit, search, command)", async () => {
		const ws = await provider.open({ userId: "alice", projectId: pAlice, sessionKey: "k1" });
		const ex = ws.toolExecutors as any;
		expect(await ex.readFile({ path: "/workspace/hello.txt" })).toContain("1 | hello world");
		expect(await ex.editor({ path: "/workspace/cline-test.txt", new_text: "Cline bridge integration works." })).toContain("created");
		expect(readFileSync(join(rootA, "cline-test.txt"), "utf8")).toBe("Cline bridge integration works."); // EXACT bytes on the device
		await ex.editor({ path: "/workspace/hello.txt", old_text: "hello", new_text: "HELLO" });
		expect(readFileSync(join(rootA, "hello.txt"), "utf8")).toContain("HELLO world");
		await ex.editor({ path: "/workspace/deep/nested/f.txt", new_text: "x\n" });
		expect(readFileSync(join(rootA, "deep/nested/f.txt"), "utf8")).toBe("x\n");
		expect(await ex.search("HELLO")).toContain("/workspace/hello.txt:1");
		expect(await ex.bash("ls /workspace")).toContain("Exit code: 0");
		expect(await ex.bash("echo hi")).toContain("stdout:\nhi");
		await expect(ex.bash("rm -rf /")).rejects.toThrow(); // existing command policy still applies
		await ex.applyPatch({ input: "*** Begin Patch\n*** Add File: /workspace/p.txt\n+patched\n*** End Patch" });
		expect(readFileSync(join(rootA, "p.txt"), "utf8")).toBe("patched");
		await ws.dispose?.();
	});

	it("traversal and .git writes are still refused", async () => {
		const ex = (await provider.open({ userId: "alice", projectId: pAlice, sessionKey: "k2" })).toolExecutors as any;
		await expect(ex.readFile({ path: "/workspace/../etc/passwd" })).rejects.toThrow();
		await expect(ex.editor({ path: "/workspace/.git/hooks/pre-commit", new_text: "x" })).rejects.toThrow();
	});

	it("7. project isolation: a project only ever reaches its own device and its owner", async () => {
		const bobEx = (await provider.open({ userId: "bob", projectId: pBob, sessionKey: "k3" })).toolExecutors as any;
		await bobEx.editor({ path: "/workspace/bob.txt", new_text: "bob" });
		expect(readFileSync(join(rootB, "bob.txt"), "utf8")).toBe("bob");
		expect(() => readFileSync(join(rootA, "bob.txt"))).toThrow();
		await expect(bobEx.readFile({ path: "/workspace/hello.txt" })).rejects.toThrow(); // phone-1's file is invisible
		// alice cannot drive bob's project (ownership), and a revoked ACL entry stops an already-bound project on the next call
		expect(router.isConnected("alice", pBob)).toBe(false);
		await expect(router.call("alice", pBob, "READ_FILE", { path: "bob.txt" })).rejects.toThrow(/not found/i);
		const revoked = new ProjectBridgeRouter(projects, { isConnected: () => false, call: async () => { throw new Error("x"); } }, new SunsetBridgeAdapter(hub), { "phone-2": [] });
		expect(revoked.isConnected("bob", pBob)).toBe(false);
		await expect(revoked.call("bob", pBob, "READ_FILE", { path: "bob.txt" })).rejects.toThrow(/may not use/);
	});

	it("8. device offline: isConnected is false (-> 409 bridge_offline) and calls fail cleanly", async () => {
		agentB.close(); await new Promise((r) => setTimeout(r, 300));
		expect(router.isConnected("bob", pBob)).toBe(false);
		await expect(router.call("bob", pBob, "READ_FILE", { path: "bob.txt" })).rejects.toMatchObject({ code: "OFFLINE" });
		expect(router.isConnected("alice", pAlice)).toBe(true); // other device unaffected
	});

	it("unbound projects keep using the Android bridge", async () => {
		const p = projects.create("alice", "android");
		expect(router.isConnected("alice", p.id)).toBe(false);
		await expect(router.call("alice", p.id, "READ_FILE", { path: "a" })).rejects.toThrow(/android bridge must not be used/);
	});
});
