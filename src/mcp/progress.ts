import { Effect, Option, Schema } from "effect";
import { McpSchema } from "effect/ai";
import type { McpServer } from "effect/ai";

import type { Codec } from "../contract/codec.js";
import type { Reporting } from "../contract/progress.js";

/** The `_meta` key a `notifications/progress` carries its value under, as JSON. */
export const progressKey = "effect-actions/progress";

const tokenOf = Schema.decodeUnknownOption(McpSchema.ProgressToken);

/**
 * Where a tool call's progress goes: a `notifications/progress` for each value, on the
 * `progressToken` its request carried, `progress` counting from 1, `message` the value's JSON and
 * `_meta` the value; none for a request without a token, so the values are checked and dropped.
 */
export const progressNotifier = (
  notifications: McpServer.McpServer["Service"]["notifications"],
  progress: Codec
): Effect.Effect<Reporting | undefined, never, McpSchema.McpRequestContext> =>
  Effect.map(
    Effect.service(McpSchema.McpRequestContext),
    ({ requestMetadata }) => {
      const token = tokenOf(requestMetadata?.progressToken);

      if (Option.isNone(token)) {
        return;
      }

      const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(progress));
      let sent = 0;

      return {
        progress: (value) =>
          Effect.flatMap(Effect.orDie(encode(value)), (json) => {
            sent += 1;

            return notifications["notifications/progress"]({
              progressToken: token.value,
              progress: sent,
              message: JSON.stringify(json),
              _meta: { [progressKey]: json },
            });
          }),
      };
    }
  );

const Notified = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal("notifications/progress"),
    params: Schema.Struct({
      _meta: Schema.Struct({ [progressKey]: Schema.Json }),
    }),
  })
);

const notifiedOf = Schema.decodeUnknownOption(Notified);

/** The value a frame's `notifications/progress` carries, or none for another frame. */
export const progressOf = (data: string): Option.Option<Schema.Json> =>
  Option.map(
    notifiedOf(data),
    (notified) => notified.params._meta[progressKey]
  );
