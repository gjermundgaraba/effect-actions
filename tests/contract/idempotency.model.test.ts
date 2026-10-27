import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";

class Refused extends Schema.TaggedError<
  Refused,
  { readonly brand: unique symbol }
>()("Refused", {
  run: Schema.Int,
}) {}

class Who extends Context.Service<Who, string>()(
  "tests/idempotency-model/Who"
) {}

const Outcome = Schema.Literals(["answer", "refuse", "die", "interrupt"]);

type Outcome = typeof Outcome.Type;

const keepingValues = <
  const N extends string,
  C extends Action.Options["caller"],
>(
  name: N,
  caller: C
) =>
  Action.make(name, {
    description:
      "Keep values, answering, refusing, dying or interrupted as told.",
    input: {
      values: Schema.Record(Schema.String, Schema.Int),
      outcome: Outcome,
      request: Schema.optional(Schema.String),
    },
    success: { run: Schema.Int },
    error: Refused,
    readOnly: false,
    caller,
    idempotencyKey: "request",
  });

const sendAndPost = <C extends Action.Options["caller"]>(caller: C) =>
  [keepingValues("send", caller), keepingValues("post", caller)] as const;

const Call = Schema.Struct({
  action: Schema.Literals(["send", "post"]),
  request: Schema.UndefinedOr(Schema.Literals(["a", "b", "c"])),
  value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reversed: Schema.Boolean,
  outcome: Outcome,
});

type Call = typeof Call.Type;

type Observed =
  | { readonly answer: number }
  | { readonly refused: number }
  | "died"
  | "interrupted"
  | "another input";

const handlerOf =
  (ran: () => number) => (input: { readonly outcome: Outcome }) => {
    const run = ran();

    return Match.value(input.outcome).pipe(
      Match.when("answer", () => Effect.succeed({ run })),
      Match.when("refuse", () => Effect.fail(new Refused({ run }))),
      Match.when("die", () => Effect.die("boom")),
      Match.when("interrupt", () => Effect.interrupt),
      Match.exhaustive
    );
  };

const inputOf = (call: Call) => {
  const entries: Array<[string, number]> = [
    ["x", call.value],
    ["y", 1 - call.value],
  ];

  return {
    values: Object.fromEntries(call.reversed ? entries.toReversed() : entries),
    outcome: call.outcome,
    ...(call.request === undefined ? {} : { request: call.request }),
  };
};

const observedOf = (
  exit: Exit.Exit<{ readonly run: number }, unknown>
): Observed =>
  Exit.match(exit, {
    onSuccess: ({ run }) => ({ answer: run }),
    onFailure: (cause) => {
      if (Cause.hasDies(cause)) {
        return "died";
      }

      if (Cause.hasInterruptsOnly(cause)) {
        return "interrupted";
      }

      return Match.value(Cause.squash(cause)).pipe(
        Match.when(Match.instanceOf(Refused), ({ run }) => ({
          refused: run,
        })),
        Match.when(
          Match.instanceOf(Action.InvalidInput),
          () => "another input" as const
        ),
        Match.orElseAbsurd
      );
    },
  });

const modelled = (
  calls: ReadonlyArray<{ readonly call: Call; readonly caller: string }>
) => {
  const kept = new Map<
    string,
    { readonly input: string; readonly observed: Observed }
  >();

  let runs = 0;

  const expected = calls.map(({ call, caller }): Observed => {
    const input = `${call.value}:${call.outcome}`;
    const key = `${call.action}/${caller}/${call.request}`;
    const held = call.request === undefined ? undefined : kept.get(key);

    if (held !== undefined) {
      return held.input === input ? held.observed : "another input";
    }

    runs += 1;

    const observed: Observed = Match.value(call.outcome).pipe(
      Match.when("answer", () => ({ answer: runs })),
      Match.when("refuse", () => ({ refused: runs })),
      Match.when("die", () => "died" as const),
      Match.when("interrupt", () => "interrupted" as const),
      Match.exhaustive
    );

    if (
      call.request !== undefined &&
      observed !== "died" &&
      observed !== "interrupted"
    ) {
      kept.set(key, { input, observed });
    }

    return observed;
  });

  return { expected, runs };
};

const callSequence = Schema.Array(Call).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(30)
);

it.effect.prop(
  "runs a call given a key once for each action and key until it answers or refuses, answering every repeat of its input as it did, whatever its record's order, and refusing another input",
  { calls: callSequence },
  ({ calls }) =>
    Effect.gen(function* () {
      const [Send, Post] = sendAndPost(Action.Anyone);
      let runs = 0;
      const handle = handlerOf(() => (runs += 1));

      const client = yield* Action.client(
        Action.implement([Send, Post], { send: handle, post: handle })
      );

      const model = modelled(calls.map((call) => ({ call, caller: "" })));

      for (const [at, call] of calls.entries()) {
        const exit = yield* Effect.exit(
          call.action === "send"
            ? client.send(inputOf(call))
            : client.post(inputOf(call))
        );

        expect(observedOf(exit)).toStrictEqual(model.expected[at]);
      }

      expect(runs).toBe(model.runs);
    }).pipe(Effect.provide(Action.layerIdempotency))
);

const Login = Authentication.make("idempotency-model.Login", Who, {
  principal: (who) => who,
});

const verified = Authentication.layer(Login, (token: Redacted.Redacted) =>
  Effect.succeed(Redacted.value(token))
);

const Answered = Schema.Literals(["answer", "refuse"]);

it.effect.prop(
  "keeps each caller's keys apart where the authentication names a principal",
  {
    calls: Schema.Array(
      Schema.Struct({
        call: Call.mapFields((fields) => ({ ...fields, outcome: Answered })),
        caller: Schema.Literals(["alice", "bob"]),
      })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  },
  ({ calls }) =>
    Effect.gen(function* () {
      const [Send, Post] = sendAndPost(Who);
      const Http = ActionHttp.make([Send, Post], { authentication: Login });
      let runs = 0;
      const handle = handlerOf(() => (runs += 1));

      const as = (token: string) =>
        ActionHttp.client(Http, {
          transformClient: (client) =>
            HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token)),
        });

      const model = modelled(calls);

      const observed = yield* Effect.gen(function* () {
        const clients = { alice: yield* as("alice"), bob: yield* as("bob") };

        return yield* Effect.forEach(calls, ({ call, caller }) =>
          Effect.map(
            Effect.exit(
              call.action === "send"
                ? clients[caller].send(inputOf(call))
                : clients[caller].post(inputOf(call))
            ),
            observedOf
          )
        );
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(
              Http,
              Action.implement(
                [Send, Post],
                { send: handle, post: handle },
                { authorize: Action.allowAll }
              )
            ).pipe(
              Layer.provide(verified),
              Layer.provide(Action.layerIdempotency)
            )
          )
        )
      );

      expect(observed).toStrictEqual(model.expected);
      expect(runs).toBe(model.runs);
    })
);
