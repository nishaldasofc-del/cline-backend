import { BridgeError } from "./protocol";

/**
 * The agent only ever sees this virtual root. Real device paths never reach the
 * server or the model. Every path is mapped to a project-relative POSIX path here
 * and rejected if it could leave the project.
 */
export const VIRTUAL_ROOT = "/workspace";
const MAX_PATH = 1024;

export function toProjectPath(input: unknown): string {
	if (typeof input !== "string" || input.length === 0 || input.length > MAX_PATH) {
		throw new BridgeError("BAD_REQUEST", "Invalid path");
	}
	if (input.includes("\0") || input.includes("\\")) throw new BridgeError("DENIED", "Path contains forbidden characters");
	let p = input;
	if (p.startsWith("/")) {
		if (p === VIRTUAL_ROOT || p.startsWith(`${VIRTUAL_ROOT}/`)) p = p.slice(VIRTUAL_ROOT.length);
		else throw new BridgeError("DENIED", `Path must be inside ${VIRTUAL_ROOT}`);
	} else if (p.startsWith("~")) {
		throw new BridgeError("DENIED", "Home-relative paths are not allowed");
	}
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new BridgeError("DENIED", "Path traversal is not allowed");
		out.push(seg);
	}
	return out.join("/") || ".";
}

/** Writes into VCS internals could plant hooks that execute on the device. */
export function assertWritable(rel: string): void {
	const segs = rel.split("/");
	if (segs.some((s) => s.toLowerCase() === ".git")) throw new BridgeError("DENIED", "Writing inside .git is not allowed");
	if (rel === ".") throw new BridgeError("DENIED", "Cannot write the project root");
}

export const toVirtual = (rel: string): string => (rel === "." ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${rel}`);
