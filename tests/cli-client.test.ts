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
import type { HttpApiError } from "effect/unstable/httpapi";
import * as Action from "../src/Action.js";
import * as ActionCliClient from "../src/ActionCliClient.js";
import * as ActionGroup from "../src/ActionGroup.js";
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

const Hidden = Action.make("hidden", {
  description: "Not HTTP",
  access: "write",
  success: Schema.String,
  http: false,
});

const RemoteGroup = ActionGroup.make(
  {
    name: "remote",
    schemaError: {
      errors: [Policy],
      map: (failure: HttpApiError.HttpApiSchemaError) => new Policy({ kind: failure.kind }),
    },
  },
  Remote,
  Hidden,
);

const Http = ActionHttp.make({ apiPath: "/api" }, RemoteGroup);

const decodedInputs: number[] = [];

const app = RemoteGroup.implement({
  remote: ({ value }) =>
    Effect.andThen(
      Effect.sync(() => decodedInputs.push(value)),
      () =>
        value === 0
          ? Effect.fail(new Domain({ message: "zero" }))
          : Effect.succeed(value === 13 ? Infinity : value * 2),
    ),
  hidden: () => Effect.succeed("not mounted"),
});

it("projects grouped commands through the native HTTP client without a local fallback", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer([app]).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  decodedInputs.length = 0;

  const command = ActionCliClient.group(Http, "remote", {
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
      url: "http://localhost/api/remote/remote",
      authorization: "Bearer host",
      body: { value: "21" },
    },
  ]);
  // The handler sees the decoded number exactly once; CLI and HTTP emit canonical JSON.
  expect(decodedInputs).toEqual([21]);
  expect(output).toEqual(['"42"']);

  // A direct HTTP request proves the HTTP-disabled action was never mounted.
  expect(
    (
      await web.handler(
        new Request("http://localhost/api/remote/hidden", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        Context.empty(),
      )
    ).status,
  ).toBe(404);

  // Runtime selectors are guarded even when values come from untyped callers.
  // SAFETY: runtime guards must reject selector strings supplied outside TypeScript.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Intentional untyped selector simulation.
  const unknownGroup = "missing" as "remote";
  // SAFETY: runtime guards must reject selector strings supplied outside TypeScript.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Intentional untyped selector simulation.
  const unknownAction = "missing" as "remote";

  expect(() => ActionCliClient.command(Http, unknownGroup, "remote")).toThrow(
    'Unknown HTTP group "missing"',
  );
  expect(() => ActionCliClient.command(Http, "remote", unknownAction)).toThrow(
    'Unknown HTTP action "remote.missing"',
  );
});

it("keeps the selected action when a connection object carries selector keys", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer([app]).pipe(Layer.provide(HttpServer.layerServices)),
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
  const connection = { baseUrl: "http://localhost", group: "other", endpoint: "hidden" };
  const command = ActionCliClient.command(Http, "remote", "remote", { connection });

  const [, output] = await logged(
    Command.runWith(command, { version: "0" })(["--input", '{"value":"21"}']),
  ).pipe(Effect.provide(fetchLayer), Effect.provide(cliServices), Effect.runPromise);

  expect(decodedInputs).toEqual([21]);
  expect(output).toEqual(['"42"']);
});

it("propagates domain and native schema-policy failures through Command.runWith", async () => {
  const web = HttpRouter.toWebHandler(
    Http.layer([app]).pipe(Layer.provide(HttpServer.layerServices)),
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

  const command = ActionCliClient.command(Http, "remote", "remote", {
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
