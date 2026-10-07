import http from "node:http";

export type Script = (ctx: { messages: any[]; step: number }) => Array<{ tool?: { name: string; args: unknown }; text?: string }>;

/** OpenAI-compatible streaming /chat/completions mock; records every request body. */
export function startMockModel(script: Script): Promise<{ url: string; requests: any[]; auth: string[]; delay: { ms: number }; close(): Promise<void> }> {
	const delay = { ms: 0 };
	const requests: any[] = []; const auth: string[] = [];
	const server = http.createServer((req, res) => {
		let body = ""; req.on("data", (c) => (body += c));
		req.on("end", async () => {
			if (delay.ms) await new Promise((r) => setTimeout(r, delay.ms));
			if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
			const j = JSON.parse(body); requests.push(j); auth.push(String(req.headers.authorization));
			const roles: string[] = j.messages.map((m: any) => m.role);
			const lastUser = roles.lastIndexOf("user");
			const step = roles.slice(lastUser + 1).filter((r) => r === "assistant").length; // model calls so far this turn
			const steps = script({ messages: j.messages, step });
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const send = (delta: any, finish?: string) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: j.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`);
			const tools = steps.filter((s) => s.tool);
			if (tools.length) {
				send({ role: "assistant", content: null, tool_calls: tools.map((s, i) => ({ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name: s.tool!.name, arguments: JSON.stringify(s.tool!.args) } })) });
				send({}, "tool_calls");
			} else { send({ role: "assistant", content: steps.map((s) => s.text).join("") }); send({}, "stop"); }
			res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.write("data: [DONE]\n\n"); res.end();
		});
	});
	return new Promise((r) => server.listen(0, "127.0.0.1", () => {
		const port = (server.address() as any).port;
		r({ url: `http://127.0.0.1:${port}/v1`, requests, auth, delay, close: () => new Promise((c) => server.close(() => c())) });
	}));
}
