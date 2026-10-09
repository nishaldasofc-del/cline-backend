import type { IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AgentService } from "./agent-service";
import { type AuthDiagnostics, assertSafeId, bearer, classifyAuthHeader, HttpError, safeEqual, type UserTokens } from "./auth";
import type { ServerConfig } from "./config";
import type { BridgeHub } from "./bridge/hub";
import { deviceAllowed } from "./bridge/project-router";
import type { ProjectBridge } from "./bridge/project-bridge";
import type { SandboxHub } from "./bridge/sandbox-hub";
import type { ProjectStore } from "./store";

export interface AppDeps {
	config: ServerConfig;
	agent: AgentService;
	hub: BridgeHub;
	/** Per-project transport (Android hub or Termux device). Defaults to `hub`. */
	bridge?: ProjectBridge;
	/** Termux agents (sunset-sandbox-v1 at /bridge). Optional: when absent the admin bridge routes are not mounted. */
	sandboxHub?: SandboxHub;
	projects: ProjectStore;
	tokens: UserTokens;
	/** Random per boot; lets clients notice that the (ephemeral) server state was reset. */
	instanceId?: string;
	/** Build stamp (not a secret): lets you confirm which code answered. */
	build?: string;
	diag?: AuthDiagnostics;
}

/** Remove every configured secret from any string that leaves the server. */
export function makeRedactor(secrets: string[]): (s: string) => string {
	const list = secrets.filter((s) => s.length >= 8);
	return (s) => list.reduce((acc, sec) => acc.split(sec).join("[redacted]"), s);
}

/** Header-class failures (no token to inspect yet) mapped to the same category vocabulary as token failures. */
function headerFailureReason(scheme: ReturnType<typeof classifyAuthHeader>): string {
	switch (scheme) {
		case "missing": return "no_authorization_header";
		case "bearer_empty": return "empty_token";
		case "bearer_wrong_case": return "scheme_case_mismatch";
		default: return "not_bearer_scheme";
	}
}

/** Hub-originated routing/validation failures -> HTTP status. Errors reported BY the device (FILE_NOT_FOUND, ...) stay 200 with ok:false. */
const SANDBOX_HTTP_STATUS: Record<string, number> = {
	INVALID_REQUEST: 400, UNKNOWN_OPERATION: 400, COMMAND_FORBIDDEN: 403, PAYLOAD_TOO_LARGE: 413,
	DEVICE_NOT_FOUND: 404, DEVICE_OFFLINE: 409, DEVICE_AMBIGUOUS: 409, DEVICE_BUSY: 429, BRIDGE_TIMEOUT: 504, BAD_RESPONSE: 502,
};

export function userFromRequest(tokens: UserTokens, req: IncomingMessage, diag?: AuthDiagnostics): string {
	const header = req.headers.authorization;
	const scheme = classifyAuthHeader(header);
	if (scheme !== "bearer") {
		diag?.failure({ reason: headerFailureReason(scheme) });
		throw new HttpError(401, "unauthorized");
	}
	const r = tokens.verifyDetailed(bearer(header));
	if (r.ok) return r.userId;
	diag?.failure({ reason: r.reason, version: r.version });
	throw new HttpError(401, "unauthorized");
}

/**
 * THE gate for every /v1/* route (except the admin mint route, which is registered before it). Exported so tests mount
 * and call exactly the function the production app uses, rather than a re-implementation of it.
 */
export function requireUser(tokens: UserTokens, diag?: AuthDiagnostics) {
	return (req: Request, res: Response, next: NextFunction): void => {
		try { res.locals.userId = userFromRequest(tokens, req, diag); next(); } catch (e) { next(e); }
	};
}

