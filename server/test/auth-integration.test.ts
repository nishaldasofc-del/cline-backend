import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, requireUser } from "../src/app";
import { AuthDiagnostics, TOKEN_ALGORITHM, UserTokens } from "../src/auth";
import { loadConfig } from "../src/config";
import { ProjectStore } from "../src/store";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");
const GROQ = "gsk_test_key_0123456789";

/** Same wiring as src/index.ts: ONE UserTokens built from config.authToken, shared by the mint route and the /v1 gate. */
async function boot(secret: string, lines: string[] = []) {
	const config = loadConfig({ GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: secret });
	const tokens = new UserTokens(config.authToken);
	const diag = new AuthDiagnostics(config.authToken.length > 0, (l) => lines.push(l));
	const app = createApp({ config, agent: { stats: () => ({ liveSessions: 0, activeTurns: 0 }) } as never, hub: {} as never, projects: new ProjectStore(5), tokens, instanceId: "i_test", build: "test", diag });
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", () => r()));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { config, tokens, diag, server, base, lines, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function http(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
	const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
	const text = await res.text();
	return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() as any, headers: res.headers };
}
const mintOver = (base: string, secret: string, body: unknown) => http(base, "POST", "/v1/admin/user-tokens", { authorization: `Bearer ${secret}` }, body);

/** Runs the exported /v1 gate directly, as Express would. Resolves with what the gate did. */
function runGate(gate: ReturnType<typeof requireUser>, authorization?: string) {
	const res = { locals: {} as Record<string, unknown> };
	let outcome: { next: true; err?: unknown } | undefined;
	gate({ headers: authorization === undefined ? {} : { authorization }, url: "/v1/info", originalUrl: "/v1/info" } as never, res as never, ((err?: unknown) => { outcome = { next: true, err }; }) as never);
	return { outcome, userId: res.locals.userId as string | undefined };
}

describe("mint -> the exact middleware used by /v1/info", () => {
	let a!: Awaited<ReturnType<typeof boot>>;
	beforeAll(async () => { a = await boot("admin-secret-token-0123456789-abcdef"); });
	afterAll(() => a.close());

	it("a token minted by POST /v1/admin/user-tokens passes requireUser() called directly", async () => {
		const m = await mintOver(a.base, a.config.authToken, { userId: "alice" });
		expect(m.status).toBe(201);
		const gate = requireUser(a.tokens, a.diag); // the same factory createApp() mounts at /v1
		const r = runGate(gate, `Bearer ${m.json.token}`);
		expect(r.outcome).toEqual({ next: true, err: undefined });
		expect(r.userId).toBe("alice");
	});

	it("the same token is accepted over HTTP by GET /v1/info, immediately and repeatedly", async () => {
		const m = await mintOver(a.base, a.config.authToken, { userId: "bob" });
		for (let i = 0; i < 3; i++) expect((await http(a.base, "GET", "/v1/info", { authorization: `Bearer ${m.json.token}` })).status).toBe(200);
	});

	it("the gate rejects with HttpError(401) and the admin secret itself is not a user token", async () => {
		const r = runGate(requireUser(a.tokens), `Bearer ${a.config.authToken}`);
		expect((r.outcome?.err as { status?: number }).status).toBe(401);
		expect(r.userId).toBeUndefined();
	});
});

