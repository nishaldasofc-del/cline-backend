import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * All runtime configuration comes from environment variables.
 * Model: PROVIDER_ID / MODEL_ID / (optional) BASE_URL / API_KEY. Defaults to Groq.
 */
export type CommandsMode = "off" | "allowlist" | "passthrough";

export interface ServerConfig {
	port: number;
	host: string;
	/** Admin secret held by YOUR trusted app backend. Mints per-user tokens. */
	authToken: string;
	providerId: string;
	modelId: string;
	apiKey: string;
	baseUrl?: string;
	maxIterations: number;
	/**
	 * EPHEMERAL scratch base (Render Free: no persistent disk). Each process creates a private
	 * run directory inside it for Cline's runtime files, per-session empty cwds and patch staging.
	 * Never holds user project data.
	 */
	dataDir: string;
	/** Evict (free memory of) sessions idle this long; they are re-opened from Cline's transcript. */
	sessionIdleMs: number;
	/** Log RSS/heap every N ms (0 = off). */
	memoryLogIntervalMs: number;
	commandsMode: CommandsMode;
	commandAllowlist: string[];
	commandTimeoutMs: number;
	enableWebFetch: boolean;
	turnTimeoutMs: number;
	maxConcurrentTurns: number;
	maxConcurrentTurnsPerUser: number;
	maxBodyBytes: number;
	maxProjectsPerUser: number;
	bridgeOpTimeoutMs: number;
	bridgeMaxPayloadBytes: number;
	maxFileBytes: number;
	userTokenMaxTtlSeconds: number;
}

export const DEFAULT_DATA_DIR = join(tmpdir(), "cline-agent");

export const DEFAULT_ALLOWLIST = [
	"ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd", "echo", "diff", "sort", "uniq",
	"mkdir", "touch", "cp", "mv", "rm", "sed", "git",
	"node", "npm", "npx", "pnpm", "yarn", "bun", "tsc", "python", "python3", "pip", "pip3", "pytest",
	"make", "cargo", "go",
];

function nonNegInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
	return n;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
	return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const providerId = env.PROVIDER_ID?.trim() || "groq";
	const apiKey =
		env.API_KEY?.trim() || (providerId === "groq" ? env.GROQ_API_KEY?.trim() : undefined) || env.OPENAI_API_KEY?.trim();
	if (!apiKey) throw new Error("Missing model API key: set GROQ_API_KEY (or API_KEY)");
	const authToken = env.SERVER_AUTH_TOKEN?.trim();
	if (!authToken) throw new Error("Missing required env var SERVER_AUTH_TOKEN");
	if (authToken.length < 24) throw new Error("SERVER_AUTH_TOKEN must be at least 24 characters");
	const mode = (env.COMMANDS_MODE?.trim() || "allowlist") as CommandsMode;
	if (!["off", "allowlist", "passthrough"].includes(mode)) throw new Error("COMMANDS_MODE must be off|allowlist|passthrough");
	const allow = env.COMMAND_ALLOWLIST?.split(",").map((s) => s.trim()).filter(Boolean);
	return {
		// Render injects PORT; 10000 is Render's documented default.
		port: int(env, "PORT", 10000),
		host: env.HOST?.trim() || "0.0.0.0",
		authToken,
		providerId,
		modelId: env.MODEL_ID?.trim() || "llama-3.3-70b-versatile",
		apiKey,
		baseUrl: env.BASE_URL?.trim() || undefined,
		maxIterations: int(env, "MAX_ITERATIONS", 30),
		dataDir: env.CLINE_DATA_DIR?.trim() || DEFAULT_DATA_DIR,
		sessionIdleMs: int(env, "SESSION_IDLE_MS", 15 * 60_000),
		memoryLogIntervalMs: nonNegInt(env, "MEMORY_LOG_INTERVAL_MS", 5 * 60_000),
		commandsMode: mode,
		commandAllowlist: allow?.length ? allow : DEFAULT_ALLOWLIST,
		commandTimeoutMs: int(env, "COMMAND_TIMEOUT_MS", 60_000),
		enableWebFetch: env.ENABLE_WEB_FETCH === "true",
		turnTimeoutMs: int(env, "TURN_TIMEOUT_MS", 10 * 60_000),
		maxConcurrentTurns: int(env, "MAX_CONCURRENT_TURNS", 1),
		maxConcurrentTurnsPerUser: int(env, "MAX_CONCURRENT_TURNS_PER_USER", 1),
		maxBodyBytes: int(env, "MAX_BODY_BYTES", 128 * 1024),
		maxProjectsPerUser: int(env, "MAX_PROJECTS_PER_USER", 20),
		bridgeOpTimeoutMs: int(env, "BRIDGE_OP_TIMEOUT_MS", 90_000),
		bridgeMaxPayloadBytes: int(env, "BRIDGE_MAX_PAYLOAD_BYTES", 2 * 1024 * 1024),
		maxFileBytes: int(env, "MAX_FILE_BYTES", 1024 * 1024),
		userTokenMaxTtlSeconds: int(env, "USER_TOKEN_MAX_TTL_SECONDS", 24 * 3600),
	};
}
