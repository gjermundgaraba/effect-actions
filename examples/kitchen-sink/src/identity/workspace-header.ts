import { Context, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

export class WorkspaceHeader extends Context.Service<
  WorkspaceHeader,
  Option.Option<string>
>()("tracker/WorkspaceHeader") {}

export const readWorkspaceHeader = HttpRouter.middleware<{
  provides: WorkspaceHeader;
}>()((route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(
      route,
      WorkspaceHeader,
      Option.fromNullishOr(request.headers["x-workspace"])
    )
  )
);
