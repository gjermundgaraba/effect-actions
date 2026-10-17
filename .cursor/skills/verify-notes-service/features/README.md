# notes-service verification map

This directory is the maintained source for verifying the user-facing behavior of the `notes-service` example. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Install dependencies from the repository root with `vp install` (or `pnpm install` when `vp` is not on `PATH` yet).
- `node` on `PATH` satisfies `devEngines.runtime`: `^22.18.0 || ^24.11.0 || >=26.0.0`.
- Launch with `.cursor/skills/verify-notes-service/helpers/notes-verify launch`. The memory store starts empty. There is no seed data.
- Export `NOTES_VERIFY_RUN` from the launch output. Set `NOTES_VERIFY_EVIDENCE` before launch when proof must land in a chosen directory.
- Run `notes-verify doctor` and require every line to be `ok`, including the launched `NOTES_URL`, the server pid, and `notes v1.0.0`.
- Never drive an instance that was not started by this verification run. A second run uses its own port and its own memory store.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted titles, tokens, and JSON unchanged.
- Run HTTP and MCP through `notes-verify http`.
- Run terminal actions through `notes-verify cli`.
- Send `{}` as the JSON body of an action that takes no input.
- Restore nothing in the memory store: the process exit discards it. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final response.
- CLI proof includes the command, stdout, stderr, and exit code (`*.cli.txt`).
- HTTP and MCP proof includes the status, headers, and body (`*.http.txt`).
- Mutation proof includes a later read-only command that shows the stored note.
- Record the feature id and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with notes-verify` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Create a note](./create-note.md) covers CLI and HTTP creation, a second read, and a safe retry with the same request key.
- [Update a note](./update-note.md) covers replacing a body with the revision you read, and the refusal when that revision is stale.
- [Export and import](./export-import.md) covers writing notes to Markdown and creating them again from that file.
- [Sign in](./sign-in.md) covers the public status, a demo token, a missing token, and a token that cannot write.
- [Call an MCP tool](./mcp-tools.md) covers listing tools without a token and calling `getStatus` and `createNote` on `/mcp`.
