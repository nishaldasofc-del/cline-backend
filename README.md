# Cline Agent Server

The real Cline coding agent (`sdk/packages/{shared,llms,agents,core,sdk}`, loop untouched) behind an
authenticated HTTP/SSE API for Render, operating **only** on a user's mobile project through a
restricted, versioned bridge. Model: Groq (or any OpenAI-compatible endpoint) via environment variables.

```
User's phone ──(outbound WSS, user token)──► Render API ──► WorkspaceProvider ──► ClineCore ──► Groq
 Android bridge executes 5 ops inside ONE        │  validates user, project ownership, every path
 project dir (docs/BRIDGE_PROTOCOL.md)           └► never touches the server filesystem for user data
```

## Auth model
- `SERVER_AUTH_TOKEN` = admin secret held by **your app backend only**. It mints short-lived per-user tokens:
  `POST /v1/admin/user-tokens {"userId","ttlSeconds"}` → `{token, expiresAt}`.
- The phone/app uses the **user token** for everything (`/v1/*` and the bridge socket). The user id comes only
  from the verified token — never from a header or body.
- Projects are created server-side (`POST /v1/projects`) and owned by the token's user. Ids are random; a foreign or
  missing project/session returns the same 404.

## API (all `/v1/*` need `Authorization: Bearer <user token>`)
| Route | Purpose |
|---|---|
| `GET /healthz` | Render health check (no auth) |
| `POST /v1/admin/user-tokens` | mint a user token (admin secret) |
| `GET /v1/info` | provider/model/limits/counters |
| `POST /v1/projects` `{name?}` · `GET /v1/projects` · `DELETE /v1/projects/:id` | project registry (`bridgeConnected` flag) |
| `GET /v1/bridge?projectId=` (WebSocket) | device connects here — see `docs/BRIDGE_PROTOCOL.md` |
| `POST /v1/projects/:id/sessions` · `DELETE /v1/sessions/:id` | session lifecycle |
| `POST /v1/sessions/:id/messages` `{prompt}` | run one turn, streamed as SSE (`agent_event`, `status`, `error`, `done`; `: ping` heartbeats) |

A turn over `TURN_TIMEOUT_MS` is aborted and the stream ends with `error: turn_timeout...` then `done {ok:false}`.
A turn needs the project's device connected (else `409 bridge_offline`). Closing the SSE connection aborts the turn. At capacity the server answers `503`.

## What the agent can do
Cline's real tools, backed by the bridge: `read_files`, `search_codebase`, `editor`, `apply_patch`, `run_commands`,
`fetch_web_content`. The agent sees a virtual root `/workspace`; the model never sees real device or server paths.
Edit/patch logic runs server-side on top of `READ_FILE`/`WRITE_FILE`/`PATCH` using Cline's own patch parser.

## Termux Sandbox Bridge (`/bridge`, `sunset-sandbox-v1`)

An Android phone running the Termux agent connects **out** to this server (no ngrok, tunnels, polling or open phone ports):

```
Termux agent ──(outbound WSS)──► wss://<render-host>/bridge ──► this server ──► admin REST ──► Sunset / your backend
```

- **Auth:** `BRIDGE_TOKEN` only (header `Authorization: Bearer`, `x-bridge-token`, or `?token=`). It is separate from
  `SERVER_AUTH_TOKEN`, which is never accepted at `/bridge`, and `BRIDGE_TOKEN` is never accepted by any REST route.
- **Registration:** the agent sends its `deviceId` (`x-device-id` / `?device_id=`); the server assigns a unique `sessionId`
  and answers with the `reg_ack_*` frame. One live session per device; a reconnect replaces the old one.
- **Operations** (admin REST, `Authorization: Bearer <SERVER_AUTH_TOKEN>`):
  `GET /v1/admin/bridge/devices` and `POST /v1/admin/bridge/execute` with a body such as
  `{"type":"read_file","path":"src/a.ts","deviceId":"pixel-7"}`. Types: `ping list_files read_file write_file delete_file mkdir run_command`.
  With one device connected `deviceId` is optional; with several it is required (`DEVICE_AMBIGUOUS` otherwise).
- **Safety:** the server rejects traversal/absolute paths and shell strings before anything reaches the phone, applies
  `COMMANDS_MODE`/allowlist to `run_command`, validates every result, times out and fails in-flight work when a device drops,
  and reaps stale devices via ping/pong. The agent's own sandbox jail remains the real boundary.
- Existing `/v1/*` APIs, `/v1/bridge` and the Cline/AI flow are unchanged. Details: `server/docs/SANDBOX_BRIDGE_PROTOCOL.md`.

