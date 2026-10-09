import type { BridgeOp, OpArgs, OpResult } from "./protocol";

/**
 * What the WorkspaceProvider and AgentService need from "the device behind a project". Two transports implement it:
 *  - BridgeHub            (cline-bridge.v1 at /v1/bridge: the Android app, one socket per user+project)
 *  - SunsetBridgeAdapter  (sunset-sandbox-v1 at /bridge: a Termux agent, one socket per device)
 * ProjectBridgeRouter picks per project, so the agent loop and tool executors never know which one they use.
 */
export interface ProjectBridge {
	isConnected(userId: string, projectId: string): boolean;
	call<O extends BridgeOp>(userId: string, projectId: string, op: O, args: OpArgs[O], timeoutMs?: number): Promise<OpResult<O>>;
}