describe("mint -> verify across every secret/user/ttl shape a real deployment can produce", () => {
	const secrets: Record<string, string> = {
		"24 chars (minimum)": "a".repeat(24),
		"Render generateValue style (base64, + / =)": randomBytes(32).toString("base64"),
		"base64 with only specials": "+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+=",
		"200 chars": randomBytes(150).toString("base64"),
		"contains dots, dashes, underscores, quotes": 'a.b-c_d"e\'f.g-h_i"j\'k.l-m_n',
		"contains inner spaces": "inner space secret with spaces 1234567890",
		"Latin-1 accents (HTTP header bytes)": "sécret-ünïcode-0123456789-abcdef",
	};
	for (const [label, secret] of Object.entries(secrets)) {
		it(`secret: ${label}`, async () => {
			const s = await boot(secret);
			try {
				for (const body of [{ userId: "u" }, { userId: "user_with-mixed_ID-1" }, { userId: "x".repeat(64) }, { userId: "alice", ttlSeconds: 1 }, { userId: "alice", ttlSeconds: 3600 }, { userId: "alice", ttlSeconds: 10 ** 9 }]) {
					const m = await mintOver(s.base, s.config.authToken, body);
					expect(m.status, JSON.stringify(body)).toBe(201);
					expect((await http(s.base, "GET", "/v1/info", { authorization: `Bearer ${m.json.token}` })).status, JSON.stringify(body)).toBe(200);
				}
			} finally { await s.close(); }
		});
	}

	it("secrets outside Latin-1 (cannot travel in an HTTP header, but must still round-trip in-process)", () => {
		const secret = "sécret-ключ-密钥-0123456789-abcdef";
		const t = new UserTokens(loadConfig({ GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: secret }).authToken);
		const r = runGate(requireUser(t), `Bearer ${t.mint("alice", 60).token}`);
		expect(r.userId).toBe("alice");
	});

	it("surrounding whitespace in the env var is trimmed identically for mint and verify", async () => {
		const s = await boot("  padded-secret-0123456789-abcdef\n");
		try {
			const m = await mintOver(s.base, "padded-secret-0123456789-abcdef", { userId: "alice" });
			expect(m.status).toBe(201);
			expect((await http(s.base, "GET", "/v1/info", { authorization: `Bearer ${m.json.token}` })).status).toBe(200);
		} finally { await s.close(); }
	});

	it("tolerated client formatting still verifies: extra space after Bearer, trailing space", async () => {
		const s = await boot("admin-secret-token-0123456789-abcdef");
		try {
			const t = (await mintOver(s.base, s.config.authToken, { userId: "alice" })).json.token as string;
			for (const h of [`Bearer ${t}`, `Bearer  ${t}`, `Bearer ${t} `]) expect((await http(s.base, "GET", "/v1/info", { authorization: h })).status, h.slice(0, 9)).toBe(200);
		} finally { await s.close(); }
	});
});

describe("one deployment, two processes (restart / scale-out / rolling deploy)", () => {
	it("same SERVER_AUTH_TOKEN: a token minted by process A verifies on process B", async () => {
		const A = await boot("shared-secret-0123456789-abcdefgh"); const B = await boot("shared-secret-0123456789-abcdefgh");
		try {
			const t = (await mintOver(A.base, A.config.authToken, { userId: "alice" })).json.token;
			expect((await http(B.base, "GET", "/v1/info", { authorization: `Bearer ${t}` })).status).toBe(200);
		} finally { await A.close(); await B.close(); }
	});
	it("different SERVER_AUTH_TOKEN: B answers 401 and says bad_signature (the signature of a mint/verify split)", async () => {
		const A = await boot("secret-A-0123456789-abcdefghijkl"); const B = await boot("secret-B-0123456789-abcdefghijkl");
		try {
			const t = (await mintOver(A.base, A.config.authToken, { userId: "alice" })).json.token;
			const r = await http(B.base, "GET", "/v1/info", { authorization: `Bearer ${t}` });
			expect(r.status).toBe(401); expect(r.json).toEqual({ error: "unauthorized" });
			expect(B.lines.join("\n")).toContain("reason=bad_signature");
		} finally { await A.close(); await B.close(); }
	});
});

