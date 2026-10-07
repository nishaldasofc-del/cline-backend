import type { IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AgentService } from "./agent-service";
import { type AuthDiagnostics, assertSafeId, bearer, classifyAuthHeader, HttpError, safeEqual, type UserTokens } from "./auth";
import type { ServerConfig } from "./config";
import type { BridgeHub } from "./bridge/hub";
import type { ProjectStore } from "./store";

export interface AppDeps {
	config: ServerConfig;
	agent: AgentService;
	hub: BridgeHub;
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

export function createApp({ config, agent, hub, projects, tokens, instanceId, build, diag }: AppDeps) {
	const app = express();
	const redact = makeRedactor([config.apiKey, config.authToken]);
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

	// Everything else requires a valid per-user token. The user id comes ONLY from the token.
	app.use("/v1", requireUser(tokens, diag));
	const uid = (res: Response): string => res.locals.userId as string;

	app.get("/v1/info", (_req, res) => void res.json({ provider: config.providerId, model: config.modelId, commandsMode: config.commandsMode, webFetch: config.enableWebFetch, storage: "ephemeral", instanceId, maxConcurrentTurns: config.maxConcurrentTurns, maxConcurrentTurnsPerUser: config.maxConcurrentTurnsPerUser, ...agent.stats() }));

	app.post("/v1/projects", (req, res) => {
		const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
		const p = projects.create(uid(res), name || "project");
		res.status(201).json({ projectId: p.id, name: p.name });
	});
	app.get("/v1/projects", (_req, res) => {
		res.json({ projects: projects.list(uid(res)).map((p) => ({ projectId: p.id, name: p.name, bridgeConnected: hub.isConnected(p.userId, p.id) })) });
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
