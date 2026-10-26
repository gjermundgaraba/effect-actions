import { Effect, Layer, Predicate, type Redacted, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
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

// The route build-events POSTs each failed build to, where the watch below reads them: the
// watch's delivery appends its path to this process's public URL.
const receiver = Webhook.layerReceiver({ path: "/hooks/builds" });

// A second service, the notifier: it watches build.finished for failures by webhook, the
// server POSTing each to it, rather than holding a stream open to build-events.
const watcher = ({ buildEvents, token, publicUrl }: NotifierOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const notices = yield* Notices;

      const builds = yield* ActionHttp.client(Http, {
        baseUrl: buildEvents,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      });

      yield* Effect.forkScoped(
        builds
          .watch(
            BuildFinished,
            { status: "failed" },
            {
              mode: Webhook.delivery({ baseUrl: publicUrl }),
              // Where it reached is kept, so a restart resumes there; failures the server no
              // longer keeps arrive as a Gap instead.
              resume: { store: yield* KeyValueStore.KeyValueStore, key: "failed-builds" },
            },
          )
          .pipe(
            // A Gap says failures were missed, which no notice can name: it is logged, for an
            // operator to look the builds up.
            Stream.runForEach((received) =>
              Predicate.isTagged(received, "Occurrence")
                ? notices.add(received.data)
                : Effect.logWarning("Failed builds were missed", received),
            ),
            // A failure no reconnect outlasts, such as a wrong PUBLIC_URL or a revoked token,
            // ends the watch: it is logged here, for a deployment to alert on or restart by.
            Effect.tapCause(Effect.logError),
          ),
      );
    }),
  );

/** The notifier's routes: the receiver, and the watch reading from that same receiver. */
export const notifier = (options: NotifierOptions) =>
  watcher(options).pipe(Layer.provideMerge(receiver));
