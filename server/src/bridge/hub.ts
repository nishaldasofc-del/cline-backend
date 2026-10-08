import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
	BridgeError, type BridgeErrorCode, type BridgeOp, ClientFrame, ERROR_CODES, type OpArgs, type OpResult,
	OPS, PROTOCOL_VERSION, ResultSchemas, SUBPROTOCOL,
} from "./protocol";

interface Pending {
	op: BridgeOp;
	resolve: (v: unknown) => void;
	reject: (e: BridgeError) => void;
	timer: NodeJS.Timeout;
}
interface Conn {
	ws: WebSocket;
	ready: boolean;
	alive: boolean;
	ops: Set<string>;
	pending: Map<string, Pending>;
}

export interface HubOptions {
	opTimeoutMs: number;
	maxPayloadBytes: number;
	maxPendingPerConn: number;
	/** Resolve the caller from the upgrade request, or throw an HttpError-like {status,message}. */
	authenticate(req: IncomingMessage, url: URL): { userId: string; projectId: string };
}

const key = (userId: string, projectId: string) => `${userId}\u0000${projectId}`;

/**
 * Holds the phones' outbound connections. A request for (userId, projectId) can
 * only ever be delivered to the socket that authenticated as exactly that pair.
 */
export class BridgeHub {
	private readonly conns = new Map<string, Conn>();
	private readonly wss: WebSocketServer;
	private readonly heartbeat: NodeJS.Timeout;

	constructor(private readonly opts: HubOptions) {
		this.wss = new WebSocketServer({
			noServer: true,
			maxPayload: opts.maxPayloadBytes,
			handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
		});
		this.heartbeat = setInterval(() => {
			for (const c of this.conns.values()) {
				if (!c.alive) { c.ws.terminate(); continue; }
				c.alive = false;
				c.ws.ping();
			}
		}, 20_000);
		this.heartbeat.unref();
	}

	attach(server: Server): void {
		server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
			const reject = (status: number, msg: string, code?: string) => {
				const hdr = code && /^[a-z_]{1,40}$/.test(code) ? `X-Cline-Error: ${code}\r\n` : "";
				socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n${hdr}Content-Length: 0\r\n\r\n`);
				socket.destroy();
			};
			let who: { userId: string; projectId: string };
			try {
				const url = new URL(req.url ?? "/", "http://x");
				if (url.pathname === "/bridge") return; // owned by SandboxHub (Termux agents, sunset-sandbox-v1)
				if (url.pathname !== "/v1/bridge") return reject(404, "Not Found");
				if (!(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).includes(SUBPROTOCOL)) {
					return reject(400, "Bad Request");
				}
				who = this.opts.authenticate(req, url);
			} catch (e) {
				const status = (e as { status?: number }).status ?? 401;
				return reject(status, status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "Unauthorized", (e as { code?: string }).code);
			}
			this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, who.userId, who.projectId));
		});
	}

	private onConnection(ws: WebSocket, userId: string, projectId: string): void {
		const k = key(userId, projectId);
		const old = this.conns.get(k);
		if (old) { this.failAll(old, new BridgeError("OFFLINE", "Bridge replaced by a newer connection")); old.ws.close(4000, "replaced"); }
		const conn: Conn = { ws, ready: false, alive: true, ops: new Set(), pending: new Map() };
		this.conns.set(k, conn);
		ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", server: "cline-agent-server", projectId, ops: OPS, maxPayloadBytes: this.opts.maxPayloadBytes }));
		const helloTimer = setTimeout(() => { if (!conn.ready) ws.close(4001, "hello timeout"); }, 10_000);
		ws.on("pong", () => { conn.alive = true; });
		ws.on("message", (data, isBinary) => {
			if (isBinary) return ws.close(1003, "text frames only");
			let frame;
			try { frame = ClientFrame.parse(JSON.parse(data.toString("utf8"))); } catch { return ws.close(1008, "invalid frame"); }
			if (frame.type === "hello") {
				conn.ready = true;
				conn.ops = new Set(frame.ops);
				clearTimeout(helloTimer);
				return;
			}
			const p = conn.pending.get(frame.id);
			if (!p) return; // late or unknown id: ignore
			conn.pending.delete(frame.id);
			clearTimeout(p.timer);
			if (!frame.ok) {
				const code = (ERROR_CODES as readonly string[]).includes(frame.error?.code ?? "") ? (frame.error!.code as BridgeErrorCode) : "IO";
				return p.reject(new BridgeError(code, frame.error?.message ?? "device error"));
			}
			const parsed = ResultSchemas[p.op].safeParse(frame.result);
			if (!parsed.success) return p.reject(new BridgeError("BAD_RESPONSE", "Device returned a malformed result"));
			p.resolve(parsed.data);
		});
		const gone = () => {
			clearTimeout(helloTimer);
			if (this.conns.get(k) === conn) this.conns.delete(k);
			this.failAll(conn, new BridgeError("OFFLINE", "Device disconnected"));
		};
		ws.on("close", gone);
		ws.on("error", gone);
	}

	private failAll(conn: Conn, err: BridgeError): void {
		for (const [id, p] of conn.pending) { clearTimeout(p.timer); p.reject(err); conn.pending.delete(id); }
	}

	isConnected(userId: string, projectId: string): boolean {
		const c = this.conns.get(key(userId, projectId));
		return !!c && c.ready && c.ws.readyState === WebSocket.OPEN;
	}

	call<O extends BridgeOp>(userId: string, projectId: string, op: O, args: OpArgs[O], timeoutMs = this.opts.opTimeoutMs): Promise<OpResult<O>> {
		const conn = this.conns.get(key(userId, projectId));
		if (!conn || !conn.ready || conn.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new BridgeError("OFFLINE", "The device for this project is not connected"));
		}
		if (!conn.ops.has(op)) return Promise.reject(new BridgeError("UNSUPPORTED", `Device does not support ${op}`));
		if (conn.pending.size >= this.opts.maxPendingPerConn) return Promise.reject(new BridgeError("BUSY", "Too many operations in flight"));
		const id = randomUUID();
		return new Promise<OpResult<O>>((resolve, reject) => {
			const timer = setTimeout(() => {
				conn.pending.delete(id);
				reject(new BridgeError("TIMEOUT", `${op} timed out`));
			}, timeoutMs);
			conn.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer });
			conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "request", id, op, args, timeoutMs }), (err) => {
				if (err) { clearTimeout(timer); conn.pending.delete(id); reject(new BridgeError("OFFLINE", "Send failed")); }
			});
		});
	}

	disconnect(userId: string, projectId: string): void {
		this.conns.get(key(userId, projectId))?.ws.close(4002, "project removed");
	}

	close(): void {
		clearInterval(this.heartbeat);
		for (const c of this.conns.values()) c.ws.close(1001, "server shutting down");
		this.wss.close();
	}
}
