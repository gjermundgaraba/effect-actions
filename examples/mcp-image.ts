import { Buffer } from "node:buffer";
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Screen = Schema.Struct({ id: Schema.Int, title: Schema.String });

class TerminusError extends Schema.TaggedError<TerminusError>()("TerminusError", {
  message: Schema.String,
}) {}

// The image is a field of the success. Over MCP it is lifted into an image block, after the
// JSON text of `{ screen }`, which is also the structured content; elsewhere it is JSON, the
// bytes in base64.
const GetScreenImage = Action.make("get_screen_image", {
  description: "Fetch the rendered image for a listed screen.",
  input: { screen_id: Schema.Int },
  success: { screen: Screen, image: Action.Image },
  error: TerminusError,
  readOnly: true,
  caller: Action.Anyone,
});

// A one-pixel PNG stands in for a rendered screen.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const getScreenImage = Action.implement(GetScreenImage, ({ screen_id }) =>
  screen_id === 1
    ? Effect.succeed({
        screen: { id: screen_id, title: "Home" },
        image: { data: pixel, mimeType: "image/png" },
      })
    : Effect.fail(new TerminusError({ message: `No screen ${screen_id}.` })),
);

// A subprocess MCP server, as mcp-stdio.ts is: launch it from an MCP client.
ActionMcp.runStdio(getScreenImage, { name: "terminus", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
