import { expect, it } from "vite-plus/test";
import { Effect, Exit, Option, Schema } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { cliServices, logged } from "./cli-services.js";
import { clientLayer, serve } from "./serve.js";

class Domain extends Schema.TaggedError<Domain>()(
  "Domain",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

const Remote = Action.make("remote", {
  description: "Doubles an encoded finite number",
  access: "write",
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.FiniteFromString,
  errors: [Domain],
});

// `POST /api/remote`, one subcommand per action.
const Http = ActionHttp.make([Remote]);

const decodedInputs: number[] = [];

const remote = ({ value }: { readonly value: number }) =>
  Effect.andThen(
    Effect.sync(() => decodedInputs.push(value)),
    () => (value === 0 ? Effect.fail(new Domain({ message: "zero" })) : Effect.succeed(value * 2)),
  );

const app = Action.implement([Remote], { remote }, Action.allowAll);

it("projects commands through the HTTP client without a local fallback", async () => {
  const web = serve(ActionHttp.layer(Http, app));

  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  decodedInputs.length = 0;

  // The host configures its client: every remote command calls through it.
  const command = ActionCli.make(Http, { name: "cli" });

  const host = Effect.updateService(
    HttpClient.HttpClient,
    HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer host")),
  );

  const fetchLayer = clientLayer(async (request) => {
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: await request.clone().json(),
    });

    return web.handler(request);
  });

  const [, output] = await logged(
    Command.runWith(command, { version: "0" })(["remote", "--value", "21"]),
  ).pipe(host, Effect.provide(fetchLayer), Effect.provide(cliServices), Effect.runPromise);

  expect(requests).toEqual([
    {
      url: "http://localhost/api/remote",
      authorization: "Bearer host",
      body: { value: "21" },
    },
  ]);
  // The handler sees the decoded number exactly once; CLI and HTTP emit canonical JSON.
  expect(decodedInputs).toEqual([21]);
  expect(output).toEqual(['"42"']);

  // The binding is selected by contract identity: an equal-looking action is not one of it.
  const Lookalike = Action.make("remote", {
    description: "Not the bound contract",
    access: "write",
    input: Schema.Struct({ value: Schema.FiniteFromString }),
    success: Schema.FiniteFromString,
    errors: [Domain],
  });

  expect(() => ActionCli.command(Http, Lookalike)).toThrow(
    'Action "remote" is not in this HTTP binding',
  );
});

it("takes positional arguments over HTTP as locally", async () => {
  const web = serve(ActionHttp.layer(Http, app));

  const command = ActionCli.command(Http, Remote, { positional: ["value"] });

  const [, output] = await logged(Command.runWith(command, { version: "0" })(["21"])).pipe(
    Effect.provide(clientLayer(web.handler)),
    Effect.provide(cliServices),
    Effect.runPromise,
  );

  expect(output).toEqual(['"42"']);
});

it("projects a flat binding as one kebab-case subcommand per action", async () => {
  const Echo = Action.make("echoText", {
    description: "Echoes its input",
    access: "read",
    input: { text: Schema.String },
    success: Schema.String,
  });

  const Flat = ActionHttp.make([Remote, Echo]);

  const web = serve(
    ActionHttp.layer(Flat, [
      app,
      Action.implement(Echo, ({ text }) => Effect.succeed(text), Action.allowAll),
    ]),
  );

  const urls: string[] = [];

  const fetchLayer = clientLayer((request) => {
    urls.push(request.url);

    return web.handler(request);
  });

  const command = ActionCli.make(Flat, { name: "cli" });

  const runLines = (args: ReadonlyArray<string>) =>
    logged(Command.runWith(command, { version: "0" })(args)).pipe(
      Effect.provide(fetchLayer),
      Effect.provide(cliServices),
      Effect.runPromise,
    );

  const [, echoed] = await runLines(["echo-text", "--text", "hi"]);
  const [, doubled] = await runLines(["remote", "--value", "2"]);

  expect(echoed).toEqual(['"hi"']);
  expect(doubled).toEqual(['"4"']);
  // The subcommand is kebab case; the route keeps the action's name.
  expect(urls).toEqual(["http://localhost/api/echoText", "http://localhost/api/remote"]);
});

it("names the same subcommands as a local aggregate for the same actions", () => {
  const Echo = Action.make("echoText", {
    description: "Echoes its input",
    access: "read",
    input: { text: Schema.String },
    success: Schema.String,
  });

  const names = (command: {
    readonly subcommands: ReadonlyArray<{
      readonly commands: ReadonlyArray<{ readonly name: string }>;
    }>;
  }) => command.subcommands.flatMap(({ commands }) => commands.map(({ name }) => name));

  const local = ActionCli.make(
    [app, Action.implement(Echo, ({ text }) => Effect.succeed(text), Action.allowAll)],
    {
      name: "cli",
    },
  );

  const remote = ActionCli.make(ActionHttp.make([Remote, Echo]), { name: "cli" });

  expect(names(remote)).toEqual(["remote", "echo-text"]);
  expect(names(local)).toEqual(names(remote));
});

/** The typed failure of a run that must fail. */
const failed = <A, E>(exit: Exit.Exit<A, E>): E =>
  Option.getOrThrowWith(
    Exit.findErrorOption(exit),
    () => new Error(`Expected a typed failure: ${String(exit)}`),
  );

it("propagates domain, refusal and transport failures as typed failures", async () => {
  const refusing = serve(
    ActionHttp.layer(
      Http,
      Action.implement([Remote], { remote }, () =>
        Effect.fail(new Action.Forbidden({ message: "Requires users:write." })),
      ),
    ),
  );

  const open = serve(ActionHttp.layer(Http, app));

  const command = ActionCli.command(Http, Remote);

  const run = (server: typeof refusing, value: string) =>
    Command.runWith(command, { version: "0" })(["--value", value]).pipe(
      Effect.provide(clientLayer(server)),
      Effect.provide(cliServices),
      Effect.runPromiseExit,
    );

  decodedInputs.length = 0;

  expect(failed(await run(open, "0"))).toEqual(new Domain({ message: "zero" }));

  // The server's hook refuses; the client decodes its refusal as a typed failure.
  expect(failed(await run(refusing, "21"))).toEqual(
    new Action.Forbidden({ message: "Requires users:write." }),
  );

  // Refused, the handler never ran.
  expect(decodedInputs).toEqual([0]);

  let transportAttempts = 0;

  const unavailableLayer = clientLayer(async () => {
    transportAttempts++;
    throw new Error("offline");
  });

  const unavailable = await Command.runWith(command, { version: "0" })(["--value", "21"]).pipe(
    Effect.provide(unavailableLayer),
    Effect.provide(cliServices),
    Effect.runPromiseExit,
  );

  expect(HttpClientError.isHttpClientError(failed(unavailable))).toBe(true);
  expect(transportAttempts).toBe(1);

  // Input that does not decode is refused locally, before any request.
  const invalid = await Command.runWith(command, { version: "0" })(["--value", "x"]).pipe(
    Effect.provide(unavailableLayer),
    Effect.provide(cliServices),
    Effect.runPromiseExit,
  );

  expect(failed(invalid)).toBeInstanceOf(Schema.SchemaError);
  expect(transportAttempts).toBe(1);
});
