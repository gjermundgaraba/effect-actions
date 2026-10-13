import { expect, it } from "@effect/vitest";
import { Cause, Effect, ErrorReporter, Exit, Layer, Logger, Option, Schema, Stream } from "effect";
import { AiError } from "effect/ai";
import { CliError } from "effect/cli";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import * as Testing from "../../src/testing/Testing.js";
import { exec } from "../support/cli-services.js";
import { recorder } from "../support/reporter.js";
import {
  post,
  rawToolCall,
  send,
  sendRawNdjson,
  valueOrSquashedCause,
} from "../support/requests.js";

const anyone = { readOnly: true, caller: Action.Anyone } as const;

class Leaked extends Schema.TaggedError<Leaked>()("Leaked", { id: Schema.String }) {}

class Fragile extends Schema.TaggedError<Fragile>()("Fragile", { value: Schema.Finite }) {}

const Crash = Action.make("crash", { ...anyone, description: "Dies." });

const Leak = Action.make("leak", { ...anyone, description: "Fails undeclared." });

const Count = Action.make("count", {
  ...anyone,
  description: "Answers a number its success does not encode.",
  success: Schema.Finite,
});

const Brittle = Action.make("brittle", {
  ...anyone,
  description: "Fails with a declared error that does not encode.",
  error: Fragile,
});

const Status = Action.make("status", {
  ...anyone,
  description: "Answers.",
  success: Schema.String,
});

const actions = [Crash, Leak, Count, Brittle, Status] as const;

const app = Action.implement(actions, {
  crash: () => Effect.die(new Error("db password hunter2")),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The failure under test: the contract broken, as plain JavaScript could.
  leak: () => Effect.fail(new Leaked({ id: "secret-id" }) as never),
  count: () => Effect.succeed(Infinity),
  brittle: () => Effect.fail(new Fragile({ value: Infinity }, { disableChecks: true })),
  status: () => Effect.succeed("up"),
});

const routes = Layer.mergeAll(
  ActionHttp.layer(ActionHttp.make(actions), app),
  ActionMcp.layerHttp(app, { name: "defects", version: "0" }),
  ActionRpc.layer(ActionRpc.make(actions), app).pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerNdjson),
  ),
);

const tools = ActionToolkit.make(app);

const failing = ["crash", "leak", "count", "brittle"] as const;

type Failing = (typeof failing)[number];

const ToolReply = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.Boolean,
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
    }),
  }),
);

const toolCall = (name: Failing) =>
  Effect.flatMap(send(rawToolCall(name)), (response) =>
    Effect.map(
      Effect.flatMap(response.text, Schema.decodeUnknownEffect(ToolReply)),
      ({ result }) => ({
        isError: result.isError,
        text: result.content[0]?.text,
      }),
    ),
  );

const toolkitCall = (name: Failing) =>
  Effect.gen(function* () {
    const toolkit = yield* tools.toolkit;

    return yield* Stream.runCollect(yield* toolkit.handle(name, {}));
  }).pipe(
    Effect.provide(tools.layer),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? "a result"
        : Cause.hasDies(exit.cause)
          ? "the call's defect"
          : Cause.findErrorOption(exit.cause).pipe(
              Option.filter(AiError.isAiError),
              Option.match({
                onNone: () => "another failure",
                onSome: ({ reason }) => `an AiError, ${reason._tag}`,
              }),
            ),
    ),
  );

const command = (name: Failing) =>
  exec(ActionCli.command(app, actions.find((action) => action.name === name) ?? Status), []).pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return "a success";

      if (Cause.hasDies(exit.cause)) return "the command's defect";

      const error = Cause.squash(exit.cause);

      return error instanceof CliError.UserError ? { printed: error.userMessage } : String(error);
    }),
  );

const internalToolError = "Tool execution failed due to an internal server error.";

const surfaces = [
  {
    surface: "HTTP",
    reports: failing.length,
    answers: Effect.forEach(failing, (name) =>
      Effect.flatMap(send(post(`/api/${name}`)), (response) =>
        Effect.map(response.text, (body) => ({ status: response.status, body })),
      ),
    ),
    guaranteed: failing.map(() => ({ status: 500, body: "" })),
  },
  {
    surface: "MCP",
    reports: failing.length,
    answers: Effect.forEach(failing, toolCall),
    guaranteed: failing.map(() => ({ isError: true, text: internalToolError })),
  },
  {
    surface: "RPC",
    reports: failing.length,
    answers: Effect.map(
      sendRawNdjson([...failing, "status"].map((tag) => ({ tag, payload: {} }))),
      ({ exits }) => exits.map(valueOrSquashedCause),
    ),
    guaranteed: [...failing.map(() => new Error("Internal server error")), "up"],
  },
  {
    surface: "Toolkit",
    reports: 0,
    answers: Effect.forEach(failing, toolkitCall),
    guaranteed: failing.map((name) =>
      name === "crash" ? "the call's defect" : "an AiError, ToolResultEncodingError",
    ),
  },
  {
    surface: "CLI",
    reports: 0,
    answers: Effect.forEach(failing, command),
    guaranteed: failing.map(
      (name) =>
        ({
          crash: "the command's defect",
          leak: { printed: "Leaked" },
          count: "the command's defect",
          brittle: { printed: "Fragile" },
        })[name],
    ),
  },
] as const;

it.effect.each(surfaces)(
  "answers a defect, an undeclared failure, and a success or an error that does not encode as guarantees.md's table states, sending no cause, and logging and reporting each, over $surface",
  ({ answers, guaranteed, reports }) =>
    Effect.gen(function* () {
      const reported: Array<string> = [];
      const logged: Array<string> = [];

      const answered = yield* answers.pipe(
        Effect.provide(Testing.layer(routes)),
        Effect.provide(ErrorReporter.layer([recorder(reported)])),
        Effect.provide(
          Logger.layer([
            Logger.make(({ cause }) => {
              if (cause.reasons.length > 0) logged.push(Cause.pretty(cause));
            }),
          ]),
        ),
      );

      expect(answered).toEqual(guaranteed);
      expect(JSON.stringify(answered)).not.toMatch(/hunter2|secret-id/);

      expect(reported.length).toBeGreaterThanOrEqual(reports);
      expect(logged.length).toBeGreaterThanOrEqual(reports);
    }),
);