describe("diagnostics: exact categories, exact fields, never a secret", () => {
	const secret = "diag-secret-0123456789-abcdefghijkl";
	let s!: Awaited<ReturnType<typeof boot>>;
	beforeAll(async () => { s = await boot(secret); });
	afterAll(() => s.close());
	const reasonFor = async (authorization: string | undefined) => {
		s.lines.length = 0;
		// a fresh diag per probe so rate limiting cannot hide a category
		const d = new AuthDiagnostics(true, (l) => s.lines.push(l), () => Date.now() + Math.random() * 1e9);
		const r = runGate(requireUser(s.tokens, d), authorization);
		expect((r.outcome?.err as { status?: number })?.status).toBe(401);
		return s.lines.join("\n");
	};

	it("categorises each way a request can fail", async () => {
		const good = s.tokens.mint("alice", 60).token;
		const [v, p, sig] = good.split(".");
		const past = Date.now() - 60_000;
		const expired = new UserTokens(secret, () => past).mint("alice", 1).token; // minted a minute ago with a 1s ttl
		const cases: Array<[string, string | undefined, string]> = [
			["no header", undefined, "reason=no_authorization_header token_version=none"],
			["Bearer with nothing (unset shell var)", "Bearer ", "reason=empty_token token_version=none"],
			["lowercase scheme", `bearer ${good}`, "reason=scheme_case_mismatch token_version=none"],
			["Basic scheme", "Basic abc", "reason=not_bearer_scheme token_version=none"],
			["JSON quotes left on the token", `Bearer "${good}"`, "reason=bad_charset"],
			["literal ${USER_TOKEN} from single quotes", "Bearer ${USER_TOKEN}", "reason=bad_charset"],
			["whole mint response pasted", 'Bearer {"token":"x"}', "reason=bad_charset"],
			["two segments", `Bearer ${v}.${p}`, "reason=malformed_segments token_version=v1"],
			["unsupported version", `Bearer v2.${p}.${sig}`, "reason=unsupported_version token_version=v2"],
			["tampered payload", `Bearer ${v}.${Buffer.from('{"sub":"bob","exp":9999999999}').toString("base64url")}.${sig}`, "reason=bad_signature token_version=v1"],
			["signed under another secret", `Bearer ${new UserTokens("another-secret-0123456789-abcdef").mint("alice", 60).token}`, "reason=bad_signature token_version=v1"],
		];
		for (const [label, header, expected] of cases) expect(await reasonFor(header), label).toContain(expected);
		// expired is verified with the real clock, so the token minted in the past is rejected as expired
		const exp = new AuthDiagnostics(true, (l) => s.lines.push(l)); s.lines.length = 0;
		const r = runGate(requireUser(new UserTokens(secret), exp), `Bearer ${expired}`);
		expect((r.outcome?.err as { status?: number }).status).toBe(401);
		expect(s.lines.join("\n")).toContain("reason=expired token_version=v1");
	});

	it("every line has exactly: reason, token_version, algorithm, secret_configured (nothing else)", async () => {
		const good = s.tokens.mint("alice", 60).token;
		const lines: string[] = [];
		const d = new AuthDiagnostics(true, (l) => lines.push(l), () => Date.now() + Math.random() * 1e9);
		d.startup();
		for (const h of [undefined, "Bearer ", `Bearer "${good}"`, `Bearer ${good}x`, "Basic zzz"]) runGate(requireUser(s.tokens, d), h);
		expect(lines.length).toBe(6);
		expect(lines[0]).toBe(`[auth-diag] ready token_version=v1 algorithm=${TOKEN_ALGORITHM} secret_configured=true`);
		for (const l of lines.slice(1)) expect(l).toMatch(new RegExp(`^\\[auth-diag\\] verify_failed reason=[a-z_]+ token_version=(none|v\\d{1,2}|unparsed) algorithm=${TOKEN_ALGORITHM} secret_configured=true$`));
	});

	it("never contains the token, the secret, or any 8+ character fragment of either", async () => {
		const good = s.tokens.mint("alice", 60).token;
		const out: string[] = [];
		const d = new AuthDiagnostics(true, (l) => out.push(l), () => Date.now() + Math.random() * 1e9);
		d.startup();
		for (const h of [`Bearer ${good}x`, `Bearer "${good}"`, `Bearer ${good.split(".").slice(0, 2).join(".")}`, `Bearer ${secret}`, `Basic ${good}`, `bearer ${good}`]) runGate(requireUser(s.tokens, d), h);
		const blob = out.join("\n");
		for (const needle of [good, secret]) for (let i = 0; i + 8 <= needle.length; i += 3) expect(blob.includes(needle.slice(i, i + 8)), `fragment @${i}`).toBe(false);
	});

	it("reports secret_configured=false when no secret exists (config absent)", () => {
		const out: string[] = []; const d = new AuthDiagnostics(false, (l) => out.push(l));
		d.startup(); d.failure({ reason: "bad_signature", version: "v1" });
		expect(out.every((l) => l.endsWith("secret_configured=false"))).toBe(true);
	});

	it("rate-limits repeats of the same category", () => {
		const out: string[] = []; let t = 0; const d = new AuthDiagnostics(true, (l) => out.push(l), () => t, 10_000);
		for (let i = 0; i < 50; i++) d.failure({ reason: "bad_signature", version: "v1" });
		expect(out.length).toBe(1); t = 20_000; d.failure({ reason: "bad_signature", version: "v1" });
		expect(out.length).toBe(2); expect(out[1]).toContain("suppressed_similar=49");
	});
});

