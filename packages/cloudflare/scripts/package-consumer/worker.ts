import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";

export const Ping = Action.make("ping", {
  description: "Answer pong",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.Literal("pong"),
});

export const Http = ActionHttp.make([Ping]);

export const ping = (stub: DurableObjectStub) =>
  Effect.gen(function* () {
    const client = yield* ActionHttp.client(Http, { baseUrl: "https://object" });

    // @ts-expect-error -- Published declarations must retain the result type through the stub.
    const wrong: Effect.Effect<number, unknown> = client.ping();

    void wrong;

    return yield* client.ping();
  }).pipe(Effect.provide(ActionDurableObject.layerHttpClient(stub)));
