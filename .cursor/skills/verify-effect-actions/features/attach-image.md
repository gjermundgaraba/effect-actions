# Attach an image

Attach an image lets a member add a PNG to an issue and read the image's name, type, and size back from the CLI.

## Sub-features

- `attach-http` stores a PNG on `ACME-1` and returns its id and size.
- `attach-read` shows that attachment from `get-attachment`.

## How to get to it (user POV)

- `POST /api/v1/attachImage` with `Authorization: Bearer ada`, `X-Workspace: acme`, and JSON `issue`, `name`, and `image`.
- Run `tracker attach-image --issue <id> --name <name> --image <json>`.
- Run `tracker get-attachment <id>`.

## Driving it with verify-effect-actions

Preconditions:

- `verify-effect-actions doctor` printed `doctor ok` for this run.
- `ACME-1` exists. Seed already attached one PNG to it. This journey attaches a second image.

The one-pixel PNG, base64, is `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=`.

- **Attach.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions http --token ada --workspace acme --evidence attach-image.http.txt POST /api/v1/attachImage --data '{"issue":"ACME-1","name":"dot.png","image":{"data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=","mimeType":"image/png"}}'`. Status `200`. Body `issue` is `ACME-1`, `name` is `dot.png`, `mimeType` is `image/png`, and `size` is `68`. Keep `id`.
- **Read it back.** Run `.cursor/skills/verify-effect-actions/helpers/verify-effect-actions cli --token ada --workspace acme --evidence get-attachment.cli.txt -- get-attachment <id>`. Exit `0`. Stdout is `dot.png: image/png, 68 bytes`.

## Gotchas

- `--image` is a JSON object with `data` as base64 and `mimeType`. A raw file path is not accepted.
- `get-attachment` without `--json` prints the name, the media type, and the byte length. It does not write a file.
- Seed's attachment is a different id. Assert the id returned by this attach, not the id in `seed.log`.
- Attaching counts as a write toward the ten writes a minute.
