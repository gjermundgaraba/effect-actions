import { Schema, SchemaAST } from "effect";
import type * as Action from "./Action.js";
import { unsuspended } from "./ast.js";

export const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
  httpApiStatusOf(ast) ??
  (SchemaAST.isSuspend(ast) ? statusThroughSuspensions(ast.thunk()) : undefined);

/**
 * `error` as an endpoint declares it: each member of a union without a status of its own apart,
 * each with its status, 422 without one.
 */
export const declared = (error: Action.Errors[number]): Action.Errors => {
  const status = statusThroughSuspensions(error.ast);

  if (status !== undefined) {
    return [
      httpApiStatusOf(error.ast) === undefined ? error.annotate({ httpApiStatus: status }) : error,
    ];
  }

  const resolved = unsuspended(error.ast);

  if (
    SchemaAST.isUnion(resolved) &&
    resolved.checks === undefined &&
    resolved.encoding === undefined
  ) {
    return resolved.types.flatMap((member) => declared(Schema.make<Action.Errors[number]>(member)));
  }

  return [error.annotate({ httpApiStatus: 422 })];
};
