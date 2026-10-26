import { SchemaAST } from "effect";
import type * as Action from "./Action.js";

export const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

// Why: These are the statuses `HttpClient.retryTransient` retries, those a server sends while it
// recovers. A watch reconnects past them, as past the transport failing or a silence, where a
// wrong URL, a request that does not encode or a refusal fails it; and a call given an
// idempotency key keeps no declared failure of them, which would answer every retry with that key
// for as long as it is kept.
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

/** Whether a server answering `status` may answer otherwise once it recovers. */
export const isTransientStatus = (status: number): boolean => transientStatuses.has(status);

const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
  httpApiStatusOf(ast) ??
  (SchemaAST.isSuspend(ast) ? statusThroughSuspensions(ast.thunk()) : undefined);

/** The status an endpoint answers `error` with: its own, through suspensions, 422 without one. */
export const declaredStatus = (error: Action.Errors[number]): number =>
  statusThroughSuspensions(error.ast) ?? 422;

/** One error schema, from `errorSchemas`, as an endpoint declares it: with its status, 422 without one. */
export const declared = (error: Action.Errors[number]): Action.Errors[number] =>
  httpApiStatusOf(error.ast) === undefined
    ? error.annotate({ httpApiStatus: declaredStatus(error) })
    : error;
