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
