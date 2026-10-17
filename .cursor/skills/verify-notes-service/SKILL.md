---
name: verify-notes-service
description: "Drive the notes-service example of @gjermundgaraba/effect-actions — its HTTP JSON API, notes CLI, and MCP endpoint — and capture proof. Use to launch an isolated local server, run doctor, or verify create, update, export, sign-in, or MCP tool behavior."
---

# Verify notes-service

Primary surface: the `notes-service` example, the application most hosts resemble. Callers reach it on three remote or local surfaces from one implementation: JSON `POST /api/<action>`, the `notes` CLI (which calls that API), and MCP at `POST /mcp`. The store is the in-memory `NoteStore` the server entrypoint provides. It starts empty. Nothing is seeded.

Other surfaces, not driven by this skill: `examples/quickstart` (one public action), `examples/mcp-tools` (stdio and HTTP tools over an upstream API), `examples/assistant` (in-process toolkit and local commands, no server), `examples/live-rpc` (Effect RPC over a WebSocket), `examples/kitchen-sink` (every module), plus `examples/notes-service/src/stdio.ts` (a separate process and a separate memory store) and `src/worker.ts` (a `fetch` handler, no listening port).

Two servers can run side by side. Each process has its own memory store and its own port. Never drive a server this run did not start. Do not reuse port 3000 just because it is the example default.

The harness is `notes-verify`, invoked as `.cursor/skills/verify-notes-service/helpers/notes-verify`.

## Launch

From the repository root, with a `node` that satisfies `package.json` `devEngines.runtime` (`^22.18.0 || ^24.11.0 || >=26.0.0`):

```sh
vp install
```

If `vp` is not on `PATH` yet, `pnpm install` (package manager `pnpm@12.5.1`) installs it. `prepare` runs `vp config`. Dependencies must be present before launch: the helper runs `node --import tsx`.

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify launch --evidence "$NOTES_VERIFY_EVIDENCE"
```

`NOTES_VERIFY_EVIDENCE` is the proof directory. When it is unset, launch uses `$HOME/.cache/effect-actions-verify/$RUN_ID`. Launch chooses a free loopback port, sets `HOST=127.0.0.1`, `PORT` to that port, and `PUBLIC_URL` to `http://127.0.0.1:$PORT`, then starts:

```sh
node --import tsx examples/notes-service/src/server.ts
```

Ready means all of these, which launch waits for:

- the process is still alive
- its log contains `Listening on http://127.0.0.1:$PORT`
- `POST /api/getStatus` with body `{}` returns JSON `"service":"notes-service"`

A listening socket alone is not ready. There is no migration. The memory store is empty when `getStatus` answers, so `notes` is `0` on a fresh process.

Launch prints `export NOTES_VERIFY_RUN=...`, `NOTES_URL`, `EVIDENCE_DIR`, `STATE_DIR`, and `PID`. Export `NOTES_VERIFY_RUN` before doctor, drive, or cleanup. State lives in `/tmp/effect-actions-verify-$NOTES_VERIFY_RUN/run.env`. The server log is `$EVIDENCE_DIR/server.log` from the start, so teardown does not eat it.

Demo tokens, fixed names in the example: `ada` and `grace` hold `notes:read` and `notes:write`; `reader` holds `notes:read` only. The CLI reads `NOTES_URL` and `NOTES_TOKEN`. The helper sets them per command. `--help` and `--version` need no token.

## Doctor

Read-only. Run it before driving, and again when a call looks wrong. It does not create notes.

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify doctor
```

It passes only when every line is `ok`:

- `PID` from the run env is alive
- `/proc/$PID/cmdline` contains `examples/notes-service/src/server.ts`
- `/proc/net/tcp` has a `LISTEN` socket on `127.0.0.1:$PORT` whose inode is one of that pid's fds (`ss` is not required)
- `GET /healthz` is `200` and body `ok`
- `POST /api/getStatus` with `{}` is `200`, `service` is `notes-service`, and `notes` is a number (not a fixed count: later creates change it)
- `POST /api/whoAmI` with `Authorization: Bearer ada` and body `{}` is `200` and the body contains `"id":"ada"` and `"notes:write"`
- `node --import tsx examples/notes-service/src/cli.ts --version` prints `notes v1.0.0` (the example command version, not the library's `package.json` version)

The report is appended to stdout and written to `$EVIDENCE_DIR/doctor.txt`. Exit code is `0` only when every check passed. Doctor talks to the server only with `GET /healthz`, `getStatus`, and `whoAmI`.

## Drive

Prefer `notes-verify http` and `notes-verify cli`. Both read the run env. Do not point `curl` at a different port.

HTTP actions are `POST /api/<action>` with `content-type: application/json`. An action with no input still needs a JSON object. `{}` is that body. A POST with no body answers `400` `{"_tag":"InvalidInput","message":"Expected object",...}`.

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify http \
  --token ada --evidence list-notes.http.txt \
  POST /api/listNotes --data '{}'
```

