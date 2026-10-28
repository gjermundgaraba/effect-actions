import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { CliError, Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestConsole } from "effect/testing";

import { Http } from "../src/Api.js";
import { commands } from "../src/commands.js";
import { ImportNotes, Note, NoteNotFound } from "../src/notes/Notes.js";
import { NoteStore } from "../src/notes/store.js";
import { routes } from "../src/routes.js";

const served = Testing.layer(routes).pipe(Layer.provide(NoteStore.layerMemory));

const connected = (
  environment: Record<string, string>,
  args: readonly string[],
  stdin = ""
) =>
  Effect.gen(function* () {
    const before = (yield* TestConsole.logLines).length;

    yield* Command.runWith(commands, { version: "0" })(args).pipe(
      Effect.provide(
        Layer.merge(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment)),
          Stdio.layerTest({
            stdin: Stream.make(new TextEncoder().encode(stdin)),
          })
        ).pipe(Layer.provideMerge(NodeServices.layer))
      )
    );

    return (yield* TestConsole.logLines).slice(before);
  });

const run = (token: string, args: readonly string[], stdin = "") =>
  connected({ NOTES_TOKEN: token }, args, stdin);

const fitsAFile = (text: string) =>
  new TextDecoder().decode(new TextEncoder().encode(text)) === text;

const trickyLines = Arbitrary.array(
  Arbitrary.schema(
    Schema.Literals([
      "",
      "# A heading",
      "\\# Escaped",
      "\\\\# Twice",
      "#tag",
      "\r# After a carriage return",
      "\u2028# After a line separator",
    ])
  )
);

const importable = Arbitrary.all([
  Arbitrary.schema(ImportNotes.input),
  Arbitrary.array(trickyLines),
]).pipe(
  Arbitrary.map(([{ notes }, extra]) =>
    notes.map(({ title, body }, place) => ({
      title,
      body: [body, ...(extra[place] ?? [])].join("\n"),
    }))
  ),
  Arbitrary.filter((notes) =>
    notes.every(({ title, body }) => fitsAFile(title) && fitsAFile(body))
  )
);

const as = (token: string) =>
  ActionHttp.client(Http).pipe(
    Effect.updateService(
      HttpClient.HttpClient,
      HttpClient.mapRequest(HttpClientRequest.bearerToken(token))
    )
  );

