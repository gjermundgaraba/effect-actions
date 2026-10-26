import { describe, expect, it } from "@effect/vitest";
import { Predicate } from "effect";
import { withEvents } from "../../src/mcp/bridge.js";
import { httpProtocol } from "../../src/mcp/protocol.js";

const serving = { events: [], authentication: undefined };

const groups = ["clientRpcs", "handlerRpcs", "serverNotificationRpcs"] as const;

const requestsOf = (adapter: typeof httpProtocol, key: string): ReadonlyArray<string> => {
  const group: unknown = Predicate.hasProperty(adapter, key) ? adapter[key] : undefined;

  return Predicate.hasProperty(group, "requests") && group.requests instanceof Map
    ? [...group.requests.keys()].filter(Predicate.isString)
    : [];
};

describe("the MCP events bridge, over Effect's 2026-07-28 adapter", () => {
  it.each(groups)("finds the adapter's %s as a group of requests", (key) => {
    expect(requestsOf(httpProtocol, key).length).toBeGreaterThan(0);
  });

  it("admits, decodes and announces the events methods beside the adapter's own", () => {
    const extended = withEvents(httpProtocol, serving);
    const methods = ["events/list", "events/poll", "events/stream"];

    expect(requestsOf(extended, "handlerRpcs")).toEqual(
      expect.arrayContaining([...requestsOf(httpProtocol, "handlerRpcs"), ...methods]),
    );
    expect(requestsOf(extended, "clientRpcs")).toEqual(expect.arrayContaining(methods));
    expect(requestsOf(extended, "serverNotificationRpcs")).toEqual(
      expect.arrayContaining([
        "notifications/events/active",
        "notifications/events/event",
        "notifications/events/heartbeat",
        "notifications/events/error",
        "notifications/events/terminated",
      ]),
    );
  });

  it("names the effect line it supports where the adapter's groups moved", () => {
    const moved = Object.defineProperty({ ...httpProtocol }, "handlerRpcs", { value: undefined });

    expect(() => withEvents(moved, serving)).toThrow(
      "Effect's MCP 2026-07-28 adapter holds no handlerRpcs group: effect-actions supports MCP events on effect 4.0.x (install the effect version its peer range names)",
    );
  });
});