**Connect a phone.** In Render set `BRIDGE_TOKEN` (see below), then in Termux:
```bash
RENDER_WSS_URL="wss://<your-service>.onrender.com/bridge" BRIDGE_TOKEN="<same value>" DEVICE_ID="pixel-7-termux" npm run bridge:agent
```
Verify: `curl -H "Authorization: Bearer $SERVER_AUTH_TOKEN" https://<your-service>.onrender.com/v1/admin/bridge/devices`.

## Security: what is actually enforced
| Control | Where | Status |
|---|---|---|
| Per-user auth (HMAC tokens, expiry), timing-safe compare | server | enforced + tested |
| Project/session ownership; cross-user access → 404 | server | enforced + tested |
| Bridge socket bound to the (user, project) it authenticated as | server | enforced + tested |
| Path validation: only `/workspace/**` or relative; no `..`, `~`, `\`, NUL; no writes into `.git` | server | enforced + tested |
| Commands: no shell, one program per call, allowlist, no shell operators, no absolute/`..` args | server | enforced + tested (**defense in depth only**, see below) |
| Request/body/prompt/file/frame size caps; per-op, per-command, per-turn timeouts; iteration cap; per-user & global turn caps | server | enforced + tested |
| Secrets (`GROQ_API_KEY`, `SERVER_AUTH_TOKEN`) redacted from SSE/errors/logs; not in model prompts | server | enforced + tested |
| Server-side `fetch_web_content`: http(s) 80/443 only, DNS-pinned private/loopback/metadata IP blocking, off by default | server | enforced; IP-guard unit-tested, live fetch not exercised |
| Symlink/real-path confinement, minimal command environment, process confinement | **device** | **NOT enforceable by the server.** Reference implementation + tests in `server/test/reference-bridge.ts`; the Android app must implement it |

Limits you should know about:
- A device that ignores the protocol's device requirements can be abused by a prompt-injected agent **within what that
  device allows**. The server cannot see or stop that. Treat the Android executor as the real sandbox.
- Allowed interpreters (`node`, `python`, `npm`…) can execute arbitrary code on the device, so the allowlist is not a
  boundary. Use `COMMANDS_MODE=off` if the device cannot confine processes.
- Tool calls are auto-approved (headless). Projects are isolated per user, not per request.
- User tokens are stateless: no per-token revocation; keep TTLs short (rotate `SERVER_AUTH_TOKEN` to invalidate all).
- Patch application briefly stages the referenced files in an ephemeral temp dir on the server, then deletes it.
- Single instance only (project/session registries and bridge sockets live in this process's memory).

## Deploy on Render Free ($0)
`render.yaml` targets a **free web service with no persistent disk**.

**What lives where**
| Data | Location | Survives restart/redeploy/spin-down? |
|---|---|---|
| Your actual project files, command execution | **Android device** (the permanent workspace), reached only via the bridge | Yes - never touched by the server |
| Project + session registries (ids, ownership) | Server **memory** | **No** |
| Cline runtime files (session DB, transcripts, logs) | Per-process dir under `/tmp/cline-agent/run-*` | **No** (deleted on shutdown; a new process never reads an old one's) |
| User tokens | Stateless HMAC, derived from `SERVER_AUTH_TOKEN` | Yes, while `SERVER_AUTH_TOKEN` is unchanged |

**Consequences of a restart, redeploy or free-tier spin-down** (be honest with your users about these)
- Active turns are ended cleanly: the SSE stream gets `error: server_restarting...` then `done {ok:false}`.
- All projects and sessions are forgotten. Old ids return `404 ... may have expired after a server restart` (same shape as a
  foreign/missing id) with `"code":"project_not_found"|"session_not_found"`; a refused bridge upgrade carries `X-Cline-Error: project_not_found`
  (recovery recipe: `server/docs/BRIDGE_PROTOCOL.md`). There is **no resume-after-restart**; clients must create a new project (`POST /v1/projects`) and session
  and re-attach the device. `GET /v1/info` returns `instanceId`, which changes on every boot, so apps can detect a reset.
- The Android bridge reconnects with its (still valid) user token and re-authenticates normally; it is refused with 404 until
  its project is recreated, then it reconnects as usual. Reconnecting never bypasses auth; a newer socket for the same
  user+project replaces the older one.
- Idle sessions are evicted from memory after `SESSION_IDLE_MS` (15 min) and re-opened from Cline's transcript **while the
  process is alive**; if that transcript is unreadable the session returns `410 session_expired` instead of continuing with partial history.
- Android project files are never modified by any of this.

**Steps**
1. Create a Blueprint from `render.yaml` (Docker, plan `free`, health check `/healthz`; Node 22 runtime in the image).
2. Set `GROQ_API_KEY` (and, for Termux, `BRIDGE_TOKEN`) in the dashboard. `SERVER_AUTH_TOKEN` is generated (>= 24 chars); copy it into your app backend's secrets.
3. Render injects `PORT`; the server binds `0.0.0.0:$PORT`. Use `wss://` for the bridge.
4. Optional: point an external monitor (e.g. UptimeRobot) at `GET /healthz` every ~5 min to reduce idle spin-down. `/healthz` is
   unauthenticated, instant and does not touch Cline, Groq or the bridge. The server has no self-ping code. Free instances can
   still restart (deploys, platform maintenance, monthly hours limits), so the consequences above always apply.

