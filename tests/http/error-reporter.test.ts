import { expect, it } from "@effect/vitest";
import { Effect, ErrorReporter, Layer } from "effect";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../support/app/authentication.js";
import { Http } from "../support/app/binding.js";
import { userActions } from "../support/app/handlers.js";
import { Users } from "../support/app/users.js";
import { post, send, withBearer } from "../support/requests.js";
import { recorder } from "../support/reporter.js";

it.effect(
  "gives a reporter a handler's declared failure, never a missing or refused credential or a refusal",
  () => {
    const reported: Array<string> = [];

    const rename = (token?: string) => {
      const request = post("/api/renameUser", { id: "1", name: "Ada" });

      return token === undefined ? request : withBearer(request, token);
    };

    return Effect.gen(function* () {
      const statuses = yield* Effect.forEach(
        [
          rename(),
          rename("unknown"),
          rename("reader"),
          withBearer(post("/api/getUser", { id: "9" }), "alice"),
        ],
        (request) => Effect.map(send(request), ({ status }) => status),
      );

      expect(statuses).toEqual([401, 401, 403, 404]);
      expect(reported).toEqual([expect.stringContaining("UserNotFound")]);
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionHttp.layer(Http, [userActions]).pipe(
            Layer.provide(authenticate),
            Layer.provide(ErrorReporter.layer([recorder(reported)])),
            Layer.provide(Users.layerMemory),
          ),
        ),
      ),
    );
  },
);
