# File an issue

File an issue lets a member of `acme` save a titled issue from the CLI or the JSON API and read it back from a second command. Seed has already filed `ACME-1`.

## Sub-features

- `create-cli` saves a title and a stdin body and prints the new issue as JSON.
- `create-http` saves the same shape with `POST /api/v1/createIssue`.
- `create-read` shows the issue from `list-issues`, `get-issue`, and `POST /api/v1/getIssue`.

## How to get to it (user POV)

- Run `tracker create-issue --title <title>` with the body on stdin, token `ada`, workspace `acme`.
- `POST /api/v1/createIssue` with `Authorization: Bearer ada`, `X-Workspace: acme`, and JSON `{"title","body"}`.
- Run `tracker list-issues --json` and `tracker get-issue <id>`.
- `POST /api/v1/listIssues` and `POST /api/v1/getIssue`.

## Driving it with verify-effect-actions

Preconditions:

- `verify-effect-actions doctor` printed `doctor ok` for this run.
- `tracker list-issues --json` contains only `ACME-1`. No command in this run has filed another issue yet.

- **CLI create.** Put the body on stdin. Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence create-issue.cli.txt --stdin-text $'Tag and publish\n' -- create-issue --title "Release checklist"`. Exit `0`. Stdout JSON has `id` `ACME-2`, `title` `Release checklist`, `body` `Tag and publish`, and `status` `open`.
- **CLI list.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence list-issues.cli.txt -- list-issues --json`. Exit `0`. `issues` contains `ACME-2` titled `Release checklist` and `ACME-1` titled `Crash on save`. Newest is first.
- **CLI read.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence get-issue.cli.txt -- get-issue ACME-2`. Exit `0`. Stdout begins `# ACME-2 Release checklist (open)` and contains `Tag and publish`.
- **HTTP read.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http --token ada --workspace acme --evidence get-issue.http.txt POST /api/v1/getIssue --data '{"id":"ACME-2"}'`. Status `200`. Body `id` is `ACME-2`, `title` is `Release checklist`, `body` is `Tag and publish`, and `status` is `open`.
- **HTTP create.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http --token ada --workspace acme --evidence create-issue.http.txt POST /api/v1/createIssue --data '{"title":"HTTP Plan","body":"First draft"}'`. Status `200`. Body `id` is `ACME-3`, `title` is `HTTP Plan`, `body` is `First draft`, and `status` is `open`.
- **HTTP list.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http --token ada --workspace acme --evidence list-issues.http.txt POST /api/v1/listIssues --data '{}'`. Status `200`. `issues` contains `ACME-3`, `ACME-2`, and `ACME-1` in that order.

## Gotchas

- `create-issue` has no `--body` flag. The body is stdin, and a trailing newline is stripped.
- `list-issues` and `get-issue` print text until you pass `--json`. `get-issue` without `--json` is Markdown. Assert the heading, not a JSON field, on that command.
- The next id is one more than the number of issues already in the workspace. After seed, the first new issue is `ACME-2`. A second filing is `ACME-3`.
- `linus` can list and cannot file. That refusal is a different journey from filing.
- Ten writes a minute per member includes seed's create, attachment, and comment. A long recipe in the same minute can answer `RateLimited`.
- The memory store vanishes when the process exits. A later launch seeds `ACME-1` again and does not still hold `Release checklist`.
