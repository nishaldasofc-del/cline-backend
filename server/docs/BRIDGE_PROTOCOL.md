# Cline Bridge Protocol v1

How the server reaches a user's project **without ever receiving filesystem access to the phone**.
The phone connects **out** to the server; the server then asks it to perform a small set of
operations inside one authorized project. The device executes and replies. Nothing else crosses.

```
phone app ──(WSS, outbound)──► Render API ──► BridgeWorkspaceProvider ──► ClineCore ──► Groq
   ▲  executes ops inside ONE project dir         validates every path/command first
   └──────────── request / response frames ◄──────┘
```

## Connect
`GET /v1/bridge?projectId=<id>` upgrade to WebSocket, subprotocol `cline-bridge.v1`,
header `Authorization: Bearer <user token>`.
- 401 bad/expired token · 404 project missing **or owned by someone else** · 400 bad projectId.
  Rejections carry `X-Cline-Error: project_not_found` (404) so a device can tell a vanished project from a bad token.
- One live connection per (user, project); a new connection replaces the old one.
- Server pings every 20 s; a socket that doesn't pong is dropped. Max frame: `BRIDGE_MAX_PAYLOAD_BYTES` (2 MB).

### Getting a user token
Your trusted app backend (the only holder of `SERVER_AUTH_TOKEN`) calls
`POST /v1/admin/user-tokens {"userId","ttlSeconds"}` after it authenticates the user and hands the
returned token to the phone. Tokens are HMAC-signed, expire (default 1 h, max 24 h) and bind the user id.
The phone **never** sees `SERVER_AUTH_TOKEN`.

## Frames (JSON, text frames, `"v":1`)
Server → device after upgrade: `{"v":1,"type":"hello","server":"…","projectId":"…","ops":[…],"maxPayloadBytes":N}`
Device → server (required within 10 s): `{"v":1,"type":"hello","client":"android/1.0","ops":["READ_FILE",…]}`
Server → device: `{"v":1,"type":"request","id":"<uuid>","op":"<OP>","args":{…},"timeoutMs":N}`
Device → server: `{"v":1,"type":"response","id":"<same>","ok":true,"result":{…}}` or
`{"v":1,"type":"response","id":"…","ok":false,"error":{"code":"…","message":"…"}}`
Error codes: `NOT_FOUND DENIED TOO_LARGE TIMEOUT IO UNSUPPORTED BAD_REQUEST`.
Invalid frames close the socket (1008). Results that don't match the schemas below are rejected server-side.

## Operations
All `path` values are **project-relative POSIX paths** (`"."` = project root). The server has already
rejected absolute paths, `..`, `~`, backslashes and NULs before sending — the device must still check.

| Op | args | result |
|---|---|---|
| `READ_FILE` | `{path}` | `{content: utf8 string, size: int}` (files > 1 MB → `TOO_LARGE`) |
| `WRITE_FILE` | `{path, content}` (create parents; overwrite) | `{bytesWritten}` |
| `PATCH` | `{changes:[{action:"write",path,content}\|{action:"delete",path}]}` — validate **all** paths before applying **any** | `{applied}` |
| `SEARCH` | `{pattern?: regex, glob?, path?, maxResults}` — no `pattern` ⇒ list files | `{matches:[{path,line?,text?}], truncated}` |
| `RUN_COMMAND` | `{argv:[string], timeoutMs, maxOutputBytes}` — **no shell**, cwd = project root | `{exitCode, stdout, stderr, timedOut}` |

Notes: line slicing, edit semantics (`old_text`/`new_text`, insert) and Cline's patch grammar are
computed **on the server** from `READ_FILE`/`WRITE_FILE`; the device only needs these five primitives.
`SEARCH` should skip `.git`, `node_modules`, and symlinks.

## Device requirements (the real security boundary)
The server cannot enforce what the device does. The Android implementation **must**:
1. Resolve every path against the project root and verify the **real path** (after symlink resolution) stays inside it.
2. Refuse anything outside the project (including `..`, absolute paths, content URIs of other apps/dirs).
3. Run `RUN_COMMAND` with `argv` directly (never via `sh -c`), `cwd` = project root, a **minimal environment**
   (no inherited secrets), enforce `timeoutMs`/`maxOutputBytes`, and confine the process (app sandbox / dedicated project dir).
4. Only operate on the project the user explicitly selected; keep the socket tied to that project.
5. Let the user disconnect at any time; show when the agent is acting.
`server/test/reference-bridge.ts` is a runnable reference of these rules (including the symlink check).

## Versioning
`v` is an integer on every frame. Additive changes (new optional fields, new ops advertised in `hello.ops`)
keep `v:1`; the server only sends ops the device listed. Breaking changes bump `v` and the subprotocol name.

## Reconnect / server restart (Render Free)
The server keeps projects and sessions in memory only, so any restart/redeploy/spin-down erases them. Device/app recovery:
1. Socket closes (1001/abnormal) -> reconnect with the same user token and `projectId`, exponential backoff (1s..30s, jitter).
   Re-authentication is always required; there is no resume token.
2. Upgrade refused `401` -> token expired: fetch a fresh user token from your app backend, then retry.
3. Upgrade refused `404` + `X-Cline-Error: project_not_found` (or an API 404 with `"code":"project_not_found"|"session_not_found"`)
   -> the server restarted. Do NOT retry the same ids. `POST /v1/projects`, `POST /v1/projects/:id/sessions`, then connect the
   bridge with the NEW `projectId`. `GET /v1/info` `instanceId` changes on every boot if you want to detect it proactively.
4. `409 bridge_offline` on a turn -> the device is not connected yet; reconnect and retry.
Project files on the device are never affected.
