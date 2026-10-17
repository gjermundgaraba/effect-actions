# Suspend a workspace

Suspend a workspace lets an operator stop members of `acme` from calling the public port. A member's next command is refused, and the operator's workspace list shows `acme` suspended.

## Sub-features

- `suspend-operator` suspends `acme` with the operator key.
- `suspend-refused` makes `tracker list-issues` exit 1 for `ada`.
- `suspend-listed` shows `acme` suspended and `globex` not.

## How to get to it (user POV)

- `POST /admin/suspendWorkspace` on the operator port with `X-Operator-Key: ops-key` and JSON `{"workspace":"acme"}`.
- Run `tracker list-issues` as `ada` in `acme`.
- `POST /admin/listWorkspaces` with the same operator key.

## Driving it with verify-effect-actions

Preconditions:

- `verify-effect-actions doctor` printed `doctor ok` for this run.
- `ada` can list issues before the suspend. Doctor's seed check is that list.

- **Suspend.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http --token none --workspace none --header 'x-operator-key: ops-key' --evidence suspend.http.txt POST /admin/suspendWorkspace --data '{"workspace":"acme"}'`. Status `200`. Body is `{"slug":"acme","name":"Acme","suspended":true}`.
- **Member refusal.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --expect-exit 1 --evidence suspend-list.cli.txt -- list-issues --json`. Exit `1`. Stderr contains `{"_tag":"Forbidden","message":"This workspace is suspended."}`.
- **Operator list.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http --token none --workspace none --header 'x-operator-key: ops-key' --evidence list-workspaces.http.txt POST /admin/listWorkspaces --data '{}'`. Status `200`. `workspaces` contains `acme` with `suspended` true and `globex` with `suspended` false.

## Gotchas

- The admin path is on `ADMIN_URL`, not the member port. The helper sends `/admin/` there. A curl to the member port does not reach this action.
- Send no bearer token and no `X-Workspace` on the operator calls. The credential is `X-Operator-Key`.
- `support-key` can list workspaces and cannot suspend. Use `ops-key` for the suspend.
- `ops.ts` is a console in its own process. Suspending there does not refuse members of this server. This journey uses the admin port.
- After a suspend, later member journeys on this same process fail with `Forbidden`. Resume with `POST /admin/resumeWorkspace` and `{"workspace":"acme"}`, or start a new launch.
