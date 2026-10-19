---
name: verify-effect-actions
description: "Drive examples/kitchen-sink of @gjermundgaraba/effect-actions — member HTTP, the tracker CLI, MCP, Effect RPC, and the operator port — and capture proof. Use to launch an isolated tracker, run doctor, or verify creating an issue, attaching an image, calling RPC, asking the assistant, or suspending a workspace."
---

# Verify effect-actions

Primary surface: `examples/kitchen-sink`, the reference application that serves every module. Members reach a JSON API at `POST /api/v1/<action>`, the `tracker` CLI (which calls that API), MCP at `POST /mcp`, and Effect RPC at `ws://<host>/rpc`. Operators reach `POST /admin/<action>` on a second port. One process holds both listeners and one in-memory store. Launch runs `seed.ts`, which files `ACME-1` in workspace `acme` with a screenshot and a comment.

`examples/notes-service` is the small application to copy. It is a subset of this one: HTTP, a remote CLI, and MCP, without RPC, images, a second audience, or the assistant. `examples/quickstart`, `examples/mcp-tools`, `examples/assistant`, and `examples/live-rpc` are smaller slices of the same modules. This skill drives kitchen-sink so one launch reaches those surfaces. It does not start `stdio.ts`, `ops.ts`, or `agent.ts`: each is its own process and its own memory, so an issue created there is not on this server.

Two trackers can run side by side. Each process has its own memory and its own pair of ports. Never drive a server this run did not start.

The harness is `verify-effect-actions`, invoked as `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions`.

## Launch

From the repository root, with a `node` that satisfies `package.json` `devEngines.runtime` (`^22.18.0 || ^24.11.0 || >=26.0.0`):

```sh
vp install
```

If `vp` is not on `PATH` yet, `pnpm install` (package manager `pnpm@12.14.0`) installs it. Dependencies must be present before launch: the helper runs `node --import tsx`.

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions launch --evidence "$EFFECT_ACTIONS_VERIFY_EVIDENCE"
```

`EFFECT_ACTIONS_VERIFY_EVIDENCE` is the proof directory. When it is unset, launch uses `$HOME/.cache/effect-actions-verify/$RUN_ID`. Launch chooses two free loopback ports and starts:

```sh
HOST=127.0.0.1 PORT=<public> ADMIN_PORT=<admin> PUBLIC_URL=http://127.0.0.1:<public> \
  node --import tsx examples/kitchen-sink/src/server.ts
```

Ready means all of these, which launch waits for, and then the seed:

- the process is still alive
- its log contains `Listening on http://127.0.0.1:<public>` and `Listening on http://127.0.0.1:<admin>`
- `POST /api/v1/getStatus` and `POST /admin/getStatus` with body `{}` both return `"service":"tracker"`
- `node --import tsx examples/kitchen-sink/src/seed.ts` with `TRACKER_URL` set exits 0 and prints `Filed ACME-1`

A listening socket alone is not ready. There is no migration. The memory store starts empty; seed is what makes `ACME-1` exist. `getStatus` reports `workspaces` `2` (`acme` and `globex`) whether or not any issue has been filed.

Launch prints `export EFFECT_ACTIONS_VERIFY_RUN=...`, `TRACKER_URL`, `ADMIN_URL`, `TRACKER_RPC_URL`, `EVIDENCE_DIR`, `STATE_DIR`, and `PID`. Each value is shell-quoted, so the block can be `eval`'d when a path contains spaces. Export `EFFECT_ACTIONS_VERIFY_RUN` before doctor, drive, or cleanup. State lives in `/tmp/effect-actions-verify-$EFFECT_ACTIONS_VERIFY_RUN/run.env`. The server log is `$EVIDENCE_DIR/server.log` and the seed log is `$EVIDENCE_DIR/seed.log` from the start, so teardown does not eat them.

Demo credentials:

- Member bearer tokens `ada` (read and write in `acme`, read in `globex`), `linus` (read in `acme`), `grace` (read and write in `globex`), `kay` (member of `acme` with no scope). Send `X-Workspace: acme` or `globex` with the token.
- Session cookies for RPC: `ada-at-acme`, `grace-at-globex`, `kay-at-acme`.
- Operator keys on the admin port: `ops-key` (list, suspend, resume) and `support-key` (list only), header `X-Operator-Key`.

The CLI reads `TRACKER_URL`, `TRACKER_TOKEN`, and `TRACKER_WORKSPACE`. The helper sets them per command. `--help` and `--version` need none.

## Doctor

