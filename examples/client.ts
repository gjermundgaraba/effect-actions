import { Effect } from "effect";
import { ActionHttp } from "../src/index.js";
import { Actions } from "./contracts.js";

export const lookup = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Actions, {
    baseUrl: "https://api.example.com",
  });
  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();
  return { user, identity };
});
