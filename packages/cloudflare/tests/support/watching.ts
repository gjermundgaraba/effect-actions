import { vi } from "@effect/vitest";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Layer, Option, Schema, Stream } from "effect";

import { keptPrefix } from "../../src/durable/subscriptions.js";
import { Watched } from "./events.js";
import type { Noted, Said, Statused } from "./events.js";
import { protocolOver } from "./socket.js";

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const clientOver = (socket: WebSocket) =>
  Effect.flatMap(Layer.build(protocolOver(socket)), (protocol) =>
    ActionRpc.client(Watched).pipe(Effect.provideContext(protocol))
  );

const Resumed = Schema.Struct({
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const resumedOf = Schema.decodeUnknownOption(Resumed);

export const keptCursors = (stub: DurableObjectStub) =>
  Effect.promise(
    async () =>
      await runInDurableObject(stub, async (_, state) => {
        const kept = await state.storage.list({
          prefix: `${keptPrefix}payload/`,
        });

        return [...kept.values()];
      })
  ).pipe(
    Effect.map((kept) =>
      kept.map((value) =>
        Option.match(resumedOf(value), {
          onNone: () => "unreadable",
          onSome: ({ cursor }) => cursor ?? null,
        })
      )
    )
  );

export const until = (check: () => boolean) =>
  Effect.promise(
    async () => await vi.waitUntil(check, { timeout: 5000, interval: 10 })
  );

export const untilKept = (
  stub: DurableObjectStub,
  check: (cursors: Array<string | null>) => boolean
) =>
  Effect.promise(
    async () =>
      await vi.waitUntil(
        async () => check(await Effect.runPromise(keptCursors(stub))),
        {
          timeout: 5000,
          interval: 10,
        }
      )
  );

export const collected = <E>(
  stream: Stream.Stream<
    | Event.Received<typeof Noted>
    | Event.Received<typeof Said>
    | Event.Received<typeof Statused>,
    E
  >
) =>
  Effect.gen(function* () {
    const received: string[] = [];

    const fiber = yield* stream.pipe(
      Stream.runForEach((item) =>
        Effect.sync(() =>
          received.push(item._tag === "Gap" ? "gap" : item.data.text)
        )
      ),
      Effect.exit,
      Effect.forkScoped
    );

    return { received, fiber };
  });
