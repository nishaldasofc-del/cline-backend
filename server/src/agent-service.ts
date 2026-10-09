import { ClineCore, type CoreSessionEvent } from "@cline/sdk";
import { buildClineSystemPrompt } from "@cline/shared";
import { HttpError } from "./auth";
import type { ProjectBridge } from "./bridge/project-bridge";
import type { ServerConfig } from "./config";
import type { ProjectStore, SessionStore } from "./store";
import type { WorkspaceHandle, WorkspaceProvider } from "./workspace";

interface Live {
	coreSessionId: string;
	workspace: WorkspaceHandle;
	busy: boolean;
	lastUsed: number;
}

const TIMEOUT_MESSAGE = "turn_timeout: the turn exceeded the server's time limit and was aborted";
const RESTART_MESSAGE = "server_restarting: the server is restarting; this session is lost, create a new session once it is back";

export type TurnEvent =
	| { type: "agent_event"; event: unknown }
	| { type: "status"; status: string }
	| { type: "error"; message: string }
	| { type: "done"; ok: boolean };

/**
 * Thin wrapper over the real ClineCore runtime. All agent behaviour (loop, tools,
 * compaction, persistence) is Cline's; this class wires config, per-session
 * workspaces, ownership checks and event delivery.
 */
export class AgentService {
	private core: ClineCore | undefined;
	private readonly live = new Map<string, Live>();
	private readonly turnsByUser = new Map<string, number>();
	private activeTurns = 0;
	private shuttingDown = false;
	private readonly abortors = new Set<() => void>();

	constructor(
		private readonly config: ServerConfig,
		private readonly workspaces: WorkspaceProvider,
		private readonly hub: ProjectBridge,
		private readonly projects: ProjectStore,
		private readonly sessions: SessionStore,
	) {}

	async init(): Promise<void> {
		this.core = await ClineCore.create({ clientName: "cline-agent-server", backendMode: "local" });
	}

	private requireCore(): ClineCore {
		if (!this.core) throw new Error("AgentService not initialised");
		return this.core;
	}

	/** Start (or restart, with prior transcript) a Cline session bound to one project. */
	private async startCore(userId: string, projectId: string, sessionKey: string, initialMessages?: unknown[]) {
		const core = this.requireCore();
		const workspace = await this.workspaces.open({ userId, projectId, sessionKey });
		const c = this.config;
		const commandsOn = c.commandsMode !== "off";
		const systemPrompt = buildClineSystemPrompt({
			ide: "Headless server (remote project on the user's device)",
			workspaceRoot: workspace.virtualRoot,
			workspaceName: "workspace",
			metadata: `The project lives on the user's device and is reached through a restricted bridge. Use absolute paths under ${workspace.virtualRoot}. ${
				commandsOn ? "Commands run without a shell: one simple program per call, no pipes, redirects or chaining." : "Command execution is disabled; use the file tools."
			}`,
			mode: "act",
			providerId: c.providerId,
			platform: "linux",
		});
		const result = await core.start({
			source: "cli",
			interactive: true,
			config: {
				providerId: c.providerId,
				modelId: c.modelId,
				apiKey: c.apiKey,
				...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
				cwd: workspace.cwd,
				workspaceRoot: workspace.cwd,
				mode: "act",
				systemPrompt,
				maxIterations: c.maxIterations,
				enableTools: true,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				disableMcpSettingsTools: true,
			},
			...(initialMessages ? { initialMessages: initialMessages as never } : {}),
			toolPolicies: {
				"*": { autoApprove: true },
				...(commandsOn ? {} : { run_commands: { enabled: false } }),
				...(c.enableWebFetch ? {} : { fetch_web_content: { enabled: false } }),
			},
			capabilities: { toolExecutors: workspace.toolExecutors, requestToolApproval: () => ({ approved: true }) },
		});
		return { coreSessionId: result.sessionId, workspace };
	}

	async createSession(userId: string, projectId: string): Promise<string> {
		this.projects.get(userId, projectId); // ownership check
		const tmpKey = `s_${Math.random().toString(36).slice(2, 12)}`;
		const { coreSessionId, workspace } = await this.startCore(userId, projectId, tmpKey);
		const id = coreSessionId;
		this.sessions.put({ id, userId, projectId, coreSessionId, createdAt: Date.now() });
		this.live.set(id, { coreSessionId, workspace, busy: false, lastUsed: Date.now() });
		return id;
	}

	private async ensureLive(userId: string, sessionId: string): Promise<{ live: Live; projectId: string }> {
		const rec = this.sessions.get(userId, sessionId); // 404 for missing OR foreign
		this.projects.get(userId, rec.projectId);
		let live = this.live.get(sessionId);
		if (!live) {
			// Resume after restart/idle eviction: replay the persisted transcript into a fresh Cline session.
			// The transcript lives in this process's ephemeral Cline run dir. If it cannot be read, do NOT
			// silently continue with an empty/partial history: drop the session and tell the client to recreate it.
			let messages: unknown[];
			try {
				messages = await this.requireCore().readMessages(rec.coreSessionId);
			} catch {
				this.sessions.delete(sessionId);
				throw new HttpError(410, "session_expired: its transcript is no longer available; create a new session");
			}
			const started = await this.startCore(userId, rec.projectId, `r_${Math.random().toString(36).slice(2, 12)}`, messages);
			live = { ...started, busy: false, lastUsed: Date.now() };
			rec.coreSessionId = started.coreSessionId;
			this.sessions.put(rec);
			this.live.set(sessionId, live);
		}
		return { live, projectId: rec.projectId };
	}

