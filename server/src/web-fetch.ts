import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** True for loopback, private, link-local, CGNAT, multicast, reserved and mapped-v4 equivalents. */
export function isBlockedIp(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split(".").map(Number);
		return (
			a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
		);
	}
	if (net.isIPv6(ip)) {
		const l = ip.toLowerCase();
		if (l === "::" || l === "::1") return true;
		const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isBlockedIp(mapped[1]);
		if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(l)) return true; // hex-form mapped v4: refuse
		return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith("ff");
	}
	return true;
}

/** Validates every address at connect time, which also defeats DNS rebinding. */
const guardedLookup: net.LookupFunction = (hostname, options, cb) => {
	dns.lookup(hostname, { all: true }, (err, addrs) => {
		if (err) return cb(err, "", 0);
		if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
			return cb(new Error("Destination address is not allowed"), "", 0);
		}
		const first = addrs[0];
		if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
		cb(null, first.address, first.family);
	});
};

function assertUrl(raw: string): URL {
	let u: URL;
	try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs are allowed");
	if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
	const port = u.port || (u.protocol === "https:" ? "443" : "80");
	if (port !== "80" && port !== "443") throw new Error("Only ports 80 and 443 are allowed");
	const host = u.hostname.replace(/^\[|\]$/g, "");
	if (net.isIP(host) && isBlockedIp(host)) throw new Error("Destination address is not allowed");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
		throw new Error("Destination host is not allowed");
	}
	return u;
}

function once(u: URL, timeoutMs: number, maxBytes: number): Promise<{ status: number; location?: string; type: string; body: string }> {
	return new Promise((resolve, reject) => {
		const lib = u.protocol === "https:" ? https : http;
		const req = lib.request(u, { method: "GET", lookup: guardedLookup, timeout: timeoutMs, headers: { "user-agent": "cline-agent-server/0.1", accept: "text/*,application/json" } }, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (c: Buffer) => {
				size += c.length;
				if (size > maxBytes) { res.destroy(); reject(new Error("Response too large")); return; }
				chunks.push(c);
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("Request timed out")));
		req.on("error", reject);
		req.end();
	});
}

export async function fetchPublicText(rawUrl: string, opts = { timeoutMs: 15_000, maxBytes: 500_000, maxRedirects: 3 }): Promise<string> {
	let u = assertUrl(rawUrl);
	for (let i = 0; i <= opts.maxRedirects; i++) {
		const r = await once(u, opts.timeoutMs, opts.maxBytes);
		if (r.status >= 300 && r.status < 400 && r.location) { u = assertUrl(new URL(r.location, u).toString()); continue; }
		if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
		if (!/^(text\/|application\/(json|xml|xhtml))/i.test(r.type)) throw new Error(`Unsupported content type: ${r.type || "unknown"}`);
		const text = /html/i.test(r.type)
			? r.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
			: r.body;
		return text.slice(0, 100_000);
	}
	throw new Error("Too many redirects");
}
