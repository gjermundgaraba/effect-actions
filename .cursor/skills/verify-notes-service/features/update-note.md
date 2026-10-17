# Update a note

Update note lets a writer replace a note's body by sending the revision they read. A stale revision is refused and the stored body stays as it was.

## Sub-features

- `update-cli` replaces the body and returns the next revision.
- `update-read` shows the new body from `get-note`.
- `update-stale` refuses a second write that still sends the old revision.

## How to get to it (user POV)

- Run `notes update-note <id> --revision <n>` with the new body on stdin.
- `POST /api/updateNote` with JSON `{"id","body","revision"}`.
- Read the result with `notes get-note <id>`.

## Driving it with notes-verify

Preconditions:

- `notes-verify doctor` printed `doctor ok` for this run.
- A note exists. Create it with `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence update-seed.cli.txt --stdin-text $'First draft\n' -- create-note --title "CLI Plan"`. Keep `id`. The printed `revision` is `1`.

- **Replace body.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence update-note.cli.txt --stdin-text $'changed\n' -- update-note <id> --revision 1`. Exit `0`. Stdout JSON has the same `id`, `body` `changed`, and `revision` `2`.
- **Read it back.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence update-get-note.cli.txt -- get-note <id>`. Exit `0`. Stdout contains `# CLI Plan` and `changed`.
- **Stale revision.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --expect-exit 1 --evidence update-stale.cli.txt --stdin-text $'again\n' -- update-note <id> --revision 1`. Exit `1`. Stderr contains `{"_tag":"NoteChanged","id":"<id>","revision":2}`.
- **Stored body unchanged.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify http --token ada --evidence update-get-note.http.txt POST /api/getNote --data '{"id":"<id>"}'`. Status `200`. `body` is `changed` and `revision` is `2`.

## Gotchas

- The revision you send is the one you last read, not the revision you hope to land on. After a successful update the next write sends `2`.
- Stdin is the new body. `--revision` is a flag. The id is a positional argument.
- `NoteChanged` is exit `1` and a JSON object on stderr under an `ERROR` heading. Pass `--expect-exit 1` or the helper fails the step.
- A refused update does not bump the revision. Prove that with `getNote`, not with the error alone.
