import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, flow, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";
import type { Issue } from "./issues/Issues.js";

export const connect = (options: {
  readonly url: string;
  readonly token: string;
  readonly workspace: string;
}) => {
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
    openIssues: async (limit = 20) =>
      await Effect.runPromise(
        Effect.map(
          api.listIssues({ status: "open", limit }),
          ({ issues }) => issues
        )
      ),

    issue: async (id: string): Promise<Issue | undefined> =>
      await api.getIssue({ id }).pipe(
        Effect.catchTag("IssueNotFound", () => Effect.undefined),
        Effect.runPromise
      ),

    file: async (title: string, body: string) =>
      await Effect.runPromise(api.createIssue({ title, body })),

    exportAll: (): AsyncIterable<Issue> =>
      Stream.toAsyncIterable(api.exportIssues({})),
  };
};
