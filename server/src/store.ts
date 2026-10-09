import { randomBytes } from "node:crypto";
import { HttpError } from "./auth";

/**
 * Project/session registries are IN MEMORY ONLY (Render Free has no persistent disk).
 * They are lost on every restart/redeploy; clients must treat a 404 for a previously valid
 * project/session as "server restarted, recreate it". The user's real project files live on
 * the Android device and are never stored here.
 */
export const EXPIRED_HINT = " (it may have expired after a server restart or redeploy; create a new one)";

export interface Project {
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	/** Termux device (sunset-sandbox-v1 at /bridge) this project runs on. Unset = the project uses the Android bridge at /v1/bridge. */
	deviceId?: string;
}

/** Ownership is enforced here: every lookup requires the caller's userId. */
export class ProjectStore {
	private readonly items = new Map<string, Project>();
	constructor(private readonly maxPerUser: number) {}
	create(userId: string, name: string): Project {
		if (this.list(userId).length >= this.maxPerUser) throw new HttpError(429, "project limit reached");
		const p: Project = { id: `p_${randomBytes(12).toString("hex")}`, userId, name: name.slice(0, 80), createdAt: Date.now() };
		this.items.set(p.id, p);
		return p;
	}
	/** Same error for "missing" and "someone else's" so ids cannot be probed. */
	get(userId: string, projectId: string): Project {
		const p = this.items.get(projectId);
		if (!p || p.userId !== userId) throw new HttpError(404, `project not found${EXPIRED_HINT}`, "project_not_found");
		return p;
	}
	/** Bind/unbind the Termux device. Authorisation (may this user use this device?) is the caller's job. */
	bindDevice(userId: string, projectId: string, deviceId: string | undefined): Project {
		const p = this.get(userId, projectId);
		if (deviceId === undefined) delete p.deviceId; else p.deviceId = deviceId;
		return p;
	}
	list(userId: string): Project[] {
		return [...this.items.values()].filter((p) => p.userId === userId);
	}
	delete(userId: string, projectId: string): void {
		this.get(userId, projectId);
		this.items.delete(projectId);
	}
}

export interface SessionRecord {
	id: string;
	userId: string;
	projectId: string;
	/** Current ClineCore session id; changes when an idle-evicted session is re-opened. */
	coreSessionId: string;
	createdAt: number;
}

export class SessionStore {
	private readonly items = new Map<string, SessionRecord>();
	put(rec: SessionRecord): void {
		this.items.set(rec.id, rec);
	}
	get(userId: string, id: string): SessionRecord {
		const r = this.items.get(id);
		if (!r || r.userId !== userId) throw new HttpError(404, `session not found${EXPIRED_HINT}`, "session_not_found");
		return r;
	}
	delete(id: string): void {
		this.items.delete(id);
	}
	deleteForProject(userId: string, projectId: string): string[] {
		const ids = [...this.items.values()].filter((r) => r.userId === userId && r.projectId === projectId).map((r) => r.id);
		for (const id of ids) this.items.delete(id);
		return ids;
	}
}
