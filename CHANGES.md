# What changed vs. upstream cline-main

Original: 4,166 files / 70.7 MB. This tree: ~910 files (+ `server/`), `node_modules` 1.2 GB → ~211 MB (incl. dev tooling).

## Removed (whole trees)
- `apps/cli` (CLI/TUI), `apps/vscode` (extension, webview-ui, proto), `apps/cline-hub`, all `apps/examples/*` (desktop-app, menubar, vscode, multi-agent, quickstart, ...)
- `sdk/packages/ui`, `sdk/examples`, `sdk/scripts`
- `docs`, `evals`, `.github`, `.agents`, `.claude`, `.codex`, `.cline`, `.vscode`, `.husky`, `patches`, lint/release tooling

## Removed inside `sdk/packages/llms` (provider transports not needed for Groq/OpenAI-compatible)
- `providers/vendors/`: anthropic, bedrock, cline, community (claude-code / codex-cli / opencode / dify / SAP), google, mistral, ollama, vertex, minimax-thinking
- `services/langfuse-*`
- 18 dependencies: @ai-sdk/{amazon-bedrock,anthropic,google,google-vertex,mistral,otel}, @aws-sdk/credential-providers, @jerome-benoit/sap-ai-provider, @langfuse/*, @opentelemetry/{api,context-async-hooks,sdk-trace-node}, ai-sdk-provider-opencode-sdk, dify-ai-provider, ollama-ai-provider-v2

## Edited (all small)
- `llms/src/providers/ai-sdk.ts`: provider dispatch keeps only `openai` and `openai-compatible`; Langfuse telemetry replaced by no-ops
- `llms/src/index.ts`: dropped exports of removed modules
- `core/src/services/telemetry/OpenTelemetryProvider.ts`: dropped one Langfuse import
- `core/.../handler-factory.test.ts`: removed one SAP-specific test; `core/.../langfuse-relay.test.ts` deleted
- `shared/package.json`: declared the previously undeclared `nanoid`

## Kept untouched
`shared`, `agents` and `core` (agent loop, tools, compaction, session persistence, hub/OTel code paths), `sdk` (public entry).

## Added
`server/` (config, WorkspaceProvider seam, AgentService, Express app), `Dockerfile`, `docker-entrypoint.sh`, `render.yaml`, `.env.example`, `README.md`.

## Known gaps
- Upstream tests in `llms` that exercise removed providers (anthropic/cline/google/codex...) fail: 54 of 742 across 5 files in `llms/src/providers`. They should be deleted or trimmed.
- Dockerfile and Render deploy were not run (no Docker here); the server was smoke-tested on Node 22 against a mock OpenAI-compatible endpoint, not real Groq.

## Render Free (no persistent disk)
- `render.yaml`: plan `free`, persistent disk and `CLINE_DATA_DIR=/var/data/cline` removed; concurrency 1/1; heap cap.
- `store.ts`: `ProjectStore`/`SessionStore` are in-memory (same API/ownership/404 behavior; constructor paths removed).
- `index.ts`: Cline files go to a per-process `mkdtemp` dir under an ephemeral base, removed on shutdown; `instanceId`; memory telemetry; graceful shutdown ordering.
- `agent-service.ts`: shutdown aborts turns and reports `server_restarting`; unreadable transcript -> `410` instead of silent empty resume.
- `config.ts`: defaults `MAX_CONCURRENT_TURNS=1`, `..._PER_USER=1`, `SESSION_IDLE_MS`, `MEMORY_LOG_INTERVAL_MS`; `CLINE_DATA_DIR` defaults to OS temp.
- Tests: restart test rewritten for the ephemeral contract; new unit + e2e coverage.

## Auth trace + diagnostics (build `auth-diag-2`)
- `app.ts`: the `/v1` gate is now the exported `requireUser(tokens, diag)`; `createApp` mounts it and the tests call the same function. Accept/reject behaviour is unchanged.
- `auth.ts`: new failure category `bad_charset`; `AuthDiagnostics` logs only reason, token_version, algorithm, secret_configured.
- `index.ts`: `[boot] build=… instance=…` line; `X-Cline-Build` includes the Render commit when available.
- `test/auth-integration.test.ts`: mint → same middleware; secret/user/ttl matrix; two-process split; diagnostics field + no-leak checks; built-bundle run under node.

## Termux Sandbox Bridge hub (`/bridge`, sunset-sandbox-v1)
- Fixes Termux agents being refused with `404` (the only upgrade path was `/v1/bridge`; every other path was destroyed).
- New: `server/src/bridge/sandbox-hub.ts`, `sandbox-protocol.ts`; `BRIDGE_TOKEN` (+ `BRIDGE_MAX_DEVICES`, `BRIDGE_AGENT_MAX_PAYLOAD_BYTES`) in `config.ts`.
- New admin routes `GET /v1/admin/bridge/devices`, `POST /v1/admin/bridge/execute` (SERVER_AUTH_TOKEN), mounted only when a hub is passed to `createApp`.
- Edited (small): `bridge/hub.ts` +1 line (ignore `/bridge` instead of 404-ing it), `index.ts` wiring/shutdown, `app.ts` routes + `BRIDGE_TOKEN` added to the redactor, `render.yaml`, `.env.example`, README.
- Unchanged: all `/v1/*` REST/SSE, `/v1/bridge`, Cline/AI flow, user-token auth. Tests: `test/sandbox-bridge.test.ts` (42).
