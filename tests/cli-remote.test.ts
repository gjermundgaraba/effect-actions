import { expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, flow, Schema } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import { causeOf, exec, logged, printed } from "./cli-services.js";
import { serve } from "./serve.js";

const Remote = Action.make("remote", {
  description: "Doubles an encoded finite number",
  readOnly: false,
  caller: Action.Anyone,
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.FiniteFromString,
});

// `POST /api/remote`, one subcommand per action.
const Http = ActionHttp.make([Remote]);

/** An implementation of `Remote`, and the inputs its handler decoded: fresh for each test. */
const recording = () => {
  const decoded: number[] = [];

  const app = Action.implement([Remote], {
    remote: ({ value }) =>
      Effect.andThen(
        Effect.sync(() => decoded.push(value)),
        () => Effect.succeed(value * 2),
      ),
  });

  return { app, decoded };
};

it.effect("projects commands through the HTTP client", () =>
  Effect.gen(function* () {
    const { app, decoded } = recording();
    const web = serve(ActionHttp.layer(Http, app));

    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];

    // The host configures its client: every remote command calls through it.
    const command = ActionCli.remote(Http, { name: "cli" });

    const host = Effect.updateService(
      HttpClient.HttpClient,
      HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "Bearer host")),
    );

    const fetchLayer = Testing.layer(async (request) => {
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.clone().json(),
      });

      return web.handler(request);
    });

    const [, output] = yield* logged(exec(command, ["remote", "--value", "21"])).pipe(
      host,
      Effect.provide(fetchLayer),
    );

    expect(requests).toEqual([
      {
        url: "http://localhost/api/remote",
        authorization: "Bearer host",
        body: { value: "21" },
      },
    ]);
    // The handler sees the decoded number exactly once; CLI and HTTP emit canonical JSON.
    expect(decoded).toEqual([21]);
    expect(output).toEqual(['"42"']);

    // The binding is selected by contract identity: an equal-looking action is not one of it.
    const Lookalike = Action.make("remote", {
      description: "Not the bound contract",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.FiniteFromString,
    });

    expect(() => ActionCli.remoteCommand(Http, Lookalike)).toThrow(
      'Action "remote" is not in this HTTP binding',
    );
  }),
);

it.effect("projects a binding as one kebab-case subcommand per action", () =>
  Effect.gen(function* () {
    const Echo = Action.make("echoText", {
      description: "Echoes its input",
      readOnly: true,
      caller: Action.Anyone,
      input: { text: Schema.String },
      success: Schema.String,
    });

    const Flat = ActionHttp.make([Remote, Echo]);

    const web = serve(
      ActionHttp.layer(Flat, [
        recording().app,
        Action.implement(Echo, ({ text }) => Effect.succeed(text)),
      ]),
    );

    const urls: string[] = [];

    const fetchLayer = Testing.layer((request) => {
      urls.push(request.url);

      return web.handler(request);
    });

    // A subcommand takes the options `command` takes, positional arguments over HTTP included.
    const command = ActionCli.remote(Flat, {
      name: "cli",
      commands: { remote: { positional: ["value"] } },
    });

    const runLines = (args: ReadonlyArray<string>) =>
      logged(exec(command, args)).pipe(Effect.provide(fetchLayer));

    const [, echoed] = yield* runLines(["echo-text", "--text", "hi"]);
    const [, doubled] = yield* runLines(["remote", "2"]);

    expect(echoed).toEqual(['"hi"']);
    expect(doubled).toEqual(['"4"']);
    // The subcommand is kebab case; the route keeps the action's name.
    expect(urls).toEqual(["http://localhost/api/echoText", "http://localhost/api/remote"]);
  }),
);

it.effect("refuses input that does not decode locally, sending no request", () =>
  Effect.gen(function* () {
    let requests = 0;

    const invalid = yield* exec(ActionCli.remoteCommand(Http, Remote), ["--value", "x"]).pipe(
      Effect.provide(
        Testing.layer(async () => {
          requests++;
          throw new Error("offline");
        }),
      ),
      Effect.exit,
    );

    expect(causeOf(invalid)).toBeInstanceOf(Action.InvalidInput);
    expect(requests).toBe(0);
  }),
);

it.effect("fails with an error its action declares, as the client decodes it", () =>
  Effect.gen(function* () {
    class TooLarge extends Schema.TaggedError<TooLarge>()(
      "TooLarge",
      { limit: Schema.Finite },
      { httpApiStatus: 413 },
    ) {}

    const Bounded = Action.make("bounded", {
      description: "Refuses a value over its limit",
      readOnly: true,
      caller: Action.Anyone,
      input: { value: Schema.Finite },
      error: [TooLarge],
    });

    const BoundedHttp = ActionHttp.make([Bounded]);

    const web = serve(
      ActionHttp.layer(
        BoundedHttp,
        Action.implement(Bounded, () => Effect.fail(new TooLarge({ limit: 10 }))),
      ),
    );

    const [exit, , stderr] = yield* exec(ActionCli.remoteCommand(BoundedHttp, Bounded), [
      "--value",
      "11",
    ]).pipe(printed, Effect.provide(Testing.layer(web.handler)));

    expect(causeOf(exit)).toEqual(new TooLarge({ limit: 10 }));
    expect(stderr).toEqual([expect.stringContaining('{"_tag":"TooLarge","limit":10}')]);
  }),
);

