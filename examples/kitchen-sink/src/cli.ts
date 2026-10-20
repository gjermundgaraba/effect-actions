import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, flow, Option } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";

// Entrypoint: `node --import tsx examples/kitchen-sink/src/cli.ts list-issues`.
// The members' CLI: a command per action of the binding, a flag per input field, each calling
// the server over HTTP. It imports the binding alone and runs nothing locally: the server
// authenticates and authorizes, as for any client.
const tracker = ActionCli.remote(Http, {
  name: "tracker",
  // Each command's options, keyed by its action's name and typed by that action.
  commands: {
    // `tracker list-issues -n 5 -s open`: short flags, and text instead of JSON (`--json` gives
    // the JSON back).
    listIssues: {
      aliases: { limit: "n", status: "s" },
      render: ({ issues }) =>
        issues.map(({ id, status, title }) => `${id}  ${status}  ${title}`).join("\n"),
    },
    // `tracker get-issue ACME-1`: the id is an argument, not a flag.
    getIssue: {
      positional: ["id"],
      render: (issue) =>
        [
          `# ${issue.id} ${issue.title} (${issue.status})`,
          issue.body,
          ...issue.comments.map(({ author, text }) => `- ${author}: ${text}`),
        ].join("\n"),
    },
    // `tracker create-issue --title Crash < report.md`: the body is piped in.
    createIssue: { stdin: "body" },
    commentOnIssue: { name: "comment", positional: ["id"], stdin: "text" },
    closeIssue: { name: "close", positional: ["id"] },
    // `render` receives the decoded success, the image's bytes a `Uint8Array`.
    getAttachment: {
      positional: ["id"],
      render: ({ attachment, image }) =>
        `${attachment.name}: ${image.mimeType}, ${image.data.byteLength} bytes`,
    },
  },
  // The connection. The token and the workspace are optional: `tracker get-status` is public
  // and needs neither, and any other command without a token gets the server's 401, and without
  // a workspace its 403.
  client: Effect.gen(function* () {
    const baseUrl = yield* Config.String("TRACKER_URL").pipe(
      Config.withDefault("http://127.0.0.1:3000"),
    );

    const token = yield* Config.option(Config.Redacted("TRACKER_TOKEN"));
    const workspace = yield* Config.option(Config.String("TRACKER_WORKSPACE"));

    const unchanged = (request: HttpClientRequest.HttpClientRequest) => request;

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
          }),
        ),
      ),
    });
  }),
});

Command.run(tracker, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
