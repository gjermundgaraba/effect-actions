import { Context, Effect, Layer, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { authenticate } from "./authentication.js";
import { authorize, CurrentActor } from "./authorization.js";
import { Login } from "./binding.js";

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfter: Schema.Finite },
  { httpApiStatus: 429 },
) {}

// A declaration, transport-free as a contract is: the error the check may fail with, and the
// one service it reads per call.
export class Limited extends Action.Check<Limited>()("example/Limited", {
  error: RateLimited,
  requires: CurrentActor,
}) {}

// `RateLimited` joins the action's errors: every surface declares it, every client decodes it.
export const Invite = Action.make("invite", {
  description: "Invite someone to your tenant.",
  input: { email: Schema.String },
  access: "write",
  auth: CurrentActor,
  checks: [Limited],
});

/** DEMO ONLY: ten calls per caller, counted in memory and never reset. */
export class Limiter extends Context.Service<
  Limiter,
  { readonly take: (key: string) => Effect.Effect<void, RateLimited> }
>()("example/Limiter") {
  static readonly layerMemory = Layer.sync(Limiter, () => {
    const counts = new Map<string, number>();

    return Limiter.of({
      take: (key) =>
        Effect.suspend(() => {
          const count = counts.get(key) ?? 0;

          if (count >= 10) return Effect.fail(new RateLimited({ retryAfter: 60 }));

          counts.set(key, count + 1);

          return Effect.void;
        }),
    });
  });
}

// Built once per layer graph, so every surface serving `Invite` counts against one limiter;
// per call it reads only the service `Limited` requires.
export const LimitedLive = Layer.effect(
  Limited,
  Effect.map(
    Limiter,
    (limiter) => () => Effect.flatMap(CurrentActor, ({ id }) => limiter.take(id)),
  ),
).pipe(Layer.provide(Limiter.layerMemory));

// `authorize` refuses, the check limits, and the handler does neither.
export const invite = Action.implement(Invite, ({ email }) => Effect.log(`Invited ${email}.`), {
  authorize,
});

export const InviteHttp = ActionHttp.make([Invite], { authentication: Login });

// Every surface serving `invite` owes `Limited` at startup, as it owes a builder's services.
export const routes = ActionHttp.layer(InviteHttp, invite).pipe(
  Layer.provide([authenticate, LimitedLive]),
);
