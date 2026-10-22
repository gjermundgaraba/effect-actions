import { expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Console, Context, Effect, Exit, Option, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import { causeOf, exec, logged, printed } from "../support/cli-services.js";
import { serve } from "../support/serve.js";

const Remote = Action.make("remote", {
  description: "Doubles an encoded finite number",
  readOnly: false,
  caller: Action.Anyone,
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.FiniteFromString,
});

const Http = ActionHttp.make([Remote]);

const freshRecordingImplementation = () => {
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
    const { app, decoded } = freshRecordingImplementation();
    const web = serve(ActionHttp.layer(Http, app));

    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];

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
    expect(decoded).toEqual([21]);
    expect(output).toEqual(['"42"']);

    const Lookalike = Action.make("remote", {
      description: "Not the bound contract",
      readOnly: false,
      caller: Action.Anyone,
      input: Schema.Struct({ value: Schema.FiniteFromString }),
      success: Schema.FiniteFromString,
    });

    expect(() => ActionCli.remoteCommand(Http, Lookalike)).toThrow(
      `Action "remote" is not in this HTTP binding (pass it to the binding's ActionHttp.make, and select with the contract value it received)`,
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
        freshRecordingImplementation().app,
        Action.implement(Echo, ({ text }) => Effect.succeed(text)),
      ]),
    );

    const urls: string[] = [];

    const fetchLayer = Testing.layer((request) => {
      urls.push(request.url);

      return web.handler(request);
    });

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
    expect(urls).toEqual(["http://localhost/api/echoText", "http://localhost/api/remote"]);
  }),
);

it.effect("runs a command of its own beside the derived ones, on the same client", () =>
  Effect.gen(function* () {
    const { app, decoded } = freshRecordingImplementation();
    const web = serve(ActionHttp.layer(Http, app));

    const doubleEach = Command.make("double-each", {}, () =>
      Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        yield* Console.log(yield* Effect.forEach([1, 2], (value) => client.remote({ value })));
      }),
    );

    const command = ActionCli.remote(Http, { name: "cli", subcommands: [doubleEach] });

    const runLines = (args: ReadonlyArray<string>) =>
      logged(exec(command, args)).pipe(Effect.provide(Testing.layer(web.handler)));

    expect((yield* runLines(["remote", "--value", "3"]))[1]).toEqual(['"6"']);
    expect((yield* runLines(["double-each"]))[1]).toEqual([[2, 4]]);
    expect(decoded).toEqual([3, 1, 2]);
  }),
);

