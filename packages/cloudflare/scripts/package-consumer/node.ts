import * as DurableObjectClient from "@gjermundgaraba/effect-actions-cloudflare/DurableObjectClient";
import { Option } from "effect";

const runtimeError = Object.assign(new Error("overloaded"), {
  retryable: true,
  overloaded: true,
});

const refused = DurableObjectClient.refused(runtimeError);

if (
  Option.getOrUndefined(DurableObjectClient.runtimeError(refused)) !==
    runtimeError ||
  !DurableObjectClient.isOverloaded(refused) ||
  DurableObjectClient.isRetryable(refused) ||
  Option.isSome(DurableObjectClient.runtimeError(runtimeError))
) {
  throw new Error(
    "DurableObjectClient, loaded in Node, misread a refused stub call built with refused"
  );
}
