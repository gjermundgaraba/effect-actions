import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stdio, Stream } from "effect";
import { CliError, Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestConsole } from "effect/testing";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { commands } from "../src/commands.js";
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

  it.effect("run a command of their own beside the derived ones", () =>
    Effect.gen(function* () {
      yield* run("ada", ["create-note", "--title", "Plan"], "First draft\n");
      yield* run("ada", ["create-note", "--title", "Budget"], "Too small\n");

      expect(yield* run("ada", ["export"])).toEqual([
        "# Plan\n\nFirst draft\n\n# Budget\n\nToo small",
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("fail as the server refuses, a command of their own included", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(run("mallory", ["export"]));

      expect(refused).toBeInstanceOf(CliError.UserError);
      expect(refused).toHaveProperty("userMessage", "Unauthenticated: Unknown demo token.");

      const missing = yield* Effect.flip(run("ada", ["get-note", "9"]));

      expect(missing).toHaveProperty("cause", new NoteNotFound({ id: "9" }));
    }).pipe(Effect.provide(served)),
  );
});
