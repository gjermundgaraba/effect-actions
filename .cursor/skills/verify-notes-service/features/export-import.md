# Export and import

Export writes every note you can read to a Markdown file. Import creates notes from a file of that shape, all or none, and a later list shows the new titles.

## Sub-features

- `export-file` writes one `# ` title section per note and prints how many it wrote.
- `import-file` creates those notes again from the file.
- `import-read` shows the imported titles in `list-notes` and a higher `notes` count from `get-status`.

## How to get to it (user POV)

- Run `notes export <file>` after at least one note exists.
- Run `notes import <file>` on that file, or on another file that starts with `# `.
- Run `notes list-notes` and `notes get-status`.

## Driving it with notes-verify

Preconditions:

- `notes-verify doctor` printed `doctor ok` for this run.
- Create one note first: `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence export-seed.cli.txt --stdin-text $'First draft\n' -- create-note --title "Plan"`.
- Choose a scratch file under the run's state directory, for example `/tmp/effect-actions-verify-$NOTES_VERIFY_RUN/notes.md`. That directory is removed on cleanup. Copy the file into `$EVIDENCE_DIR` before cleanup if the proof must keep it.

- **Export.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence export.cli.txt -- export /tmp/effect-actions-verify-$NOTES_VERIFY_RUN/notes.md`. Exit `0`. Stdout is `Wrote 1 notes to /tmp/effect-actions-verify-$NOTES_VERIFY_RUN/notes.md`. The file contains `# Plan` and `First draft`.
- **Keep the file.** Copy it to `$EVIDENCE_DIR/notes.md` before cleanup.
- **Import.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence import.cli.txt -- import /tmp/effect-actions-verify-$NOTES_VERIFY_RUN/notes.md`. Exit `0`. Stdout is `Created 1 notes`.
- **List.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence import-list.cli.txt -- list-notes`. Exit `0`. `notes` has two objects, both titled `Plan` (the original and the imported copy), with different ids.
- **Count.** Run `.cursor/skills/verify-notes-service/helpers/notes-verify cli --token ada --evidence import-status.cli.txt -- get-status`. Exit `0`. `notes` is `2`.

## Gotchas

- `export` writes the path you pass. A path inside the state directory disappears on cleanup unless you copied it to `$EVIDENCE_DIR`.
- The file has no trailing extra blank line after the last body. Import still accepts it when it starts with `# `.
- Import creates new notes. It does not update the notes that were exported. Two titles `Plan` after one import is the expected end state.
- A file that does not start with `# ` is a usage error and creates nothing. Do not strip a leading title to make the command succeed.
- `import` is not the same command as `import-notes`. `import` reads the Markdown file. `import-notes` takes a JSON array flag and is a different entry point.
