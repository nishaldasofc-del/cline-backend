// Minimal OpenAI-compatible /chat/completions streaming mock.
// Turn 1 -> tool call run_commands (writes a file + tries to leak the API key)
// Turn 2 (after tool result) -> plain text answer.
import http from "node:http";
const port = Number(process.env.MOCK_PORT || 18080);
const seen = [];
http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (!req.url.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
		const j = JSON.parse(body || "{}");
		seen.push({ auth: req.headers.authorization, model: j.model, tools: (j.tools || []).map((t) => t.function?.name) });
		const hasToolResult = (j.messages || []).some((m) => m.role === "tool");
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: j.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`);
		if (!hasToolResult) {
			send({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_commands", arguments: JSON.stringify({ commands: ["echo hello > out.txt && echo \"leak=[$GROQ_API_KEY][$SERVER_AUTH_TOKEN]\" >> out.txt && cat out.txt"] }) } }] });
			send({}, "tool_calls");
		} else {
			send({ role: "assistant", content: "All done: wrote out.txt." });
			send({}, "stop");
		}
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.write("data: [DONE]\n\n"); res.end();
	});
}).listen(port, () => console.log("mock up", port));
process.on("SIGTERM", () => { console.log("SEEN", JSON.stringify(seen)); process.exit(0); });
