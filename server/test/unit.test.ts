import { describe, expect, it } from "vitest";
import { UserTokens } from "../src/auth";
import { toProjectPath, assertWritable } from "../src/bridge/paths";
import { prepareCommand, tokenize } from "../src/command-policy";
import { loadConfig, DEFAULT_ALLOWLIST } from "../src/config";
import { isBlockedIp, fetchPublicText } from "../src/web-fetch";
import { makeRedactor } from "../src/app";
import { ProjectStore, SessionStore } from "../src/store";

describe("virtual path mapping", () => {
	it("maps virtual-root and relative paths", () => {
		expect(toProjectPath("/workspace/src/a.ts")).toBe("src/a.ts");
		expect(toProjectPath("src/./a.ts")).toBe("src/a.ts");
		expect(toProjectPath("/workspace")).toBe(".");
	});
	it.each(["/", "/etc/passwd", "/workspace/../etc", "../../x", "a/../../b", "~/x", "a\\b", "/workspaceX/a", "/data/data/com.app/x", "x\0y", ""])("rejects %j", (p) => {
		expect(() => toProjectPath(p)).toThrow();
	});
	it("blocks writes into .git and the root", () => {
		expect(() => assertWritable(".git/hooks/pre-commit")).toThrow();
		expect(() => assertWritable("sub/.GIT/config")).toThrow();
		expect(() => assertWritable(".")).toThrow();
		expect(() => assertWritable("src/a.ts")).not.toThrow();
	});
});

describe("command policy", () => {
	const allow = { mode: "allowlist" as const, allowlist: DEFAULT_ALLOWLIST };
	it("tokenizes quotes and rejects shell operators", () => {
		expect(tokenize(`grep -n "hello world" src`)).toEqual(["grep", "-n", "hello world", "src"]);
		for (const bad of ["ls; rm -rf x", "cat a | sh", "echo $(id)", "ls > out", "echo `id`", "ls && ls", "ls\nrm x"]) expect(() => tokenize(bad)).toThrow();
	});
	it("allows simple allowlisted commands and maps the virtual root", () => {
		expect(prepareCommand("ls -la /workspace/src", allow)).toEqual(["ls", "-la", "./src"]);
		expect(prepareCommand({ command: "npm", args: ["test"] }, allow)).toEqual(["npm", "test"]);
	});
	it.each(["curl http://x", "sh -c ls", "/bin/ls", "../ls", "cat /etc/passwd", "cat ../x", "cat ~/.ssh/id_rsa", "ls --dir=/etc", "find . -exec rm {} +", "git -c core.sshCommand=x fetch", "sed -i s/a/b/ f", "env"])("denies %s", (c) => {
		expect(() => prepareCommand(c, allow)).toThrow();
	});
	it("off disables, passthrough allows unlisted programs (still no shell/abs paths)", () => {
		expect(() => prepareCommand("ls", { mode: "off", allowlist: [] })).toThrow(/disabled/);
		expect(prepareCommand("curl https://example.com", { mode: "passthrough", allowlist: [] })[0]).toBe("curl");
		expect(() => prepareCommand("curl x | sh", { mode: "passthrough", allowlist: [] })).toThrow();
		expect(() => prepareCommand("cat /etc/passwd", { mode: "passthrough", allowlist: [] })).toThrow();
	});
});

describe("user tokens", () => {
	const t = new UserTokens("s".repeat(32));
	it("round-trips and binds the user", () => { expect(t.verify(t.mint("alice", 60).token)).toBe("alice"); });
	it("rejects tampering, other secrets, expiry and junk", () => {
		const { token } = t.mint("alice", 60);
		const [v, p, s] = token.split(".");
		const forged = Buffer.from(JSON.stringify({ sub: "bob", exp: 9999999999 })).toString("base64url");
		expect(t.verify(`${v}.${forged}.${s}`)).toBeUndefined();
		expect(new UserTokens("x".repeat(32)).verify(token)).toBeUndefined();
		let now = Date.now(); const clock = new UserTokens("s".repeat(32), () => now);
		const short = clock.mint("alice", 1).token; now += 5000;
		expect(clock.verify(short)).toBeUndefined();
		for (const junk of ["", "v1.a.b", "garbage", `${v}.${p}`]) expect(t.verify(junk)).toBeUndefined();
	});
	it.each([0, -5, 0.5, NaN, Infinity])("never mints a dead/invalid token for ttl=%s", (ttl) => { expect(() => t.mint("alice", ttl)).toThrow(/positive integer/); });
	it("refuses unsafe user ids", () => { expect(() => t.mint("../x", 60)).toThrow(); });
});