`--token none` sends no `Authorization` header. Tokens are `ada`, `grace`, or `reader`. The command prints the status, response headers, and body, writes the same exchange to `$EVIDENCE_DIR/<name>` when `--evidence` is set, and exits `0` only on a `2xx` status.

CLI commands are the example's `notes` commands. `create-note` reads the body from stdin (there is no `--body` flag). `get-note <id>` prints Markdown `# <title>` plus the body, not JSON. `list-notes`, `create-note`, `update-note`, and `get-status` print JSON.

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify cli \
  --token ada --evidence create-note.cli.txt \
  --stdin-text $'Tag and publish\n' -- \
  create-note --title "Release checklist"
```

`--expect-exit 1` is for a refusal you mean to observe (`MissingToken`, `NoteChanged`, `RequestConflict`). The default expected exit is `0`. Evidence records the command, token, `NOTES_URL`, exit code, stdout, and stderr.

MCP uses the same HTTP helper. Stateless revision `2026-07-28`. Listing tools needs no token, because `getStatus` is public. Calling a protected tool needs a bearer token.

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify http \
  --token none --evidence tools-list.http.txt \
  POST /mcp \
  --header 'accept: application/json, text/event-stream' \
  --header 'mcp-protocol-version: 2026-07-28' \
  --header 'mcp-method: tools/list' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"effect-actions","version":"0"},"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'
```

A `tools/call` adds `--header 'mcp-method: tools/call'`, `--header 'mcp-name: <tool>'`, and a bearer token for every tool except `getStatus`. Success is HTTP `200` and a JSON-RPC `result.structuredContent` equal to the action's success, with `result.isError` false.

Recipes for each feature are in `features/`. Start from a server this launch created. Drive every entry point the feature file lists before calling that feature verified.

## Evidence

Proof shows the user action and the resulting state. For a write, follow it with a second read through a user-facing command (`list-notes`, `get-note`, `POST /api/getNote`, or `get-status`), not by inspecting the process heap.

Write artifacts only under `$EVIDENCE_DIR`:

- `server.log` — launch log, including `Listening on ...`
- `doctor.txt` — doctor report
- `*.cli.txt` — command, exit code, stdout, stderr
- `*.http.txt` — method, path, status, headers, body

Assert titles, bodies, revisions, tags, and counts. Note ids are new UUIDs on every create; do not pin an id copied from another run. Parse JSON. Do not compare pretty-printed CLI output as a raw string.

The memory store is the production boundary of this example (marked `DEMO ONLY` in the example). There is no external network to mock. `PUBLIC_URL` only changes the OAuth metadata URL the server advertises. Verification does not open a browser and does not call `https://auth.example.com`.

## Cleanup

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify cleanup
```

That sends `SIGTERM` to the pid in the run env, `SIGKILL` if it is still alive after about five seconds, then deletes `/tmp/effect-actions-verify-$NOTES_VERIFY_RUN`. It does not delete `$EVIDENCE_DIR`. It does not kill by process name. After a failed launch or drive, run cleanup before starting another run. Confirm the evidence files are still in `$EVIDENCE_DIR` after cleanup.

## Helpers

| Script | Role |
| --- | --- |
| `.cursor/skills/verify-notes-service/helpers/notes-verify` | `launch`, `doctor`, `http`, `cli`, `cleanup` |

```sh
.cursor/skills/verify-notes-service/helpers/notes-verify help
```

The script is executable. It `cd`s to the repository root itself. Run it from anywhere. Feature recipes in `features/` use this helper and no other.
