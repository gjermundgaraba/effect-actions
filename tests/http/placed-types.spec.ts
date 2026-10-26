import { expectTypeOf } from "@effect/vitest";
import { HttpClient } from "effect/http";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import { GetUser } from "../support/app/contracts.js";
import { Placed } from "../support/placed.js";

declare const reaching: HttpClient.HttpClient;

type Contract = (typeof Placed)["actions"][number] | (typeof Placed)["events"][number];

ActionHttp.placed(Placed, (input, contract) => {
  expectTypeOf(contract).toEqualTypeOf<Contract>();
  expectTypeOf(input).toEqualTypeOf<Contract["input"]["Type"]>();

  return reaching;
});

const forGetUser = (_input: (typeof GetUser)["input"]["Type"], _contract: typeof GetUser) =>
  reaching;

// @ts-expect-error -- a client for one contract's calls alone: it is chosen for every contract's
ActionHttp.placed(Placed, forGetUser);
