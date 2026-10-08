import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentService } from "./agent-service";
import { createApp, userFromRequest } from "./app";
import { AuthDiagnostics, HttpError, UserTokens } from "./auth";
import { BridgeHub } from "./bridge/hub";
import { SandboxHub } from "./bridge/sandbox-hub";
import { assertSafeId } from "./auth";
import { loadConfig } from "./config";
import { ProjectStore, SessionStore } from "./store";
import { BridgeWorkspaceProvider } from "./workspace";

const config = loadConfig();

// Render Free has NO persistent disk. Everything Cline writes (sessions.db, transcripts, logs, settings)
// goes to a private, per-process directory under an ephemeral base (default: os.tmpdir()/cline-agent).
// A fresh run dir per process means a restart can never half-restore a previous process's state.
// The user's project files are never here: they stay on the Android device, behind the bridge.
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const runDir = mkdtempSync(join(config.dataDir, "run-"));
process.env.CLINE_DIR = runDir;
process.env.CLINE_DATA_DIR = join(runDir, "data");
mkdirSync(process.env.CLINE_DATA_DIR, { recursive: true });
const serverDir = join(runDir, "server"); // per-session empty cwds + short-lived patch staging
mkdirSync(serverDir, { recursive: true });
const instanceId = `i_${randomBytes(6).toString("hex")}`; // changes on every boot so clients can detect a restart

// Build stamp (not a secret). Render exposes the deployed commit as RENDER_GIT_COMMIT; when present it is appended so the
// X-Cline-Build response header proves which commit is answering. Bump the label when you redeploy.
const BUILD = `auth-diag-2${process.env.RENDER_GIT_COMMIT ? `+${process.env.RENDER_GIT_COMMIT.slice(0, 7)}` : ""}`;
const tokens = new UserTokens(config.authToken);
const diag = new AuthDiagnostics(config.authToken.length > 0);
diag.startup();
console.log(`[boot] build=${BUILD} instance=${instanceId}`); // which code/process this is (kept out of the auth-diag lines)
const projects = new ProjectStore(config.maxProjectsPerUser);
const sessions = new SessionStore();

const hub = new BridgeHub({
	opTimeoutMs: config.bridgeOpTimeoutMs,
	maxPayloadBytes: config.bridgeMaxPayloadBytes,
	maxPendingPerConn: 8,
	authenticate: (req, url) => {
		const userId = userFromRequest(tokens, req, diag); // throws HttpError(401)
		let projectId: string;
		try { projectId = assertSafeId("projectId", url.searchParams.get("projectId")); } catch { throw new HttpError(400, "bad projectId"); }
		try { projects.get(userId, projectId); } catch { throw new HttpError(404, "project not found", "project_not_found"); }
		return { userId, projectId };
	},
});

// Termux Sandbox Bridge: agents connect OUT to wss://<host>/bridge (sunset-sandbox-v1) with BRIDGE_TOKEN. Independent of the hub above.
const sandboxHub = new SandboxHub({
	token: config.bridgeToken,
	opTimeoutMs: config.bridgeOpTimeoutMs,
	commandTimeoutMs: config.commandTimeoutMs,
	maxPayloadBytes: config.bridgeAgentMaxPayloadBytes,
	maxDevices: config.bridgeMaxDevices,
	maxPendingPerDevice: 8,
	commands: { mode: config.commandsMode, allowlist: config.commandAllowlist },
});
console.log(`[boot] sandbox-bridge ${config.bridgeToken ? "enabled at /bridge" : "disabled (set BRIDGE_TOKEN to enable /bridge)"}`);

const agent = new AgentService(config, new BridgeWorkspaceProvider(hub, serverDir, config), hub, projects, sessions);
await agent.init();

const server = createApp({ config, agent, hub, sandboxHub, projects, tokens, instanceId, build: BUILD, diag }).listen(config.port, config.host, () => {
	console.log(`cline-agent-server listening on ${config.host}:${config.port} (${config.providerId}/${config.modelId}, commands=${config.commandsMode}, node ${process.version})`);
});
hub.attach(server);
sandboxHub.attach(server);
// Render's proxy keeps connections ~60s+; stay above it so we never race a reused socket.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const reaper = setInterval(() => void agent.reapIdle(config.sessionIdleMs), Math.min(5 * 60_000, Math.max(10_000, config.sessionIdleMs / 3)));
reaper.unref();

// Memory telemetry: numbers only (never prompts, code, keys or file contents).
const mb = (n: number) => Math.round(n / 1048576);
let memTimer: NodeJS.Timeout | undefined;
if (config.memoryLogIntervalMs > 0) {
	const logMem = () => { const m = process.memoryUsage(); console.log(`[mem] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB ${JSON.stringify(agent.stats())}`); };
	logMem();
	memTimer = setInterval(logMem, config.memoryLogIntervalMs);
	memTimer.unref();
}

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	console.log(`${signal} received, shutting down`);
	clearInterval(reaper);
	if (memTimer) clearInterval(memTimer);
	server.close(); // stop accepting new HTTP connections
	// Abort running turns: each SSE stream gets an `error` (server_restarting) + `done{ok:false}` and ends cleanly.
	await agent.shutdown();
	sandboxHub.close();
	hub.close(); // devices see a normal close and reconnect (re-authenticating) once the new instance is up
	try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort: the dir is ephemeral anyway */ }
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
