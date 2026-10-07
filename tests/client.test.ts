import { assert, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  Stream,
} from "effect";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { actors, CurrentActor } from "../examples/authorization.js";
import { userActions } from "../examples/handlers.js";
import { Users } from "../examples/users.js";
import { defectOf } from "./defect.js";

const asAlice = Effect.provideService(CurrentActor, actors.alice);

const asReader = Effect.provideService(CurrentActor, actors.reader);

const Ping = Action.make("ping", {
  description: "Ping",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Number,
});

describe("Action.client", () => {
  it.effect(
    "calls each action with its input, behind its authorize, as the caller around each call",
    () =>
      Effect.gen(function* () {
        const users = yield* Action.client(userActions);

        const renamed = yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);

        const refused = yield* Effect.flip(
          users.renameUser({ id: "1", name: "Cy" }).pipe(asReader),
        );

        const read = yield* users.getUser({ id: "1" }).pipe(asReader);
        const { changes } = yield* users.listChanges().pipe(asReader);

        expect(renamed).toEqual({ id: "1", name: "Bea" });
        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(refused).toMatchObject({ scopes: ["users:write"] });
        // The refused call changed nothing, and an action no binding holds is called all the same.
        expect(read).toEqual({ id: "1", name: "Bea" });
        expect(changes).toEqual([{ actorId: "alice", userId: "1", name: "Bea" }]);
      }).pipe(Effect.provide(Users.layerMemory)),
  );

  it("reads the caller around each call, never one around its acquisition", async () => {
    const acquiredAsAlice = <A, E, R>(
      call: (users: Action.Client<typeof userActions>) => Effect.Effect<A, E, R>,
    ) =>
      Effect.flatMap(Action.client(userActions).pipe(asAlice), call).pipe(
        Effect.scoped,
        Effect.provide(Users.layerMemory),
      );

    const who = await Effect.runPromise(acquiredAsAlice((users) => users.whoAmI().pipe(asReader)));

    expect(who).toEqual({ id: "reader", tenantId: "acme" });

    const exit = await Effect.runPromiseExit(
      // @ts-expect-error Deliberately call without a caller: the acquisition's is not the call's.
      acquiredAsAlice((users) => users.whoAmI()),
    );

    // Refused before authorize and the handler run, as a remote call without a credential is.
    assert(Exit.isFailure(exit));
    expect(Cause.squash(exit.cause)).toBeInstanceOf(Action.Unauthenticated);
  });

  it.effect(
    "refuses input that does not pass through its codec with InvalidInput, before authorize",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];

        const NonEmpty = Schema.String.check(Schema.isMinLength(1));

        const Rename = Action.make("rename", {
          description: "Rename",
          readOnly: false,
          caller: CurrentActor,
          input: { id: NonEmpty, name: NonEmpty },
          success: Schema.String,
        });

        const app = Action.implement(
          Rename,
          (input) =>
            Effect.sync(() => (calls.push(`handler ${JSON.stringify(input)}`), input.name)),
          { authorize: () => Effect.sync(() => void calls.push("authorize")) },
        );

        // Wider than the input declares, as TypeScript lets a variable through.
        const wider = { id: "1", name: "Bea", admin: true };

        const client = yield* Action.client(app);
        const invalid = yield* Effect.flip(client.rename({ id: "", name: "" }).pipe(asAlice));
        // The undeclared field is dropped, as a typed client's encoding drops it.
        const dropped = yield* client.rename(wider).pipe(asAlice);

        // Every issue, as over HTTP.
        expect(invalid).toBeInstanceOf(Action.InvalidInput);
        expect(invalid.message).toContain('at ["id"]');
        expect(invalid.message).toContain('at ["name"]');
        expect(dropped).toBe("Bea");
        expect(calls).toEqual(["authorize", 'handler {"id":"1","name":"Bea"}']);
      }),
  );

  it.effect("gives the handler the input a remote one decodes, and the caller the success", () =>
    Effect.gen(function* () {
      class Filters extends Schema.Class<Filters>("Filters")({
        tag: Schema.optionalKey(Schema.String),
      }) {}

      const Double = Action.make("double", {
        description: "Double",
        readOnly: true,
        caller: Action.Anyone,
        input: { value: Schema.FiniteFromString },
        success: Schema.Finite,
      });

      const Search = Action.make("search", {
        description: "Search",
        readOnly: true,
        caller: Action.Anyone,
        input: Filters,
        success: Schema.String,
      });

      // Trimmed when decoded, and sent as given: a remote handler gets it trimmed.
      const Greet = Action.make("greet", {
        description: "Greet",
        readOnly: true,
        caller: Action.Anyone,
        input: { name: Schema.String.pipe(Schema.decode(SchemaTransformation.trim())) },
        success: Schema.String,
      });

      // JSON has no `-0`: a remote handler gets `0`, and so does a remote caller.
      const Zero = Action.make("zero", {
        description: "Zero",
        readOnly: true,
        caller: Action.Anyone,
        input: { value: Schema.Number },
        success: Schema.Array(Schema.Number),
      });

      const app = Action.implement([Double, Search, Greet, Zero], {
        double: ({ value }) => Effect.succeed(value * 2),
        search: (filters) => Effect.succeed(filters instanceof Filters ? "instance" : "plain"),
        greet: ({ name }) => Effect.succeed(`Hello, ${name}`),
        zero: ({ value }) => Effect.succeed([value, -0]),
      });

      const client = yield* Action.client(app);
      const doubled = yield* client.double({ value: 21 });
      const greeted = yield* client.greet({ name: " Bea " });
      const zeros = yield* client.zero({ value: -0 });
      // Left out, the input is what `{}` decodes to: an instance of the class.
      const all = yield* client.search();
      const plain = yield* Effect.flip(client.search({ tag: "x" }));

      expect(doubled).toBe(42);
      expect(greeted).toBe("Hello, Bea");
      expect(zeros.map((zero) => Object.is(zero, 0))).toEqual([true, true]);
      expect(all).toBe("instance");
      // A class encodes only its instances, as over HTTP.
      expect(plain).toBeInstanceOf(Action.InvalidInput);
      expect(plain.message).toContain("Expected Filters");
    }),
  );

  it.effect("leaves the input out where `{}` is a valid encoded input, and only there", () =>
    Effect.gen(function* () {
      // Every field defaulted when decoded: `{}` decodes, to the defaults.
      const Page = Action.make("page", {
        description: "Page",
        readOnly: true,
        caller: Action.Anyone,
        input: { limit: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))) },
        success: Schema.Number,
      });

      // Decoded, it takes nothing; encoded, it requires a token, so `{}` does not decode.
      const Signed = Action.make("signed", {
        description: "Signed",
        readOnly: true,
        caller: Action.Anyone,
        input: Schema.Struct({ token: Schema.String }).pipe(
          Schema.decodeTo(
            Schema.Struct({}),
            SchemaTransformation.transform({ decode: () => ({}), encode: () => ({ token: "t" }) }),
          ),
        ),
        success: Schema.String,
      });

      const client = yield* Action.client(
        Action.implement([Page, Signed], {
          page: ({ limit }) => Effect.succeed(limit),
          signed: () => Effect.succeed("signed"),
        }),
      );

      expect(yield* client.page()).toBe(20);
      expect(yield* client.signed({})).toBe("signed");

      // @ts-expect-error Its encoded form requires a field: the argument is required.
      const omitted = yield* Effect.flip(client.signed());

      expect(omitted).toBeInstanceOf(Action.InvalidInput);
    }),
  );

  it.effect("gives each call a scope of its own, and releases the builders with the client's", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];

      const logged = (name: string) =>
        Effect.acquireRelease(
          Effect.sync(() => log.push(`${name} acquire`)),
          () => Effect.sync(() => log.push(`${name} release`)),
        );

      const Guarded = Action.make("ping", {
        description: "Ping",
        readOnly: true,
        caller: CurrentActor,
        success: Schema.Number,
      });

      // The handlers and the authorizer are each built by an Effect of their own.
      const app = Action.implement(
        Guarded,
        Effect.as(logged("builder"), () => Effect.as(logged("handler"), 1)),
        {
          authorize: Effect.as(logged("authorize builder"), () =>
            Effect.asVoid(logged("authorize")),
          ),
        },
      );

      yield* Effect.gen(function* () {
        const client = yield* Action.client(app);

        log.push("acquired");
        yield* client.ping().pipe(asAlice);
        yield* client.ping().pipe(asAlice);
        log.push("called twice");
      }).pipe(Effect.scoped);

      const built = ["authorize builder acquire", "builder acquire"];
      const call = ["authorize acquire", "handler acquire", "handler release", "authorize release"];
      const released = ["authorize builder release", "builder release"];

      // Built once, when acquired; each call releases what it acquired; the builders last.
      expect(log.slice(0, 2).toSorted()).toEqual(built);
      expect(log.slice(2, -2)).toEqual(["acquired", ...call, ...call, "called twice"]);
      expect(log.slice(-2).toSorted()).toEqual(released);
    }),
  );

  it.effect("releases what a failed call acquired when it fails, the handler's first", () =>
    Effect.gen(function* () {
      class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}

      const log: Array<string> = [];

      const logged = (name: string) =>
        Effect.acquireRelease(
          Effect.sync(() => log.push(`${name} acquire`)),
          () => Effect.sync(() => log.push(`${name} release`)),
        );

      const Guarded = Action.make("ping", {
        description: "Ping",
        readOnly: true,
        caller: CurrentActor,
        error: [Busy],
      });

      const app = Action.implement(
        Guarded,
        () => Effect.andThen(logged("handler"), Effect.fail(new Busy())),
        { authorize: () => Effect.asVoid(logged("authorize")) },
      );

      yield* Effect.gen(function* () {
        const client = yield* Action.client(app);

        expect(yield* Effect.flip(client.ping().pipe(asAlice))).toEqual(new Busy());
        log.push("failed");
      }).pipe(Effect.scoped);

      expect(log).toEqual([
        "authorize acquire",
        "handler acquire",
        "handler release",
        "authorize release",
        "failed",
      ]);
    }),
  );

  it.effect("dies with a success that does not pass through its codec, as a server's 500", () =>
    Effect.gen(function* () {
      const Name = Action.make("name", {
        description: "A name",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String.check(Schema.isMinLength(1)),
      });

      const Profile = Action.make("profile", {
        description: "A profile",
        readOnly: true,
        caller: Action.Anyone,
        success: { id: Schema.String },
      });

      const Nothing = Action.make("nothing", {
        description: "Returns nothing",
        readOnly: false,
        caller: Action.Anyone,
      });

      // Trimmed when decoded, and sent as given: a remote caller gets it trimmed.
      const Label = Action.make("label", {
        description: "A label",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.String.pipe(Schema.decode(SchemaTransformation.trim())),
      });

      // Wider than the success declares, as TypeScript lets a variable through.
      const stored = { id: "1", secret: "s" };

      const app = Action.implement([Name, Profile, Nothing, Label], {
        name: () => Effect.succeed(""),
        profile: () => Effect.succeed(stored),
        nothing: () => Effect.void,
        label: () => Effect.succeed(" Bea "),
      });

      const client = yield* Action.client(app);
      const defect = yield* defectOf(client.name());

      expect(Schema.isSchemaError(defect) && defect.message).toContain(
        "Expected a value with a length of at least 1",
      );

      // A success is what its encoding decodes to, as a remote caller gets it: the undeclared
      // field is dropped, a void success is `undefined`, and a decoding transformation applies.
      expect(yield* client.profile()).toEqual({ id: "1" });
      expect(yield* client.nothing()).toBeUndefined();
      expect(yield* client.label()).toBe("Bea");
    }),
  );

  it.effect(
    "gives the caller a failure as a remote one decodes it, from where the handler failed",
    () =>
      Effect.gen(function* () {
        // Trimmed when decoded, and sent as given: a remote caller gets it trimmed.
        class Mislabeled extends Schema.TaggedError<Mislabeled>()("Mislabeled", {
          label: Schema.String.pipe(Schema.decode(SchemaTransformation.trim())),
        }) {}

        const Missing = Schema.TaggedStruct("Missing", { id: Schema.String });

        // Encoded by an Effect that completes later, as a codec may be.
        class Busy extends Schema.TaggedError<Busy>()("Busy", {
          reason: Schema.String.pipe(
            Schema.decodeTo(
              Schema.String,
              SchemaTransformation.transformEffect({
                decode: (reason) => Effect.succeed(reason),
                encode: (reason) =>
                  Effect.as(
                    Effect.promise(() => Promise.resolve()),
                    reason,
                  ),
              }),
            ),
          ),
        }) {}

        const Label = Action.make("label", {
          description: "A label",
          readOnly: true,
          caller: Action.Anyone,
          error: [Mislabeled],
        });

        const Profile = Action.make("profile", {
          description: "A profile",
          readOnly: true,
          caller: Action.Anyone,
          error: [Missing],
        });

        const Queue = Action.make("queue", {
          description: "A queue",
          readOnly: true,
          caller: Action.Anyone,
          error: [Busy],
        });

        // Wider than the error declares, as TypeScript lets a variable through.
        const missing = { ...Missing.make({ id: "1" }), secret: "s" };

        const app = Action.implement([Label, Profile, Queue], {
          label: () => Effect.fail(new Mislabeled({ label: " Bea " })),
          profile: () => Effect.fail(missing),
          queue: () => Effect.fail(new Busy({ reason: "full" })),
        });

        const client = yield* Action.client(app);
        const mislabeled = yield* Effect.flip(Effect.sandbox(client.label()));
        const notFound = yield* Effect.flip(client.profile());
        const busy = yield* Effect.flip(client.queue());

        const error = Cause.squash(mislabeled);

        // A failure is what its encoding decodes to: a decoding transformation applies, and the
        // undeclared field is dropped.
        expect(error).toEqual(new Mislabeled({ label: "Bea" }));
        expect(notFound).toEqual(Missing.make({ id: "1" }));
        expect(busy).toEqual(new Busy({ reason: "full" }));
        // Its trace is the handler's: where it failed, then its action's span.
        expect(Predicate.isError(error) && error.stack).toContain("client.test.ts");
        expect(Cause.pretty(mislabeled)).toMatch(/^\s+at label$/m);
      }),
  );

  it.effect("dies with a failure that does not pass through its codec, as a server's 500", () =>
    Effect.gen(function* () {
      class Unlisted extends Schema.TaggedError<Unlisted>()("Unlisted", {}) {}

      class Counted extends Schema.TaggedError<Counted>()("Counted", { count: Schema.Int }) {}

      const Count = Action.make("count", {
        description: "Count",
        readOnly: true,
        caller: Action.Anyone,
        error: [Counted],
      });

      const app = Action.implement([Count, Ping], {
        // Made without its check, as TypeScript lets any number through.
        count: () => Effect.fail(new Counted({ count: 1.5 }, { disableChecks: true })),
        // @ts-expect-error `ping` does not declare `Unlisted`; plain JavaScript can still fail with it.
        ping: () => Effect.fail(new Unlisted()),
      });

      const client = yield* Action.client(app);
      const unencoded = yield* defectOf(client.count());
      const undeclared = yield* Effect.exit(client.ping());

      // Its `SchemaError`, then the failure itself, which the `SchemaError` does not name.
      const defects = Exit.isFailure(undeclared)
        ? undeclared.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)
        : [];

      expect(Schema.isSchemaError(unencoded) && unencoded.message).toContain('at ["count"]');
      expect(defects).toHaveLength(2);
      expect(Schema.isSchemaError(defects[0])).toBe(true);
      expect(defects[1]).toBeInstanceOf(Unlisted);
    }),
  );

  it.effect("passes a failure its schema checks asynchronously", () =>
    Effect.gen(function* () {
      // A code checked only once a promise settles, as a lookup would.
      const Code = Schema.declareConstructor<string>()(
        [],
        () => (input, ast) =>
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.flatMap(() =>
              Predicate.isString(input)
                ? Effect.succeed(input)
                : Effect.fail(new SchemaIssue.InvalidType(ast, Option.some(input))),
            ),
          ),
        { toCodecJson: () => undefined },
      );

      const Quota = Schema.TaggedStruct("Quota", { code: Code });
      const quota = yield* Quota.makeEffect({ code: "quota" });

      const Status = Action.make("status", {
        description: "Status",
        readOnly: true,
        caller: Action.Anyone,
        error: [Quota],
      });

      const client = yield* Action.client(Action.implement(Status, () => Effect.fail(quota)));

      expect(yield* Effect.flip(client.status())).toEqual(quota);
    }),
  );

  it.effect("keeps a failure's whole cause: its trace and a defect beside it", () =>
    Effect.gen(function* () {
      class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}

      const Status = Action.make("status", {
        description: "Status",
        readOnly: true,
        caller: Action.Anyone,
        error: [Busy],
      });

      const busy = new Busy();
      const cleanup = new Error("cleanup failed");

      // Failed in a span of its own, with a cleanup that dies.
      const client = yield* Action.client(
        Action.implement(Status, () =>
          Effect.fail(busy).pipe(Effect.ensuring(Effect.die(cleanup)), Effect.withSpan("quota")),
        ),
      );

      const cause = yield* Effect.flip(Effect.sandbox(client.status()));

      expect(cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)).toEqual([busy]);
      expect(cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)).toEqual([
        cleanup,
      ]);
      expect(Cause.pretty(cause)).toMatch(/^\s+at quota \(.*client\.test\.ts/m);
    }),
  );

  it.effect(
    "runs each handler in its action's span, a child of the caller's, never the acquisition's",
    () =>
      Effect.gen(function* () {
        const Where = Action.make("where", {
          description: "Name the span it runs in",
          readOnly: true,
          caller: Action.Anyone,
          success: { name: Schema.String, parent: Schema.String },
        });

        const app = Action.implement(Where, () =>
          Effect.map(Effect.orDie(Effect.currentSpan), (span) => ({
            name: span.name,
            parent: Option.match(span.parent, {
              onNone: () => "",
              onSome: (parent) => (Predicate.isTagged(parent, "Span") ? parent.name : ""),
            }),
          })),
        );

        const client = yield* Action.client(app).pipe(Effect.withSpan("acquisition"));

        const result = {
          inside: yield* client.where().pipe(Effect.withSpan("caller")),
          outside: yield* client.where(),
        };

        // The acquisition's span parents no call: a call outside any span has no parent.
        expect(result).toEqual({
          inside: { name: "where", parent: "caller" },
          outside: { name: "where", parent: "" },
        });
      }),
  );

  it.effect("calls a selection of its actions with its builder and its authorize", () =>
    Effect.gen(function* () {
      let built = 0;

      const Read = Action.make("read", {
        description: "Read",
        readOnly: true,
        caller: CurrentActor,
      });

      const Write = Action.make("write", {
        description: "Write",
        readOnly: false,
        caller: CurrentActor,
      });

      const app = Action.implement(
        [Read, Write],
        Effect.sync(() => {
          built++;

          return { read: () => Effect.void, write: () => Effect.void };
        }),
        {
          authorize: (action) =>
            !action.readOnly ? Effect.fail(new Action.Forbidden()) : Effect.void,
        },
      );

      // Both acquired in one layer graph, `Layer.empty`'s, where the builder runs once.
      const all = yield* Action.client(app);
      const writer = yield* Action.client(app, { actions: [Write] });

      // Selection never changes who may call.
      expect(yield* Effect.flip(all.write().pipe(asAlice))).toBeInstanceOf(Action.Forbidden);
      expect(yield* Effect.flip(writer.write().pipe(asAlice))).toBeInstanceOf(Action.Forbidden);
      expect(yield* all.read().pipe(asAlice)).toBeUndefined();
      expect(Object.keys(writer)).toEqual(["write"]);
      expect(built).toBe(1);
    }).pipe(Effect.provide(Layer.empty)),
  );

  it("builds once when acquired, for every call, into the graph it is acquired in", async () => {
    let built = 0;

    const app = Action.implement(
      Ping,
      Effect.sync(() => {
        const run = ++built;

        return () => Effect.succeed(run);
      }),
    );

    const twice = Effect.gen(function* () {
      const first = yield* Action.client(app);
      const second = yield* Action.client(app);

      return [yield* first.ping(), yield* first.ping(), yield* second.ping()];
    }).pipe(Effect.scoped);

    // Under a provided layer, both share its graph; under none, each has one of its own.
    expect(await Effect.runPromise(twice.pipe(Effect.provide(Layer.empty)))).toEqual([1, 1, 1]);
    expect(await Effect.runPromise(twice)).toEqual([2, 2, 3]);
  });

  it.effect.each(["the builder acquiring it", "the surface"])(
    "shares a builder's run with a surface of its graph when %s builds first",
    (first) =>
      Effect.gen(function* () {
        let built = 0;

        const inner = Action.implement(
          Ping,
          Effect.sync(() => {
            const run = ++built;

            return () => Effect.succeed(run);
          }),
        );

        const Pong = Action.make("pong", {
          description: "Pong",
          readOnly: true,
          caller: Action.Anyone,
          success: Schema.Number,
        });

        // Acquired where builders live: in a builder, built with the host's layers.
        const outer = Action.implement(
          Pong,
          Effect.map(Action.client(inner), (client) => () => client.ping()),
        );

        const { toolkit, layer: composite } = ActionToolkit.make(outer);
        const served = ActionToolkit.make(inner).layer;

        const layer =
          first === "the surface"
            ? Layer.mergeAll(served, composite)
            : Layer.mergeAll(composite, served);

        const results = yield* Effect.gen(function* () {
          const tools = yield* toolkit;

          return yield* Stream.runCollect(yield* tools.handle("pong", {}));
        }).pipe(Effect.provide(layer));

        expect(results).toMatchObject([{ result: 1 }]);
        expect(built).toBe(1);
      }),
  );

  it("refuses a name twice, and a value no Action.implement made, where it is made", () => {
    const again = Action.implement(Ping, () => Effect.succeed(2));
    const ping = Action.implement(Ping, () => Effect.succeed(1));

    expect(() => Action.client([ping, again])).toThrow("Duplicate action: ping");

    // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication fixture.
    const copy = { ...ping };

    // @ts-expect-error A copy of an implementation is not one.
    expect(() => Action.client(copy)).toThrow(
      "Not an implementation made by this Action.implement",
    );
  });
});
