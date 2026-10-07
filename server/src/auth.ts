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
		const exp = Math.floor(this.now() / 1000) + ttlSeconds;
		const payload = b64(JSON.stringify({ sub: userId, exp }));
		const sig = b64(createHmac("sha256", this.key).update(`v1.${payload}`).digest());
		return { token: `v1.${payload}.${sig}`, expiresAt: exp * 1000 };
	}
	/** Returns the userId, or undefined if invalid/expired. */
	verify(token: string): string | undefined {
		const parts = token.split(".");
		if (parts.length !== 3 || parts[0] !== "v1") return undefined;
		const expected = b64(createHmac("sha256", this.key).update(`v1.${parts[1]}`).digest());
		if (!safeEqual(parts[2], expected)) return undefined;
		try {
			const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
			if (typeof p.sub !== "string" || !SAFE_ID.test(p.sub) || typeof p.exp !== "number") return undefined;
			if (p.exp * 1000 <= this.now()) return undefined;
			return p.sub;
		} catch {
			return undefined;
		}
	}
}

export function bearer(header: string | undefined): string {
	return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
