import { assert, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Logger,
  References,
  Schema,
  Tracer,
} from "effect";

import * as Action from "../../src/contract/Action.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { recordSpans } from "../support/tracing.js";

const Public = Action.make("public", {
  description: "Public action",
  readOnly: true,
  caller: Action.Anyone,
});

const Guarded = Action.make("guarded", {
  description: "Protected action",
  readOnly: false,
  caller: CurrentActor,
});

describe("the action span", () => {
  it("records a failed action span when the caller's identity is absent", async () => {
    const { spans, tracer } = recordSpans();

    const call = Effect.gen(function* () {
      const client = yield* Action.client(
        Action.implement(Guarded, () => Effect.void, {
          authorize: Action.allowAll,
        })
      );

      return yield* client.guarded();
    }).pipe(Effect.scoped, Effect.provideService(Tracer.Tracer, tracer));

    // @ts-expect-error -- Deliberately omit the required identity to exercise the dispatch check.
    const exit = await Effect.runPromiseExit(call);

    assert(Exit.isFailure(exit));
    expect(Cause.squash(exit.cause)).toBeInstanceOf(Action.Unauthenticated);
    expect(spans.get("guarded")?.status).toMatchObject({ _tag: "Ended", exit });
  });

  it.effect("records an authorization refusal in the action span", () => {
    const { spans, tracer } = recordSpans();
    const refusal = new Action.Forbidden();

    return Effect.gen(function* () {
      const client = yield* Action.client(
        Action.implement(Guarded, () => Effect.void, {
          authorize: () => Effect.fail(refusal),
        })
      );

      yield* Effect.exit(
        client.guarded().pipe(Effect.provideService(CurrentActor, actors.alice))
      );

      const status = spans.get("guarded")?.status;
      assert(status?._tag === "Ended");
      assert(Exit.hasFails(status.exit));
      expect(Cause.squash(status.exit.cause)).toBe(refusal);
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });

  it.effect(
    "records a synchronous authorizer throw as a defect in the action span",
    () => {
      const { spans, tracer } = recordSpans();
      const failure = new Error("authorize failed");

      return Effect.gen(function* () {
        const client = yield* Action.client(
          Action.implement(Guarded, () => Effect.void, {
            authorize: () => {
              throw failure;
            },
          })
        );

        const exit = yield* Effect.exit(
          client
            .guarded()
            .pipe(Effect.provideService(CurrentActor, actors.alice))
        );

        assert(Exit.hasDies(exit));
        expect(Cause.squash(exit.cause)).toBe(failure);
        expect(spans.get("guarded")?.status).toMatchObject({
          _tag: "Ended",
          exit,
        });
      }).pipe(Effect.provideService(Tracer.Tracer, tracer));
    }
  );

  it.effect(
    "records a synchronous handler throw as a defect in the action span",
    () => {
      const { spans, tracer } = recordSpans();
      const failure = new Error("handler failed");

      return Effect.gen(function* () {
        const client = yield* Action.client(
          Action.implement(Public, () => {
            throw failure;
          })
        );

        const exit = yield* Effect.exit(client.public());

        assert(Exit.hasDies(exit));
        expect(Cause.squash(exit.cause)).toBe(failure);
        expect(spans.get("public")?.status).toMatchObject({
          _tag: "Ended",
          exit,
        });
      }).pipe(Effect.provideService(Tracer.Tracer, tracer));
    }
  );

  it.effect(
    "records the dispatch exit after validating the declared error",
    () => {
      const { spans, tracer } = recordSpans();
      const Limited = Schema.TaggedStruct("Limited", { value: Schema.Finite });

      const Refuse = Action.make("refuse", {
        description: "Refuse with an invalid declared error",
        readOnly: true,
        caller: Action.Anyone,
        error: Limited,
      });

      return Effect.gen(function* () {
        const client = yield* Action.client(
          Action.implement(Refuse, () =>
            Effect.fail(
              Limited.make({ value: Infinity }, { disableChecks: true })
            )
          )
        );

        const exit = yield* Effect.exit(client.refuse());

        expect(Exit.hasDies(exit)).toBe(true);
        const status = spans.get("refuse")?.status;
        assert(status?._tag === "Ended");
        expect(status.exit).toStrictEqual(exit);
      }).pipe(Effect.provideService(Tracer.Tracer, tracer));
    }
  );

  it.effect(
    "keeps the action span open and its log annotations available during cleanup",
    () => {
      const { spans, tracer } = recordSpans();

      const logs: Array<{
        message: unknown;
        annotations: (typeof References.CurrentLogAnnotations)["Service"];
      }> = [];

      const logger = Logger.make(({ message, fiber }) => {
        logs.push({
          message,
          annotations: fiber.getRef(References.CurrentLogAnnotations),
        });
      });

      return Effect.gen(function* () {
        const client = yield* Action.client(
          Action.implement(Public, () =>
            Effect.addFinalizer(() =>
              Effect.gen(function* () {
                const span = yield* Effect.orDie(Effect.currentSpan);
                expect(span.name).toBe("public");
                expect(span.status._tag).toBe("Started");
                yield* Effect.log("cleanup ran");
              })
            )
          )
        );

        yield* client.public();

        expect(logs).toContainEqual({
          message: ["cleanup ran"],
          annotations: { "action.name": "public", "action.read_only": true },
        });
        expect(spans.get("public")?.status).toMatchObject({
          _tag: "Ended",
          exit: Exit.void,
        });
      }).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger]))
      );
    }
  );

  it.effect("records a cleanup defect in the action span's exit", () => {
    const { spans, tracer } = recordSpans();
    const failure = new Error("cleanup failed");

    return Effect.gen(function* () {
      const client = yield* Action.client(
        Action.implement(Public, () =>
          Effect.addFinalizer(() => Effect.die(failure))
        )
      );

      const exit = yield* Effect.exit(client.public());

      assert(Exit.hasDies(exit));
      expect(Cause.squash(exit.cause)).toBe(failure);
      expect(spans.get("public")?.status).toMatchObject({
        _tag: "Ended",
        exit,
      });
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });
});
