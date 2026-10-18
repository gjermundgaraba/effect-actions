import { Context, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiSecurity } from "effect/http-api";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { savedOf } from "../../src/durable/credential.js";

class Caller extends Context.Service<Caller, string>()("test/Caller") {}

const bindingOver = (security?: Authentication.Options["security"]) =>
  ActionRpc.make(
    [
      Action.make("me", {
        description: "me",
        readOnly: true,
        caller: Caller,
        success: Schema.String,
      }),
    ],
    {
      authentication: Authentication.make(
        "test.Credential",
        Caller,
        security === undefined ? {} : { security },
      ),
    },
  );

const upgradeWith = (headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(new Request("https://object/rpc?key=in-query", { headers }));

const sent = {
  authorization: "Bearer token",
  "x-api-key": "key",
  cookie: "theme=dark; session=a%20b",
  "x-note": "kept",
  "x-other": "dropped",
};

describe("savedOf", () => {
  it.each([
    ["Bearer", undefined, [["authorization", "Bearer token"]]],
    ["Basic", HttpApiSecurity.basic, [["authorization", "Bearer token"]]],
    [
      "an API key header",
      HttpApiSecurity.apiKey({ in: "header", key: "X-Api-Key" }),
      [["x-api-key", "key"]],
    ],
    [
      "an API key cookie, alone",
      HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
      [["cookie", "session=a%20b"]],
    ],
    [
      "an API key in the query, which authenticates no message",
      HttpApiSecurity.apiKey({ in: "query", key: "key" }),
      [],
    ],
  ] as const)("keeps the credential of %s and the listed headers", (_, security, credential) => {
    expect(savedOf(bindingOver(security), ["X-Note"])(upgradeWith(sent))).toEqual([
      ...credential,
      ["x-note", "kept"],
    ]);
  });

  it("keeps nothing a binding without authentication or the upgrade request does not name", () => {
    const publicBinding = ActionRpc.make([
      Action.make("open", { description: "open", readOnly: true, caller: Action.Anyone }),
    ]);

    expect(savedOf(publicBinding, ["x-absent"])(upgradeWith(sent))).toEqual([]);
    expect(savedOf(bindingOver(), [])(upgradeWith({}))).toEqual([]);
  });
});