**Environment variables**
| Variable | Required | Value on Render Free |
|---|---|---|
| `GROQ_API_KEY` | yes | secret (dashboard) |
| `SERVER_AUTH_TOKEN` | yes | generated by the blueprint |
| `BRIDGE_TOKEN` | for `/bridge` | secret (dashboard). >= 24 chars, **different from** `SERVER_AUTH_TOKEN`, same value in Termux. Unset = `/bridge` returns 503; nothing else changes. Boot fails if it is weak or equal to the server key |
| `BRIDGE_MAX_DEVICES` / `BRIDGE_AGENT_MAX_PAYLOAD_BYTES` | no | `16` / `8388608` |
| `PROVIDER_ID` / `MODEL_ID` | no | `groq` / `llama-3.3-70b-versatile` |
| `COMMANDS_MODE` | no | `allowlist` (or `off` if the device cannot confine processes) |
| `MAX_CONCURRENT_TURNS` / `MAX_CONCURRENT_TURNS_PER_USER` | no | `1` / `1` (defaults) |
| `NODE_OPTIONS` | no | `--max-old-space-size=320` (set in blueprint) |
| `SESSION_IDLE_MS`, `MEMORY_LOG_INTERVAL_MS`, `TURN_TIMEOUT_MS`, `MAX_ITERATIONS`, ... | no | see `.env.example` |

**Memory.** Measured locally on Node 22 with a mock model: ~173 MB RSS at boot, ~185 MB after one session and five turns
(peak 194 MB). That is the Cline runtime plus server only; real model streaming, large tool outputs and concurrent turns will
use more, and Render's 512 MB limit also covers the container. Watch the `[mem] rss=... heapUsed=...` log lines (numbers only,
no prompts/code/secrets; every `MEMORY_LOG_INTERVAL_MS`, default 5 min) before raising concurrency. Free instances also have little CPU.

**Limitations.** This is a hobby/dev setup, not production-grade persistent infrastructure: single instance, no durable state,
cold starts after spin-down (~1 min), shared free-tier CPU. The security model is unchanged (see above): the device is the
real sandbox; the server enforces auth, ownership, path/command policy and limits but never exposes its own filesystem to the agent.
Config reference: `.env.example`.

## Develop / verify
```
bun install && bun run build          # sdk packages + server bundle
bun run test                          # server unit + e2e (production bundle, mock model, reference device)
bun run test:sdk                      # upstream package suites
GROQ_API_KEY=gsk_… bun x vitest run server/test/groq.live.test.ts   # real Groq (skipped without a key)
```
Runtime is plain Node 22; Bun is build-time only.

## Auth diagnostics (TEMPORARY — remove once the production 401 is understood)

Every `/v1/*` 401 logs ONE line (rate-limited per category) with exactly four facts, never a token or secret:

```
[auth-diag] verify_failed reason=<category> token_version=<v1|v2|unparsed|none> algorithm=HMAC-SHA256 secret_configured=<true|false>
```

| reason | meaning |
|---|---|
| `no_authorization_header` / `not_bearer_scheme` / `scheme_case_mismatch` / `empty_token` | the request never carried a usable `Bearer <token>` (empty = unset shell variable) |
| `bad_charset` | token contains characters a minted token never has: JSON quotes, a literal `${VAR}`, `\r`, a pasted response body |
| `malformed_segments` / `unsupported_version` / `bad_payload` | not a `v1.<payload>.<sig>` token |
| `bad_signature` | well-formed, signed under a **different** `SERVER_AUTH_TOKEN` (mint and verify hit different processes/services, or the secret was rotated) |
| `expired` | valid signature, past `exp` |
| `admin_secret_mismatch` | `/v1/admin/user-tokens` called with the wrong admin secret |

Which code/process answered: every response carries `X-Cline-Build` (label + first 7 chars of Render's `RENDER_GIT_COMMIT` when present) and `X-Cline-Instance` (random per boot). `curl -i` the mint call and the `/v1/info` call: different `X-Cline-Instance` values mean two processes handled them.
Tests: `bun run --cwd server test:auth` (mints a token and runs it through the same `requireUser()` gate, plus the built bundle under node).
