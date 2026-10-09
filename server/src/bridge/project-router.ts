import { HttpError } from "../auth";
import type { ProjectStore } from "../store";
import { BridgeError, type BridgeOp, type OpArgs, type OpResult } from "./protocol";
import type { ProjectBridge } from "./project-bridge";
import type { SunsetBridgeAdapter } from "./sunset-adapter";

/** May `userId` use Termux device `deviceId`? The map comes from BRIDGE_DEVICE_USERS; empty = nobody. */
export function deviceAllowed(acl: Record<string, string[]>, userId: string, deviceId: string): boolean {
	return Object.hasOwn(acl, deviceId) && acl[deviceId].includes(userId);
}

/**
 * Picks the transport for a project: a project with a bound deviceId runs on that Termux device (sunset-sandbox-v1);
 * a project without one keeps using the Android bridge (cline-bridge.v1). The device is re-authorised on EVERY call,
 * not just at bind time, so removing a user from BRIDGE_DEVICE_USERS takes effect on the next operation.
 */
export class ProjectBridgeRouter implements ProjectBridge {
	constructor(
		private readonly projects: ProjectStore,
		private readonly android: ProjectBridge,
		private readonly sunset: SunsetBridgeAdapter | undefined,
		private readonly acl: Record<string, string[]>,
	) {}

	isConnected(userId: string, projectId: string): boolean {
		let dev: string | undefined;
		try { dev = this.projects.get(userId, projectId).deviceId; } catch { return false; }
		if (dev === undefined) return this.android.isConnected(userId, projectId);
		return !!this.sunset && deviceAllowed(this.acl, userId, dev) && this.sunset.isConnected(dev);
	}

	async call<O extends BridgeOp>(userId: string, projectId: string, op: O, args: OpArgs[O], timeoutMs?: number): Promise<OpResult<O>> {
		let dev: string | undefined;
		try { dev = this.projects.get(userId, projectId).deviceId; } catch (e) { if (e instanceof HttpError) throw new BridgeError("DENIED", "Project not found"); throw e; }
		if (dev === undefined) return this.android.call(userId, projectId, op, args, timeoutMs);
		if (!this.sunset) throw new BridgeError("OFFLINE", "The Termux bridge is disabled on this server");
		if (!deviceAllowed(this.acl, userId, dev)) throw new BridgeError("DENIED", "This user may not use the project's device");
		return this.sunset.call(dev, op, args);
	}
}
