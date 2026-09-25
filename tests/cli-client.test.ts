import { expect, it, onTestFinished } from "vite-plus/test";
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionCliClient from "../src/ActionCliClient.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { cliServices, logged } from "./cli-services.js";

class Domain extends Schema.TaggedError<Domain>()(
  "Domain",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

class Policy extends Schema.TaggedError<Policy>()(
  "Policy",
  { kind: Schema.String },
  { httpApiStatus: 500 },
) {}

const Remote = Action.make("remote", {
  description: "Doubles an encoded finite number",
  access: "write",
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.FiniteFromString,
  errors: [Domain],
});

const schemaError = {
  invalid: {
    schema: Policy,
    make: (failure: { readonly kind: string }) => new Policy({ kind: failure.kind }),
  },
  internal: {
    schema: Policy,
    make: (failure: { readonly kind: string }) => new Policy({ kind: failure.kind }),
  },
};

// `POST /api/remote`, one subcommand per action.
const Http = ActionHttp.make([Remote], { schemaError });

const decodedInputs: number[] = [];

const app = Action.implement([Remote], {
  remote: ({ value }) =>
    Effect.andThen(
      Effect.sync(() => decodedInputs.push(value)),
      () =>
        value === 0
          ? Effect.fail(new Domain({ message: "zero" }))
          : Effect.succeed(value === 13 ? Infinity : value * 2),
    ),
});

it("projects commands through the HTTP client without a local fallback", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer(app).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  decodedInputs.length = 0;

  const command = ActionCliClient.make(Http, {
    name: "cli",
    connection: {
      baseUrl: "http://localhost",
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer host")),
        ),
    },
  });

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().json(),
        });

        return web.handler(request, Context.empty());
      }),
    ),
  );

  const [, output] = await logged(
    Command.runWith(command, { version: "0" })(["remote", "--input", '{"value":"21"}']),
  ).pipe(Effect.provide(fetchLayer), Effect.provide(cliServices), Effect.runPromise);

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

  expect(() => ActionCliClient.command(Http, Lookalike)).toThrow(
    'Action "remote" is not in this HTTP binding',
  );
});

it("projects a flat binding as one subcommand per action", async () => {
  const Echo = Action.make("echo", {
    description: "Echoes its input",
    access: "read",
    input: { value: Schema.String },
    success: Schema.String,
  });

  const Flat = ActionHttp.make([Remote, Echo]);

  const web = HttpRouter.toWebHandler(
    Flat.layer([...app, ...Action.implement(Echo, ({ value }) => Effect.succeed(value))]).pipe(
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  const urls: string[] = [];

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
        const request = new Request(input, init);
        urls.push(request.url);

        return web.handler(request, Context.empty());
      }),
    ),
  );

  const command = ActionCliClient.make(Flat, {
    name: "cli",
    connection: { baseUrl: "http://localhost" },
  });

  const runLines = (args: ReadonlyArray<string>) =>
    logged(Command.runWith(command, { version: "0" })(args)).pipe(
      Effect.provide(fetchLayer),
      Effect.provide(cliServices),
      Effect.runPromise,
    );

  const [, echoed] = await runLines(["echo", "--input", '{"value":"hi"}']);
  const [, doubled] = await runLines(["remote", "--input", '{"value":"2"}']);

  expect(echoed).toEqual(['"hi"']);
  expect(doubled).toEqual(['"4"']);
  expect(urls).toEqual(["http://localhost/api/echo", "http://localhost/api/remote"]);
});

it("connection options cannot select another action", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer(app).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());
  decodedInputs.length = 0;

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
        web.handler(new Request(input, init), Context.empty()),
      ),
    ),
  );

  // Structurally assignable, since the host's object is not a literal here.
  const connection = { baseUrl: "http://localhost", group: "other", endpoint: "missing" };
  const command = ActionCliClient.command(Http, Remote, { connection });

  const [, output] = await logged(
    Command.runWith(command, { version: "0" })(["--input", '{"value":"21"}']),
  ).pipe(Effect.provide(fetchLayer), Effect.provide(cliServices), Effect.runPromise);

  expect(decodedInputs).toEqual([21]);
  expect(output).toEqual(['"42"']);
});

it("names the same subcommands as a local aggregate for the same actions", () => {
  const Echo = Action.make("echo", {
    description: "Echoes its input",
    access: "read",
    input: { value: Schema.String },
    success: Schema.String,
  });

  const names = (command: {
    readonly subcommands: ReadonlyArray<{
      readonly commands: ReadonlyArray<{ readonly name: string }>;
    }>;
  }) => command.subcommands.flatMap(({ commands }) => commands.map(({ name }) => name));

  const local = ActionCli.make(
    [...app, ...Action.implement(Echo, ({ value }) => Effect.succeed(value))],
    { name: "cli" },
  );

  const remote = ActionCliClient.make(ActionHttp.make([Remote, Echo]), { name: "cli" });

  expect(names(remote)).toEqual(["remote", "echo"]);
  expect(names(local)).toEqual(names(remote));
});

it("propagates domain and native schema-policy failures through Command.runWith", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer(app).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
        web.handler(
          new Request(
            `http://localhost${new URL(input instanceof Request ? input.url : input).pathname}`,
            init,
          ),
          Context.empty(),
        ),
      ),
    ),
  );

  const command = ActionCliClient.command(Http, Remote, {
    parameters: { value: Argument.String("value") },
    input: ({ value }) => ({ value }),
    connection: { baseUrl: "http://localhost" },
  });

  const run = (value: string) =>
    Command.runWith(command, { version: "0" })([value]).pipe(
      Effect.provide(fetchLayer),
      Effect.provide(cliServices),
      Effect.runPromiseExit,
    );

  const domain = await run("0");
  expect(Exit.isFailure(domain)).toBe(true);

  if (Exit.isFailure(domain)) {
    const reason = domain.cause.reasons.at(0);

    if (reason === undefined) throw new Error("Expected a domain failure reason");
    expect(Cause.isFailReason(reason)).toBe(true);

    if (Cause.isFailReason(reason)) expect(reason.error).toEqual(new Domain({ message: "zero" }));
  }

  const policy = await run("13");
  expect(Exit.isFailure(policy)).toBe(true);

  if (Exit.isFailure(policy)) {
    const reason = policy.cause.reasons.at(0);

    if (reason === undefined) throw new Error("Expected a policy failure reason");
    expect(Cause.isFailReason(reason)).toBe(true);

    if (Cause.isFailReason(reason)) expect(reason.error).toEqual(new Policy({ kind: "Body" }));
  }

  let transportAttempts = 0;

  const unavailableLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, async () => {
        transportAttempts++;
        throw new Error("offline");
      }),
    ),
  );

  const unavailable = await Command.runWith(command, { version: "0" })(["21"]).pipe(
    Effect.provide(unavailableLayer),
    Effect.provide(cliServices),
    Effect.runPromiseExit,
  );

  expect(Exit.isFailure(unavailable)).toBe(true);

  if (Exit.isFailure(unavailable)) {
    const reason = unavailable.cause.reasons.at(0);

    if (reason === undefined) throw new Error("Expected a client transport failure");
    expect(Cause.isFailReason(reason)).toBe(true);

    if (Cause.isFailReason(reason))
      expect(HttpClientError.isHttpClientError(reason.error)).toBe(true);
  }

  expect(transportAttempts).toBe(1);
});
