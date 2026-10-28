import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Config, Effect, flow, Option } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";

const unchanged = (request: HttpClientRequest.HttpClientRequest) => request;

const tracker = ActionCli.remote(Http, {
  name: "tracker",
  commands: {
    listIssues: {
      description:
        "List your workspace's issues, newest first, one line each: id, status, title.",
      aliases: { limit: "n", status: "s" },
      render: ({ issues }) =>
        issues
          .map(({ id, status, title }) => `${id}  ${status}  ${title}`)
          .join("\n"),
    },
    getIssue: {
      positional: ["id"],
      render: (issue) =>
        [
          `# ${issue.id} ${issue.title} (${issue.status})`,
          issue.body,
          ...issue.comments.map(({ author, text }) => `- ${author}: ${text}`),
        ].join("\n"),
    },
    createIssue: { stdin: "body" },
    commentOnIssue: { name: "comment", positional: ["id"], stdin: "text" },
    closeIssue: { name: "close", positional: ["id"] },
    exportIssues: {
      render: ({ id, status, title }) => `${id}  ${status}  ${title}`,
    },
    getAttachment: {
      positional: ["id"],
      render: ({ attachment, image }) =>
        `${attachment.name}: ${image.mimeType}, ${image.data.byteLength} bytes`,
    },
  },
  client: Effect.gen(function* () {
    const baseUrl = yield* Config.String("TRACKER_URL").pipe(
      Config.withDefault("http://127.0.0.1:3000")
    );

    const token = yield* Config.option(Config.Redacted("TRACKER_TOKEN"));
    const workspace = yield* Config.option(Config.String("TRACKER_WORKSPACE"));

    return yield* ActionHttp.client(Http, {
      baseUrl,
      transformClient: HttpClient.mapRequest(
        flow(
          Option.match(token, {
            onNone: () => unchanged,
            onSome: (value) => HttpClientRequest.bearerToken(value),
          }),
          Option.match(workspace, {
            onNone: () => unchanged,
            onSome: (slug) => HttpClientRequest.setHeader("x-workspace", slug),
          })
        )
      ),
    });
  }),
});

Command.run(tracker, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