/**
 * The closest thing to production that runs without Docker: bundle src/index.ts exactly as `bun run build:server` does,
 * start the BUNDLE under plain node with Render-style env, and replay mint -> /v1/info over a real socket.
 */
describe("built bundle (what Render actually runs)", () => {
	const bun = spawnSync("bun", ["--version"]).status === 0;
	const sdkBuilt = existsSync(join(serverDir, "..", "sdk", "packages", "core", "dist"));
	const adminSecret = randomBytes(32).toString("base64"); // same shape Render's generateValue produces
	let outDir = ""; let child: ChildProcess | undefined; let base = ""; const logs: string[] = [];

	beforeAll(async () => {
		if (!bun || !sdkBuilt) return;
		outDir = mkdtempSync(join(serverDir, ".bundle-"));
		const b = spawnSync("bun", ["build", "./src/index.ts", "--outdir", outDir, "--target", "node", "--format", "esm", "--packages", "external"], { cwd: serverDir });
		if (b.status !== 0) throw new Error(`bundle failed: ${b.stderr}`);
		const port = 20000 + Math.floor(Math.random() * 20000);
		child = spawn("node", [join(outDir, "index.js")], { cwd: serverDir, env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", GROQ_API_KEY: GROQ, SERVER_AUTH_TOKEN: adminSecret, PORT: String(port), MEMORY_LOG_INTERVAL_MS: "0", CLINE_DATA_DIR: join(outDir, "data"), RENDER_GIT_COMMIT: "abcdef1234567890" } });
		child.stdout?.on("data", (d) => logs.push(String(d))); child.stderr?.on("data", (d) => logs.push(String(d)));
		base = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
		throw new Error(`bundle never became healthy:\n${logs.join("")}`);
	}, 30_000);
	afterAll(() => { child?.kill("SIGTERM"); if (outDir) rmSync(outDir, { recursive: true, force: true }); });

	it.skipIf(!bun || !sdkBuilt)("mint -> /v1/info authenticates on the bundle; build + instance headers identify the process", async () => {
		const m = await mintOver(base, adminSecret, { userId: "alice" });
		expect(m.status).toBe(201);
		const info = await http(base, "GET", "/v1/info", { authorization: `Bearer ${m.json.token}` });
		expect(info.status).toBe(200);
		expect(m.headers.get("x-cline-build")).toBe("auth-diag-2+abcdef1");
		expect(info.headers.get("x-cline-instance")).toBe(m.headers.get("x-cline-instance")); // one process answered both
	});

	it.skipIf(!bun || !sdkBuilt)("bundle logs: startup shows the secret exists; failures carry a category only; no secret/token ever printed", async () => {
		const m = await mintOver(base, adminSecret, { userId: "alice" });
		await http(base, "GET", "/v1/info", { authorization: `Bearer "${m.json.token}"` }); // quoted token -> bad_charset
		await new Promise((r) => setTimeout(r, 200));
		const blob = logs.join("");
		expect(blob).toContain(`[auth-diag] ready token_version=v1 algorithm=${TOKEN_ALGORITHM} secret_configured=true`);
		expect(blob).toContain("[boot] build=auth-diag-2+abcdef1");
		expect(blob).toContain("verify_failed reason=bad_charset token_version=unparsed");
		for (const needle of [adminSecret, m.json.token as string]) for (let i = 0; i + 8 <= needle.length; i += 5) expect(blob.includes(needle.slice(i, i + 8))).toBe(false);
	});
});
