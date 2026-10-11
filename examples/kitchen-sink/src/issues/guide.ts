import { Effect, Layer, Schema } from "effect";
import { McpServer } from "effect/ai";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Issues } from "./Issues.js";

const guide = `# Triage

- An issue is \`open\` or \`closed\`. Its id is the workspace's key and a number: \`ACME-12\`.
- Read an issue before commenting on it, and comment before closing it: say why.
- Writes are limited to ten a minute. When refused, wait as long as the error says.
`;

// The contracts keyed by name, each its exact contract. The prompt below names its tools through
// them, so renaming an action is a compile error here, not a stale instruction to a model.
const tools = Action.byName(Issues);

// Effect's own MCP resources and prompts, served beside the actions' tools as an endpoint's
// `features`. They are native, not actions: no `authorize` runs for them, and they run with
// the services they were built with, never a request's, so they cannot read the caller.
// Content that depends on the caller is an action.
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
        `Call ${tools.listIssues.name} for the open issues and ${tools.getIssue.name} for those about ${focus}. For each, propose ${tools.commentOnIssue.name} or ${tools.closeIssue.name}. Follow tracker://guides/triage.`,
      ),
  }),
);
