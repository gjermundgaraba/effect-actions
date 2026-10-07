import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import { AiError, LanguageModel, type Response, Tool, Toolkit } from "effect/ai";
import { actors } from "../examples/authorization.js";
import { chat, layer as approvalHandlers } from "../examples/toolkit-approval.js";
import { Users } from "../examples/users.js";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

class Principal extends Context.Service<Principal, string>()("toolkit-test/Principal") {}

const Erase = Action.make("erase", {
  description: "Erase",
  readOnly: false,
  caller: Action.Anyone,
  input: { id: Schema.String },
  success: Schema.String,
});

/** A model that calls the tools of each `[name, params]` at once, then stops. */
const modelCalling = (...calls: ReadonlyArray<readonly [string, object]>) =>
  LanguageModel.make({
    generateText: () =>
      Effect.succeed(
        calls.map(([name, params], index) => ({
          type: "tool-call" as const,
          id: `${index + 1}`,
          name,
          params,
        })),
      ),
    streamText: () => Stream.empty,
  });

/** What a response asks approval for, by tool call, and what it ran. */
const outcome = <Tools extends Record<string, Tool.Any>, Mode extends Response.ToolParametersMode>(
  response: LanguageModel.GenerateTextResponse<Tools, Mode>,
) => ({
  approvals: response.content.flatMap((part) =>
    part.type === "tool-approval-request" ? [part.toolCallId] : [],
  ),
  results: response.toolResults.map(({ name, result }) => [name, result]),
});

