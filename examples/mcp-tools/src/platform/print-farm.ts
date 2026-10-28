import { Config, Effect, Layer, Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { HttpClientError } from "effect/http";

import { PrintFarm } from "../printers/farm.js";
import { Printer, PrintFarmError } from "../printers/Printers.js";

const fail = (message: string) => Effect.fail(new PrintFarmError({ message }));

const unreadable = "The print farm sent an answer this server could not read.";

const at = (id: string, rest = "") => `/api/printers/${id}${rest}`;

const refuseUnlessOk = HttpClientResponse.matchStatus({
  "2xx": (response) => Effect.succeed(response),
  orElse: (response) =>
    HttpClientResponse.schemaBodyJson(Schema.Struct({ error: Schema.String }))(
      response
    ).pipe(
      Effect.matchEffect({
        onFailure: () =>
          fail(`The print farm refused the request (HTTP ${response.status}).`),
        onSuccess: ({ error }) => fail(`The print farm refused: ${error}`),
      })
    ),
});

const asPrintFarmError = <A>(
  effect: Effect.Effect<
    A,
    PrintFarmError | HttpClientError.HttpClientError | Schema.SchemaError
  >
) =>
  effect.pipe(
    Effect.catchTags({
      HttpClientError: ({ response }) =>
        fail(
          response === undefined
            ? "The print farm could not be reached."
            : unreadable
        ),
      SchemaError: () => fail(unreadable),
    }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => fail("The print farm did not answer in time."),
    })
  );

const asImage = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const mimeType = response.headers["content-type"];

    if (mimeType === undefined || !mimeType.startsWith("image/")) {
      return yield* fail(unreadable);
    }

    return { data: new Uint8Array(yield* response.arrayBuffer), mimeType };
  });

export const printFarm = Layer.effect(
  PrintFarm,
  Effect.gen(function* () {
    const { url, user, password } = yield* Config.all({
      url: Config.URL("FARM_URL"),
      user: Config.NonEmptyString("FARM_USER"),
      password: Config.Redacted("FARM_PASSWORD"),
    });

    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(url.href)),
      HttpClient.transformResponse(Effect.flatMap(refuseUnlessOk))
    );

    const session = yield* http
      .post("/api/login", {
        body: HttpBody.jsonUnsafe({ user, password: Redacted.value(password) }),
      })
      .pipe(
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(
            Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) })
          )
        ),
        asPrintFarmError
      );

    yield* Effect.logInfo(
      `Signed in to the print farm at ${url.host} as ${user}.`
    );

    const api = HttpClient.mapRequest(
      http,
      HttpClientRequest.bearerToken(session.token)
    );

    const printer = (answer: ReturnType<typeof api.get>) =>
      answer.pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Printer)),
        asPrintFarmError
      );

    return PrintFarm.of({
      printers: api.get("/api/printers").pipe(
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(
            Schema.Struct({ printers: Schema.Array(Printer) })
          )
        ),
        Effect.map(({ printers }) => printers),
        asPrintFarmError
      ),
      printer: (id) => printer(api.get(at(id))),
      snapshot: (id) =>
        api
          .get(at(id, "/camera"))
          .pipe(Effect.flatMap(asImage), asPrintFarmError),
      start: (id, file) =>
        printer(
          api.post(at(id, "/job"), { body: HttpBody.jsonUnsafe({ file }) })
        ),
      setPaused: (id, paused) =>
        printer(api.post(at(id, paused ? "/pause" : "/resume"))),
      cancel: (id) => printer(api.del(at(id, "/job"))),
    });
  })
);
