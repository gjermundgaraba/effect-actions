# Sign in

Sign in is how a caller learns whether the service is up, which demo token they hold, and which writes that token may perform. A missing token and a read-only token fail before a note is written.

## Sub-features

- `status-public` answers `get-status` with no token.
- `health` answers `GET /healthz` with `ok`.
- `who-ada` names `ada` and both scopes.
- `token-missing` makes every notes command exit `1` with `MissingToken`, including `get-status`.
- `reader-forbidden` lets `reader` call `whoAmI` and refuses `createNote` with `notes:write`.

## How to get to it (user POV)

- `POST /api/getStatus` with body `{}` and no `Authorization` header, or `notes get-status` with `NOTES_TOKEN` set.
- `GET /healthz`.
- `notes who-am-i` or `POST /api/whoAmI` with `Authorization: Bearer ada`.
- Run any notes command with `NOTES_TOKEN` unset.
- Call `POST /api/createNote` with `Authorization: Bearer reader`.

## Driving it with notes-verify

Preconditions:

- `notes-verify doctor` printed `doctor ok` for this run.
- No note has been created yet, so a refused create is visible as `getStatus` still reporting `"notes":0`.

- **Public status.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence sign-in-status.http.txt POST /api/getStatus --data '{}'`. Status `200`. Body is `{"service":"notes-service","notes":0}`.
- **Health.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence healthz.http.txt GET /healthz`. Status `200`. Body is `ok`.
- **Who ada.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence who-am-i.http.txt POST /api/whoAmI --data '{}'`. Status `200`. Body is `{"id":"ada","scopes":["notes:read","notes:write"]}`.
- **CLI who.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence who-am-i.cli.txt -- who-am-i`. Exit `0`. Stdout JSON has `id` `ada`.
- **Missing token.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token none --expect-exit 1 --evidence missing-token.cli.txt -- get-status`. Exit `1`. Stderr contains `MissingToken: NOTES_TOKEN is not set. Set it to your token: export NOTES_TOKEN=<your token>`.
- **Reader identity.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token reader --evidence who-reader.http.txt POST /api/whoAmI --data '{}'`. Status `200`. Body is `{"id":"reader","scopes":["notes:read"]}`.
- **Reader write.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token reader --evidence reader-create.http.txt POST /api/createNote --data '{"title":"Nope","body":"x"}'`. The helper exits non-zero. Status `403`. Body is `{"_tag":"Forbidden","message":"Requires notes:write.","scopes":["notes:write"]}`.
- **No note stored.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence sign-in-status-after.http.txt POST /api/getStatus --data '{}'`. `notes` is still `0`.

## Gotchas

- `notes --help` and `notes --version` need no token. Every other command, `get-status` included, exits `1` when `NOTES_TOKEN` is unset. That is the CLI asking for a token, not the server refusing `getStatus`.
- HTTP `getStatus` is public. Proving the CLI without a token does not prove the HTTP route requires one.
- `reader` may call `whoAmI` and `listNotes`. Only a write such as `createNote` answers `Forbidden` with `scopes` `["notes:write"]`.
- An unknown token such as `mallory` on `whoAmI` is `401` and `{"_tag":"Unauthenticated","message":"Unknown demo token."}`. Do not substitute that for the `reader` check.
- `GET /healthz` is not an action. It has no JSON body and no token.