	async runTurn(
		input: { sessionId: string; userId: string; prompt: string; signal: AbortSignal },
		emit: (event: TurnEvent) => void,
	): Promise<void> {
		const core = this.requireCore();
		const { userId } = input;
		const rec = this.sessions.get(userId, input.sessionId);
		if (this.shuttingDown) throw new HttpError(503, "server_restarting: retry shortly");
		if (!this.hub.isConnected(userId, rec.projectId)) throw new HttpError(409, "bridge_offline: connect the project's device first");
		if ((this.turnsByUser.get(userId) ?? 0) >= this.config.maxConcurrentTurnsPerUser || this.activeTurns >= this.config.maxConcurrentTurns) {
			throw new HttpError(503, "Server at capacity, retry shortly");
		}
		const existing = this.live.get(input.sessionId);
		if (existing?.busy) throw new HttpError(409, "Session already has a turn running");
		// Reserve before any await so concurrent requests cannot both pass the busy check.
		this.activeTurns++;
		this.turnsByUser.set(userId, (this.turnsByUser.get(userId) ?? 0) + 1);
		let live: Live | undefined;
		let unsubscribe: (() => void) | undefined;
		let timer: NodeJS.Timeout | undefined;
		let timedOut = false;
		const onAbort = () => { if (live) void core.abort(live.coreSessionId).catch(() => undefined); };
		const abortor = () => onAbort();
		this.abortors.add(abortor);
		try {
			live = (await this.ensureLive(userId, input.sessionId)).live;
			if (live.busy) throw new HttpError(409, "Session already has a turn running");
			live.busy = true;
			live.lastUsed = Date.now();
			const coreId = live.coreSessionId;
			unsubscribe = core.subscribe((event: CoreSessionEvent) => {
				if (event.type === "agent_event" && event.payload.sessionId === coreId) emit({ type: "agent_event", event: event.payload.event });
				else if (event.type === "status" && event.payload.sessionId === coreId) emit({ type: "status", status: event.payload.status });
			});
			input.signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => { timedOut = true; onAbort(); }, this.config.turnTimeoutMs);
			try {
				await core.send({ sessionId: coreId, prompt: input.prompt });
				// Cline reports an abort as a normal "aborted" completion, so a shutdown abort must be surfaced explicitly.
				if (this.shuttingDown || timedOut) {
					emit({ type: "error", message: this.shuttingDown ? RESTART_MESSAGE : TIMEOUT_MESSAGE });
					emit({ type: "done", ok: false });
				} else emit({ type: "done", ok: true });
			} catch (error) {
				const message = this.shuttingDown
					? RESTART_MESSAGE
					: timedOut ? TIMEOUT_MESSAGE
					: error instanceof Error ? error.message : String(error);
				emit({ type: "error", message });
				emit({ type: "done", ok: false });
			}
		} finally {
			this.abortors.delete(abortor);
			if (timer) clearTimeout(timer);
			input.signal.removeEventListener("abort", onAbort);
			unsubscribe?.();
			if (live) { live.busy = false; live.lastUsed = Date.now(); }
			this.activeTurns--;
			this.turnsByUser.set(userId, Math.max(0, (this.turnsByUser.get(userId) ?? 1) - 1));
		}
	}

	private async evict(id: string): Promise<void> {
		const live = this.live.get(id);
		if (!live) return;
		this.live.delete(id);
		await this.requireCore().stop(live.coreSessionId).catch(() => undefined);
		await live.workspace.dispose?.();
	}

	async closeSession(userId: string, sessionId: string): Promise<void> {
		this.sessions.get(userId, sessionId);
		await this.evict(sessionId);
		this.sessions.delete(sessionId);
	}

	async closeProjectSessions(userId: string, projectId: string): Promise<void> {
		for (const id of this.sessions.deleteForProject(userId, projectId)) await this.evict(id);
	}

	/** Free memory for idle sessions. Records stay, so they resume transparently. */
	async reapIdle(maxIdleMs: number): Promise<number> {
		const cutoff = Date.now() - maxIdleMs;
		let n = 0;
		for (const [id, l] of this.live) if (!l.busy && l.lastUsed < cutoff) { await this.evict(id); n++; }
		return n;
	}

	stats() { return { liveSessions: this.live.size, activeTurns: this.activeTurns }; }

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const abort of [...this.abortors]) abort();
		for (let i = 0; i < 80 && this.activeTurns > 0; i++) await new Promise((r) => setTimeout(r, 100)); // let streams finish (<=8s)
		for (const id of [...this.live.keys()]) await this.evict(id);
		await this.core?.dispose().catch(() => undefined);
	}
}
