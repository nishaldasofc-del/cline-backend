import type { IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AgentService } from "./agent-service";
import { assertSafeId, bearer, HttpError, safeEqual, type UserTokens } from "./auth";
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
}

/** Remove every configured secret from any string that leaves the server. */
export function makeRedactor(secrets: string[]): (s: string) => string {
	const list = secrets.filter((s) => s.length >= 8);
	return (s) => list.reduce((acc, sec) => acc.split(sec).join("[redacted]"), s);
}

export function userFromRequest(tokens: UserTokens, req: IncomingMessage): string {
	const userId = tokens.verify(bearer(req.headers.authorization));
	if (!userId) throw new HttpError(401, "unauthorized");
	return userId;
}

export function createApp({ config, agent, hub, projects, tokens, instanceId }: AppDeps) {
	const app = express();
	const redact = makeRedactor([config.apiKey, config.authToken]);
	app.disable("x-powered-by");
	app.use(express.json({ limit: config.maxBodyBytes }));

	app.get("/healthz", (_req, res) => void res.json({ ok: true }));

	// Admin: only the holder of SERVER_AUTH_TOKEN (your app backend) may mint user tokens.
	app.post("/v1/admin/user-tokens", (req, res) => {
		if (!safeEqual(bearer(req.header("authorization")), config.authToken)) throw new HttpError(401, "unauthorized");
		const userId = assertSafeId("userId", req.body?.userId);
		const ttl = Math.min(Number(req.body?.ttlSeconds) || 3600, config.userTokenMaxTtlSeconds);
		res.status(201).json(tokens.mint(userId, ttl));
	});

	// Everything else requires a valid per-user token. The user id comes ONLY from the token.
	app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
		try { res.locals.userId = userFromRequest(tokens, req); next(); } catch (e) { next(e); }
	});
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
