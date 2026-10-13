import { expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Logger,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
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
  toolReplyOf,
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

const defect = new Error("db password hunter2");

const failing = [Crash, Leak, Count, Brittle] as const;

const served = [...failing, Status] as const;

const app = Action.implement(served, {
  crash: () => Effect.die(defect),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The failure under test: the contract broken, as plain JavaScript could.
  leak: () => Effect.fail(new Leaked({ id: "secret-id" }) as never),
  count: () => Effect.succeed(Infinity),
  brittle: () => Effect.fail(new Fragile({ value: Infinity }, { disableChecks: true })),
  status: () => Effect.succeed("up"),
});

const routes = Layer.mergeAll(
  ActionHttp.layer(ActionHttp.make(served), app),
  ActionMcp.layerHttp(app, { name: "defects", version: "0" }),
  ActionRpc.layer(ActionRpc.make(served), app).pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerNdjson),
  ),
);

const tools = ActionToolkit.make(app);

type Failing = (typeof failing)[number];

const died = (cause: Cause.Cause<unknown>) => ({
  died: cause.reasons
    .filter(Cause.isDieReason)
    .map(({ defect: died }) =>
      died === defect
        ? "the handler's defect"
        : Predicate.hasProperty(died, "_tag")
          ? died._tag
          : "another defect",
    ),
});

const toolkitCall = ({ name }: Failing) =>
  Effect.gen(function* () {
    const toolkit = yield* tools.toolkit;

    return yield* Stream.runCollect(yield* toolkit.handle(name, {}));
  }).pipe(
    Effect.provide(tools.layer),
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return { answered: "a result", sent: "" };

      if (Cause.hasDies(exit.cause)) return { answered: died(exit.cause), sent: "" };

      return Cause.findErrorOption(exit.cause).pipe(
        Option.filter(AiError.isAiError),
        Option.match({
          onNone: () => ({ answered: "another failure", sent: "" }),
          onSome: ({ reason }) => ({
            answered: reason.message.startsWith(`Failed to encode result for tool '${name}'`)
              ? "an AiError naming the tool"
              : reason.message,
            sent: reason.message,
          }),
        }),
      );
    }),
  );

const command = (action: Failing) =>
  exec(ActionCli.command(app, action), []).pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return { answered: "a success", sent: "" };

      if (Cause.hasDies(exit.cause)) return { answered: died(exit.cause), sent: "" };

      const error = Cause.squash(exit.cause);

      return error instanceof CliError.UserError
        ? { answered: { printed: error.userMessage }, sent: error.userMessage ?? "" }
        : { answered: String(error), sent: String(error) };
    }),
  );

const internalToolError = "Tool execution failed due to an internal server error.";

const surfaces = [
  {
    surface: "HTTP",
    reporting: "each, some twice as Effect's HTTP server reports a failed response again",
    reports: { atLeast: failing.length, atMost: 2 * failing.length },
    logs: failing.length,
    answers: Effect.forEach(failing, ({ name }) =>
      Effect.flatMap(send(post(`/api/${name}`)), (response) =>
        Effect.map(response.text, (body) => ({
          answered: { status: response.status, body },
          sent: body,
        })),
      ),
    ),
    guaranteed: failing.map(() => ({ status: 500, body: "" })),
  },
  {
    surface: "MCP",
    reporting: "each once",
    reports: { atLeast: failing.length, atMost: failing.length },
    logs: failing.length,
    answers: Effect.forEach(failing, ({ name }) =>
      Effect.flatMap(send(rawToolCall(name)), (response) =>
        Effect.flatMap(response.text, (text) =>
          Effect.map(toolReplyOf(text), (answered) => ({ answered, sent: text })),
        ),
      ),
    ),
    guaranteed: failing.map(() => ({ isError: true, text: internalToolError })),
  },
  {
    surface: "RPC",
    reporting: "each once, answering the connection's other call",
    reports: { atLeast: failing.length, atMost: failing.length },
    logs: failing.length,
    answers: Effect.map(
      sendRawNdjson(served.map(({ name }) => ({ tag: name, payload: {} }))),
      ({ text, exits }) =>
        exits.map((exit) => ({ answered: valueOrSquashedCause(exit), sent: text })),
    ),
    guaranteed: [...failing.map(() => new Error("Internal server error")), "up"],
  },
  {
    surface: "Toolkit",
    reporting: "nothing",
    reports: { atLeast: 0, atMost: 0 },
    logs: 0,
    answers: Effect.forEach(failing, toolkitCall),
    guaranteed: failing.map(({ name }) =>
      name === "crash" ? { died: ["the handler's defect"] } : "an AiError naming the tool",
    ),
  },
  {
    surface: "CLI",
    reporting: "nothing",
    reports: { atLeast: 0, atMost: 0 },
    logs: 0,
    answers: Effect.forEach(failing, command),
    guaranteed: failing.map(
      ({ name }) =>
        ({
          crash: { died: ["the handler's defect"] },
          leak: { printed: "Leaked" },
          count: { died: ["SchemaError"] },
          brittle: { printed: "Fragile" },
        })[name],
    ),
  },
] as const;

it.effect.each(surfaces)(
  "answers a defect, an undeclared failure, and a success or an error that does not encode as guarantees.md's table states, sending no cause, over $surface, logging and reporting $reporting",
  ({ answers, guaranteed, reports, logs }) =>
    Effect.gen(function* () {
      const reported: Array<string> = [];
      const logged: Array<string> = [];

      const calls = yield* answers.pipe(
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

      expect(calls.map(({ answered }) => answered)).toEqual(guaranteed);

      for (const { sent } of calls) expect(sent).not.toMatch(/hunter2|secret-id/);

      expect(reported.length).toBeGreaterThanOrEqual(reports.atLeast);
      expect(reported.length).toBeLessThanOrEqual(reports.atMost);
      expect(logged).toHaveLength(logs);
      expect(reported.some((report) => report.includes("hunter2"))).toBe(logs > 0);
      expect(logged.some((log) => log.includes("hunter2"))).toBe(logs > 0);
    }),
);
