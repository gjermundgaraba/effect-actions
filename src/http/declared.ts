import { Schema, SchemaAST } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiSchema } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import { unsuspended } from "../contract/rules.js";

const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
  httpApiStatusOf(ast) ??
  (SchemaAST.isSuspend(ast) ? statusThroughSuspensions(ast.thunk()) : undefined);

type Declared = Action.Errors[number];

/**
 * The schemas an endpoint declares for one error, each with the status it is sent with. `HttpApi`
 * reads a status off each declared schema, never off a union's members nor through a suspension, so
 * a plain union without a status of its own declares each member, and a suspended error, as a
 * recursive one is written, without a status of its own states the status of what it suspends. An
 * error without a status is an outcome the action expects, not a server fault: it is sent as 422,
 * rather than `HttpApi`'s 500, which clients and proxies read as the server failing.
 */
export const declared = (error: Declared): ReadonlyArray<Declared> => {
  const status = statusThroughSuspensions(error.ast);

  if (status !== undefined) {
    return [httpApiStatusOf(error.ast) === undefined ? HttpApiSchema.status(status)(error) : error];
  }

  const resolved = unsuspended(error.ast);

  if (
    SchemaAST.isUnion(resolved) &&
    resolved.checks === undefined &&
    resolved.encoding === undefined
  ) {
    return resolved.types.flatMap((member) => declared(Schema.make<Declared>(member)));
  }

  return [HttpApiSchema.status(422)(error)];
};

/**
 * `error` as an endpoint declaring `errors` sends it: its JSON, encoded by the first declared
 * schema that accepts it, with that schema's status. None for a value no schema accepts.
 */
export const declaredResponse = (
  errors: ReadonlyArray<Declared>,
  error: Declared["Type"],
): HttpServerResponse.HttpServerResponse | undefined => {
  const schema = errors.flatMap(declared).find((each) => Schema.is(each)(error));

  return schema === undefined
    ? undefined
    : HttpServerResponse.jsonUnsafe(Schema.encodeUnknownSync(Schema.toCodecJson(schema))(error), {
        status: httpApiStatusOf(schema.ast) ?? 422,
      });
};
