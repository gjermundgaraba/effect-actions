import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import { Printer, PrintFarmError } from "./Printers.js";

const fail = (message: string) => Effect.fail(new PrintFarmError({ message }));

const unreadable = "The print farm sent an answer this server could not read.";

// The farm answers a request it refuses with a status that is not 2xx and `{ "error": "..." }`.
// Its reason is passed on to the model, which can act on "The printer is busy with a job".
const refuseUnlessOk = HttpClientResponse.matchStatus({
  "2xx": (response) => Effect.succeed(response),
  orElse: (response) =>
    HttpClientResponse.schemaBodyJson(Schema.Struct({ error: Schema.String }))(response).pipe(
      Effect.matchEffect({
        onFailure: () => fail(`The print farm refused the request (HTTP ${response.status}).`),
        onSuccess: ({ error }) => fail(`The print farm refused: ${error}`),
      }),
    ),
});

// Every other way a call to the farm fails, as the same declared error: no connection, an
// answer of another shape than expected, or none in time. Nothing of the HTTP client's own
// errors leaves this file, so no tool can fail with something its contract does not declare.
const asPrintFarmError = <A>(
  effect: Effect.Effect<A, PrintFarmError | HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  effect.pipe(
    Effect.catchTag("HttpClientError", ({ response }) =>
      fail(response === undefined ? "The print farm could not be reached." : unreadable),
    ),
    Effect.catchTag("SchemaError", () => fail(unreadable)),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => fail("The print farm did not answer in time."),
    }),
  );

const asImage = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const mimeType = response.headers["content-type"];

    if (mimeType === undefined || !mimeType.startsWith("image/")) return yield* fail(unreadable);

    return { data: new Uint8Array(yield* response.arrayBuffer), mimeType };
  });

/**
 * The print farm's HTTP API, the one upstream of this server. Its methods require nothing and
 * fail only with the error the tools declare: the layer has captured the HTTP client, the
 * farm's URL and the session.
 */
export class PrintFarm extends Context.Service<
  PrintFarm,
  {
    readonly printers: Effect.Effect<ReadonlyArray<Printer>, PrintFarmError>;
    readonly printer: (id: string) => Effect.Effect<Printer, PrintFarmError>;
    readonly snapshot: (id: string) => Effect.Effect<typeof Action.Image.Type, PrintFarmError>;
    readonly start: (id: string, file: string) => Effect.Effect<Printer, PrintFarmError>;
    readonly setPaused: (id: string, paused: boolean) => Effect.Effect<Printer, PrintFarmError>;
    readonly cancel: (id: string) => Effect.Effect<Printer, PrintFarmError>;
  }
>()("mcp-tools/PrintFarm") {
  // Built once, when the process starts. It requires an `HttpClient` and reads its settings
  // from `Config`: the entrypoint decides which client, and the environment says which farm.
  // Not `fetch`: as a service, a test replaces the network alone and opens no port
  // (test/printers/printers.test.ts).
  static readonly layer = Layer.effect(
    PrintFarm,
    Effect.gen(function* () {
      const { url, user, password } = yield* Config.all({
        url: Config.URL("FARM_URL"),
        user: Config.NonEmptyString("FARM_USER"),
        password: Config.Redacted("FARM_PASSWORD"),
      });

      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(url.href)),
        HttpClient.transformResponse(Effect.flatMap(refuseUnlessOk)),
      );

      // Signs in once, here, and every call below reuses the token, kept `Redacted` so no log
      // prints it. A farm that refuses the sign-in stops the process at startup, with its
      // reason, before any tool is listed. A real client also signs in again when a call
      // answers 401, as tokens expire.
      const session = yield* http
        .post("/api/login", {
          body: HttpBody.jsonUnsafe({ user, password: Redacted.value(password) }),
        })
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) }),
            ),
          ),
          asPrintFarmError,
        );

      yield* Effect.logInfo(`Signed in to the print farm at ${url.host} as ${user}.`);

      const api = HttpClient.mapRequest(http, HttpClientRequest.bearerToken(session.token));

      // An id is written into the path as it is: the contract admits only letters, digits,
      // `_` and `-`, so it is always one segment. Encoding would not make other text safe:
      // `encodeURIComponent` leaves `..` alone, and a URL parser then walks up the path.
      const at = (id: string, rest = "") => `/api/printers/${id}${rest}`;

      const printer = (answer: ReturnType<typeof api.get>) =>
        answer.pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Printer)), asPrintFarmError);

      return PrintFarm.of({
        printers: api.get("/api/printers").pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(Schema.Struct({ printers: Schema.Array(Printer) })),
          ),
          Effect.map(({ printers }) => printers),
          asPrintFarmError,
        ),
        printer: (id) => printer(api.get(at(id))),
        snapshot: (id) =>
          api.get(at(id, "/camera")).pipe(Effect.flatMap(asImage), asPrintFarmError),
        start: (id, file) =>
          printer(api.post(at(id, "/job"), { body: HttpBody.jsonUnsafe({ file }) })),
        setPaused: (id, paused) => printer(api.post(at(id, paused ? "/pause" : "/resume"))),
        cancel: (id) => printer(api.del(at(id, "/job"))),
      });
    }),
  );
}