Read-only. Run it before driving, and again when a call looks wrong. It does not file an issue.

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions doctor
```

It passes only when every line is `ok`:

- `PID` from the run env is alive and its `/proc` start time is the `STARTED` value launch recorded
- `/proc/$PID/cmdline` contains `examples/kitchen-sink/src/server.ts`
- `/proc/net/tcp` shows `127.0.0.1:$PORT` and `127.0.0.1:$ADMIN_PORT` as listen sockets whose inodes are fds of that pid (`ss` is not required)
- `GET /healthz` on the public port is `200` and body `ok`
- `POST /api/v1/getStatus` with `{}` is `200`, `service` is `tracker`, `workspaces` is `2`, and `instance` is a string
- `POST /admin/getStatus` on the admin port is `200` and `service` is `tracker`
- `POST /api/v1/whoAmI` with `Authorization: Bearer ada`, `X-Workspace: acme`, and body `{}` is `200` and contains `"id":"ada"`, `"workspace":"acme"`, and `"issues:write"`
- `node --import tsx examples/kitchen-sink/src/cli.ts --version` prints `tracker v1.0.0`
- `tracker list-issues --json` as `ada` in `acme` includes `ACME-1`

The report is printed and written to `$EVIDENCE_DIR/doctor.txt`. Exit code is `0` only when every check passed.

## Drive

Prefer `verify-effect-actions http`, `cli`, and `rpc`. All three read the run env. Do not point `curl` at a different port. Paths under `/admin/` go to `ADMIN_URL`. Every other path goes to `TRACKER_URL`.

HTTP actions are `POST` with `content-type: application/json`. An action with no input still needs `{}`. A POST with no body answers `400` `InvalidInput`.

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http \
  --token ada --workspace acme --evidence list-issues.http.txt \
  POST /api/v1/listIssues --data '{}'
```

`--token none` sends no bearer token. `--workspace none` sends no `X-Workspace`. Operator calls add `--header 'x-operator-key: ops-key'`. The command prints the status, response headers, and body, writes that exchange when `--evidence` is set, and exits `0` only on a `2xx` status.

CLI commands are the example's `tracker` commands. `create-issue` reads the body from stdin. `list-issues` and `get-issue` print text unless you pass `--json`. `get-issue <id>` without `--json` prints a Markdown heading.

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli \
  --token ada --workspace acme --evidence create-issue.cli.txt \
  --stdin-text $'Tag and publish\n' -- \
  create-issue --title "Release checklist"
```

`--expect-exit 1` is for a refusal you mean to observe. The default expected exit is `0`.

RPC is one WebSocket call of `listIssues`, using Node's WebSocket and the session cookie on the message:

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions rpc \
  --session ada-at-acme --evidence rpc-list.txt
```

Stdout is the decoded `{ issues }` JSON. Exit `0` means the socket answered within 8 seconds.

MCP uses the HTTP helper. Stateless revision `2026-07-28`. Listing tools needs no token, because `getStatus` is public. A protected tool needs the bearer token and `X-Workspace`.

Recipes for each feature are in `features/`. Start from a server this launch created. Drive every entry point the feature file lists before calling that feature verified.

## Evidence

Proof shows the user action and the resulting state. For a write, follow it with a later read through `list-issues`, `get-issue`, `POST /api/v1/getIssue`, or the operator's `listWorkspaces`.

Write artifacts only under `$EVIDENCE_DIR`:

- `server.log` — launch log, including both `Listening on` lines
- `seed.log` — seed stdout, including `Filed ACME-1`
- `doctor.txt` — doctor report
- `*.cli.txt` — command, exit code, stdout, stderr
- `*.http.txt` — method, path, status, headers, body
- `rpc-list.txt` — session, socket URL, exit code, stdout, stderr

Issue ids are `<WORKSPACE>-<n>` in filing order. After seed, the next issue in `acme` is `ACME-2`. Parse JSON. Do not compare pretty-printed CLI output as a raw string except the Markdown from `get-issue`.

The memory store, the scripted assistant model, and the fixed credentials are the demo boundary of this example. Verification does not call `https://auth.example.com` and does not open a browser. The RPC script is the web app's client run under Node, which is how `examples/live-rpc/src/client.ts` runs its page client.

## Cleanup

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cleanup
```

That sends `SIGTERM` to the pid in the run env only when `/proc/<pid>` still shows the start time launch recorded, then `SIGKILL` if that same process is still alive after about five seconds, then deletes `/tmp/effect-actions-verify-$EFFECT_ACTIONS_VERIFY_RUN`. A pid whose start time differs is left alone. It does not delete `$EVIDENCE_DIR`. It does not kill by process name. `run.env` stores every value with shell quoting, so an evidence path may contain spaces. After a failed launch or drive, run cleanup before starting another run. Confirm the evidence files are still in `$EVIDENCE_DIR` after cleanup.

## Helpers

| Script | Role |
| --- | --- |
| `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions` | `launch`, `doctor`, `http`, `cli`, `rpc`, `cleanup` |
| `.cursor/skills/verify-effect-actions/helpers/rpc-list.ts` | WebSocket `listIssues`. Invoked by the `rpc` subcommand, not by hand. |

```sh
.cursor/skills/verify-effect-actions/helpers/verify-effect-actions help
```

The shell script is executable. It `cd`s to the repository root itself. Feature recipes use this helper and no other.
