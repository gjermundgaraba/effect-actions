import { SchemaAST } from "effect";
import type * as Action from "./Action.js";

export const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

export const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
  httpApiStatusOf(ast) ??
  (SchemaAST.isSuspend(ast) ? statusThroughSuspensions(ast.thunk()) : undefined);

/** One error schema, from `errorSchemas`, as an endpoint declares it: with its status, 422 without one. */
export const declared = (error: Action.Errors[number]): Action.Errors[number] => {
  const status = statusThroughSuspensions(error.ast);

  return status === undefined
    ? error.annotate({ httpApiStatus: 422 })
    : httpApiStatusOf(error.ast) === undefined
      ? error.annotate({ httpApiStatus: status })
      : error;
};
