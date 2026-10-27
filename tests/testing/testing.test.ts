import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  ErrorReporter,
  FileSystem,
  Layer,
  Logger,
  Path,
  Schema,
  Stream,
} from "effect";
import {
  Etag,
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { layer as host } from "../support/app/app.js";
import { authenticate } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Http, Login } from "../support/app/binding.js";
import { GetUser } from "../support/app/contracts.js";
import { as } from "../support/requests.js";

const textOf = (url: string) =>
  Effect.flatMap(HttpClient.get(url), (response) => response.text);

const text = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.flatMap(HttpClient.execute(request), (response) => response.text);

const network: typeof globalThis.fetch = async () => new Response("network");

const readData = (fs: FileSystem.FileSystem, path: Path.Path, name: string) =>
  fs.readFileString(path.join("data", name));

describe("layer", () => {
  it.effect(
    "runs requests in the program's context, middleware and handlers alike",
    () =>
      Effect.gen(function* () {
        const Stage = Context.Reference<string>("testing-test/Stage", {
          defaultValue: () => "real",
        });

        const stamped = HttpRouter.middleware((route) =>
          Effect.flatMap(Effect.service(Stage), (stage) =>
            Effect.map(route, (response) =>
              HttpServerResponse.setHeader(response, "x-stage", stage)
            )
          )
        ).layer;

        const routes = HttpRouter.add(
          "GET",
          "/stage",
          Effect.map(Effect.service(Stage), HttpServerResponse.text)
        ).pipe(Layer.provide(stamped));

        const [header, body] = yield* Effect.gen(function* () {
          const response = yield* HttpClient.get("/stage");

          return [response.headers["x-stage"], yield* response.text] as const;
        }).pipe(
          Effect.provide(Testing.layer(routes)),
          Effect.provideService(Stage, "test")
        );

        expect([header, body]).toStrictEqual(["test", "test"]);
      })
  );

  class Visits extends Context.Service<Visits, { count: number }>()(
    "testing/Visits"
  ) {}

  it("answers through a web handler the test serves, which it neither builds nor disposes", async () => {
    const web = HttpRouter.toWebHandler(
      host.pipe(Layer.provide(HttpServer.layerServices)),
      {
        disableLogger: true,
      }
    );

    const run = async <A, E>(
      program: Effect.Effect<A, E, HttpClient.HttpClient>
    ) =>
      await program.pipe(
        Effect.provide(Testing.layer(web.handler)),
        Effect.runPromise
      );

    try {
      const renamed = await run(
        Effect.flatMap(ActionHttp.client(Http, as("alice")), (client) =>
          client.renameUser({ id: "1", name: "Grace" })
        )
      );

      const answeredBySecondLayer = await run(
        Effect.gen(function* () {
          const client = yield* ActionHttp.client(Http, as("alice"));

          const listed = yield* HttpClient.execute(
            ActionMcp.request(
              "tools/list",
              {},
              { headers: { authorization: "Bearer alice" } }
            )
          );

          return [
            yield* client.getUser({ id: "1" }),
            yield* (yield* ActionMcp.client([GetUser], as("alice"))).getUser({
              id: "1",
            }),
            listed.status,
          ];
        })
      );

      expect(renamed).toStrictEqual({ id: "1", name: "Grace" });
      expect(answeredBySecondLayer).toStrictEqual([
        { id: "1", name: "Grace" },
        { id: "1", name: "Grace" },
        200,
      ]);
    } finally {
      await web.dispose();
    }
  });

  it.effect(
    "resolves a relative URL against http://localhost, and answers any origin in memory",
    () =>
      Effect.gen(function* () {
        const routes = HttpRouter.add(
          "GET",
          "/where",
          Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
            HttpServerResponse.text(request.originalUrl)
          )
        );

        const relativeAfterClientBaseUrl = textOf("/where").pipe(
          Effect.provideServiceEffect(
            HttpClient.HttpClient,
            Effect.map(
              HttpClient.HttpClient,
              HttpClient.mapRequest(
                HttpClientRequest.prependUrl("https://api.example")
              )
            )
          )
        );

        const urls = yield* Effect.all([
          ...[
            "/where",
            "where",
            "./where?x=1",
            "http://localhost/where",
            "https://api.example/where",
          ].map(textOf),
          relativeAfterClientBaseUrl,
        ]).pipe(Effect.provide(Testing.layer(routes)));

        expect(urls).toStrictEqual([
          "http://localhost/where",
          "http://localhost/where",
          "http://localhost/where?x=1",
          "http://localhost/where",
          "https://api.example/where",
          "https://api.example/where",
        ]);

        const unresolvableUrlFailures = yield* Effect.forEach(
          ["http://", "http://[invalid"],
          (url) => Effect.flip(textOf(url))
        ).pipe(Effect.provide(Testing.layer(routes)));

        expect(
          unresolvableUrlFailures.map(
            (error) =>
              HttpClientError.isHttpClientError(error) && error.reason._tag
          )
        ).toStrictEqual(["InvalidUrlError", "InvalidUrlError"]);
      })
  );

  it.effect(
    "sends the Host header of the request's URL, as the network does",
    () =>
      Effect.gen(function* () {
        const routes = HttpRouter.add(
          "GET",
          "/host",
          Effect.map(HttpServerRequest.HttpServerRequest, ({ headers }) =>
            HttpServerResponse.text(headers["host"] ?? "none")
          )
        );

        const hosts = yield* Effect.all([
          text(HttpClientRequest.get("/host")),
          text(HttpClientRequest.get("https://api.example.com:8443/host")),
          text(
            HttpClientRequest.get("/host").pipe(
              HttpClientRequest.setHeader("host", "given")
            )
          ),
        ]).pipe(Effect.provide(Testing.layer(routes)));

        expect(hosts).toStrictEqual([
          "localhost",
          "api.example.com:8443",
          "given",
        ]);
      })
  );

  class OtherFetchClient extends Context.Service<
    OtherFetchClient,
    Effect.Effect<string, HttpClientError.HttpClientError>
  >()("testing/OtherFetchClient") {}

  const otherFetchClient = Layer.effect(
    OtherFetchClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      textOf("https://elsewhere.example/").pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )
    )
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, network))
  );

  const postWhereAfterReadingBody = HttpRouter.add(
    "POST",
    "/where",
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.as(request.text, HttpServerResponse.text("routes"))
    )
  );

  const where = Layer.merge(
    HttpRouter.add("GET", "/where", HttpServerResponse.text("routes")),
    postWhereAfterReadingBody
  );

  const routesAndOtherClient = Effect.all([
    textOf("/where"),
    Effect.flatten(OtherFetchClient),
  ]);

  const insideAndOutsideLayer = Effect.all([
    textOf("/where").pipe(Effect.provide(Testing.layer(where))),
    textOf("https://elsewhere.example/"),
  ]);

  const requestMappingCallsOtherClient = Effect.gen(function* () {
    const answers: string[] = [];
    const call = yield* OtherFetchClient;

    const client = HttpClient.mapRequestEffect(
      yield* HttpClient.HttpClient,
      (request) =>
        call.pipe(
          Effect.tap((answer) => Effect.sync(() => answers.push(answer))),
          Effect.as(request)
        )
    );

    const answer = yield* textOf("/where").pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    );

    return [answer, ...answers];
  });

  const streamedBodyCallsOtherClient = Effect.gen(function* () {
    const answers: string[] = [];
    const call = yield* OtherFetchClient;

    const body = Stream.fromEffect(
      call.pipe(Effect.tap((answer) => Effect.sync(() => answers.push(answer))))
    ).pipe(Stream.encodeText);

    const answer = yield* HttpClient.execute(
      HttpClientRequest.post("/where").pipe(HttpClientRequest.bodyStream(body))
    ).pipe(Effect.flatMap((response) => response.text));

    return [answer, ...answers];
  });

  it.effect.each([
    [
      "a FetchHttpClient merged after it",
      routesAndOtherClient.pipe(
        Effect.provide(Layer.mergeAll(Testing.layer(where), otherFetchClient))
      ),
    ],
    [
      "a FetchHttpClient merged before it",
      routesAndOtherClient.pipe(
        Effect.provide(Layer.mergeAll(otherFetchClient, Testing.layer(where)))
      ),
    ],
    [
      "FetchHttpClient.layer provided around the program",
      insideAndOutsideLayer.pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, network))
          )
        )
      ),
    ],
    [
      "FetchHttpClient.Fetch provided around the program",
      insideAndOutsideLayer.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, network)
      ),
    ],
    [
      "a FetchHttpClient called while mapping its request",
      requestMappingCallsOtherClient.pipe(
        Effect.provide(Layer.mergeAll(otherFetchClient, Testing.layer(where)))
      ),
    ],
    [
      "a FetchHttpClient called while its streamed body is read",
      streamedBodyCallsOtherClient.pipe(
        Effect.provide(Layer.mergeAll(otherFetchClient, Testing.layer(where)))
      ),
    ],
  ] as const)("keeps its client apart from %s", ([, program]) =>
    Effect.gen(function* () {
      expect(yield* program).toStrictEqual(["routes", "network"]);
    })
  );

  it.effect(
    "serves routes with the services their middleware provides, until its scope closes",
    () =>
      Effect.gen(function* () {
        const visits = { count: 0 };
        let released = false;

        const routes = Layer.merge(
          HttpRouter.add(
            "GET",
            "/visits",
            Effect.map(Visits, (seen) => {
              seen.count += 1;

              return HttpServerResponse.text(String(seen.count));
            })
          ).pipe(HttpRouter.provideRequest(Layer.succeed(Visits, visits))),
          Layer.effectDiscard(
            Effect.addFinalizer(() => Effect.sync(() => (released = true)))
          )
        );

        const [visited, missing] = yield* Effect.gen(function* () {
          const response = yield* HttpClient.get("/visits");

          const answered = [
            response.status,
            yield* response.text,
            released,
          ] as const;

          return [
            answered,
            (yield* HttpClient.get("/missing")).status,
          ] as const;
        }).pipe(Effect.provide(Testing.layer(routes)));

        expect(visited).toStrictEqual([200, "1", false]);
        expect(missing).toBe(404);
        expect(visits.count).toBe(1);
        expect(released).toBe(true);
      })
  );

  it.effect("fails with the routes' build failure", () =>
    Effect.gen(function* () {
      class Unavailable extends Schema.TaggedError<
        Unavailable,
        { readonly brand: unique symbol }
      >()("Unavailable", {}) {}

      const Ping = Action.make("ping", {
        description: "Ping",
        readOnly: true,
        caller: Action.Anyone,
        success: Schema.Boolean,
      });

      const routes = ActionHttp.layer(
        ActionHttp.make([Ping]),
        Action.implement(Ping, Effect.fail(new Unavailable()))
      );

      const failure = yield* HttpClient.get("/api/ping").pipe(
        Effect.provide(Testing.layer(routes)),
        Effect.flip
      );

      expect(failure).toStrictEqual(new Unavailable());

      const Guarded = Action.make("ping", {
        description: "Ping",
        readOnly: true,
        caller: CurrentActor,
        success: Schema.Boolean,
      });

      const guarded = ActionHttp.layer(
        ActionHttp.make([Guarded], { authentication: Login }),
        Action.implement(Guarded, () => Effect.succeed(true), {
          authorize: Effect.fail(new Unavailable()),
        })
      ).pipe(Layer.provide(authenticate));

      const authorizeFailure = yield* HttpClient.get("/api/ping").pipe(
        Effect.provide(Testing.layer(guarded)),
        Effect.flip
      );

      expect(authorizeFailure).toStrictEqual(new Unavailable());
    })
  );

  it.effect(
    "logs the cause of a request a reporter would be given, a route's own failure included, and of no other",
    () =>
      Effect.gen(function* () {
        class Missing extends Schema.TaggedError<
          Missing,
          { readonly brand: unique symbol }
        >()("Missing", {}) {}

        class RouteFailed extends Schema.TaggedError<
          RouteFailed,
          { readonly brand: unique symbol }
        >()("RouteFailed", { message: Schema.String }) {}

        const options = {
          description: "Probe",
          readOnly: true,
          caller: Action.Anyone,
        } as const;

        const Crash = Action.make("crash", options);

        const Count = Action.make("count", {
          ...options,
          success: Schema.Finite,
        });

        const Find = Action.make("find", { ...options, error: Missing });
        const Fine = Action.make("fine", options);

        const Secret = Action.make("secret", {
          ...options,
          caller: CurrentActor,
        });

        const Probes = ActionHttp.make([Crash, Count, Find, Fine, Secret], {
          authentication: Login,
        });

        const routes = ActionHttp.layer(Probes, [
          Action.implement([Crash, Count, Find, Fine], {
            crash: () => Effect.die(new Error("db password hunter2")),
            count: () => Effect.succeed(Infinity),
            find: () => Effect.fail(new Missing()),
            fine: () => Effect.void,
          }),
          Action.implement(Secret, () => Effect.void, {
            authorize: Action.allowAll,
          }),
        ]).pipe(
          Layer.provide(authenticate),
          Layer.merge(
            HttpRouter.add(
              "GET",
              "/own",
              Effect.fail(new RouteFailed({ message: "a route of its own" }))
            )
          ),
          Layer.merge(
            HttpRouter.add(
              "GET",
              "/unreported",
              Effect.die(
                Object.assign(new Error("marked"), {
                  [ErrorReporter.ignore]: true,
                })
              )
            )
          )
        );

        const logged: string[] = [];

        yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(Probes);

          yield* Effect.exit(client.find());
          yield* client.fine();
          yield* Effect.exit(client.secret());
          yield* HttpClient.get("/nowhere");
          yield* HttpClient.get("/unreported");

          expect(logged).toStrictEqual([]);

          yield* Effect.exit(client.crash());
          yield* Effect.exit(client.count());
          yield* HttpClient.get("/own");
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              Testing.layer(routes),
              Logger.layer([
                Logger.make(({ cause, logLevel }) => {
                  logged.push(`${logLevel} ${Cause.pretty(cause)}`);
                }),
              ])
            )
          )
        );

        expect(logged).toStrictEqual([
          expect.stringMatching(/^Error Error: db password hunter2/u),
          expect.stringMatching(
            /^Error HttpApiSchemaError[^]*Expected a finite number/u
          ),
          expect.stringMatching(/^Error RouteFailed: a route of its own/u),
        ]);
      })
  );

  it.effect(
    "answers a route's defect as an empty 500, logging the cause on the process console, which it.effect's TestConsole would keep",
    () =>
      Effect.gen(function* () {
        const printed: string[] = [];

        const print = (...args: readonly unknown[]) => {
          printed.push(args.map(String).join(" "));
        };

        const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];

        for (const spy of spies) {
          spy.mockImplementation(print);
        }

        const answer = yield* Effect.flatMap(
          HttpClient.get("/crash"),
          (response) =>
            Effect.map(response.text, (body) => ({
              status: response.status,
              body,
            }))
        ).pipe(
          Effect.provide(
            Testing.layer(
              HttpRouter.add(
                "GET",
                "/crash",
                Effect.die(new Error("printed defect"))
              )
            )
          ),
          Effect.ensuring(
            Effect.sync(() => {
              for (const spy of spies) {
                spy.mockRestore();
              }
            })
          )
        );

        expect(answer).toStrictEqual({ status: 500, body: "" });
        expect(printed).toStrictEqual([
          expect.stringContaining("printed defect"),
        ]);
      })
  );

  it.effect(
    "leaves the routes' startup services to the program, which shares them",
    () =>
      Effect.gen(function* () {
        let built = 0;

        const Visit = Action.make("visit", {
          description: "Count a visit.",
          readOnly: false,
          caller: Action.Anyone,
          success: Schema.Finite,
        });

        const visit = Action.implement(
          Visit,
          Effect.map(
            Visits,
            (seen) => () =>
              Effect.sync(() => {
                seen.count += 1;

                return seen.count;
              })
          )
        );

        const VisitHttp = ActionHttp.make([Visit]);

        const answered = yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(VisitHttp);

          return [yield* client.visit(), (yield* Visits).count];
        }).pipe(
          Effect.provide(
            Testing.layer(ActionHttp.layer(VisitHttp, visit)).pipe(
              Layer.provideMerge(
                Layer.sync(Visits, () => {
                  built += 1;

                  return { count: 0 };
                })
              )
            )
          )
        );

        expect(answered).toStrictEqual([1, 1]);
        expect(built).toBe(1);
      })
  );

  it.effect(
    "serves a per-request service provided around it, such as the caller",
    () =>
      Effect.gen(function* () {
        const routes = HttpRouter.add(
          "GET",
          "/visits",
          Effect.map(Visits, (seen) => {
            seen.count += 1;

            return HttpServerResponse.text(String(seen.count));
          })
        );

        const answered = yield* HttpClient.get("/visits").pipe(
          Effect.flatMap((response) => response.text),
          Effect.provide(
            Testing.layer(routes).pipe(
              Layer.provide(Layer.succeed(Visits, { count: 0 }))
            )
          )
        );

        expect(answered).toBe("1");
      })
  );

  it.effect(
    "serves a global middleware the per-request service provided around it",
    () =>
      Effect.gen(function* () {
        const globalCountingMiddleware = HttpRouter.middleware(
          (route) =>
            Effect.flatMap(Visits, (seen) =>
              Effect.map(route, (response) => {
                seen.count += 1;

                return HttpServerResponse.setHeader(
                  response,
                  "x-visits",
                  String(seen.count)
                );
              })
            ),
          { global: true }
        );

        const routes = Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.empty()),
          globalCountingMiddleware
        );

        const visits = yield* HttpClient.get("/").pipe(
          Effect.map((response) => [
            response.status,
            response.headers["x-visits"],
          ]),
          Effect.provide(
            Testing.layer(routes).pipe(
              Layer.provide(Layer.succeed(Visits, { count: 0 }))
            )
          )
        );

        expect(visits).toStrictEqual([204, "1"]);
      })
  );

  it.effect(
    "gives builders and handlers the platform services provided around it, the program's own",
    () =>
      Effect.gen(function* () {
        let built = 0;

        const instanceNamingFileSystem = Layer.sync(
          FileSystem.FileSystem,
          () => {
            built += 1;

            const instance = built;

            return FileSystem.makeNoop({
              readFileString: (file) => Effect.succeed(`${instance}:${file}`),
            });
          }
        );

        const Read = Action.make("read", {
          description:
            "Reads a file with its builder's services and with its request's.",
          readOnly: true,
          caller: Action.Anyone,
          input: { name: Schema.String },
          success: Schema.Array(Schema.String),
        });

        const read = Action.implement(
          Read,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;

            return ({ name }) =>
              Effect.gen(function* () {
                const atStartup = yield* readData(fs, path, name);

                const perRequest = yield* readData(
                  yield* FileSystem.FileSystem,
                  yield* Path.Path,
                  name
                );

                return [atStartup, perRequest];
              }).pipe(Effect.orDie);
          })
        );

        const ReadHttp = ActionHttp.make([Read]);

        const answered = yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(ReadHttp);
          const fs = yield* FileSystem.FileSystem;

          return [
            ...(yield* client.read({ name: "a.txt" })),
            yield* fs.readFileString("a.txt"),
          ];
        }).pipe(
          Effect.provide(
            Testing.layer(ActionHttp.layer(ReadHttp, read)).pipe(
              Layer.provide(NodePath.layerWin32),
              Layer.provideMerge(instanceNamingFileSystem)
            )
          )
        );

        expect(answered).toStrictEqual([
          "1:data\\a.txt",
          "1:data\\a.txt",
          "1:a.txt",
        ]);
        expect(built).toBe(1);
      })
  );

  const packageJson = fileURLToPath(
    new URL("../../package.json", import.meta.url)
  );

  const fileRoute = HttpRouter.add(
    "GET",
    "/package.json",
    HttpServerResponse.file(packageJson)
  );

  const getFile = Effect.flatMap(HttpClient.get("/package.json"), (response) =>
    Effect.map(response.text, (body) => [response.status, body])
  );

  it.effect(
    "reads files through the FileSystem provided around it, or else a no-op one",
    () =>
      Effect.gen(function* () {
        const Exists = Action.make("exists", {
          description:
            "Whether a file exists, to its builder's file system and to its request's.",
          readOnly: true,
          caller: Action.Anyone,
          input: { path: Schema.String },
          success: Schema.Array(Schema.Boolean),
        });

        const exists = Action.implement(
          Exists,
          Effect.map(
            FileSystem.FileSystem,
            (fs) =>
              ({ path }) =>
                Effect.flatMap(FileSystem.FileSystem, (perRequest) =>
                  Effect.all([fs.exists(path), perRequest.exists(path)])
                ).pipe(Effect.orDie)
          )
        );

        const ExistsHttp = ActionHttp.make([Exists]);

        const routes = Layer.mergeAll(
          ActionHttp.layer(ExistsHttp, exists),
          fileRoute
        );

        const program = Effect.gen(function* () {
          const client = yield* ActionHttp.client(ExistsHttp);

          return [yield* client.exists({ path: packageJson }), yield* getFile];
        });

        const real = yield* program.pipe(
          Effect.provide(
            Testing.layer(routes).pipe(Layer.provide(NodeFileSystem.layer))
          )
        );

        expect(real).toStrictEqual([
          [true, true],
          [200, readFileSync(packageJson, "utf-8")],
        ]);

        const withNothingProvided = yield* program.pipe(
          Effect.provide(Testing.layer(routes))
        );

        expect(withNothingProvided).toStrictEqual([
          [false, false],
          [500, expect.any(String)],
        ]);
      })
  );

  it.effect(
    "gives the routes HttpServer.layerServices' defaults, per request too, when nothing provides them",
    () =>
      Effect.gen(function* () {
        const routes = HttpRouter.add(
          "GET",
          "/defaults",
          Effect.gen(function* () {
            const file = new File(["hello"], "hello.txt");
            const path = yield* Path.Path;

            const etag = yield* Effect.flatMap(Etag.Generator, (etags) =>
              etags.fromFileWeb(file)
            );

            const response = yield* HttpServerResponse.fileWeb(file);

            return HttpServerResponse.setHeaders(response, {
              "x-separator": path.sep,
              "x-etag": Etag.toString(etag),
            });
          })
        );

        const answered = yield* HttpClient.get("/defaults").pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (body) => [
              response.status,
              body,
              response.headers["x-separator"],
              response.headers["x-etag"],
            ])
          ),
          Effect.provide(Testing.layer(routes))
        );

        expect(answered).toStrictEqual([
          200,
          "hello",
          "/",
          expect.stringMatching(/^W\//u),
        ]);
      })
  );

  it.effect(
    "serves files from the FileSystem provided around it, whatever platform the program built elsewhere",
    () =>
      Effect.gen(function* () {
        const platformBuiltElsewhere = Layer.effectDiscard(Effect.void).pipe(
          Layer.provide(HttpServer.layerServices)
        );

        const answered = yield* getFile.pipe(
          Effect.provide(
            Testing.layer(fileRoute).pipe(
              Layer.provide(
                Layer.merge(NodeFileSystem.layer, platformBuiltElsewhere)
              )
            )
          )
        );

        expect(answered).toStrictEqual([
          200,
          readFileSync(packageJson, "utf-8"),
        ]);
      })
  );
});
