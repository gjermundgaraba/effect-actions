import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, flow, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";
import type { Issue } from "./issues/Issues.js";

// Entrypoint for code written with promises: an integration, a bot, another product's page.
// It imports the binding and nothing of the server, so a bundler keeps the contracts and
// Effect's fetch client, no handler.
export const connect = (options: {
  readonly url: string;
  readonly token: string;
  readonly workspace: string;
}) => {
  // Built once, outside any Effect, over `fetch`: its methods require nothing, so each call
  // runs with `Effect.runPromise`.
  const api = ActionHttp.fetchClient(Http, {
    baseUrl: options.url,
    transformClient: HttpClient.mapRequest(
      flow(
        HttpClientRequest.bearerToken(options.token),
        HttpClientRequest.setHeader("x-workspace", options.workspace)
      )
    ),
  });

  return {
    // A method takes the action's decoded input, so a field with a decoding default is given
    // here; only a call without any argument sends `{}` and gets the defaults.
    openIssues: async (limit = 20) =>
      await Effect.runPromise(
        Effect.map(
          api.listIssues({ status: "open", limit }),
          ({ issues }) => issues
        )
      ),

    // A declared error is a typed failure, handled by its tag: a missing issue is `undefined`.
    issue: async (id: string): Promise<Issue | undefined> =>
      await api.getIssue({ id }).pipe(
        Effect.catchTag("IssueNotFound", () => Effect.undefined),
        Effect.runPromise
      ),

    // Left unhandled, a declared error rejects the promise as its decoded value, so a caller's
    // `catch` may test `error instanceof RateLimited`.
    file: async (title: string, body: string) =>
      await Effect.runPromise(api.createIssue({ title, body })),

    // A stream action's method returns a `Stream`; as an async iterable, `for await` reads each
    // issue as the server sends it.
    exportAll: (): AsyncIterable<Issue> =>
      Stream.toAsyncIterable(api.exportIssues({})),
  };
};
