import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  OpenApi,
} from "effect/http-api";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";

const publicAction = (name: string) =>
  Action.make(name, {
    description: name,
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

const Protected = Action.make("protected", {
  description: "Protected",
  readOnly: true,
  caller: CurrentActor,
  success: Schema.String,
});

const combined = (
  first: ReturnType<typeof ActionHttp.make>,
  second: ReturnType<typeof ActionHttp.make>
) => HttpApi.make("app").addHttpApi(first.api).addHttpApi(second.api);

describe("a binding's native api", () => {
  it("combined with another sharing an action name, throws when documented", () => {
    const api = combined(
      ActionHttp.make([publicAction("echo")], { prefix: "/a" }),
      ActionHttp.make([publicAction("echo")], { prefix: "/b" })
    );

    expect(() => OpenApi.fromApi(api)).toThrow(
      "Duplicate OpenAPI operationId: echo"
    );
  });

  it.effect(
    "combined with another sharing its prefix, silently loses one binding's actions from the document and a native client",
    () =>
      Effect.gen(function* () {
        const api = combined(
          ActionHttp.make([publicAction("first")], { prefix: "/a" }),
          ActionHttp.make([publicAction("second")], { prefix: "/a" })
        );

        expect(Object.keys(OpenApi.fromApi(api).paths)).toStrictEqual([
          "/a/second",
        ]);
        expect(Object.keys(yield* HttpApiClient.make(api))).toStrictEqual([
          "second",
        ]);
      }).pipe(Effect.provide(FetchHttpClient.layer))
  );

  it.effect(
    "holding a protected action, fails to build under the native HttpApiBuilder",
    () =>
      Effect.gen(function* () {
        const guarded = ActionHttp.make([Protected], { authentication: Login });
        const groupTypedAsString: string = "api";

        const exit = yield* Effect.exit(
          Layer.build(
            HttpApiBuilder.group(guarded.api, groupTypedAsString, (handlers) =>
              handlers.handleAll({ protected: () => Effect.succeed("ok") })
            )
          )
        );

        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
          "Service not found: effect-actions/Authentication/Security/"
        );
      })
  );
});
