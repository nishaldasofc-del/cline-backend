import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { safeEqual } from "../auth";
import { prepareCommand } from "../command-policy";
import type { CommandsMode } from "../config";
import { BridgeError } from "./protocol";
import {
	AgentFrame, parseSandboxCall, SANDBOX_PATH, SANDBOX_PROTOCOL, SandboxHubError, SandboxResultSchemas,
	type SandboxCall, type SandboxErrorCode, type SandboxResponse,
} from "./sandbox-protocol";

export interface SandboxHubOptions {
	/** BRIDGE_TOKEN. Undefined = endpoint disabled (503), nothing else changes. */
	token: string | undefined;
	/** Default per-operation timeout. */
	opTimeoutMs: number;
	/** Applied to run_command when the caller gives none; the agent caps it at 120 s. */
	commandTimeoutMs: number;
	/** Max frame accepted from an agent, and max frame sent to one. */
	maxPayloadBytes: number;
	maxDevices: number;
	maxPendingPerDevice: number;
	commands: { mode: CommandsMode; allowlist: string[] };
	/** Ping interval; a device that misses one full interval is terminated. Default 20 s. */
	heartbeatMs?: number;
	log?: (line: string) => void;
}

export interface DeviceInfo {
	deviceId: string;
	sessionId: string;
	connectedAt: number;
	lastSeenAt: number;
	remoteAddress?: string;
	pending: number;
}

interface Pending {
	resolve: (r: SandboxResponse) => void;
	timer: NodeJS.Timeout;
	op: SandboxCall["type"];
	callerId: string;
}
interface Session {
	deviceId: string;
	sessionId: string;
	ws: WebSocket;
	connectedAt: number;
	lastSeenAt: number;
	remoteAddress?: string;
	alive: boolean;
	pending: Map<string, Pending>;
}

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CMD_GRACE_MS = 5_000;
const AGENT_MAX_CMD_MS = 120_000;

export function errorResponse(id: string, code: SandboxErrorCode | string, message: string, extra?: { deviceId?: string; sessionId?: string; details?: unknown }): SandboxResponse {
	return {
		protocol: SANDBOX_PROTOCOL, id, ok: false,
		error: { code, message: message.slice(0, 500), ...(extra?.details !== undefined ? { details: extra.details } : {}) },
		...(extra?.deviceId ? { deviceId: extra.deviceId } : {}),
		...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
	};
}

/**
 * Holds the Termux agents' OUTBOUND connections (one live session per deviceId) and routes operations to the right one.
 *
 * Isolation from the rest of the server: it owns only the `/bridge` upgrade path, shares no state with the per-user
 * `/v1/bridge` hub, and authenticates exclusively with BRIDGE_TOKEN (never SERVER_AUTH_TOKEN or a user token).
 */
export class SandboxHub {
	private readonly sessions = new Map<string, Session>();
	private readonly wss: WebSocketServer;
	private readonly heartbeat: NodeJS.Timeout;
	private readonly log: (line: string) => void;
	private closed = false;

