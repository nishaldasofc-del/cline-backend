import { createHmac, timingSafeEqual } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function assertSafeId(label: string, value: unknown): string {
	if (typeof value !== "string" || !SAFE_ID.test(value)) throw new HttpError(400, `${label} is invalid`);
	return value;
}

export class HttpError extends Error {
	constructor(public status: number, message: string, public code?: string) {
		super(message);
	}
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Stateless per-user tokens: `v1.<payload>.<sig>`; sig = HMAC-SHA256 under a key
 * derived from SERVER_AUTH_TOKEN. Minted only by the holder of SERVER_AUTH_TOKEN
 * (your app backend, after it authenticates the user). No server-side revocation:
 * keep TTLs short; rotating SERVER_AUTH_TOKEN invalidates every token.
 */
export class UserTokens {
	private readonly key: Buffer;
	constructor(adminSecret: string, private readonly now: () => number = () => Date.now()) {
		this.key = createHmac("sha256", adminSecret).update("cline-agent-server/user-token/v1").digest();
	}
	mint(userId: string, ttlSeconds: number): { token: string; expiresAt: number } {
		assertSafeId("userId", userId);
		// Never issue a token that is already dead (ttl <= 0) or has a fractional/NaN expiry.
		if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new HttpError(400, "ttlSeconds must be a positive integer");
		const exp = Math.floor(this.now() / 1000) + ttlSeconds;
		const payload = b64(JSON.stringify({ sub: userId, exp }));
		const sig = b64(createHmac("sha256", this.key).update(`v1.${payload}`).digest());
		return { token: `v1.${payload}.${sig}`, expiresAt: exp * 1000 };
	}
	/** Returns the userId, or undefined if invalid/expired. */
	verify(token: string): string | undefined {
		const r = this.verifyDetailed(token);
		return r.ok ? r.userId : undefined;
	}
	/** Same checks as verify(), but says WHY it failed (category only; never echoes token content). */
	verifyDetailed(token: string): { ok: true; userId: string } | { ok: false; reason: VerifyFailure; version: string; segments: number } {
		const parts = token.split(".");
		const version = /^v\d{1,2}$/.test(parts[0] ?? "") ? parts[0] : "unparsed";
		const fail = (reason: VerifyFailure) => ({ ok: false as const, reason, version, segments: parts.length });
		if (!token) return fail("empty_token");
		if (parts.length !== 3) return fail("malformed_segments");
		if (parts[0] !== "v1") return fail("unsupported_version");
		const expected = b64(createHmac("sha256", this.key).update(`v1.${parts[1]}`).digest());
		if (!safeEqual(parts[2], expected)) return fail("bad_signature");
		try {
			const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
			if (typeof p.sub !== "string" || !SAFE_ID.test(p.sub) || typeof p.exp !== "number") return fail("bad_payload");
			if (p.exp * 1000 <= this.now()) return fail("expired");
			return { ok: true, userId: p.sub };
		} catch {
			return fail("bad_payload");
		}
	}
}

export type VerifyFailure = "empty_token" | "malformed_segments" | "unsupported_version" | "bad_signature" | "bad_payload" | "expired";
export const TOKEN_ALGORITHM = "HMAC-SHA256";
export const TOKEN_VERSION = "v1";

/** Classify the Authorization header WITHOUT revealing its value (a mis-sent token must never be echoed). */
export function classifyAuthHeader(header: string | undefined): "missing" | "bearer" | "bearer_empty" | "bearer_wrong_case" | "other_scheme" {
	if (header === undefined || header === "") return "missing";
	if (/^bearer\s*$/i.test(header)) return "bearer_empty"; // e.g. `Bearer ${UNSET_VAR}`: HTTP stacks trim the trailing space
	if (header.startsWith("Bearer ")) return "bearer";
	if (/^bearer\s/i.test(header)) return "bearer_wrong_case";
	return "other_scheme";
}

export interface AuthDiagEvent { route: string; reason: string; scheme: string; version?: string; segments?: number; tokenLength?: number }

/**
 * TEMPORARY auth diagnostics. Emits category-level facts only: failure reason, header scheme class, token version,
 * configured algorithm, whether the secret exists. Never the token, the Authorization value, or any secret/derived key.
 * Rate-limited per (route, reason) so a flood of bad requests cannot flood the logs.
 */
export class AuthDiagnostics {
	private readonly last = new Map<string, { at: number; suppressed: number }>();
	constructor(
		private readonly secretConfigured: boolean,
		private readonly sink: (line: string) => void = (l) => console.log(l),
		private readonly now: () => number = () => Date.now(),
		private readonly intervalMs = 10_000,
	) {}
	startup(build: string): void {
		this.sink(`[auth-diag] ready build=${build} algorithm=${TOKEN_ALGORITHM} token_version=${TOKEN_VERSION} secret_configured=${this.secretConfigured}`);
	}
	failure(e: AuthDiagEvent): void {
		const k = `${e.route}|${e.reason}`;
		const t = this.now();
		const prev = this.last.get(k);
		if (prev && t - prev.at < this.intervalMs) { prev.suppressed++; return; }
		this.last.set(k, { at: t, suppressed: 0 });
		const extra = [e.version !== undefined ? ` token_version=${e.version}` : "", e.segments !== undefined ? ` segments=${e.segments}` : "", e.tokenLength !== undefined ? ` token_length=${e.tokenLength}` : ""].join("");
		this.sink(`[auth-diag] verify_failed route=${e.route} reason=${e.reason} header_scheme=${e.scheme}${extra} algorithm=${TOKEN_ALGORITHM} secret_configured=${this.secretConfigured}${prev?.suppressed ? ` (+${prev.suppressed} similar suppressed)` : ""}`);
	}
}

export function bearer(header: string | undefined): string {
	return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
