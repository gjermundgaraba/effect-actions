import { expectTypeOf } from "@effect/vitest";
import { HttpClient } from "effect/http";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import { GetUser } from "../support/app/contracts.js";
import { Countdown, Placed } from "../support/placed.js";

declare const reaching: HttpClient.HttpClient;

type Contract = (typeof Placed)["actions"][number] | (typeof Placed)["events"][number];

type Routed = Parameters<Parameters<typeof ActionHttp.placed<typeof Placed>>[1]>;

ActionHttp.placed(Placed, (input, contract) => {
  expectTypeOf(contract).toEqualTypeOf<Contract>();
  expectTypeOf(input).toEqualTypeOf<Contract["input"]["Type"]>();

  return reaching;
});

expectTypeOf<[(typeof GetUser)["input"]["Type"], typeof GetUser]>().toExtend<Routed>();

expectTypeOf<[(typeof GetUser)["input"]["Type"], typeof Countdown]>().not.toExtend<Routed>();

const forGetUser = (_input: (typeof GetUser)["input"]["Type"], _contract: typeof GetUser) =>
  reaching;

// @ts-expect-error -- a client for one contract's calls alone: it is chosen for every contract's
ActionHttp.placed(Placed, forGetUser);