export function createApp({ config, agent, hub, bridge, sandboxHub, projects, tokens, instanceId, build, diag }: AppDeps) {
	const pbridge: ProjectBridge = bridge ?? hub;
	const app = express();
	const redact = makeRedactor([config.apiKey, config.authToken, ...(config.bridgeToken ? [config.bridgeToken] : [])]);
	app.disable("x-powered-by");
	// Identify which build/process answered (random per-boot id, not a secret). Lets you spot a stale deploy, or a mint and a
	// verify that landed on different processes/services, straight from the response headers.
	app.use((_req, res, next) => { if (build) res.setHeader("X-Cline-Build", build); if (instanceId) res.setHeader("X-Cline-Instance", instanceId); next(); });
	app.use(express.json({ limit: config.maxBodyBytes }));

	app.get("/healthz", (_req, res) => void res.json({ ok: true }));

	// Admin: only the holder of SERVER_AUTH_TOKEN (your app backend) may mint user tokens.
	app.post("/v1/admin/user-tokens", (req, res) => {
		if (!safeEqual(bearer(req.header("authorization")), config.authToken)) {
			const scheme = classifyAuthHeader(req.header("authorization"));
			diag?.failure({ reason: scheme === "bearer" ? "admin_secret_mismatch" : headerFailureReason(scheme) });
			throw new HttpError(401, "unauthorized");
		}
		const userId = assertSafeId("userId", req.body?.userId);
		// Omitted/null -> 1h default. Anything else must be a positive integer: a zero/negative/fractional TTL used to
		// mint a token that was already expired, so the very next request got 401. Over-long TTLs are capped.
		const raw = req.body?.ttlSeconds;
		const requested = raw === undefined || raw === null ? 3600 : Number(raw);
		if (!Number.isInteger(requested) || requested <= 0) throw new HttpError(400, "ttlSeconds must be a positive integer");
		res.status(201).json(tokens.mint(userId, Math.min(requested, config.userTokenMaxTtlSeconds)));
	});

	// Admin: operate the Termux devices connected at /bridge. Same gate as the mint route (SERVER_AUTH_TOKEN, i.e. your trusted
	// backend only). BRIDGE_TOKEN is NOT accepted here: it only lets a device connect, never drive one.
	if (sandboxHub) {
		const adminOnly = (req: Request) => {
			if (!safeEqual(bearer(req.header("authorization")), config.authToken)) throw new HttpError(401, "unauthorized");
		};
		app.get("/v1/admin/bridge/devices", (req, res) => {
			adminOnly(req);
			res.json({ enabled: sandboxHub.enabled, devices: sandboxHub.listDevices() });
		});
		// Body: a sunset-sandbox-v1 operation, e.g. {"type":"read_file","path":"a.txt","deviceId":"pixel-7"}.
		// `ok` in the envelope is authoritative; the HTTP status only reflects failures to ROUTE (see SANDBOX_HTTP_STATUS).
		app.post("/v1/admin/bridge/execute", async (req, res) => {
			adminOnly(req);
			const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
			const r = await sandboxHub.route(body, { deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined, id: typeof body.id === "string" ? body.id : undefined });
			const status = r.ok ? 200 : (SANDBOX_HTTP_STATUS[r.error?.code ?? ""] ?? 200);
			res.status(status).type("application/json").send(redact(JSON.stringify(r)));
		});
	}

	// Everything else requires a valid per-user token. The user id comes ONLY from the token.
	app.use("/v1", requireUser(tokens, diag));
	const uid = (res: Response): string => res.locals.userId as string;
	// Same 403 whether the device is unknown or just not yours, so device ids cannot be probed.
	const assertDeviceAccess = (userId: string, deviceId: string) => {
		if (!deviceAllowed(config.bridgeDeviceUsers, userId, deviceId)) throw new HttpError(403, "device not available to this user", "device_forbidden");
	};

	app.get("/v1/info", (_req, res) => void res.json({ provider: config.providerId, model: config.modelId, commandsMode: config.commandsMode, webFetch: config.enableWebFetch, storage: "ephemeral", instanceId, maxConcurrentTurns: config.maxConcurrentTurns, maxConcurrentTurnsPerUser: config.maxConcurrentTurnsPerUser, ...agent.stats() }));

	app.post("/v1/projects", (req, res) => {
		const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
		const userId = uid(res);
		const wanted = req.body?.deviceId;
		if (wanted !== undefined && wanted !== null) assertDeviceAccess(userId, assertSafeId("deviceId", wanted));
		const p = projects.create(userId, name || "project");
		if (typeof wanted === "string") projects.bindDevice(userId, p.id, wanted);
		res.status(201).json({ projectId: p.id, name: p.name, ...(p.deviceId ? { deviceId: p.deviceId } : {}) });
	});
	app.get("/v1/projects", (_req, res) => {
		res.json({ projects: projects.list(uid(res)).map((p) => ({ projectId: p.id, name: p.name, ...(p.deviceId ? { deviceId: p.deviceId } : {}), bridgeConnected: pbridge.isConnected(p.userId, p.id) })) });
	});
	// Bind a project to a Termux device (body {"deviceId":"..."}) or back to the Android bridge ({"deviceId":null}).
	app.put("/v1/projects/:projectId/device", (req, res) => {
		const userId = uid(res);
		const raw = req.body?.deviceId;
		const p = projects.get(userId, req.params.projectId);
		if (raw === null) { projects.bindDevice(userId, p.id, undefined); return void res.json({ projectId: p.id }); }
		const deviceId = assertSafeId("deviceId", raw);
		assertDeviceAccess(userId, deviceId);
		projects.bindDevice(userId, p.id, deviceId);
		res.json({ projectId: p.id, deviceId, bridgeConnected: pbridge.isConnected(userId, p.id) });
	});
	app.delete("/v1/projects/:projectId", async (req, res) => {
		const userId = uid(res);
		const p = projects.get(userId, req.params.projectId);
		await agent.closeProjectSessions(userId, p.id);
		hub.disconnect(userId, p.id);
		projects.delete(userId, p.id);
		res.status(204).end();
	});

	app.post("/v1/projects/:projectId/sessions", async (req, res) => {
		const sessionId = await agent.createSession(uid(res), req.params.projectId);
		res.status(201).json({ sessionId });
	});
	app.delete("/v1/sessions/:id", async (req, res) => {
		await agent.closeSession(uid(res), req.params.id);
		res.status(204).end();
	});

	app.post("/v1/sessions/:id/messages", async (req, res) => {
		const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
		if (!prompt) throw new HttpError(400, "prompt is required");
		if (prompt.length > 32_000) throw new HttpError(413, "prompt too long");
		const abort = new AbortController();
		res.on("close", () => abort.abort()); // client went away (or finished): stop the agent turn
		let started = false;
		let heartbeat: NodeJS.Timeout | undefined;
		const write = (chunk: string) => { if (!res.writableEnded && !res.destroyed) res.write(chunk); };
		const emit = (event: unknown) => {
			if (!started) {
				started = true;
				res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
				res.flushHeaders();
				heartbeat = setInterval(() => write(": ping\n\n"), 15_000);
			}
			write(`data: ${redact(JSON.stringify(event))}\n\n`);
		};
		try {
			await agent.runTurn({ sessionId: req.params.id, userId: uid(res), prompt, signal: abort.signal }, emit);
		} catch (e) {
			if (!started) throw e; // pre-stream failures become normal JSON errors
			emit({ type: "error", message: e instanceof Error ? e.message : "internal error" });
			emit({ type: "done", ok: false });
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			if (started && !res.writableEnded) res.end();
		}
	});

	app.use((_req, res) => void res.status(404).json({ error: "not found" }));
	app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof HttpError) return void res.status(err.status).json({ error: redact(err.message), ...(err.code ? { code: err.code } : {}) });
		const e = err as { status?: number; type?: string };
		if (e?.type === "entity.too.large") return void res.status(413).json({ error: "request too large" });
		if (e?.status && e.status >= 400 && e.status < 500) return void res.status(400).json({ error: "bad request" });
		console.error("[error]", redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
		res.status(500).json({ error: "internal error" });
	});
	return app;
}
