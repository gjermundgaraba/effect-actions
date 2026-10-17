# effect-actions verification map

This directory is the maintained source for verifying the user-facing behavior of `examples/kitchen-sink`, the reference application for `@gjermundgaraba/effect-actions`. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Install dependencies from the repository root with `vp install` (or `pnpm install` when `vp` is not on `PATH` yet).
- `node` on `PATH` satisfies `devEngines.runtime`: `^22.18.0 || ^24.11.0 || >=26.0.0`.
- Launch with `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions launch`. Launch seeds workspace `acme` with issue `ACME-1`, title `Crash on save`, one PNG attachment, and one comment.
- Export `EFFECT_ACTIONS_VERIFY_RUN` from the launch output. Set `EFFECT_ACTIONS_VERIFY_EVIDENCE` before launch when proof must land in a chosen directory.
- Run `verify-effect-actions doctor` and require every line to be `ok`, including both ports, `tracker v1.0.0`, and `ACME-1`.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted titles, tokens, and JSON unchanged.
- Run HTTP through `verify-effect-actions http`. Paths under `/admin/` use the operator port.
- Run terminal actions through `verify-effect-actions cli`.
- Run the web app's list through `verify-effect-actions rpc`.
- Send `{}` as the JSON body of an action that takes no input.
- The memory store disappears when the process exits. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final response.
- CLI proof includes the command, stdout, stderr, and exit code (`*.cli.txt`).
- HTTP proof includes the status, headers, and body (`*.http.txt`).
- RPC proof includes the session, the socket URL, stdout, stderr, and the exit code.
- Mutation proof includes a later read-only command that shows the stored issue or workspace.
- Record the feature id and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-effect-actions` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [File an issue](./create-issue.md) covers CLI and HTTP creation and a second read of the filed issue.
- [Attach an image](./attach-image.md) covers attaching a PNG and reading it back from the CLI.
- [Call over RPC](./rpc-session.md) covers listing issues on the WebSocket with the session cookie.
- [Ask the assistant](./ask-assistant.md) covers a turn that waits to close `ACME-1`, and the approval that closes it.
- [Suspend a workspace](./suspend-workspace.md) covers the operator key, the member refusal, and the workspace list.
