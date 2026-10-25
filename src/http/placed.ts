import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";
import type * as Action from "../contract/Action.js";
import * as Event from "../contract/Event.js";
import type { ErasedRule } from "../contract/authorizer.js";
import { EventImplementation, type Run } from "../contract/feed.js";
import {
  type ErasedAuthorize,
  type ErasedValue,
  Implementation,
  memoized,
  type Written,
  type WrittenHandler,
} from "../contract/implementation.js";
import { isNotFound } from "../contract/transient.js";
import { actionMethodWith, type AnyHttp, transportWith } from "./client.js";
import { elementOf } from "../contract/stream.js";

type Contract<H extends AnyHttp> = H["actions"][number] | H["events"][number];

/**
 * What `placed` returns: an implementation of the binding's actions where it has some, and one of
 * its event types where it has some, which require nothing.
 */
export type Placed<H extends AnyHttp> = ReadonlyArray<
  | Implementation<
      H["actions"][number],
      { readonly [K in H["actions"][number]["name"]]: never },
      never,
      never
    >
  | EventImplementation<
      H["events"][number],
      { readonly [K in H["events"][number]["name"]]: never },
      never,
      never
    >
>;

// Why: each family belongs to the request the server received, not to the one sent on: its
// connection's, a socket's upgrade's among them, its body's, what it accepts, which the client
// sets for the answer it reads, and an MCP request's routing.
const ownedByTheRequest = (name: string) =>
  ["host", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"].includes(
    name,
  ) ||
  ["content-", "accept", "proxy-", "sec-websocket-", "mcp-"].some((family) =>
    name.startsWith(family),
  );

const forwarded = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({
    onNone: () => Headers.empty,
    onSome: ({ headers }) =>
      Headers.fromInput(Object.entries(headers).filter(([name]) => !ownedByTheRequest(name))),
  }),
);

const isSubscriptionError: Predicate.Refinement<unknown, Event.SubscriptionError> = Schema.is(
  Event.SubscriptionError,
);

const isNotServed = Predicate.compose(isSubscriptionError, (error: Event.SubscriptionError) =>
  Predicate.isTagged(error.reason, "NotServed"),
);

const notServedThere = (name: string) =>
  new Error(
    `ActionHttp.placed: the server its client reaches does not serve ${name} (serve its implementation in that server's ActionHttp.layer of this binding)`,
  );

/**
 * The actions and event types of `binding` served where another server serves them, as a
 * surface's implementations: each call and subscription sent on over `binding` with the client
 * `client` answers for its input and its contract, carrying the caller's headers, and its answer, its errors and
 * its occurrences passed back as they are. The surface serving them authenticates a protected one
 * as its own and authorizes every caller; the server reached authenticates and authorizes again.
 *
 * **Gotchas**
 *
 * - The caller's credential is verified twice, by the surface serving these and by the server reached, so both are given the verifier: a credential expiring between the two is refused by the second.
 * - The server reached builds its own verifier: one caching signing keys in memory fetches them in each of its instances, a Durable Object's again after each eviction.
 * - Every header of the caller's request is sent on but its connection's, its body's, what it accepts and an MCP request's routing headers (`mcp-*`): a header that must not reach the server reached is removed by router middleware first.
 * - A header `client`'s client sets replaces the caller's of that name, as it is set after them: a service's own `authorization` is sent in place of the caller's.
 * - An error the server reached declares beyond the action's own and the built-in ones, its binding's `error` or its verifier's, is a defect where it is passed back, answered as one.
 * - A server reached that does not serve one of them, its route a 404, is a defect naming it, with the fix: a declared error whose status is 404 is passed back as it is.
 * - A refusal of a subscription by the server reached comes after the surface admitted it, so it ends the subscription's stream where the surface's own would have answered its 401 or 403.
 */
export const placed = <const H extends AnyHttp>(
  binding: H,
  client: (
    input: Contract<H>["input"]["Type"],
    contract: Action.Any | Event.Any,
  ) => HttpClient.HttpClient,
): Placed<H> => {
  const sending = (contract: Action.Any | Event.Any, input: ErasedValue) =>
    Effect.map(forwarded, (headers) =>
      HttpClient.mapRequestInput(client(input, contract), HttpClientRequest.setHeaders(headers)),
    );

  // Why: the method answers a stream exactly where the action does, as `client` reads its
  // success, so the other answer is no call's.
  const otherwise = new Error(
    "A placed action's method answered otherwise than its action declares",
  );

  const handlerOf =
    (action: Action.Any): WrittenHandler<unknown> =>
    (input, reporting) => {
      const sent = Effect.map(
        Effect.flatMap(sending(action, input), (http) => actionMethodWith(binding, http, action)),
        (method) =>
          method(
            input,
            ...(reporting === undefined || reporting.dropped
              ? []
              : [{ onProgress: reporting.progress }]),
          ),
      );

      return elementOf(action.success) === undefined
        ? Effect.flatMap(sent, (answer) =>
            Stream.isStream(answer) ? Effect.die(otherwise) : answer,
          ).pipe(Effect.catchIf(isNotFound, () => Effect.die(notServedThere(action.name))))
        : Stream.unwrap(
            Effect.map(sent, (answer) =>
              Stream.isStream(answer) ? answer : Stream.die(otherwise),
            ),
          ).pipe(Stream.catchIf(isNotFound, () => Stream.die(notServedThere(action.name))));
    };

  const runOf = (event: Event.Any): Run => {
    const transport = (input: ErasedValue) =>
      Effect.flatMap(sending(event, input), (http) => transportWith(binding, http, event, input));

    return {
      emits: false,
      subscribes: false,
      poll: (input, cursor) =>
        Effect.flatMap(transport(input), ({ poll }) => poll(cursor)).pipe(
          Effect.catchIf(isNotServed, () => Effect.die(notServedThere(event.name))),
        ),
      stream: (input, cursor) =>
        Stream.unwrap(Effect.map(transport(input), ({ stream }) => stream(cursor))).pipe(
          Stream.catchIf(isNotServed, () => Stream.die(notServedThere(event.name))),
        ),
    };
  };

  return [
    ...(binding.actions.length === 0
      ? []
      : [
          new Implementation<
            H["actions"][number],
            { readonly [K in H["actions"][number]["name"]]: never },
            never,
            never
          >(
            binding.actions,
            memoized<Written, never, never>(
              Effect.succeed(binding.actions.map((action) => [action, handlerOf(action)] as const)),
            ),
            memoized<ErasedAuthorize, never, never>(Effect.succeed(() => Effect.void)),
          ),
        ]),
    ...(binding.events.length === 0
      ? []
      : [
          new EventImplementation<
            H["events"][number],
            { readonly [K in H["events"][number]["name"]]: never },
            never,
            never
          >(
            binding.events,
            binding.events.map(
              (event) =>
                [event, memoized<Run, never, never>(Effect.succeed(runOf(event)))] as const,
            ),
            memoized<ErasedRule<Event.Any>, never, never>(Effect.succeed(() => Effect.void)),
          ),
        ]),
  ];
};
