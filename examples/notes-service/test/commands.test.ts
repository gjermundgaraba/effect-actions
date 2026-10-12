import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Schema, Stdio, Stream } from "effect";
import { CliError, Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestConsole } from "effect/testing";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { commands, connection } from "../src/commands.js";
import { Note, NoteNotFound } from "../src/notes/Notes.js";
import { NoteStore } from "../src/notes/store.js";
import { routes } from "../src/routes.js";

// What the commands add to the routes: their syntax and what they print. They call the real
// routes in memory, as a client with a token does, where cli.ts connects them to a server.
const served = Testing.layer(routes).pipe(Layer.provide(NoteStore.layerMemory));

// Effect's own runner, given arguments instead of the process's. The console of `it.effect`
// keeps every line printed, so a run returns the lines it added.
const run = (token: string, args: ReadonlyArray<string>, stdin = "") =>
  Effect.gen(function* () {
    const before = (yield* TestConsole.logLines).length;

    yield* Command.runWith(commands, { version: "0" })(args).pipe(
      Effect.updateService(
        HttpClient.HttpClient,
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      ),
      Effect.provide(Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(stdin)) })),
      Effect.provide(NodeServices.layer),
    );

    return (yield* TestConsole.logLines).slice(before);
  });

// The commands as cli.ts connects them, with what it reads from the environment given as a
// Layer, so the test decides whether a token is configured, whatever the shell holds.
const connected = (environment: Record<string, string>, args: ReadonlyArray<string>) =>
  Command.runWith(commands.pipe(Command.provideEffect(HttpClient.HttpClient, connection)), {
    version: "0",
  })(args).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment))),
    Effect.provide(NodeServices.layer),
  );

describe("the commands", () => {
  it.effect("take an argument, a flag and stdin, and print what `render` returns", () =>
    Effect.gen(function* () {
      // A command without `render` prints its result as JSON.
      const [created] = yield* run("ada", ["create-note", "--title", "Plan"], "First draft\n");
      const { id } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Note))(created);

      expect(yield* run("ada", ["get-note", id])).toEqual(["# Plan\n\nFirst draft"]);

      yield* run("ada", ["update-note", id, "--revision", "1"], "Second draft\n");

      expect(yield* run("ada", ["get-note", id])).toEqual(["# Plan\n\nSecond draft"]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("describe a flag in `--help` as the contract describes its field", () =>
    Effect.gen(function* () {
      // Help is one printed text. The description is the `revision` field's, from Notes.ts.
      expect(yield* run("ada", ["update-note", "--help"])).toEqual([
        expect.stringContaining("The revision you read: 1 for a new note"),
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("run a command of their own beside the derived ones", () =>
    Effect.gen(function* () {
      yield* run("ada", ["create-note", "--title", "Plan"], "First draft\n");
      yield* run("ada", ["create-note", "--title", "Budget"], "Too small\n");

      // The command writes with the real file system, so the test gives it a real directory.
      const files = yield* FileSystem.FileSystem;
      const file = `${yield* files.makeTempDirectoryScoped()}/notes.md`;

      expect(yield* run("ada", ["export", file])).toEqual([`Wrote 2 notes to ${file}`]);
      expect(yield* files.readFileString(file)).toBe(
        "# Plan\n\nFirst draft\n\n# Budget\n\nToo small",
      );
    }).pipe(Effect.provide(served), Effect.provide(NodeServices.layer)),
  );

  it.effect("fail as the server refuses, a command of their own included", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(run("mallory", ["export", "notes.md"]));

      expect(refused).toBeInstanceOf(CliError.UserError);
      expect(refused).toHaveProperty(
        "userMessage",
        '{"_tag":"Unauthenticated","message":"Unknown demo token."}',
      );
      // The command's own context is a line of its own on stderr, the JSON left as it is.
      expect(yield* TestConsole.errorLines).toContain("The export to notes.md did not finish.");

      // Not an action's error: the file system's, named in the message.
      const unwritable = yield* Effect.flip(run("ada", ["export", "no-such-directory/notes.md"]));

      expect(unwritable).toBeInstanceOf(CliError.UserError);
      expect(unwritable).toHaveProperty("userMessage", expect.stringMatching(/^PlatformError: /));

      const missing = yield* Effect.flip(run("ada", ["get-note", "9"]));

      expect(missing).toHaveProperty("cause", new NoteNotFound({ id: "9" }));
    }).pipe(Effect.provide(served)),
  );

  it.effect("call as the configured token names, and ask for one where none is configured", () =>
    Effect.gen(function* () {
      yield* connected({ NOTES_TOKEN: "reader" }, ["who-am-i"]);

      expect(yield* TestConsole.logLines).toEqual([expect.stringContaining('"id": "reader"')]);

      const refused = yield* Effect.flip(connected({}, ["list-notes"]));

      expect(refused).toBeInstanceOf(CliError.UserError);
      expect(refused).toHaveProperty(
        "userMessage",
        "NOTES_TOKEN is not set. Set it to your token: export NOTES_TOKEN=ada",
      );

      // What a person sees: that message, once, on stderr, and no report of a `ConfigError`.
      expect(yield* TestConsole.errorLines).toEqual([
        expect.stringContaining("NOTES_TOKEN is not set."),
      ]);

      // The token is read when a command runs, so its help needs none.
      yield* connected({}, ["list-notes", "--help"]);

      expect(yield* TestConsole.logLines).toHaveLength(2);
    }).pipe(Effect.provide(served)),
  );
});
