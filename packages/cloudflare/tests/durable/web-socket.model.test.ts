import { expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Exit, Match, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";

import { noteHeader, Overdrawn } from "../support/app.js";
import { scopedClientOver, upgradeToRpc } from "../support/socket.js";

const Token = Schema.NullOr(Schema.Literals(["ada", "grace", "nobody"]));

const Note = Schema.NullOr(Schema.Literals(["red", "blue"]));

const Socket = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }));

const Connect = Schema.TaggedStruct("Connect", { token: Token, note: Note });

const Command = Schema.Union([
  Connect,
  Schema.TaggedStruct("Whoami", { socket: Socket, token: Token }),
  Schema.TaggedStruct("ReadNote", { socket: Socket, note: Note }),
  Schema.TaggedStruct("Spend", {
    socket: Socket,
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
  }),
  Schema.TaggedStruct("Everyone", {}),
  Schema.TaggedStruct("Hibernate", {}),
  Schema.TaggedStruct("Close", { socket: Socket }),
]);

type Command = typeof Command.Type;

type Token = typeof Token.Type;

interface Connected {
  readonly token: Token;
  readonly note: typeof Note.Type;
  readonly socket: WebSocket;
  readonly client: Effect.Success<ReturnType<typeof scopedClientOver>>;
  readonly exits: { calls: number; received: number };
}

const isExit = Schema.is(Schema.TaggedStruct("Exit", {}));

const countExitsReceived = (socket: WebSocket) => {
  const exits = { calls: 0, received: 0 };

  socket.addEventListener("message", ({ data }) => {
    if (isExit(JSON.parse(String(data)))) {
      exits.received += 1;
    }
  });

  return exits;
};

const settled = Effect.promise(async () => {
  await scheduler.wait(10);
});

const userOf = (token: Token) =>
  token === "ada" || token === "grace" ? token : undefined;

const headersOf = (token: Token, note: typeof Note.Type) => ({
  ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  ...(note === null ? {} : { [noteHeader]: note }),
});

const whoamiAs = (token: Token) => (exit: Exit.Exit<string, unknown>) => {
  const user = userOf(token);

  if (user === undefined) {
    expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(
      Action.Unauthenticated
    );
  } else {
    expect(exit).toStrictEqual(Exit.succeed(user));
  }
};

let rooms = 0;

const runScenario = (commands: readonly Command[]) =>
  Effect.gen(function* () {
    rooms += 1;

    const stub = env.ROOM.getByName(`model-${rooms}`);
    const open: Connected[] = [];
    let balance = 10;
    let running = false;

    const pick = (index: number) => {
      const connected = open[index % Math.max(open.length, 1)];

      if (connected !== undefined) {
        connected.exits.calls += 1;
      }

      return connected;
    };

    const step = Match.type<Command>().pipe(
      Match.tagsExhaustive({
        Connect: ({ token, note }) =>
          Effect.gen(function* () {
            const socket = yield* upgradeToRpc(stub, headersOf(token, note));
            const exits = countExitsReceived(socket);

            open.push({
              token,
              note,
              socket,
              exits,
              client: yield* scopedClientOver(socket),
            });
            running = true;
          }),
        Whoami: ({ socket, token }) => {
          const connected = pick(socket);

          if (connected === undefined) {
            return Effect.void;
          }

          running = true;

          return connected.client
            .whoami()
            .pipe(
              RpcClient.withHeaders(headersOf(token, null)),
              Effect.exit,
              Effect.map(whoamiAs(token ?? connected.token))
            );
        },
        ReadNote: ({ socket, note }) => {
          const connected = pick(socket);

          if (connected === undefined) {
            return Effect.void;
          }

          running = true;

          return connected.client.readNote().pipe(
            RpcClient.withHeaders(headersOf(null, note)),
            Effect.map((read) => {
              expect(read).toBe(note ?? connected.note ?? "none");
            })
          );
        },
        Spend: ({ socket, amount }) => {
          const connected = pick(socket);

          if (connected === undefined) {
            return Effect.void;
          }

          running = true;

          const expected =
            amount > balance
              ? Exit.fail(new Overdrawn({ by: amount - balance }))
              : Exit.succeed({ left: (balance -= amount) });

          return connected.client.spend({ amount }).pipe(
            RpcClient.withHeaders(headersOf("ada", null)),
            Effect.exit,
            Effect.map((exit) => {
              expect(exit).toStrictEqual(expected);
            })
          );
        },
        Everyone: () => {
          running ||= open.length > 0;

          return Effect.forEach(
            open,
            ({ client, token, exits }) => {
              exits.calls += 1;

              return client
                .whoami()
                .pipe(Effect.exit, Effect.map(whoamiAs(token)));
            },
            { concurrency: "unbounded", discard: true }
          );
        },
        Hibernate: () => {
          if (!running) {
            return Effect.void;
          }

          running = false;
          balance = 10;

          return Effect.promise(async () => {
            await evictDurableObject(stub);
          });
        },
        Close: ({ socket }) => {
          const connected = open[socket % Math.max(open.length, 1)];

          if (connected === undefined) {
            return Effect.void;
          }

          open.splice(open.indexOf(connected), 1);

          return Effect.sync(() => {
            connected.socket.close(1000, "done");
          });
        },
      })
    );

    for (const command of commands) {
      yield* step(command);

      yield* settled;

      for (const { exits } of open) {
        expect(exits.received).toBe(exits.calls);
      }
    }
  }).pipe(Effect.scoped);

it.effect.prop(
  "answers every socket's calls as its saved credential and headers say, under its own, across hibernations",
  {
    first: Connect,
    rest: Schema.Array(Command).check(Schema.isBetweenLength(6, 16)),
  },
  ({ first, rest }) => runScenario([first, ...rest]),
  { timeout: 120_000, arbitrary: { runs: 60 } }
);
