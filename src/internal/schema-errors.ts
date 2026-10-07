import { Effect } from "effect";
import { type HttpApiError, HttpApiMiddleware } from "effect/http-api";
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
 * `InvalidInput`, the schema's own message and issues, a result that does not encode as a defect,
 * the empty 500 of any other server bug.
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-actions/http/SchemaErrors",
  { error: [InvalidInput] },
) {}

/** `SchemaErrors`' server side, built by `ActionHttp.layer` alone, so a client's bundle leaves it out. */
export const schemaErrors = () =>
  HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
    responseKinds.has(failure.kind)
      ? // Its cause, not the native failure: the failure itself renders as a 400.
        Effect.die(failure.cause)
      : Effect.fail(InvalidInput.fromSchemaError(failure.cause)),
  );
