# Testing

Two ways to test, and neither opens a port. `Action.client` calls an implementation in process: what its handlers and its `authorize` do. `Testing.layer` answers the real routes in memory, through Effect's own `HttpClient`: what a surface adds, such as authentication, statuses, challenges and tool results as sent. The examples put a domain's tests in `test/<domain>/` and tests of the surfaces beside them, in `it.effect` from `@effect/vitest`, which supplies a `Scope`, a `TestClock` and a `TestConsole` (both imported from `effect/testing`).

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [Testing-failures.md](Testing-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Test an implementation in process

Acquire `Action.client(implementation)` and call its methods ([Action.md](Action.md#call-actions-in-process)), as [notes-service/test/notes/in-process.test.ts](../examples/notes-service/test/notes/in-process.test.ts) does. The rules are on `Action.client`.

```ts example=notes-service/test/notes/in-process.test.ts
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { CurrentUser } from "../../src/identity/Identity.js";
import { users } from "../../src/identity/users.js";
import { notes } from "../../src/notes/handlers.js";
import { NoteNotFound } from "../../src/notes/Notes.js";
import { NoteStore } from "../../src/notes/store.js";

// What the implementation does, with no transport: `Action.client` runs the same decoding,
// `authorize` and handler a server runs. The caller is provided around each call, as a server
// provides it per request.
const as = (user: keyof typeof users) =>
  Effect.provideService(CurrentUser, users[user]);

describe("notes, in process", () => {
  it.effect("keeps each user's notes their own", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);

      const note = yield* client
        .createNote({ title: "Plan", body: "Draft" })
        .pipe(as("ada"));

      expect(yield* client.listNotes().pipe(as("ada"))).toStrictEqual({
        notes: [{ id: note.id, title: "Plan" }],
      });
      expect(yield* client.listNotes().pipe(as("grace"))).toStrictEqual({
        notes: [],
      });

      const missing = new NoteNotFound({ id: note.id });
      const update = { id: note.id, body: "Mine now", revision: note.revision };

      expect(
        yield* Effect.flip(client.getNote({ id: note.id }).pipe(as("grace")))
      ).toStrictEqual(missing);
      expect(
        yield* Effect.flip(client.updateNote(update).pipe(as("grace")))
      ).toStrictEqual(missing);
      expect(
        yield* Effect.flip(client.deleteNote({ id: note.id }).pipe(as("grace")))
      ).toStrictEqual(missing);
      expect(
        yield* client.getNote({ id: note.id }).pipe(as("ada"))
      ).toStrictEqual(note);
    }).pipe(Effect.provide(NoteStore.layerMemory))
  );

  it.effect("refuses a write from a caller holding the read scope alone", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);
      const create = client.createNote({ title: "Plan", body: "Draft" });
      const refusal = yield* Effect.flip(create.pipe(as("reader")));

      expect(refusal).toBeInstanceOf(Action.Forbidden);
      expect(refusal.message).toBe("Requires notes:write.");
    }).pipe(Effect.provide(NoteStore.layerMemory))
  );
});
```

- Replace the edge, not the service under test: [mcp-tools/test/printers/printers.test.ts](../examples/mcp-tools/test/printers/printers.test.ts) runs the real upstream service over a fake `HttpClient` Layer.
- `it.effect` runs on a test clock: fork a call that waits, `TestClock.adjust`, then join it.
- A stdio server runs the same implementations: test them here. A subprocess test adds only what the process adds, stdout carrying nothing but the protocol.
- A Toolkit and a CLI need no `Testing` export: call `handle` on `yield* toolkit`, or script a `LanguageModel` ([assistant/test/toolkit.test.ts](../examples/assistant/test/toolkit.test.ts)), and run commands without a process ([ActionCli.md](ActionCli.md#run-actions-as-local-commands)).

## Test routes in memory

Export the routes still requiring what an entrypoint chooses, give the test its own services, and provide `Testing.layer(routes)` to each test. What it serves, the requests it reaches, a remote `ActionCli` command's included, and what it cannot do are on `Testing.layer`.

The smallest test:

```ts example=quickstart/test/routes.test.ts
import { expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect } from "effect";

import { Http } from "../src/Api.js";
import { Greet } from "../src/greeting/Greeting.js";
import { routes } from "../src/routes.js";

// The routes answer in memory: no port, and the same code the server runs.
it.effect("greets over HTTP and as an MCP tool", () =>
  Effect.gen(function* () {
    const http = yield* ActionHttp.client(Http);
    const mcp = yield* ActionMcp.client([Greet]);

    expect(yield* http.greet({ name: "Ada" })).toBe("Hello, Ada!");
    expect(yield* mcp.greet({ name: "Ada" })).toBe("Hello, Ada!");
  }).pipe(Effect.provide(Testing.layer(routes)))
);
```

[notes-service/test/routes.test.ts](../examples/notes-service/test/routes.test.ts) provides a store a builder yields, calls the host's own routes with `HttpClient.get("/healthz")` and signs callers in.

- A service the test reads too: [kitchen-sink/test/identity/session.test.ts](../examples/kitchen-sink/test/identity/session.test.ts).
- Several `layer`s sharing one build: [kitchen-sink/test/routes.test.ts](../examples/kitchen-sink/test/routes.test.ts) ([Action.md](Action.md#share-one-build-across-servers)).
- A fake upstream: [mcp-tools/test/routes.test.ts](../examples/mcp-tools/test/routes.test.ts).
- Raw web `Request`s beside the typed clients, through one web handler the test disposes of, given to `Testing.layer(handler)`: [kitchen-sink/test/request-policy.test.ts](../examples/kitchen-sink/test/request-policy.test.ts).

## Test as a signed-in caller

Serve the routes behind their provider ([Authentication.md](Authentication.md#verify-credentials)), and give each client its caller's credential in `transformClient`, as `as` in [notes-service/test/routes.test.ts](../examples/notes-service/test/routes.test.ts) does for `ActionHttp.client` and `ActionMcp.client` alike. An OAuth access token is such a credential: signing in, or again for more scopes, is the MCP client's part, so an application's tests need no MCP client package.

To change what a credential verifies as, replace the service the verifier reads (`servedWith` in [kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts)), or provide a test verifier: another `Authentication.layer` of the same descriptor.

A typed client decodes a refusal to its error. To assert on the answer as sent, its status and its `www-authenticate` challenge, send the request with `HttpClient.execute`, as that file does; a tool call's request is built with `ActionMcp.request` ([Test MCP tools](#test-mcp-tools)). The status and body of each case are on `ActionHttp.layer` and on each built-in error.

## Test MCP tools

`ActionMcp.client(actions, options?)` gives one method per action, calling its tool. What it decodes and how it fails are on `ActionMcp.client` and `McpCallError` ([ActionMcp-failures.md](ActionMcp-failures.md)).

For what the client's types will not send or its decoding hides, build the request with `ActionMcp.request`, which says how to send it: [kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts) asserts a 401, and [mcp-tools/test/routes.test.ts](../examples/mcp-tools/test/routes.test.ts) reads `tools/list`.

## Test rpcs

Export the rpc layer without its protocol ([ActionRpc.md](ActionRpc.md#serve-the-rpcs)) and serve it under `Testing.layer`, as [live-rpc/test/routes.test.ts](../examples/live-rpc/test/routes.test.ts) does; the protocol each side takes is on `Testing.layer`. [live-rpc/test/browser.test.ts](../examples/live-rpc/test/browser.test.ts) tests a page's client the same way, and [kitchen-sink/test/identity/session.test.ts](../examples/kitchen-sink/test/identity/session.test.ts) serves JSON routes and rpcs in one `Testing.layer`.

## Test events

Watch an event with the client of the implementations, as here, or of the routes under `Testing.layer`, giving each test its own `Event.layerMemory`:

```ts example=build-events/test/builds/events.test.ts
import { expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { BuildFinished } from "../../src/builds/Builds.js";
import { buildEvents } from "../../src/builds/events.js";
import { builds } from "../../src/builds/handlers.js";
import { BuildStore } from "../../src/builds/store.js";
import { as } from "../support/as.js";

it.effect(
  "delivers each build a member may see as it finishes, as the subscription selects",
  () =>
    Effect.gen(function* () {
      // One client holds both: the action that finishes builds and the event that reports them.
      const client = yield* Action.client([builds, buildEvents]);

      const failed = yield* client
        .watch(BuildFinished, { status: "failed" })
        .pipe(Stream.take(1), Stream.runCollect, as("grace"), Effect.forkChild);

      // The watch starts from now: let it take its first position before builds finish.
      yield* TestClock.adjust("0 millis");
      yield* client
        .finishBuild({ pipeline: "api", status: "failed" })
        .pipe(as("ada"));
      yield* client
        .finishBuild({ pipeline: "web", status: "passed" })
        .pipe(as("ada"));
      // Each build finished notifies: the watch reads at once, with no wait for its next poll.
      yield* client
        .finishBuild({ pipeline: "web", status: "failed" })
        .pipe(as("ada"));

      // grace sees only the web pipeline, and asked only for failures.
      expect(yield* Fiber.join(failed)).toMatchObject([
        {
          _tag: "Occurrence",
          data: { id: "build-3", pipeline: "web", status: "failed" },
        },
      ]);
    }).pipe(Effect.provide([BuildStore.layerMemory, Event.layerMemory]))
);

it.effect(
  "sends a gap first to a subscriber resuming from a cursor the store never gave",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client([builds, buildEvents]);

      yield* client
        .finishBuild({ pipeline: "web", status: "passed" })
        .pipe(as("ada"));

      // A cursor of the store before a restart, its offset one this store has too: what it named
      // is gone, so the watch is told.
      const resumed = yield* client
        .watch(BuildFinished, {}, { cursor: "an-earlier-epoch:0" })
        .pipe(Stream.take(2), Stream.runCollect, as("grace"));

      expect(resumed).toMatchObject([
        { _tag: "Gap" },
        { _tag: "Occurrence", data: { id: "build-1", pipeline: "web" } },
      ]);
    }).pipe(Effect.provide([BuildStore.layerMemory, Event.layerMemory]))
);
```

A watch forked before what it should see starts from now, so let it take its first position before acting, with `TestClock.adjust("0 millis")`. An announcement, `notify` or `publish`, is read at once; without one, a check source is asked again on its own schedule, every 5 seconds unless it says otherwise, which `TestClock.adjust` moves past. Move the clock only past what the test waits for: a webhook's POST still in flight times out after 5 seconds of it.

Webhook delivery needs an `HttpClient` answering for the subscriber and a `Dns` resolving its callback to a public address, as [build-events/test/support/memory.ts](../examples/build-events/test/support/memory.ts) provides: `Testing.layer` of the subscriber's routes or of a handler, and `Dns.layerStatic`. A subscription made through requests in memory runs on promises the test clock does not drive, so wait for it as that file's `settled` does.

## Assert on errors

Take the failure with `Effect.flip(call)`, which alone asserts only that the call failed, then assert its class and its `message` separately, as the last test of [notes-service/test/notes/in-process.test.ts](../examples/notes-service/test/notes/in-process.test.ts) does.

`toEqual` never compares a tagged error's `message`, which is not an enumerable property: `expect(error).toEqual(new Action.Forbidden({ message: "anything" }))` passes for every message, and so does `toStrictEqual`. Other fields are compared, so `toEqual(new NoteNotFound({ id }))` asserts the `id`, and `toEqual(new Action.Forbidden({ scopes: ["issues:write"] }))` still needs the message asserted beside it.
