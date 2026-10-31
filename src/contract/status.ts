import { Predicate, SchemaAST } from "effect";
import type { Schema } from "effect";

import type * as Action from "./Action.js";

const statusAnnotationsOf = (
  node: SchemaAST.AST | SchemaAST.FilterGroup<unknown>
): Schema.Annotations.Annotations | undefined => {
  for (const check of (node.checks ?? []).toReversed()) {
    if (Predicate.hasProperty(check.annotations, "httpApiStatus")) {
      return check.annotations;
    }

    const grouped =
      check._tag === "FilterGroup" ? statusAnnotationsOf(check) : undefined;

    if (grouped !== undefined) {
      return grouped;
    }
  }

  return Predicate.hasProperty(node.annotations, "httpApiStatus")
    ? node.annotations
    : undefined;
};

export const httpApiStatusOf = (ast: SchemaAST.AST): number | undefined => {
  const status = (statusAnnotationsOf(ast) ?? ast.context?.annotations)?.[
    "httpApiStatus"
  ];

  return Predicate.isNumber(status) ? status : undefined;
};

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