describe("the commands", () => {
  it.effect(
    "take an argument, a flag and stdin, and print what `render` returns",
    () =>
      Effect.gen(function* () {
        const [created] = yield* run(
          "ada",
          ["create-note", "--title", "Plan"],
          "First draft\n"
        );

        const { id } = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Note)
        )(created);

        expect(yield* run("ada", ["get-note", id])).toStrictEqual([
          "# Plan\n\nFirst draft",
        ]);

        yield* run(
          "ada",
          ["update-note", id, "--revision", "1"],
          "Second draft\n"
        );

        expect(yield* run("ada", ["get-note", id])).toStrictEqual([
          "# Plan\n\nSecond draft",
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "describe a flag in `--help` as the contract describes its field",
    () =>
      Effect.gen(function* () {
        expect(yield* run("ada", ["update-note", "--help"])).toStrictEqual([
          expect.stringContaining("The revision you read: 1 for a new note"),
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect("run a command of their own beside the derived ones", () =>
    Effect.gen(function* () {
      yield* run("ada", ["create-note", "--title", "Plan"], "First draft\n");
      yield* run("ada", ["create-note", "--title", "Budget"], "Too small\n");

      const files = yield* FileSystem.FileSystem;
      const file = `${yield* files.makeTempDirectoryScoped()}/notes.md`;

      expect(yield* run("ada", ["export", file])).toStrictEqual([
        `Wrote 2 notes to ${file}`,
      ]);
      expect(yield* files.readFileString(file)).toBe(
        "# Plan\n\nFirst draft\n\n# Budget\n\nToo small"
      );
    }).pipe(Effect.provide(Layer.merge(served, NodeServices.layer)))
  );

  it.effect("import a file `export` wrote, all its notes or none", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem;
      const directory = yield* files.makeTempDirectoryScoped();
      const file = `${directory}/notes.md`;

      yield* files.writeFileString(
        file,
        "# Plan\n\nFirst draft\n\n# Budget\n\nToo small"
      );

      expect(yield* run("ada", ["import", file])).toStrictEqual([
        "Created 2 notes",
      ]);
      expect(yield* run("grace", ["import", file])).toStrictEqual([
        "Created 2 notes",
      ]);

      yield* files.writeFileString(
        `${directory}/untitled.md`,
        "# Plan\n\nKept?\n\n# \n\nNo title"
      );

      const refused = yield* Effect.flip(
        run("ada", ["import", `${directory}/untitled.md`])
      );

      expect(refused).toHaveProperty(
        "userMessage",
        expect.stringContaining("A note needs a title.")
      );
      const [listed = ""] = yield* run("ada", ["list-notes"]);

      const { notes } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            notes: Schema.Array(Schema.Struct({ title: Schema.String })),
          })
        )
      )(listed);

      expect(notes.map(({ title }) => title)).toStrictEqual(["Plan", "Budget"]);

      yield* Effect.flip(run("ada", ["import", `${directory}/nowhere.md`]));

      expect(yield* TestConsole.errorLines).toContainEqual(
        expect.stringMatching(
          /Invalid value for argument <file>: .*nowhere\.md.*File does not exist/su
        )
      );
    }).pipe(Effect.provide(Layer.merge(served, NodeServices.layer)))
  );

  it.effect.prop(
    "import every note `export` wrote as it was, whatever its body holds",
    [importable],
    ([notes]) =>
      Effect.gen(function* () {
        const files = yield* FileSystem.FileSystem;
        const file = `${yield* files.makeTempDirectoryScoped()}/notes.md`;

        const [ada, grace] = [yield* as("ada"), yield* as("grace")];

        yield* ada.importNotes({ notes });
        yield* run("ada", ["export", file]);
        yield* run("grace", ["import", file]);

        const { notes: listed } = yield* grace.listNotes();

        const read = yield* Effect.forEach(listed, ({ id }) =>
          grace.getNote({ id })
        );

        expect(read.map(({ title, body }) => ({ title, body }))).toStrictEqual(
          notes
        );
      }).pipe(Effect.provide(Layer.merge(served, NodeServices.layer))),
    { arbitrary: { runs: 50 } }
  );

  it.effect(
    "import an empty file as no notes, and refuse one `export` did not write or too long",
    () =>
      Effect.gen(function* () {
        const files = yield* FileSystem.FileSystem;
        const directory = yield* files.makeTempDirectoryScoped();

        yield* files.writeFileString(`${directory}/empty.md`, "");

        expect(
          yield* run("grace", ["import", `${directory}/empty.md`])
        ).toStrictEqual(["Created 0 notes"]);

        yield* files.writeFileString(
          `${directory}/preamble.md`,
          "My notes\n\n# Plan\n\nDraft"
        );

        expect(
          yield* Effect.flip(
            run("grace", ["import", `${directory}/preamble.md`])
          )
        ).toHaveProperty(
          "userMessage",
          "The file does not start with a `# ` title, as `notes export` writes one."
        );

        const many = Array.from(
          { length: 101 },
          (_, place) => `# Note ${place}\n\nBody`
        );

        yield* files.writeFileString(`${directory}/many.md`, many.join("\n\n"));

        expect(
          yield* Effect.flip(run("grace", ["import", `${directory}/many.md`]))
        ).toHaveProperty(
          "userMessage",
          expect.stringContaining("An import holds at most 100 notes.")
        );

        expect(yield* run("grace", ["list-notes"])).toStrictEqual([
          JSON.stringify({ notes: [] }, null, 2),
        ]);
      }).pipe(Effect.provide(Layer.merge(served, NodeServices.layer)))
  );

  it.effect("fail as the server refuses, a command of their own included", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        run("mallory", ["export", "notes.md"])
      );

      expect(refused).toBeInstanceOf(CliError.UserError);
      expect(refused).toHaveProperty(
        "userMessage",
        '{"_tag":"Unauthenticated","message":"Unknown demo token."}'
      );
      expect(yield* TestConsole.errorLines).toContain(
        "The export to notes.md did not finish."
      );

      const unwritable = yield* Effect.flip(
        run("ada", ["export", "no-such-directory/notes.md"])
      );

      expect(unwritable).toBeInstanceOf(CliError.UserError);
      expect(unwritable).toHaveProperty(
        "userMessage",
        expect.stringMatching(/^PlatformError: /u)
      );

      const missing = yield* Effect.flip(run("ada", ["get-note", "9"]));

      expect(missing).toHaveProperty("cause", new NoteNotFound({ id: "9" }));
    }).pipe(Effect.provide(served))
  );

  it.effect(
    "call as the configured token names, and ask for one where none is configured",
    () =>
      Effect.gen(function* () {
        yield* connected({ NOTES_TOKEN: "reader" }, ["who-am-i"]);

        expect(yield* TestConsole.logLines).toStrictEqual([
          expect.stringContaining('"id": "reader"'),
        ]);

        const refused = yield* Effect.flip(connected({}, ["list-notes"]));

        expect(refused).toBeInstanceOf(CliError.UserError);
        expect(refused).toHaveProperty("cause._tag", "MissingToken");
        expect(refused).toHaveProperty(
          "userMessage",
          "MissingToken: NOTES_TOKEN is not set. Set it to your token: export NOTES_TOKEN=<your token>"
        );

        expect(yield* TestConsole.errorLines).toStrictEqual([
          expect.stringContaining("NOTES_TOKEN is not set."),
        ]);

        yield* connected({}, ["list-notes", "--help"]);

        expect(yield* TestConsole.logLines).toHaveLength(2);
      }).pipe(Effect.provide(served))
  );
});
