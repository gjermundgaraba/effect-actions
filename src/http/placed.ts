import { Context, Effect, Option, Predicate, Schema, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";
import type * as Action from "../contract/Action.js";
import * as Event from "../contract/Event.js";
import { EventImplementation, type Run } from "../contract/feed.js";
import {
  type ErasedAuthorize,
  type ErasedValue,
  Implementation,
  memoized,
  type Written,
  type WrittenHandler,
} from "../contract/implementation.js";
import { type AnyHttp, type Senders, sendersWith } from "./client.js";
import { isNotFound } from "./watch.js";

type Contract<H extends AnyHttp> = H["actions"][number] | H["events"][number];

/** A call's or a subscription's decoded input, beside its contract, one of `C`. */
type Routed<C> = C extends Action.Any | Event.Any
  ? [input: C["input"]["Type"], contract: C]
  : never;

/** What the contracts `C` require per request, by name: nothing. */
type Nothing<C extends Action.Any | Event.Any> = { readonly [K in C["name"]]: never };

/**
 * What `placed` returns: an implementation of the binding's actions where it has some, and one of
 * its event types where it has some, which require nothing.
 */
export type Placed<H extends AnyHttp> = ReadonlyArray<
  | Implementation<H["actions"][number], Nothing<H["actions"][number]>, never, never>
  | EventImplementation<H["events"][number], Nothing<H["events"][number]>, never, never>
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

// Why: The binding's native clients are built once, over `dispatching`, which sends each request
// with the client a call's input and contract chose, as this holds it for the call.
class Sending extends Context.Service<Sending, HttpClient.HttpClient>()(
  "effect-actions/ActionHttp/placed/Sending",
) {}

const dispatching = HttpClient.makeWith(
  (request: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
    Effect.flatMap(Effect.all([request, Effect.service(Sending)]), ([sent, client]) =>
      client.execute(sent),
    ),
  (request) => Effect.succeed(request),
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

const admitting: ErasedAuthorize = () => Effect.void;

const admittingEvents: ErasedAuthorize<Event.Any> = () => Effect.void;

/**
 * The actions and event types of `binding` served where another server serves them, as a
 * surface's implementations: each call and subscription sent on over `binding` with the client
 * `client` answers for its decoded input and its contract, one of the binding's, carrying the
 * caller's headers, and its answer, its errors and its occurrences passed back as they are. The
 * surface serving them authenticates a protected one as its own and authorizes every caller; the
 * server reached authenticates and authorizes again.
 *
 * **Gotchas**
 *
 * - The caller's credential is verified twice, by the surface serving these and by the server reached, so both are given the verifier: a credential expiring between the two is refused by the second.
 * - The server reached builds its own verifier: one caching signing keys in memory fetches them in each of its instances, a Durable Object's again after each eviction.
 * - Every header of the caller's request is sent on but its connection's, its body's, what it accepts and an MCP request's routing headers (`mcp-*`): one that must not reach the server reached is removed per contract by the client `client` returns, `HttpClient.mapRequest(HttpClientRequest.removeHeader("cookie"))`, which runs after them.
 * - A header `client`'s client sets replaces the caller's of that name, as it is set after them: a service's own `authorization` is sent in place of the caller's.
 * - A call with no HTTP request, as through `Action.client` in process or an MCP stdio surface, sends no header on: a protected one reaches the server reached with no credential, which refuses it with `Unauthenticated`.
 * - An error the server reached declares beyond the action's own and the built-in ones, its binding's `error` or its verifier's, is a defect where it is passed back, answered as one.
 * - A server reached that does not serve one of them, its route a 404, is a defect naming it, with the fix: a declared error whose status is 404 is passed back as it is.
 * - A refusal of a subscription by the server reached comes after the surface admitted it, so it ends the subscription's stream where the surface's own would have answered its 401 or 403.
 */
export const placed = <const H extends AnyHttp>(
  binding: H,
  client: (...routed: Routed<Contract<H>>) => HttpClient.HttpClient,
): Placed<H> => {
  // Why: Read as the erased signature a method's parameters are compared by, both ways: a
  // surface hands each contract its own decoded input.
  const route: {
    route(input: ErasedValue, contract: Action.Any | Event.Any): HttpClient.HttpClient;
  }["route"] = client;

  const sendingTo = (input: ErasedValue, contract: Action.Any | Event.Any) =>
    HttpClient.mapRequestInputEffect(route(input, contract), (request) =>
      Effect.map(forwarded, (headers) => HttpClientRequest.setHeaders(request, headers)),
    );

  const senders = sendersWith(binding, dispatching);

  const handlerOf = ({ method }: Senders<Sending>, action: Action.Any): WrittenHandler<unknown> => {
    const send = method(action);

    return (input, reporting) => {
      const sent = send(
        input,
        ...(reporting === undefined || reporting.dropped
          ? []
          : [{ onProgress: reporting.progress }]),
      );

      const sending = sendingTo(input, action);

      return Stream.isStream(sent)
        ? sent.pipe(
            Stream.provideService(Sending, sending),
            Stream.catchIf(isNotFound, () => Stream.die(notServedThere(action.name))),
          )
        : sent.pipe(
            Effect.provideService(Sending, sending),
            Effect.catchIf(isNotFound, () => Effect.die(notServedThere(action.name))),
          );
    };
  };

  const runOf = ({ transport }: Senders<Sending>, event: Event.Any): Run => ({
    poll: (input, cursor) =>
      transport(event, input)
        .poll(cursor)
        .pipe(
          Effect.provideService(Sending, sendingTo(input, event)),
          Effect.catchIf(isNotServed, () => Effect.die(notServedThere(event.name))),
        ),
    stream: (input, cursor) =>
      transport(event, input)
        .stream(cursor)
        .pipe(
          Stream.provideService(Sending, sendingTo(input, event)),
          Stream.catchIf(isNotServed, () => Stream.die(notServedThere(event.name))),
        ),
  });

  return [
    ...(binding.actions.length === 0
      ? []
      : [
          new Implementation<H["actions"][number], Nothing<H["actions"][number]>, never, never>(
            binding.actions,
            memoized(
              Effect.map(senders, (built): Written =>
                binding.actions.map((action) => [action, handlerOf(built, action)]),
              ),
            ),
            memoized(Effect.succeed(admitting)),
          ),
        ]),
    ...(binding.events.length === 0
      ? []
      : [
          new EventImplementation<H["events"][number], Nothing<H["events"][number]>, never, never>(
            binding.events,
            binding.events.map(
              (event) =>
                [event, memoized(Effect.map(senders, (built) => runOf(built, event)))] as const,
            ),
            memoized(Effect.succeed(admittingEvents)),
          ),
        ]),
  ];
};
