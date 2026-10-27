import { Effect } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import type { HttpApiError } from "effect/http-api";

import { InvalidInput } from "../contract/errors.js";

const responseEncodingKinds: ReadonlySet<
  HttpApiError.HttpApiSchemaError["kind"]
> = new Set(["Body", "ResponseHeaders"]);

export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-actions/http/SchemaErrors",
  { error: [InvalidInput] }
) {}

// Why: A result that does not encode stays the native failure, an empty 500, under no policy
// mapping it to a declared error: the handler has run, so any write it made has happened, which a
// declared error would misreport.
export const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrors,
  (failure) =>
    Effect.fail(
      responseEncodingKinds.has(failure.kind)
        ? failure
        : InvalidInput.fromSchemaError(failure.cause)
    )
);
