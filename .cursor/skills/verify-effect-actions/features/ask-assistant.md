# Ask the assistant

Ask the assistant lets a member request a turn about their issues. The demo model lists open issues and asks to close `ACME-1`. Approving that call closes the issue. A later read shows it closed.

## Sub-features

- `ask-wait` starts a turn whose read ran and whose close is waiting.
- `ask-approve` approves the waiting close.
- `ask-read` shows `ACME-1` closed, with the seeded comment still there.

## How to get to it (user POV)

- Run `tracker ask-assistant --prompt "Close what is done."` as `ada` in `acme`.
- Run `tracker answer-assistant --conversation <id> --answers <json>`.
- Run `tracker get-issue ACME-1`.

## Driving it with verify-effect-actions

Preconditions:

- `verify-effect-actions doctor` printed `doctor ok` for this run.
- `ACME-1` is open. Seed left it open. Do not close it before this journey.

- **Ask.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence ask-assistant.cli.txt -- ask-assistant --prompt "Close what is done."`. Exit `0`. Stdout JSON has empty `text`, `ran` containing `{ "tool": "listIssues", "failed": false }`, and `waiting` containing one object whose `tool` is `closeIssue` and whose `arguments` is `{"id":"ACME-1"}`. Keep `conversation` and `approvalId`.
- **Approve.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence answer-assistant.cli.txt -- answer-assistant --conversation <conversation> --answers '[{"approvalId":"<approvalId>","approved":true}]'`. Exit `0`. `text` is `Done.`, `ran` contains `{ "tool": "closeIssue", "failed": false }`, and `waiting` is empty.
- **Read it back.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence ask-get-issue.cli.txt -- get-issue ACME-1`. Exit `0`. The heading is `# ACME-1 Crash on save (closed)` and the body contains `Reproduced on 2.4.1.`

## Gotchas

- The close does not run on the ask. `waiting` is not a closed issue. Prove the close with `get-issue` after the answer.
- `arguments` is a JSON string, not an object. The id inside it is `ACME-1` only while that issue is the one the demo model names.
- Approving a write counts toward the ten writes a minute. The ask's list does not.
- `agent.ts` is a separate process with its own issues. A turn there does not close this server's `ACME-1`.
