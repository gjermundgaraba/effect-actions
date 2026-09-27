// Server-only, and a module of its own: a client bundle, which never serves, drops it whole.
import { Effect } from "effect";
import { type HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi";
import { InvalidInput } from "./errors.js";

/**
 * `HttpApiBuilder` reports these kinds while encoding the handler's answer, after the
 * handler ran; every other kind (`Payload`, `Params`, `Headers`, `Query`) comes from
 * decoding the request before it.
 */
const responseKinds: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> = new Set([
  "Body",
  "ResponseHeaders",
]);

/**
 * The native middleware answering schema failures: a request that does not decode with
 * `InvalidInput` and the schema's own message, a result that does not encode as a defect,
 * the empty 500 of any other server bug.
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-actions/http/SchemaErrors",
  { error: [InvalidInput] },
) {}

export const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
  responseKinds.has(failure.kind)
    ? // Its cause, not the native failure: the failure itself renders as a 400.
      Effect.die(failure.cause)
    : Effect.fail(new InvalidInput({ message: failure.cause.message })),
);