it.effect(
  "fails a command of its own as a derived one fails, through toUserError, and leaves its own message alone",
  () =>
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

      class Throttled extends Schema.TaggedError<Throttled>()(
        "Throttled",
        { retryAfter: Schema.Finite },
        { httpApiStatus: 429 },
      ) {}

      const BoundedHttp = ActionHttp.make([Bounded], { error: [Throttled] });

      const web = serve(
        ActionHttp.layer(
          BoundedHttp,
          Action.implement(Bounded, () => Effect.fail(new TooLarge({ limit: 10 }))),
        ),
      );

      const twice = Command.make("twice", {}, () =>
        Effect.gen(function* () {
          const client = yield* ActionHttp.client(BoundedHttp);

          yield* client.bounded({ value: 11 });
          yield* client.bounded({ value: 12 });
        }).pipe(ActionCli.toUserError(BoundedHttp)),
      );

      const worded = Command.make("worded", {}, () =>
        Effect.fail(
          new CliError.UserError({ cause: "no file", userMessage: "No such file." }),
        ).pipe(ActionCli.toUserError(BoundedHttp)),
      );

      const command = ActionCli.remote(BoundedHttp, { name: "cli", subcommands: [twice, worded] });

      const stderrOf = (
        args: ReadonlyArray<string>,
        answer: (request: Request) => Promise<Response> = web.handler,
      ) => exec(command, args).pipe(printed, Effect.provide(Testing.layer(answer)));

      const [derived, , derivedErr] = yield* stderrOf(["bounded", "--value", "11"]);
      const [own, , ownErr] = yield* stderrOf(["twice"]);

      expect(causeOf(own)).toEqual(new TooLarge({ limit: 10 }));
      expect(causeOf(own)).toEqual(causeOf(derived));
      expect(ownErr).toEqual(derivedErr);
      expect(ownErr).toEqual([expect.stringContaining('{"_tag":"TooLarge","limit":10}')]);

      const [, , wordedErr] = yield* stderrOf(["worded"]);

      expect(wordedErr).toEqual([expect.stringContaining("No such file.")]);
      expect(wordedErr).toEqual([expect.not.stringContaining("UserError")]);

      const throttling = async () =>
        Response.json(Schema.encodeSync(Throttled)(new Throttled({ retryAfter: 5 })), {
          status: 429,
        });

      const [, , throttledErr] = yield* stderrOf(["twice"], throttling);

      expect(throttledErr).toEqual([
        expect.stringContaining('{"_tag":"Throttled","retryAfter":5}'),
      ]);
      expect(throttledErr).toEqual((yield* stderrOf(["bounded", "--value", "11"], throttling))[2]);

      const offline = async () => {
        throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
      };

      const [refused, , refusedErr] = yield* stderrOf(["twice"], offline);

      expect(HttpClientError.isHttpClientError(causeOf(refused))).toBe(true);
      expect(refusedErr).toEqual((yield* stderrOf(["bounded", "--value", "11"], offline))[2]);
      expect(refusedErr).toEqual([
        expect.stringMatching(/HttpClientError: .*: Error: fetch failed/),
      ]);
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
  "prints a verifier's declared error as its JSON, from a derived command and through toUserError",
  () =>
    Effect.gen(function* () {
      class Caller extends Context.Service<Caller, { readonly id: string }>()(
        "cli-remote/Caller",
      ) {}

      class Unavailable extends Schema.TaggedError<Unavailable>()(
        "Unavailable",
        { retryAfter: Schema.Finite },
        { httpApiStatus: 503 },
      ) {}

      const Login = Authentication.make("cli-remote.Login", Caller, { error: Unavailable });

      const Secret = Action.make("secret", {
        description: "Reads what only a caller may",
        readOnly: true,
        caller: Caller,
      });

      const Guarded = ActionHttp.make([Secret], { authentication: Login });

      const own = Command.make("own", {}, () =>
        Effect.flatMap(ActionHttp.client(Guarded), (client) => client.secret()).pipe(
          ActionCli.toUserError(Guarded),
        ),
      );

      const command = ActionCli.remote(Guarded, { name: "cli", subcommands: [own] });

      const stderrOf = (args: ReadonlyArray<string>) =>
        exec(command, args).pipe(
          printed,
          Effect.provide(
            Testing.layer(async () =>
              Response.json(Schema.encodeSync(Unavailable)(new Unavailable({ retryAfter: 5 })), {
                status: 503,
              }),
            ),
          ),
        );

      const [derived, , derivedErr] = yield* stderrOf(["secret"]);

      expect(causeOf(derived)).toEqual(new Unavailable({ retryAfter: 5 }));
      expect(derivedErr).toEqual([
        expect.stringContaining('{"_tag":"Unavailable","retryAfter":5}'),
      ]);
      expect((yield* stderrOf(["own"]))[2]).toEqual(derivedErr);
    }),
);

it.effect(
  "prints through toUserError the errors an RPC binding and its authentication declare, as their JSON",
  () =>
    Effect.gen(function* () {
      class Caller extends Context.Service<Caller, { readonly id: string }>()(
        "cli-remote/RpcCaller",
      ) {}

      class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
        retryAfter: Schema.Finite,
      }) {}

      class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {
        retryAfter: Schema.Finite,
      }) {}

      const Login = Authentication.make("cli-remote.RpcLogin", Caller, { error: Unavailable });

      const Secret = Action.make("secret", {
        description: "Reads what only a caller may",
        readOnly: true,
        caller: Caller,
      });

      const Rpc = ActionRpc.make([Secret], { authentication: Login, error: [Throttled] });

      const cli = Command.make("cli").pipe(
        Command.withSubcommands([
          Command.make("throttled", {}, () =>
            Effect.fail(new Throttled({ retryAfter: 5 })).pipe(ActionCli.toUserError(Rpc)),
          ),
          Command.make("unavailable", {}, () =>
            Effect.fail(new Unavailable({ retryAfter: 9 })).pipe(ActionCli.toUserError(Rpc)),
          ),
          Command.make("by-actions", {}, () =>
            Effect.fail(new Throttled({ retryAfter: 5 })).pipe(ActionCli.toUserError(Rpc.actions)),
          ),
        ]),
      );

      const stderrOf = (name: string) => Effect.map(printed(exec(cli, [name])), ([, , err]) => err);

      expect(yield* stderrOf("throttled")).toEqual([
        expect.stringContaining('{"_tag":"Throttled","retryAfter":5}'),
      ]);
      expect(yield* stderrOf("unavailable")).toEqual([
        expect.stringContaining('{"_tag":"Unavailable","retryAfter":9}'),
      ]);
      expect(yield* stderrOf("by-actions")).toEqual([expect.not.stringContaining("retryAfter")]);
    }),
);