	constructor(private readonly opts: SandboxHubOptions) {
		this.log = opts.log ?? ((l) => console.log(l));
		// The agent does not request a subprotocol, so none is negotiated; the protocol name travels inside every frame.
		this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes });
		const every = opts.heartbeatMs ?? 20_000;
		this.heartbeat = setInterval(() => {
			for (const s of this.sessions.values()) {
				if (!s.alive) { this.log(`[sandbox-bridge] stale device=${s.deviceId} session=${s.sessionId}: no pong, terminating`); s.ws.terminate(); continue; }
				s.alive = false;
				try { s.ws.ping(); } catch { s.ws.terminate(); }
			}
		}, every);
		this.heartbeat.unref();
	}

	get enabled(): boolean { return !!this.opts.token; }

	/** Registers the /bridge upgrade handler. Requests for any other path are left to the other handlers. */
	attach(server: Server): void {
		server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
			let pathname: string;
			let url: URL;
			try { url = new URL(req.url ?? "/", "http://x"); pathname = url.pathname; } catch { return; }
			if (pathname !== SANDBOX_PATH) return;
			const refuse = (status: number, text: string, code: string) => {
				socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nX-Cline-Error: ${code}\r\nContent-Length: 0\r\n\r\n`);
				socket.destroy();
			};
			if (this.closed) return refuse(503, "Service Unavailable", "bridge_shutting_down");
			if (!this.opts.token) return refuse(503, "Service Unavailable", "bridge_disabled");
			const auth = this.authenticate(req, url);
			if (!auth.ok) {
				this.log(`[sandbox-bridge] refused upgrade: ${auth.code}`);
				return refuse(auth.status, auth.status === 401 ? "Unauthorized" : "Bad Request", auth.code);
			}
			if (!this.sessions.has(auth.deviceId) && this.sessions.size >= this.opts.maxDevices) {
				this.log(`[sandbox-bridge] refused upgrade: capacity (${this.opts.maxDevices})`);
				return refuse(503, "Service Unavailable", "bridge_capacity");
			}
			const fwd = req.headers["x-forwarded-for"];
			const remote = (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : undefined) || req.socket.remoteAddress; // informational only, not trusted
			this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, auth.deviceId, remote?.slice(0, 64)));
		});
	}

	/** Token: `Authorization: Bearer`, then `x-bridge-token`, then `?token=` (the agent sends all three). Device: `x-device-id` / `?device_id=`. */
	private authenticate(req: IncomingMessage, url: URL): { ok: true; deviceId: string } | { ok: false; status: number; code: string } {
		let token: string | undefined;
		const h = req.headers.authorization;
		if (typeof h === "string" && h.startsWith("Bearer ")) token = h.slice(7).trim();
		if (!token && typeof req.headers["x-bridge-token"] === "string") token = req.headers["x-bridge-token"].trim();
		if (!token) token = url.searchParams.get("token")?.trim() || undefined;
		if (!token || !safeEqual(token, this.opts.token as string)) return { ok: false, status: 401, code: "bridge_unauthorized" };
		const hd = req.headers["x-device-id"];
		const deviceId = (typeof hd === "string" && hd.trim() ? hd : url.searchParams.get("device_id") ?? "").trim();
		if (!DEVICE_ID.test(deviceId)) return { ok: false, status: 400, code: "bridge_bad_device_id" };
		return { ok: true, deviceId };
	}

	private register(ws: WebSocket, deviceId: string, remoteAddress: string | undefined): void {
		const prev = this.sessions.get(deviceId);
		if (prev) {
			// One live session per device: the newest connection wins (a phone that lost network reconnects before the old socket times out).
			this.sessions.delete(deviceId);
			this.failPending(prev, "DEVICE_OFFLINE", `Device '${deviceId}' was replaced by a newer session`);
			try { prev.ws.close(4009, "replaced by newer session"); } catch { /* ignore */ }
		}
		const now = Date.now();
		const s: Session = {
			deviceId, ws, sessionId: `sess_${now}_${randomBytes(4).toString("hex")}`,
			connectedAt: now, lastSeenAt: now, remoteAddress, alive: true, pending: new Map(),
		};
		this.sessions.set(deviceId, s);
		this.log(`[sandbox-bridge] device connected device=${deviceId} session=${s.sessionId} devices=${this.sessions.size}`);

		// Registration ack: the agent recognises `reg_ack_*` and stores data.sessionId.
		ws.send(JSON.stringify({ protocol: SANDBOX_PROTOCOL, id: `reg_ack_${s.sessionId}`, ok: true, data: { registered: true, deviceId, sessionId: s.sessionId, hubTimestamp: now } }));

		ws.on("pong", () => { s.alive = true; s.lastSeenAt = Date.now(); });
		ws.on("message", (data, isBinary) => this.onMessage(s, data, isBinary));
		const gone = () => this.end(s);
		ws.on("close", gone);
		ws.on("error", (e) => { this.log(`[sandbox-bridge] socket error device=${deviceId}: ${e.message}`); gone(); });
	}

	private onMessage(s: Session, data: unknown, isBinary: boolean): void {
		if (isBinary) return void s.ws.close(1003, "text frames only");
		let frame: ReturnType<typeof AgentFrame.parse>;
		try { frame = AgentFrame.parse(JSON.parse(String(data))); } catch { return void s.ws.close(1008, "invalid frame"); }
		s.alive = true;
		s.lastSeenAt = Date.now();
		const p = s.pending.get(frame.id);
		if (!p) return; // late (already timed out), duplicate or unknown id: ignore
		s.pending.delete(frame.id);
		clearTimeout(p.timer);
		const meta = { deviceId: s.deviceId, sessionId: s.sessionId };
		if (!frame.ok) {
			return p.resolve(errorResponse(p.callerId, frame.error?.code ?? "INTERNAL_ERROR", frame.error?.message ?? "device error", { ...meta, details: frame.error?.details }));
		}
		const parsed = SandboxResultSchemas[p.op].safeParse(frame.data);
		if (!parsed.success) return p.resolve(errorResponse(p.callerId, "BAD_RESPONSE", `Device returned a malformed ${p.op} result`, meta));
		p.resolve({ protocol: SANDBOX_PROTOCOL, id: p.callerId, ok: true, data: parsed.data, ...meta });
	}

	private end(s: Session): void {
		if (this.sessions.get(s.deviceId) === s) {
			this.sessions.delete(s.deviceId);
			this.log(`[sandbox-bridge] device disconnected device=${s.deviceId} session=${s.sessionId} devices=${this.sessions.size}`);
		}
		this.failPending(s, "DEVICE_OFFLINE", `Device '${s.deviceId}' disconnected before completing the request`);
	}

	private failPending(s: Session, code: SandboxErrorCode, message: string): void {
		for (const [id, p] of s.pending) {
			clearTimeout(p.timer);
			p.resolve(errorResponse(p.callerId, code, message, { deviceId: s.deviceId, sessionId: s.sessionId }));
			s.pending.delete(id);
		}
	}

	listDevices(): DeviceInfo[] {
		return [...this.sessions.values()].map((s) => ({ deviceId: s.deviceId, sessionId: s.sessionId, connectedAt: s.connectedAt, lastSeenAt: s.lastSeenAt, remoteAddress: s.remoteAddress, pending: s.pending.size }));
	}

	isConnected(deviceId: string): boolean {
		const s = this.sessions.get(deviceId);
		return !!s && s.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Validate, apply the command policy, pick the device and send. NEVER rejects: every failure (bad input, offline, timeout,
	 * device error) comes back as an `ok:false` envelope so callers handle one shape.
	 *
	 * Routing: an explicit `deviceId` goes to exactly that device (DEVICE_NOT_FOUND if absent). With none, the single connected
	 * device is used; zero devices -> DEVICE_OFFLINE; several -> DEVICE_AMBIGUOUS (never guess).
	 */
	async route(input: unknown, opts: { deviceId?: string; id?: string } = {}): Promise<SandboxResponse> {
		const callerId = typeof opts.id === "string" && opts.id.length > 0 && opts.id.length <= 128 ? opts.id : `req_${randomUUID()}`;
		let call: SandboxCall;
		let wire: Record<string, unknown>;
		let timeoutMs = this.opts.opTimeoutMs;
		try {
			call = parseSandboxCall(input);
			wire = { ...call };
			if (call.type === "run_command") {
				const argv = this.prepare(call);
				const cmdTimeout = Math.min(call.timeoutMs ?? this.opts.commandTimeoutMs, AGENT_MAX_CMD_MS);
				wire = { type: "run_command", command: argv[0], ...(argv.length > 1 ? { args: argv.slice(1) } : {}), timeoutMs: cmdTimeout };
				timeoutMs = cmdTimeout + CMD_GRACE_MS;
			}
		} catch (e) {
			if (e instanceof SandboxHubError) return errorResponse(callerId, e.code, e.message);
			throw e;
		}

		const target = opts.deviceId?.trim() || undefined;
		let s: Session | undefined;
		if (target) {
			s = this.sessions.get(target);
			if (!s) return errorResponse(callerId, "DEVICE_NOT_FOUND", `Device '${target.slice(0, 64)}' is not currently connected`);
		} else if (this.sessions.size === 0) {
			return errorResponse(callerId, "DEVICE_OFFLINE", "No Termux bridge device is connected. Start the agent on the phone.");
		} else if (this.sessions.size > 1) {
			return errorResponse(callerId, "DEVICE_AMBIGUOUS", `Several devices are connected (${[...this.sessions.keys()].join(", ")}); specify deviceId`);
		} else {
			s = this.sessions.values().next().value as Session;
		}
		const meta = { deviceId: s.deviceId, sessionId: s.sessionId };
		if (s.ws.readyState !== WebSocket.OPEN) return errorResponse(callerId, "DEVICE_OFFLINE", `Device '${s.deviceId}' connection is not open`, meta);
		if (s.pending.size >= this.opts.maxPendingPerDevice) return errorResponse(callerId, "DEVICE_BUSY", `Device '${s.deviceId}' has too many operations in flight`, meta);

		// The wire id is always server-generated, so two callers can never collide or spoof each other's responses.
		const wireId = `req_${randomUUID()}`;
		const text = JSON.stringify({ protocol: SANDBOX_PROTOCOL, id: wireId, deviceId: s.deviceId, ...wire });
		if (Buffer.byteLength(text) > this.opts.maxPayloadBytes) return errorResponse(callerId, "PAYLOAD_TOO_LARGE", `Request exceeds ${this.opts.maxPayloadBytes} bytes`, meta);

		const session = s;
		return new Promise<SandboxResponse>((resolve) => {
			const timer = setTimeout(() => {
				session.pending.delete(wireId);
				resolve(errorResponse(callerId, "BRIDGE_TIMEOUT", `Device '${session.deviceId}' did not answer ${call.type} within ${timeoutMs} ms`, meta));
			}, timeoutMs);
			session.pending.set(wireId, { resolve, timer, op: call.type, callerId });
			session.ws.send(text, (err) => {
				if (!err) return;
				clearTimeout(timer);
				if (session.pending.delete(wireId)) resolve(errorResponse(callerId, "DEVICE_OFFLINE", `Failed to send to device '${session.deviceId}'`, meta));
			});
		});
	}

	/** Command policy (COMMANDS_MODE / allowlist). Always yields a bare program name + argv; a shell string can never reach the agent. */
	private prepare(call: Extract<SandboxCall, { type: "run_command" }>): string[] {
		try {
			return prepareCommand(call.args ? { command: call.command, args: call.args } : call.command, this.opts.commands);
		} catch (e) {
			if (e instanceof BridgeError) throw new SandboxHubError(e.code === "BAD_REQUEST" || e.code === "TOO_LARGE" ? "INVALID_REQUEST" : "COMMAND_FORBIDDEN", e.message);
			throw e;
		}
	}

	/** Drop a device (e.g. operator action). */
	disconnect(deviceId: string): void {
		this.sessions.get(deviceId)?.ws.close(4002, "disconnected by server");
	}

	close(): void {
		this.closed = true;
		clearInterval(this.heartbeat);
		for (const s of [...this.sessions.values()]) {
			this.sessions.delete(s.deviceId);
			this.failPending(s, "DEVICE_OFFLINE", "Server shutting down");
			try { s.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
		}
		this.wss.close();
	}
}