it.effect(
  "prints a binding's error as its JSON, and a transport failure with the causes beneath it",
  () =>
    Effect.gen(function* () {
      class Throttled extends Schema.TaggedError<Throttled>()(
        "Throttled",
        { retryAfter: Schema.Finite },
        { httpApiStatus: 429 },
      ) {}

      const Throttling = ActionHttp.make([Remote], { error: [Throttled] });
      const command = ActionCli.remoteCommand(Throttling, Remote);

      const stderrOf = (answer: (request: Request) => Promise<Response>) =>
        exec(command, ["--value", "21"]).pipe(printed, Effect.provide(Testing.layer(answer)));

      // The binding's error, as a server answers it, which the client decodes from its status.
      const [throttled, , throttledErr] = yield* stderrOf(async () =>
        Response.json(Schema.encodeSync(Throttled)(new Throttled({ retryAfter: 5 })), {
          status: 429,
        }),
      );

      expect(causeOf(throttled)).toEqual(new Throttled({ retryAfter: 5 }));
      expect(throttledErr).toEqual([
        expect.stringContaining('{"_tag":"Throttled","retryAfter":5}'),
      ]);

      let attempts = 0;

      // No schema encodes a transport failure: it is described, down to its root cause, and the
      // request is not retried.
      const [refused, , refusedErr] = yield* stderrOf(async () => {
        attempts++;
        throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
      });

      expect(HttpClientError.isHttpClientError(causeOf(refused))).toBe(true);
      expect(attempts).toBe(1);
      expect(refusedErr).toEqual([
        expect.stringMatching(
          /HttpClientError: .*POST http:\/\/localhost\/api\/remote.*: Error: fetch failed: Error: connect ECONNREFUSED 127\.0\.0\.1:1/,
        ),
      ]);
    }),
);

it.effect(
  "nests under a host's own tree, with a connection of its own that no other command's requests take",
  () =>
    Effect.gen(function* () {
      const web = serve(ActionHttp.layer(Http, recording().app));
      const requests: Array<{ url: string; authorization: string | null }> = [];

      const fetchLayer = Testing.layer(async (request) => {
        requests.push({ url: request.url, authorization: request.headers.get("authorization") });

        return request.url.startsWith("https://auth.example.com/")
          ? Response.json({ code: "device" })
          : web.handler(request);
      });

      // The remote commands' URL and token, read when one of them runs.
      const api = ActionCli.remote(Http, { name: "api" }).pipe(
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
        logged(exec(cli, args)).pipe(
          Effect.provide(fetchLayer),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
        );

      const env = { ACME_URL: "http://api.example.com", ACME_TOKEN: "secret" };

      const [, output] = yield* runWith(env, ["api", "remote", "--value", "21"]);
      yield* runWith(env, ["login"]);

      expect(output).toEqual(['"42"']);
      expect(requests).toEqual([
        { url: "http://api.example.com/api/remote", authorization: "Bearer secret" },
        { url: "https://auth.example.com/device/code", authorization: null },
      ]);

      // Help reads no configuration and sends nothing.
      yield* runWith({}, ["api", "--help"]);
      yield* runWith({}, ["api", "remote", "--help"]);
      expect(requests).toHaveLength(2);
    }),
);

it.effect("connects through its client options, which no other command's requests take", () =>
  Effect.gen(function* () {
    const web = serve(ActionHttp.layer(Http, recording().app));
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const fetchLayer = Testing.layer(async (request) => {
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });

      return request.url.startsWith("https://auth.example.com/")
        ? Response.json({ code: "device" })
        : web.handler(request);
    });

    const client = {
      baseUrl: "http://api.example.com",
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("secret")),
    };

    const login = Command.make("login", {}, () =>
      Effect.asVoid(
        Effect.flatMap(HttpClient.HttpClient, (http) =>
          http.get("https://auth.example.com/device/code"),
        ),
      ),
    );

    const cli = Command.make("acme").pipe(
      Command.withSubcommands([
        ActionCli.remote(Http, { name: "api", client }),
        ActionCli.remoteCommand(Http, Remote, { name: "double", client }),
        login,
      ]),
    );

    const run = (args: ReadonlyArray<string>) =>
      logged(exec(cli, args)).pipe(Effect.provide(fetchLayer));

    const [, aggregated] = yield* run(["api", "remote", "--value", "21"]);
    const [, selected] = yield* run(["double", "--value", "4"]);
    yield* run(["login"]);

    expect([aggregated, selected]).toEqual([['"42"'], ['"8"']]);
    expect(requests).toEqual([
      { url: "http://api.example.com/api/remote", authorization: "Bearer secret" },
      { url: "http://api.example.com/api/remote", authorization: "Bearer secret" },
      { url: "https://auth.example.com/device/code", authorization: null },
    ]);
  }),
);