describe("config", () => {
	const base = { GROQ_API_KEY: "gsk_x", SERVER_AUTH_TOKEN: "t".repeat(24) };
	it("reads Render's PORT and defaults to Groq", () => {
		const c = loadConfig({ ...base, PORT: "12345" } as any);
		expect(c.port).toBe(12345); expect(c.providerId).toBe("groq"); expect(c.apiKey).toBe("gsk_x");
	});
	it("requires secrets and valid values", () => {
		expect(() => loadConfig({ SERVER_AUTH_TOKEN: base.SERVER_AUTH_TOKEN } as any)).toThrow(/API key/);
		expect(() => loadConfig({ GROQ_API_KEY: "k" } as any)).toThrow(/SERVER_AUTH_TOKEN/);
		expect(() => loadConfig({ ...base, SERVER_AUTH_TOKEN: "short" } as any)).toThrow(/24/);
		expect(() => loadConfig({ ...base, PORT: "abc" } as any)).toThrow();
		expect(() => loadConfig({ ...base, COMMANDS_MODE: "yolo" } as any)).toThrow();
	});
});

describe("SSRF guard", () => {
	it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])("blocks %s", (ip) => { expect(isBlockedIp(ip)).toBe(true); });
	it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", (ip) => { expect(isBlockedIp(ip)).toBe(false); });
	it.each(["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://x/", "http://user:pw@example.com/", "http://example.com:22/", "http://svc.internal/"])("refuses %s", async (u) => {
		await expect(fetchPublicText(u)).rejects.toThrow();
	});
});

describe("redaction", () => {
	it("removes secrets from output", () => {
		const r = makeRedactor(["gsk_SECRET_VALUE_1", "admin-token-abcdefghijklmnop"]);
		expect(r('{"e":"bad key gsk_SECRET_VALUE_1 and admin-token-abcdefghijklmnop"}')).not.toMatch(/gsk_SECRET|admin-token/);
	});
});

describe("in-memory stores (Render Free)", () => {
	it("projects: random ids, ownership, identical 404 for missing vs foreign, per-user cap, delete", () => {
		const ps = new ProjectStore(2);
		const a = ps.create("alice", "one"); const a2 = ps.create("alice", "two");
		expect(a.id).toMatch(/^p_[0-9a-f]{24}$/); expect(a.id).not.toBe(a2.id);
		expect(() => ps.create("alice", "three")).toThrow(/limit/);
		ps.create("bob", "b"); // other users have their own quota
		const foreign = (() => { try { ps.get("bob", a.id); } catch (e) { return e as { status: number; message: string }; } })();
		const missing = (() => { try { ps.get("bob", "p_nope"); } catch (e) { return e as { status: number; message: string }; } })();
		expect(foreign?.status).toBe(404); expect(foreign?.message).toBe(missing?.message);
		expect(ps.list("alice").map((p) => p.id).sort()).toEqual([a.id, a2.id].sort());
		ps.delete("alice", a.id);
		expect(() => ps.get("alice", a.id)).toThrow();
		expect(() => ps.delete("bob", a2.id)).toThrow(); // cannot delete someone else's
	});
	it("sessions: ownership, 404 parity, project-scoped delete; a fresh store starts empty (restart = loss, not corruption)", () => {
		const ss = new SessionStore();
		ss.put({ id: "s1", userId: "alice", projectId: "p1", coreSessionId: "c1", createdAt: 1 });
		ss.put({ id: "s2", userId: "alice", projectId: "p2", coreSessionId: "c2", createdAt: 1 });
		expect(ss.get("alice", "s1").projectId).toBe("p1");
		expect(() => ss.get("bob", "s1")).toThrow(/session not found/);
		expect(() => ss.get("alice", "zzz")).toThrow(/session not found/);
		expect(ss.deleteForProject("bob", "p1")).toEqual([]);
		expect(ss.deleteForProject("alice", "p1")).toEqual(["s1"]);
		expect(() => ss.get("alice", "s1")).toThrow();
		expect(() => new SessionStore().get("alice", "s2")).toThrow(/expired|restart/);
	});
	it("config: Render Free defaults are conservative, no /var/data, env still overrides", () => {
		const base = { GROQ_API_KEY: "gsk_x_0123456789", SERVER_AUTH_TOKEN: "t".repeat(32) };
		const c = loadConfig(base);
		expect(c.maxConcurrentTurns).toBe(1); expect(c.maxConcurrentTurnsPerUser).toBe(1);
		expect(c.dataDir).not.toContain("/var/data"); expect(c.host).toBe("0.0.0.0");
		expect(c.turnTimeoutMs).toBe(600_000); expect(c.maxIterations).toBe(30);
		const o = loadConfig({ ...base, MAX_CONCURRENT_TURNS: "3", MAX_CONCURRENT_TURNS_PER_USER: "2", MEMORY_LOG_INTERVAL_MS: "0" });
		expect(o.maxConcurrentTurns).toBe(3); expect(o.maxConcurrentTurnsPerUser).toBe(2); expect(o.memoryLogIntervalMs).toBe(0);
	});
});
