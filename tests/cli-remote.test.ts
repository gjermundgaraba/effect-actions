import { expect, it } from "vite-plus/test";
import { Config, ConfigProvider, Effect, flow, Schema } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { causeOf, cliServices, logged, printed } from "./cli-services.js";
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

it("fails with the domain error, refusal or transport failure it received, beneath Effect CLI's UserError", async () => {
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

  expect(causeOf(await run(open, "0"))).toEqual(new Domain({ message: "zero" }));

  // The server's hook refuses; the client decodes its refusal as a typed failure.
  expect(causeOf(await run(refusing, "21"))).toEqual(
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

  expect(HttpClientError.isHttpClientError(causeOf(unavailable))).toBe(true);
  expect(transportAttempts).toBe(1);

  // Input that does not decode is refused locally, before any request.
  const invalid = await Command.runWith(command, { version: "0" })(["--value", "x"]).pipe(
    Effect.provide(unavailableLayer),
    Effect.provide(cliServices),
    Effect.runPromiseExit,
  );

  expect(causeOf(invalid)).toBeInstanceOf(Action.InvalidInput);
  expect(transportAttempts).toBe(1);
});

it("prints a binding's error as its JSON, and a transport failure with the causes beneath it", async () => {
  class Throttled extends Schema.TaggedError<Throttled>()(
    "Throttled",
    { retryAfter: Schema.Finite },
    { httpApiStatus: 429 },
  ) {}

  const Throttling = ActionHttp.make([Remote], { errors: [Throttled] });
  const command = ActionCli.command(Throttling, Remote);

  const stderrOf = (answer: (request: Request) => Promise<Response>) =>
    Command.runWith(command, { version: "0" })(["--value", "21"]).pipe(
      printed,
      Effect.provide(clientLayer(answer)),
      Effect.provide(cliServices),
      Effect.runPromise,
    );

  // The binding's error, as a server answers it, which the client decodes from its status.
  const [throttled, , throttledErr] = await stderrOf(async () =>
    Response.json(Schema.encodeSync(Throttled)(new Throttled({ retryAfter: 5 })), {
      status: 429,
    }),
  );

  expect(causeOf(throttled)).toEqual(new Throttled({ retryAfter: 5 }));
  expect(throttledErr).toEqual([expect.stringContaining('{"_tag":"Throttled","retryAfter":5}')]);

  // No schema encodes a transport failure: it is described, down to its root cause.
  const [refused, , refusedErr] = await stderrOf(async () => {
    throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
  });

  expect(HttpClientError.isHttpClientError(causeOf(refused))).toBe(true);
  expect(refusedErr).toEqual([
    expect.stringMatching(
      /HttpClientError: .*POST http:\/\/localhost\/api\/remote.*: Error: fetch failed: Error: connect ECONNREFUSED 127\.0\.0\.1:1/,
    ),
  ]);
});

it("nests under a host's own tree, with a connection of its own that no other command's requests take", async () => {
  const web = serve(ActionHttp.layer(Http, app));
  const requests: Array<{ url: string; authorization: string | null }> = [];

  const fetchLayer = clientLayer(async (request) => {
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });

    return request.url.startsWith("https://auth.example.com/")
      ? Response.json({ code: "device" })
      : web.handler(request);
  });

  // The remote commands' URL and token, read when one of them runs.
  const api = ActionCli.make(Http, { name: "api" }).pipe(
    Command.provideEffect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const url = yield* Config.String("ACME_URL");
        const token = yield* Config.Redacted("ACME_TOKEN");

        return HttpClient.mapRequest(
          yield* HttpClient.HttpClient,
          flow(HttpClientRequest.prependUrl(url), HttpClientRequest.bearerToken(token)),
        );
      }),
    ),
  );

  // A command of the host's own, calling another service through the host's plain client.
  const login = Command.make("login", {}, () =>
    Effect.asVoid(
      Effect.flatMap(HttpClient.HttpClient, (client) =>
        client.get("https://auth.example.com/device/code"),
      ),
    ),
  );

  const cli = Command.make("acme").pipe(Command.withSubcommands([api, login]));

  const runWith = (env: Record<string, string>, args: ReadonlyArray<string>) =>
    logged(Command.runWith(cli, { version: "0" })(args)).pipe(
      Effect.provide(fetchLayer),
      Effect.provide(cliServices),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      Effect.runPromise,
    );

  const env = { ACME_URL: "http://api.example.com", ACME_TOKEN: "secret" };

  const [, output] = await runWith(env, ["api", "remote", "--value", "21"]);
  await runWith(env, ["login"]);

  expect(output).toEqual(['"42"']);
  expect(requests).toEqual([
    { url: "http://api.example.com/api/remote", authorization: "Bearer secret" },
    { url: "https://auth.example.com/device/code", authorization: null },
  ]);

  // Help reads no configuration and sends nothing.
  await runWith({}, ["api", "--help"]);
  await runWith({}, ["api", "remote", "--help"]);
  expect(requests).toHaveLength(2);
});
