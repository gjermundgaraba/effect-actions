import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Layer, Schema } from "effect";
import { McpServer } from "effect/ai";

import { Issues } from "./Issues.js";

const guide = `# Triage

- An issue is \`open\` or \`closed\`. Its id is the workspace's key and a number: \`ACME-12\`.
- Read an issue before commenting on it, and comment before closing it: say why.
- Writes are limited to ten a minute. When refused, wait as long as the error says.
`;

const tools = Action.byName(Issues);

export const features = Layer.mergeAll(
  McpServer.resource({
    uri: "tracker://guides/triage",
    name: "Triage guide",
    mimeType: "text/markdown",
    content: Effect.succeed(guide),
  }),
  McpServer.prompt({
    name: "triage",
    description: "Go through the open issues and propose what to do with each.",
    parameters: { focus: Schema.String },
    content: ({ focus }) =>
      Effect.succeed(
        `Call ${tools.listIssues.name} for the open issues and ${tools.getIssue.name} for those about ${focus}. For each, propose ${tools.commentOnIssue.name} or ${tools.closeIssue.name}. Follow tracker://guides/triage.`
      ),
  })
);
