import { SchemaAST } from "effect";
import type * as Action from "./Action.js";

export const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

// Why: What a reconnect may outlast is what `HttpClient.retryTransient` retries: the transport
// failing, a status a server sends while it recovers, or a silence. A wrong URL, a request that
// does not encode, or a refusal fails the watch.
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

/** Whether a server answering `status` may answer otherwise once it recovers. */
export const isTransientStatus = (status: number): boolean => transientStatuses.has(status);

const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
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
