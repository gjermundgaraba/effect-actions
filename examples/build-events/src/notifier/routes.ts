import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Effect, Layer, Predicate, Stream } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";

import { Http } from "../Api.js";
import { BuildFinished } from "../builds/Builds.js";
import { Notices } from "./Notices.js";

/** Where build-events is, who the notifier signs in as there, and where it is reached itself. */
export interface NotifierOptions {
  readonly buildEvents: string;
  readonly token: string | Redacted.Redacted;
  /** This process's public https origin, which build-events POSTs to. */
  readonly publicUrl: string;
}

const receiver = Webhook.layerReceiver({ path: "/hooks/builds" });

const watcher = ({ buildEvents, token, publicUrl }: NotifierOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const notices = yield* Notices;

      const builds = yield* ActionHttp.client(Http, {
        baseUrl: buildEvents,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.bearerToken(token)
        ),
      });

      yield* Effect.forkScoped(
        builds
          .watch(
            BuildFinished,
            { status: "failed" },
            {
              mode: Webhook.delivery({ baseUrl: publicUrl }),
              resume: {
                store: yield* KeyValueStore.KeyValueStore,
                key: "failed-builds",
              },
            }
          )
          .pipe(
            Stream.runForEach((received) =>
              Predicate.isTagged(received, "Occurrence")
                ? notices.add(received.data)
                : Effect.logWarning("Failed builds were missed", received)
            ),
            Effect.tapCause(Effect.logError)
          )
      );
    })
  );

/** The notifier's routes: the receiver, and the watch reading from that same receiver. */
export const notifier = (options: NotifierOptions) =>
  watcher(options).pipe(Layer.provideMerge(receiver));
