import { SchemaAST } from "effect";

import type * as Action from "./Action.js";

export const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

export const isTransientStatus = (status: number): boolean =>
  transientStatuses.has(status);

const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
  httpApiStatusOf(ast) ??
  (SchemaAST.isSuspend(ast)
    ? statusThroughSuspensions(ast.thunk())
    : undefined);

export const declaredStatus = (error: Action.Errors[number]): number =>
  statusThroughSuspensions(error.ast) ?? 422;

export const declared = (
  error: Action.Errors[number]
): Action.Errors[number] =>
  httpApiStatusOf(error.ast) === undefined
    ? error.annotate({ httpApiStatus: declaredStatus(error) })
    : error;
