# Call over RPC

Call over RPC lets the web app's client list the member's issues on the WebSocket at `/rpc`, using the session cookie instead of a bearer token.

## Sub-features

- `rpc-list` lists `acme` issues for session `ada-at-acme`.
- `rpc-seed` shows the seeded issue `ACME-1` with title `Crash on save` and status `open`.

## How to get to it (user POV)

- Open the WebSocket `ws://<public host>/rpc`.
- Send each call with the cookie `tracker_session=ada-at-acme`.
- Call `listIssues`.

## Driving it with verify-effect-actions

Preconditions:

- `verify-effect-actions doctor` printed `doctor ok` for this run.
- No issue has been filed after seed, so `acme` holds only `ACME-1`.

- **List.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions rpc --session ada-at-acme --evidence rpc-list.txt`. Exit `0`. Stdout JSON `issues` has one object: `id` `ACME-1`, `title` `Crash on save`, `status` `open`.

## Gotchas

- The helper uses Node's WebSocket, the same split as `examples/live-rpc`: a page uses the browser's WebSocket, and a script uses Node's. The browser's global `WebSocket` does not carry this call to completion.
- The session cookie is `ada-at-acme`, not the bearer token `ada`.
- A call that does not answer within 8 seconds fails the helper. Do not replace the socket with `POST /api/v1/listIssues` and call the RPC journey verified.
- `grace-at-globex` lists `globex`, which has no seeded issue. That is a different workspace, not an empty `acme`.
