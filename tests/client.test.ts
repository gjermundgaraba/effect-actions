import { assert, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
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

const Ping = Action.make("ping", { description: "Ping", access: "read", success: Schema.Number });

describe("Action.client", () => {
  it.effect(
    "calls each action with its input, behind its hook, as the caller around each call",
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

    assert(Exit.isFailure(exit));
    expect(Cause.pretty(exit.cause)).toContain("example/CurrentActor");
  });

  it.effect(
    "refuses input that does not pass through its codec with InvalidInput, before the hook",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];

        const NonEmpty = Schema.String.check(Schema.isMinLength(1));

        const Rename = Action.make("rename", {
          description: "Rename",
          access: "write",
          input: { id: NonEmpty, name: NonEmpty },
          success: Schema.String,
        });

        const app = Action.implement(
          Rename,
          (input) =>
            Effect.sync(() => (calls.push(`handler ${JSON.stringify(input)}`), input.name)),
          () => Effect.sync(() => void calls.push("hook")),
        );

        // Wider than the input declares, as TypeScript lets a variable through.
        const wider = { id: "1", name: "Bea", admin: true };

        const client = yield* Action.client(app);
        const invalid = yield* Effect.flip(client.rename({ id: "", name: "" }));
        // The undeclared field is dropped, as a typed client's encoding drops it.
        const dropped = yield* client.rename(wider);

        // Every issue, as over HTTP.
        expect(invalid).toBeInstanceOf(Action.InvalidInput);
        expect(invalid.message).toContain('at ["id"]');
        expect(invalid.message).toContain('at ["name"]');
        expect(dropped).toBe("Bea");
        expect(calls).toEqual(["hook", 'handler {"id":"1","name":"Bea"}']);
      }),
  );

  it.effect("gives the handler the input a remote one decodes, and the caller the success", () =>
    Effect.gen(function* () {
      class Filters extends Schema.Class<Filters>("Filters")({
        tag: Schema.optionalKey(Schema.String),
      }) {}

      const Double = Action.make("double", {
        description: "Double",
        access: "read",
        input: { value: Schema.FiniteFromString },
        success: Schema.Finite,
      });

      const Search = Action.make("search", {
        description: "Search",
        access: "read",
        input: Filters,
        success: Schema.String,
      });

      // Trimmed when decoded, and sent as given: a remote handler gets it trimmed.
      const Greet = Action.make("greet", {
        description: "Greet",
        access: "read",
        input: { name: Schema.String.pipe(Schema.decode(SchemaTransformation.trim())) },
        success: Schema.String,
      });

      // JSON has no `-0`: a remote handler gets `0`, and so does a remote caller.
      const Zero = Action.make("zero", {
        description: "Zero",
        access: "read",
        input: { value: Schema.Number },
        success: Schema.Array(Schema.Number),
      });

      const app = Action.implement(
        [Double, Search, Greet, Zero],
        {
          double: ({ value }) => Effect.succeed(value * 2),
          search: (filters) => Effect.succeed(filters instanceof Filters ? "instance" : "plain"),
          greet: ({ name }) => Effect.succeed(`Hello, ${name}`),
          zero: ({ value }) => Effect.succeed([value, -0]),
        },
        Action.allowAll,
      );

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

  it.effect("gives each call a scope of its own, and releases the builders with the client's", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];

      const logged = (name: string) =>
        Effect.acquireRelease(
          Effect.sync(() => log.push(`${name} acquire`)),
          () => Effect.sync(() => log.push(`${name} release`)),
        );

      // The handlers and the hook are each built by an Effect of their own.
      const app = Action.implement(
        Ping,
        Effect.as(logged("builder"), () => Effect.as(logged("handler"), 1)),
        Effect.as(logged("hook builder"), () => Effect.asVoid(logged("hook"))),
      );

      yield* Effect.gen(function* () {
        const client = yield* Action.client(app);

        log.push("acquired");
        yield* client.ping();
        yield* client.ping();
        log.push("called twice");
      }).pipe(Effect.scoped);

      const built = ["builder acquire", "hook builder acquire"];
      const call = ["hook acquire", "handler acquire", "handler release", "hook release"];
      const released = ["builder release", "hook builder release"];

      // Built once, when acquired; each call releases what it acquired; the builders last.
      expect(log.slice(0, 2).toSorted()).toEqual(built);
      expect(log.slice(2, -2)).toEqual(["acquired", ...call, ...call, "called twice"]);
      expect(log.slice(-2).toSorted()).toEqual(released);
    }),
  );

  it.effect("dies with a success that does not pass through its codec, as a server's 500", () =>
    Effect.gen(function* () {
      const Name = Action.make("name", {
        description: "A name",
        access: "read",
        success: Schema.String.check(Schema.isMinLength(1)),
      });

      const Profile = Action.make("profile", {
        description: "A profile",
        access: "read",
        success: { id: Schema.String },
      });

      const Nothing = Action.make("nothing", { description: "Returns nothing", access: "write" });

      // Trimmed when decoded, and sent as given: a remote caller gets it trimmed.
      const Label = Action.make("label", {
        description: "A label",
        access: "read",
        success: Schema.String.pipe(Schema.decode(SchemaTransformation.trim())),
      });

      // Wider than the success declares, as TypeScript lets a variable through.
      const stored = { id: "1", secret: "s" };

      const app = Action.implement(
        [Name, Profile, Nothing, Label],
        {
          name: () => Effect.succeed(""),
          profile: () => Effect.succeed(stored),
          nothing: () => Effect.void,
          label: () => Effect.succeed(" Bea "),
        },
        Action.allowAll,
      );

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
          access: "read",
          errors: [Mislabeled],
        });

        const Profile = Action.make("profile", {
          description: "A profile",
          access: "read",
          errors: [Missing],
        });

        const Queue = Action.make("queue", {
          description: "A queue",
          access: "read",
          errors: [Busy],
        });

        // Wider than the error declares, as TypeScript lets a variable through.
        const missing = { ...Missing.make({ id: "1" }), secret: "s" };

        const app = Action.implement(
          [Label, Profile, Queue],
          {
            label: () => Effect.fail(new Mislabeled({ label: " Bea " })),
            profile: () => Effect.fail(missing),
            queue: () => Effect.fail(new Busy({ reason: "full" })),
          },
          Action.allowAll,
        );

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
        access: "read",
        errors: [Counted],
      });

      const app = Action.implement(
        [Count, Ping],
        {
          // Made without its check, as TypeScript lets any number through.
          count: () => Effect.fail(new Counted({ count: 1.5 }, { disableChecks: true })),
          // @ts-expect-error `ping` does not declare `Unlisted`; plain JavaScript can still fail with it.
          ping: () => Effect.fail(new Unlisted()),
        },
        Action.allowAll,
      );

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

  it.effect(
    "runs each handler in its action's span, a child of the caller's, never the acquisition's",
    () =>
      Effect.gen(function* () {
        const Where = Action.make("where", {
          description: "Name the span it runs in",
          access: "read",
          success: { name: Schema.String, parent: Schema.String },
        });

        const app = Action.implement(
          Where,
          () =>
            Effect.map(Effect.orDie(Effect.currentSpan), (span) => ({
              name: span.name,
              parent: Option.match(span.parent, {
                onNone: () => "",
                onSome: (parent) => (Predicate.isTagged(parent, "Span") ? parent.name : ""),
              }),
            })),
          Action.allowAll,
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

  it.effect("calls a share's actions with its source's builder, behind the share's own hook", () =>
    Effect.gen(function* () {
      let built = 0;

      const Read = Action.make("read", { description: "Read", access: "read" });
      const Write = Action.make("write", { description: "Write", access: "write" });

      const source = Action.implement(
        [Read, Write],
        Effect.sync(() => {
          built++;

          return { read: () => Effect.void, write: () => Effect.void };
        }),
        (action) => (action.access === "write" ? Effect.fail(new Action.Forbidden()) : Effect.void),
      );

      const trusted = Action.share([Write], source, Action.allowAll);

      // Both acquired in one layer graph, `Layer.empty`'s, where the builder runs once.
      const guarded = yield* Action.client(source);
      const admin = yield* Action.client(trusted);
      const refused = yield* Effect.flip(guarded.write());
      const written = yield* admin.write();

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(written).toBeUndefined();
      expect(Object.keys(admin)).toEqual(["write"]);
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
      Action.allowAll,
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
          Action.allowAll,
        );

        const Pong = Action.make("pong", {
          description: "Pong",
          access: "read",
          success: Schema.Number,
        });

        // Acquired where builders live: in a builder, built with the host's layers.
        const outer = Action.implement(
          Pong,
          Effect.map(Action.client(inner), (client) => () => client.ping()),
          Action.allowAll,
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
    const again = Action.implement(Ping, () => Effect.succeed(2), Action.allowAll);
    const ping = Action.implement(Ping, () => Effect.succeed(1), Action.allowAll);

    expect(() => Action.client([ping, again])).toThrow("Duplicate action: ping");

    // oxlint-disable-next-line typescript/no-misused-spread -- Deliberate nominal-fabrication fixture.
    const copy = { ...ping };

    // @ts-expect-error A copy of an implementation is not one.
    expect(() => Action.client(copy)).toThrow(
      "Not an implementation made by this Action.implement",
    );
  });
});
