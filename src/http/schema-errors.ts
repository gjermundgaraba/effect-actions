import { Effect } from "effect";
import { type HttpApiError, HttpApiMiddleware } from "effect/http-api";
import { InvalidInput } from "../contract/errors.js";

const responseEncodingKinds: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> = new Set([
  "Body",
  "ResponseHeaders",
]);

/**
 * The native middleware answering schema failures: a request that does not decode with
 * `InvalidInput`, the schema's own message and issues. A result that does not encode stays the
 * native failure, which Effect answers with an empty 500 and reports.
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-actions/http/SchemaErrors",
  { error: [InvalidInput] },
) {}

/** `SchemaErrors`' server side, built by `ActionHttp.layer` alone, so a client's bundle leaves it out. */
export const schemaErrors = () =>
  HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
    Effect.fail(
      responseEncodingKinds.has(failure.kind)
        ? failure
        : InvalidInput.fromSchemaError(failure.cause),
    ),
  );