describe("ActionToolkit", () => {
  it.effect(
    "asks approval for the calls one check over every call marks, each call's name narrowing its input",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];

        const Read = Action.make("read", {
          description: "Read",
          readOnly: true,
          caller: Action.Anyone,
          input: { path: Schema.String },
          success: Schema.String,
        });

        const app = Action.implement([Read, Erase], {
          read: ({ path }) => Effect.sync(() => (calls.push(`read ${path}`), "read")),
          erase: ({ id }) => Effect.sync(() => (calls.push(`erase ${id}`), "erased")),
        });

        const contexts: Array<readonly [string, number]> = [];

        // Erasing needs approval, except a draft: `call.name` narrows `call.input` to erase's. The
        // check also gets Effect's native approval context: the call's id and the conversation.
        const binding = ActionToolkit.make(app, {
          needsApproval: (call, context) => {
            contexts.push([context.toolCallId, context.messages.length]);

            return call.name === "erase" && call.input.id !== "draft";
          },
        });

        // No tool needs approval unless the host says so: the native tool's own default.
        expect(ActionToolkit.make(app).toolkit.tools.erase.needsApproval).toBeUndefined();

        const response = yield* LanguageModel.generateText({
          prompt: "go",
          toolkit: binding.toolkit,
        }).pipe(
          Effect.provide(binding.layer),
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            modelCalling(
              ["read", { path: "a" }],
              ["erase", { id: "draft" }],
              ["erase", { id: "x" }],
            ),
          ),
        );

        expect(outcome(response)).toEqual({
          approvals: ["3"],
          results: [
            ["read", "read"],
            ["erase", "erased"],
          ],
        });
        expect(calls).toEqual(["read a", "erase draft"]);
        expect(contexts).toEqual([
          ["1", 1],
          ["2", 1],
          ["3", 1],
        ]);
      }),
  );

  it.effect(
    "reads each call's caller in the check, so one toolkit asks approval of some callers only",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];

        const app = Action.implement(Erase, ({ id }) =>
          Effect.sync(() => (calls.push(id), "erased")),
        );

        // One make call: a write needs approval unless an admin calls; without a caller, it asks.
        const { toolkit, layer } = ActionToolkit.make(app, {
          needsApproval: (call) =>
            !call.action.readOnly &&
            Effect.map(
              Effect.serviceOption(Principal),
              Option.match({ onNone: () => true, onSome: (principal) => principal !== "admin" }),
            ),
        });

        const turn = LanguageModel.generateText({ prompt: "go", toolkit }).pipe(
          Effect.map(outcome),
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            modelCalling(["erase", { id: "x" }]),
          ),
        );

        const [admin, guest, nobody] = yield* Effect.all([
          Effect.provideService(turn, Principal, "admin"),
          Effect.provideService(turn, Principal, "guest"),
          turn,
        ]).pipe(Effect.provide(layer));

        expect(admin).toEqual({ approvals: [], results: [["erase", "erased"]] });
        expect(guest).toEqual({ approvals: ["1"], results: [] });
        expect(nobody).toEqual({ approvals: ["1"], results: [] });
        expect(calls).toEqual(["x"]);
      }),
  );

  it.effect("asks, in the approval example, before a model renames anyone but its caller", () =>
    Effect.gen(function* () {
      // A caller who is also user 1 of acme, beside alice, who is not.
      const self = {
        id: "1",
        tenantId: "acme",
        permissions: ["users:read", "users:write"],
      } as const;

      const [asked, renamed] = yield* Effect.all([
        chat(actors.alice, "rename"),
        chat(self, "rename"),
      ]).pipe(
        Effect.map((responses) => responses.map(outcome)),
        Effect.provideServiceEffect(
          LanguageModel.LanguageModel,
          modelCalling(["renameUser", { id: "1", name: "Bea" }]),
        ),
        Effect.provide(approvalHandlers.pipe(Layer.provide(Users.layerMemory))),
      );

      expect(asked).toEqual({ approvals: ["1"], results: [] });
      expect(renamed).toEqual({
        approvals: [],
        results: [["renameUser", { id: "1", name: "Bea" }]],
      });
    }),
  );

  it.effect(
    "runs a call whose check fails without approval, as LanguageModel decides natively",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];

        const binding = ActionToolkit.make(
          Action.implement(Erase, ({ id }) => Effect.sync(() => (calls.push(id), "erased"))),
          {
            // @ts-expect-error The check's Effect cannot fail in its type; plain JavaScript's can.
            needsApproval: () => Effect.fail("unavailable"),
          },
        );

        const response = yield* LanguageModel.generateText({
          prompt: "go",
          toolkit: binding.toolkit,
        }).pipe(
          Effect.provide(binding.layer),
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            modelCalling(["erase", { id: "x" }]),
          ),
        );

        expect(outcome(response)).toEqual({ approvals: [], results: [["erase", "erased"]] });
        expect(calls).toEqual(["x"]);
      }),
  );

  it.effect(
    "names each tool after its action, takes and gives its JSON encoding, as a model speaks, and decodes it for the handler",
    () =>
      Effect.gen(function* () {
        const received: unknown[] = [];

        const Schedule = Action.make("schedule", {
          description: "Schedule a reminder.",
          readOnly: false,
          caller: Action.Anyone,
          input: { at: Schema.Date, note: Schema.optional(Schema.String) },
          success: Schema.BigInt,
        });

        const binding = ActionToolkit.make(
          Action.implement(Schedule, (input) =>
            Effect.sync(() => {
              received.push(input);

              return 42n;
            }),
          ),
        );

        expect(Object.keys(binding.toolkit.tools)).toEqual(["schedule"]);

        const result = yield* Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(
            yield* tools.handle("schedule", { at: "2026-09-29T00:00:00.000Z", note: null }),
          );
        }).pipe(Effect.provide(binding.layer));

        expect(received).toEqual([{ at: new Date("2026-09-29T00:00:00.000Z"), note: undefined }]);
        expect(result).toMatchObject([{ result: 42n, encodedResult: "42", isFailure: false }]);
        expect(JSON.stringify(result[0]?.encodedResult)).toBe('"42"');
      }),
  );

  it.effect("returns a declared error as the tool's failure, its own value", () =>
    Effect.gen(function* () {
      class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}

      const Find = Action.make("find", {
        description: "Find a note.",
        readOnly: true,
        caller: Action.Anyone,
        input: { id: Schema.String },
        success: Schema.String,
        error: [NotFound],
      });

      const binding = ActionToolkit.make(
        Action.implement(Find, ({ id }) => Effect.fail(new NotFound({ id }))),
      );

      const result = yield* Effect.gen(function* () {
        const tools = yield* binding.toolkit;

        return yield* Stream.runCollect(yield* tools.handle("find", { id: "n1" }));
      }).pipe(Effect.provide(binding.layer));

      const notFound = new NotFound({ id: "n1" });

      expect(result).toMatchObject([
        { result: notFound, encodedResult: Schema.encodeSync(NotFound)(notFound) },
      ]);
      expect(result[0]?.isFailure).toBe(true);
    }),
  );

  it.effect(
    "returns arguments that do not decode as a parameter failure, running neither authorize nor handler",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];

        const Echo = Action.make("echo", {
          description: "Echo a number.",
          readOnly: true,
          caller: Principal,
          input: { value: Schema.Finite },
          success: Schema.Finite,
        });

        const binding = ActionToolkit.make(
          Action.implement(Echo, ({ value }) => Effect.sync(() => (ran.push("handler"), value)), {
            authorize: () => Effect.sync(() => void ran.push("authorize")),
          }),
        );

        const [returned] = yield* Effect.flatMap(binding.toolkit, (tools) =>
          Effect.flatMap(tools.handle("echo", { value: "one" }), Stream.runCollect),
        ).pipe(Effect.provideService(Principal, "alice"), Effect.provide(binding.layer));

        expect(returned).toMatchObject({ isFailure: true, failureOrigin: "parameters" });
        expect(AiError.isAiError(returned?.result) && returned.result.reason._tag).toBe(
          "ToolParameterValidationError",
        );
        expect(ran).toEqual([]);
      }),
  );

  it("runs each call with its own identity, filling in one provided to layer for a call without one", async () => {
    const Who = Action.make("who", {
      description: "Current principal",
      readOnly: true,
      caller: Principal,
      success: Schema.String,
    });

    const binding = ActionToolkit.make(
      Action.implement(Who, () => Principal, { authorize: Action.allowAll }),
    );

    const call = Effect.flatMap(binding.toolkit, (tools) =>
      Effect.flatMap(tools.handle("who", {}), Stream.runCollect),
    );

    const as = (principal: string) => call.pipe(Effect.provideService(Principal, principal));

    // On one layer, concurrent calls with an identity each, then one without, which no
    // earlier call's identity reaches: it is refused before authorize and the handler run.
    const [[alice, bob], anonymous] = await Effect.runPromise(
      // @ts-expect-error The last call lacks the Principal its tool requires.
      Effect.all([Effect.all([as("alice"), as("bob")], { concurrency: "unbounded" }), call]).pipe(
        Effect.provide(binding.layer),
      ),
    );

    expect(alice).toMatchObject([{ result: "alice" }]);
    expect(bob).toMatchObject([{ result: "bob" }]);
    expect(anonymous).toMatchObject([{ isFailure: true }]);
    expect(anonymous[0]?.result).toBeInstanceOf(Action.Unauthenticated);

    // What the docs warn against: an identity provided at startup. The types refuse the call
    // without its own, yet the native toolkit lays the layer's context beneath each call's, so
    // it fills in; a call's own still wins.
    const startup = binding.layer.pipe(Layer.provide(Layer.succeed(Principal, "startup")));

    const [own, lacking] = await Effect.runPromise(
      // @ts-expect-error The second call lacks the Principal its tool requires.
      Effect.all([as("caller"), call]).pipe(Effect.provide(startup)),
    );

    expect(own).toMatchObject([{ result: "caller" }]);
    expect(lacking).toMatchObject([{ result: "startup" }]);
  });

  it.effect(
    "keeps each implementation's tools its own beside another's with tools of the same names",
    () =>
      Effect.gen(function* () {
        const Secret = Action.make("secret", {
          description: "A secret.",
          readOnly: true,
          caller: Principal,
          success: Schema.String,
        });

        const guarded = Action.implement(Secret, () => Effect.succeed("secret"), {
          authorize: () => Effect.fail(new Action.Forbidden()),
        });

        // The same action, implemented again with an authorizer letting every caller through.
        const open = Action.implement(Secret, () => Effect.succeed("secret"), {
          authorize: Action.allowAll,
        });

        const guardedTools = ActionToolkit.make(guarded);
        const openTools = ActionToolkit.make(open);

        const secret = ({ toolkit }: typeof guardedTools) =>
          Effect.flatMap(toolkit, (handled) =>
            Effect.flatMap(handled.handle("secret", {}), Stream.runCollect),
          ).pipe(Effect.provideService(Principal, "alice"));

        // Merged either way, each toolkit runs its own implementation's authorizer.
        for (const layers of [
          Layer.mergeAll(guardedTools.layer, openTools.layer),
          Layer.mergeAll(openTools.layer, guardedTools.layer),
        ]) {
          const [refused, answered] = yield* Effect.forEach([guardedTools, openTools], secret).pipe(
            Effect.provide(layers),
          );

          expect(refused).toMatchObject([{ isFailure: true }]);
          expect(refused?.[0]?.result).toBeInstanceOf(Action.Forbidden);
          expect(answered).toMatchObject([{ isFailure: false, result: "secret" }]);
        }

        // Given only the other implementation's layer, which the types accept, it never answers.
        const crossed = yield* Effect.exit(
          secret(guardedTools).pipe(Effect.provide(openTools.layer)),
        );

        expect(Exit.hasDies(crossed)).toBe(true);
      }),
  );

  it.effect("serves every toolkit of an implementation with the layer of any make call of it", () =>
    Effect.gen(function* () {
      let built = 0;

      const Read = Action.make("read", {
        description: "Read",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const Other = Action.make("other", {
        description: "Other",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String,
      });

      const app = Action.implement(
        [Read, Erase],
        Effect.sync(() => {
          built++;

          return { read: () => Effect.succeed("read"), erase: () => Effect.succeed("erased") };
        }),
      );

      const other = Action.implement(Other, () => Effect.succeed("other"));

      // A toolkit per agent or per policy, each from a make call of its own.
      const approving = ActionToolkit.make(app, {
        needsApproval: (call) => !call.action.readOnly,
      }).toolkit;

      const some = ActionToolkit.make(other).toolkit;
      const every = ActionToolkit.make([app, other]).toolkit;

      const handle = (toolkit: typeof every, name: "read" | "other") =>
        Effect.flatMap(toolkit, (handled) =>
          Effect.map(Effect.flatMap(handled.handle(name, {}), Stream.runCollect), (results) =>
            results.map(({ result }) => result),
          ),
        );

      // The handlers once, from yet another make call: one build serves them all.
      const [approved, subset, superset] = yield* Effect.all([
        LanguageModel.generateText({ prompt: "go", toolkit: approving }).pipe(
          Effect.map(outcome),
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            modelCalling(["read", {}], ["erase", { id: "x" }]),
          ),
        ),
        Effect.flatMap(some, (handled) =>
          Effect.flatMap(handled.handle("other", {}), Stream.runCollect),
        ),
        Effect.all([handle(every, "read"), handle(every, "other")]),
      ]).pipe(Effect.provide(ActionToolkit.make([app, other]).layer));

      expect(approved).toEqual({ approvals: ["2"], results: [["read", "read"]] });
      expect(subset).toMatchObject([{ result: "other" }]);
      expect(superset).toEqual([["read"], ["other"]]);
      expect(built).toBe(1);

      // And the layers of two make calls, one per implementation, serve a toolkit of both.
      const split = yield* Effect.all([handle(every, "read"), handle(every, "other")]).pipe(
        Effect.provide(
          Layer.mergeAll(ActionToolkit.make(app).layer, ActionToolkit.make(other).layer),
        ),
      );

      expect(split).toEqual([["read"], ["other"]]);

      // A selection, an agent's fewer tools, runs with its implementation's layer.
      const reader = ActionToolkit.make(app, { actions: [Read] }).toolkit;

      const shared = yield* Effect.flatMap(reader, (handled) =>
        Effect.flatMap(handled.handle("read", {}), Stream.runCollect),
      ).pipe(Effect.provide(ActionToolkit.make(app).layer));

      expect(shared).toMatchObject([{ isFailure: false, result: "read" }]);
    }),
  );

  it.effect(
    "releases what a call acquires when the call ends, not when its caller's scope closes",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const Open = Action.make("open", {
          description: "Opens a resource of its own",
          readOnly: false,
          caller: Principal,
          success: Schema.String,
        });

        const logged = (name: string) =>
          Effect.acquireRelease(
            Effect.sync(() => log.push(`${name} acquire`)),
            () => Effect.sync(() => log.push(`${name} release`)),
          );

        const { toolkit, layer } = ActionToolkit.make(
          Action.implement(Open, () => Effect.as(logged("handler"), "opened"), {
            authorize: () => Effect.asVoid(logged("authorize")),
          }),
          // Approved below by a response the prompt carries.
          { needsApproval: () => true },
        );

        // An approved call, which LanguageModel runs before asking the model again.
        const approved = LanguageModel.generateText({
          prompt: [
            { role: "user", content: "open" },
            {
              role: "assistant",
              content: [
                { type: "tool-call", id: "1", name: "open", params: {} },
                { type: "tool-approval-request", approvalId: "a", toolCallId: "1" },
              ],
            },
            {
              role: "tool",
              content: [{ type: "tool-approval-response", approvalId: "a", approved: true }],
            },
          ],
          toolkit,
        }).pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, modelCalling()));

        yield* Effect.scoped(
          Effect.gen(function* () {
            const tools = yield* toolkit;

            yield* Stream.runDrain(yield* tools.handle("open", {}));
            log.push("called directly");

            yield* approved;
            log.push("approved");

            yield* Effect.addFinalizer(() => Effect.sync(() => log.push("caller's scope closed")));
          }),
        ).pipe(Effect.provideService(Principal, "alice"), Effect.provide(layer));

        const call = [
          "authorize acquire",
          "handler acquire",
          "handler release",
          "authorize release",
        ];

        expect(log).toEqual([
          ...call,
          "called directly",
          ...call,
          "approved",
          "caller's scope closed",
        ]);
      }),
  );

  it.effect("merges with native tools into one toolkit a model calls", () =>
    Effect.gen(function* () {
      const Double = Action.make("double", {
        description: "Double a number.",
        readOnly: true,
        caller: Action.Anyone,
        input: { value: Schema.Finite },
        success: Schema.Finite,
      });

      const actions = ActionToolkit.make(
        Action.implement(Double, ({ value }) => Effect.succeed(value * 2)),
      );

      const Now = Tool.make("now", { success: Schema.Finite });
      const native = Toolkit.make(Now);

      const model = LanguageModel.make({
        generateText: () =>
          Effect.succeed([
            { type: "tool-call", id: "1", name: "double", params: { value: 21 } },
            { type: "tool-call", id: "2", name: "now", params: {} },
          ] as const),
        streamText: () => Stream.empty,
      });

      const response = yield* LanguageModel.generateText({
        prompt: "go",
        toolkit: Toolkit.merge(actions.toolkit, native),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(actions.layer, native.toLayer({ now: () => Effect.succeed(7) })),
        ),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, model),
      );

      expect(response.toolResults).toMatchObject([
        { name: "double", result: 42 },
        { name: "now", result: 7 },
      ]);
    }),
  );

  it.effect("releases a builder's resources with the layer", () =>
    Effect.gen(function* () {
      let acquired = 0;
      let released = 0;

      const One = Action.make("one", {
        description: "One",
        readOnly: false,
        caller: Action.Anyone,
        success: Schema.Number,
      });

      const Two = Action.make("two", {
        description: "Two",
        readOnly: false,
        caller: Action.Anyone,
        success: Schema.Number,
      });

      const app = Action.implement(
        [One, Two],
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired++;

            return { one: () => Effect.succeed(1), two: () => Effect.succeed(2) };
          }),
          () => Effect.sync(() => released++),
        ),
      );

      const binding = ActionToolkit.make(app);

      yield* Effect.gen(function* () {
        const tools = yield* binding.toolkit;
        const calls = yield* tools.handle("two", {});
        yield* Stream.runDrain(calls);
        expect(acquired).toBe(1);
      }).pipe(Effect.provide(binding.layer));

      expect(released).toBe(1);
    }),
  );
});