it.effect(
  "nests under a host's own tree, with a connection of its own that no other command's requests take, failing as a command when it cannot be read",
  () =>
    Effect.gen(function* () {
      const web = serve(ActionHttp.layer(Http, freshRecordingImplementation().app));
      const requests: Array<{ url: string; authorization: string | null }> = [];

      const fetchLayer = Testing.layer(async (request) => {
        requests.push({ url: request.url, authorization: request.headers.get("authorization") });

        return request.url.startsWith("https://auth.example.com/")
          ? Response.json({ code: "device" })
          : web.handler(request);
      });

      const api = ActionCli.remote(Http, {
        name: "api",
        client: Effect.gen(function* () {
          const baseUrl = yield* Config.String("ACME_URL");
          const token = yield* Config.Redacted("ACME_TOKEN");

          return yield* ActionHttp.client(Http, {
            baseUrl,
            transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
          });
        }),
      });

      const hostsOwnLogin = Command.make("login", {}, () =>
        Effect.asVoid(
          Effect.flatMap(HttpClient.HttpClient, (client) =>
            client.get("https://auth.example.com/device/code"),
          ),
        ),
      );

      const cli = Command.make("acme").pipe(Command.withSubcommands([api, hostsOwnLogin]));

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

      yield* runWith({}, ["api", "--help"]);
      yield* runWith({}, ["api", "remote", "--help"]);
      expect(requests).toHaveLength(2);

      const [unset, , stderr] = yield* printed(exec(cli, ["api", "remote", "--value", "21"])).pipe(
        Effect.provide(fetchLayer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
      );

      expect(causeOf(unset)).toHaveProperty("_tag", "ConfigError");
      expect(stderr).toEqual([expect.stringContaining("ConfigError: ")]);
      expect(requests).toHaveLength(2);
    }),
);

it.effect("connects through its client, which no other command's requests take", () =>
  Effect.gen(function* () {
    const web = serve(ActionHttp.layer(Http, freshRecordingImplementation().app));
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const fetchLayer = Testing.layer(async (request) => {
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });

      return request.url.startsWith("https://auth.example.com/")
        ? Response.json({ code: "device" })
        : web.handler(request);
    });

    const client = ActionHttp.client(Http, {
      baseUrl: "http://api.example.com",
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("secret")),
    });

    const hostsOwnLogin = Command.make("login", {}, () =>
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
        hostsOwnLogin,
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

it.effect(
  "fails with what its client's methods fail with, named on stderr, and reads nothing for help",
  () =>
    Effect.gen(function* () {
      class SignInRequired extends Schema.TaggedError<SignInRequired>()("SignInRequired", {
        message: Schema.String,
      }) {}

      class SignIn extends Context.Service<SignIn, { readonly token: Option.Option<string> }>()(
        "cli-remote/SignIn",
      ) {}

      const web = serve(ActionHttp.layer(Http, freshRecordingImplementation().app));
      const authorizations: Array<string | null> = [];
      let reads = 0;

      const fetchLayer = Testing.layer((request) => {
        authorizations.push(request.headers.get("authorization"));

        return web.handler(request);
      });

      const client = ActionHttp.client(Http, {
        transformClient: (http) =>
          HttpClient.mapRequestEffect(http, (request) =>
            Effect.flatMap(SignIn, ({ token }) => {
              reads++;

              return Option.match(token, {
                onNone: () => Effect.fail(new SignInRequired({ message: "Run `acme login`" })),
                onSome: (bearer) => Effect.succeed(HttpClientRequest.bearerToken(request, bearer)),
              });
            }),
          ),
      });

      const cli = ActionCli.remote(Http, { name: "acme", client });

      const run = (token: Option.Option<string>, args: ReadonlyArray<string>) =>
        printed(exec(cli, args)).pipe(
          Effect.provide(fetchLayer),
          Effect.provideService(SignIn, { token }),
        );

      const [signedOut, , stderr] = yield* run(Option.none(), ["remote", "--value", "21"]);

      expect(causeOf(signedOut)).toStrictEqual(new SignInRequired({ message: "Run `acme login`" }));
      expect(stderr).toEqual([expect.stringContaining("SignInRequired: Run `acme login`")]);
      expect(authorizations).toEqual([]);

      const [, output] = yield* run(Option.some("secret"), ["remote", "--value", "21"]);

      expect(output).toEqual(['"42"']);
      expect(authorizations).toEqual(["Bearer secret"]);

      yield* run(Option.none(), ["remote", "--help"]);
      expect(reads).toBe(2);
    }),
);

it.effect(
  "prints a CliError.UserError its client fails with as it is, in derived commands and its own alike",
  () =>
    Effect.gen(function* () {
      const signIn = new CliError.UserError({ cause: "no session", userMessage: "Sign in first" });
      const api = Effect.andThen(Effect.fail(signIn), ActionHttp.client(Http));

      const own = Command.make("own", {}, () =>
        Effect.asVoid(api).pipe(ActionCli.toUserError(Http)),
      );

      const cli = ActionCli.remote(Http, { name: "acme", client: api, subcommands: [own] });

      const web = serve(ActionHttp.layer(Http, freshRecordingImplementation().app));

      const run = (args: ReadonlyArray<string>) =>
        printed(exec(cli, args)).pipe(Effect.provide(Testing.layer(web.handler)));

      const [derivedExit, , derived] = yield* run(["remote", "--value", "1"]);
      const [ownExit, , owned] = yield* run(["own"]);

      expect(Exit.findErrorOption(derivedExit)).toStrictEqual(Option.some(signIn));
      expect(Exit.findErrorOption(ownExit)).toStrictEqual(Option.some(signIn));
      expect(derived).toEqual([expect.stringContaining("Sign in first")]);
      expect(derived.join("\n")).not.toContain("no session");
      expect(owned).toEqual(derived);
    }),
);

it.effect("sends a field read from stdin as its flag would send it", () =>
  Effect.gen(function* () {
    const { app, decoded } = freshRecordingImplementation();
    const web = serve(ActionHttp.layer(Http, app));
    const command = ActionCli.remoteCommand(Http, Remote, { stdin: "value" });

    const [, output] = yield* logged(exec(command, [], { stdin: "21\n" })).pipe(
      Effect.provide(Testing.layer(web.handler)),
    );

    const aggregate = ActionCli.remote(Http, {
      name: "cli",
      commands: { remote: { stdin: "value" } },
    });

    yield* exec(aggregate, ["remote"], { stdin: "4" }).pipe(
      Effect.provide(Testing.layer(web.handler)),
    );

    expect(decoded).toEqual([21, 4]);
    expect(output).toEqual(['"42"']);
  }),
);

it.effect("calls through a client holding only the methods of the actions it derives", () =>
  Effect.gen(function* () {
    const Echo = Action.make("echo", {
      description: "Echoes its input",
      readOnly: true,
      caller: Action.Anyone,
      input: Schema.Struct({ value: Schema.String }),
      success: Schema.String,
    });

    const Both = ActionHttp.make([Remote, Echo]);

    const app = Action.implement([Remote, Echo], {
      remote: ({ value }) => Effect.succeed(value * 2),
      echo: ({ value }) => Effect.succeed(value),
    });

    const remoteOnly = Effect.map(ActionHttp.client(Both), ({ remote }) => ({ remote }));
    const group = ActionCli.remote(Both, { name: "api", actions: [Remote], client: remoteOnly });
    const single = ActionCli.remoteCommand(Both, Remote, { client: remoteOnly });

    const run = <Name extends string, Input, E>(
      command: Command.Command<Name, Input, {}, E, HttpClient.HttpClient>,
      args: ReadonlyArray<string>,
    ) =>
      Effect.map(logged(exec(command, args)), ([, logs]) => logs).pipe(
        Effect.provide(Testing.layer(ActionHttp.layer(Both, app))),
      );

    expect(yield* run(group, ["remote", "--value", "21"])).toEqual(['"42"']);
    expect(yield* run(single, ["--value", "4"])).toEqual(['"8"']);
  }),
);

it.effect("describes a remote command as its options say", () =>
  Effect.gen(function* () {
    const description = "Double a number on the server";
    const command = ActionCli.remoteCommand(Http, Remote, { description });

    const [, logs] = yield* logged(exec(command, ["--help"])).pipe(
      Effect.provide(Testing.layer(ActionHttp.layer(Http, freshRecordingImplementation().app))),
    );

    const help = logs.join("\n");

    expect(help).toContain(description);
    expect(help).not.toContain("Doubles an encoded finite number");
  }),
);
