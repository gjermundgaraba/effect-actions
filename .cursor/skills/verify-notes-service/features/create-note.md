# Create a note

Create note lets a signed-in writer save a titled note from the CLI or the JSON API, read it back from a second command, and retry the same creation with a request key.

## Sub-features

- `create-cli` saves a title and a stdin body and prints the new note as JSON.
- `create-http` saves the same shape with `POST /api/createNote`.
- `create-read` shows the note from `list-notes`, `get-note`, and `POST /api/getNote`.
- `create-replay` returns the original note when the same caller repeats the same request key and content, and refuses a repeat that changes the content.

## How to get to it (user POV)

- Run `notes create-note --title <title>` with the body on stdin, token `ada`.
- `POST /api/createNote` with `Authorization: Bearer ada` and JSON `{"title","body"}`.
- Run `notes list-notes` and `notes get-note <id>`.
- `POST /api/listNotes` and `POST /api/getNote`.
- Repeat `POST /api/createNote` with the same `requestId`, or `notes create-note --request-id <key>`.

## Driving it with notes-verify

Preconditions:

- `notes-verify doctor` printed `doctor ok` for this run.
- `POST /api/getStatus` reports `"notes":0` (a fresh server). Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence get-status-before.http.txt POST /api/getStatus --data '{}'` and keep that artifact.
- No command in this run has created a note yet.

- **CLI create.** Put the body on stdin. Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence create-note.cli.txt --stdin-text $'Tag and publish\n' -- create-note --title "Release checklist"`. Exit `0`. Stdout JSON has `title` `Release checklist`, `body` `Tag and publish`, and `revision` `1`. Keep `id`.
- **CLI list.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence list-notes.cli.txt -- list-notes`. Exit `0`. Stdout `notes` has one object whose `id` is the created id and whose `title` is `Release checklist`.
- **CLI read.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence get-note.cli.txt -- get-note <id>`. Exit `0`. Stdout is a Markdown heading `# Release checklist` and the body `Tag and publish`.
- **HTTP read.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence get-note.http.txt POST /api/getNote --data '{"id":"<id>"}'`. Status `200`. Body `title` is `Release checklist`, `body` is `Tag and publish`, `revision` is `1`.
- **HTTP create.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence create-note.http.txt POST /api/createNote --data '{"title":"HTTP Plan","body":"First draft"}'`. Status `200`. Body `title` is `HTTP Plan`, `body` is `First draft`, `revision` is `1`.
- **HTTP list.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence list-notes.http.txt POST /api/listNotes --data '{}'`. Status `200`. `notes` contains both titles `Release checklist` and `HTTP Plan`.
- **Replay.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence create-replay.http.txt POST /api/createNote --data '{"requestId":"plan-1","title":"Replay","body":"Same text"}'`, then the same command with `--evidence create-replay-again.http.txt`. Both responses are `200` and the same `id`. Then run it with body `Other text` and `--evidence create-conflict.http.txt`. Status is not `2xx` (the helper exits non-zero). The body is `{"_tag":"RequestConflict","requestId":"plan-1"}`.
- **Status after writes.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token none --evidence get-status.http.txt POST /api/getStatus --data '{}'`. Status `200`. `notes` is `3`: the CLI note, the HTTP note, and one replay note. The conflict did not add a fourth.

## Gotchas

- `create-note` has no `--body` flag. A missing stdin body is not the string you meant to save.
- `get-note` prints Markdown. `list-notes` and `create-note` print JSON. Assert the heading text, not a JSON field, on `get-note`.
- Ids change every launch. Read `id` from the create response.
- The same request key with different content is `RequestConflict` and creates nothing. A new key creates another note even when the title and body match an existing one.
- `notes-verify http` exits non-zero on the conflict response. Keep that artifact; do not treat the non-zero exit as a harness failure.
- `reader` cannot create. That refusal belongs to [Sign in](./sign-in.md).
- The memory store vanishes when the process exits. A later launch does not still hold `Release checklist`.
