import {
  Cause,
  Clock,
  Console,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Schema,
} from "effect";
import { constVoid } from "effect/Function";
import type { Stdio as StdioService } from "effect/Stdio";
import { McpProtocol, McpServer, type McpSchema, Tool } from "effect/ai";
import type { HttpRouter } from "effect/http";
import type * as Action from "./Action.js";
import type { IsUnion } from "./internal/actions.js";
import { defaultPath, httpProtocol } from "./internal/mcp.js";
import { recordStepUp } from "./internal/refusal.js";
import { bindTools, type Projection } from "./internal/tools.js";
import {
  type ActionOf,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type Member,
  provideHandlers,
  type RequestContext,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * An MCP server, over HTTP or stdio: every native `McpServer.layerStdio` option except
 * `protocols`, the server information, `instructions` and `extensions`.
 */
export type Options = Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols">;

/**
 * One Streamable HTTP MCP endpoint: every native `McpServer.layerHttp` option except
 * `protocols`, `Options` and `allowedOrigins` among them, with `path` defaulting to `/mcp`.
 */
export interface LayerHttpOptions extends Omit<
  Parameters<typeof McpServer.layerHttp>[0],
  "protocols" | "path"
> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
}

/**
 * The revisions served over stdio: 2026-07-28 and every stateful revision a host negotiates
 * with `initialize`, newest first. A success is the same `{ value }` text on each; revisions
 * before 2025-06-18 have no `structuredContent` to repeat it in, nor 2024-11-05 tool hints.
 */
const stdioProtocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

/** What a group indents the output inside it by, as Node's console does. */
const groupIndentation = "  ";

/**
 * A timer's elapsed time as Node's console prints it below a minute: in milliseconds, from a
 * second in seconds. Past a minute it stays in seconds, where Node's console prints minutes.
 */
const elapsed = (nanos: bigint): string => {
  const millis = Number(nanos) / 1e6;

  return millis < 1000 ? `${Number(millis.toFixed(3))}ms` : `${(millis / 1000).toFixed(3)}s`;
};

/**
 * The console of a stdio server, whose stdout carries the protocol. Every method writes
 * through `console.error` alone, so every console logger, `Console.log` and the default
 * logger alike, leaves the protocol intact, and so do counters, timers and group labels,
 * which Node's console prints on stdout. Counts, timers, read on `clock`, and group
 * indentation are this console's own, with Node's labels, defaults and warnings. What
 * `error` cannot rebuild is left out: a group indents only the first line of a value the
 * console inspects, a timer prints seconds past a minute, `dir` takes no inspect options,
 * `table` prints its data without a grid or column filter, and `clear` clears nothing.
 */
const stderrConsole = (console: Console.Console, clock: Clock.Clock): Console.Console => {
  const counts = new Map<string, number>();
  const timers = new Map<string, bigint>();
  let indent = "";

  // Indented by the open groups: every line of a first string argument, which the console
  // prints as it is, and the first line of anything else, so no value it prints is changed.
  const write = (...args: ReadonlyArray<unknown>) => {
    const [first, ...rest] = args;

    if (args.length === 0) {
      console.error(indent);
    } else if (Predicate.isString(first)) {
      console.error(indent + first.replaceAll("\n", `\n${indent}`), ...rest);
    } else {
      // The console joins arguments with a space, so one space less indents one it inspects.
      console.error(...(indent === "" ? [] : [indent.slice(1)]), first, ...rest);
    }
  };

  // Node emits these as process warnings, outside any group.
  const warning = (message: string) => console.error(`Warning: ${message}`);

  const report = (method: "timeLog" | "timeEnd", label: string, data: ReadonlyArray<unknown>) => {
    const start = timers.get(label);

    if (start === undefined) {
      warning(`No such label '${label}' for console.${method}()`);
    } else {
      write("%s: %s", label, elapsed(clock.monotonicTimeNanosUnsafe() - start), ...data);
    }
  };

  // Effect's `Console.group` passes a missing label as `undefined`: a group without a label.
  const group = (...label: ReadonlyArray<unknown>) => {
    if (label.some((part) => part !== undefined)) write(...label);

    indent += groupIndentation;
  };

  return {
    assert: (condition, ...args: ReadonlyArray<unknown>) => {
      const [first, ...rest] = args;

      if (!condition) {
        write(
          ...(Predicate.isString(first)
            ? [`Assertion failed: ${first}`, ...rest]
            : ["Assertion failed", ...args]),
        );
      }
    },
    // Node clears only a terminal on stdout, which here carries the protocol.
    clear: constVoid,
    count: (label = "default") => {
      const count = (counts.get(label) ?? 0) + 1;

      counts.set(label, count);
      write(`${label}: ${count}`);
    },
    countReset: (label = "default") => {
      if (!counts.delete(label)) warning(`Count for '${label}' does not exist`);
    },
    debug: write,
    dir: (item) => write("%O", item),
    dirxml: write,
    error: write,
    group,
    groupCollapsed: group,
    groupEnd: () => {
      indent = indent.slice(groupIndentation.length);
    },
    info: write,
    log: write,
    table: (data) => write(data),
    time: (label = "default") => {
      if (timers.has(label)) {
        warning(`Label '${label}' already exists for console.time()`);
      } else {
        timers.set(label, clock.monotonicTimeNanosUnsafe());
      }
    },
    timeEnd: (label = "default") => {
      report("timeEnd", label, []);
      timers.delete(label);
    },
    timeLog: (label = "default", ...data: ReadonlyArray<unknown>) => report("timeLog", label, data),
    trace: (...args: ReadonlyArray<unknown>) => {
      const [first, ...rest] = args;
      // The caller's stack: without the header line and this function's own frame.
      const { stack = "" } = new Error();
      const frames = stack.split("\n").slice(2).join("\n");

      write(
        ...(args.length === 0
          ? ["Trace"]
          : Predicate.isString(first)
            ? [`Trace: ${first}`, ...rest]
            : ["Trace:", ...args]),
      );

      if (frames !== "") write(frames);
    },
    warn: write,
  };
};

/**
 * Whether an input encoding `E` is one object with keys, a record included, as the JSON
 * Schema root of a tool's arguments must be: not a union, an array, a scalar, nor an object
 * without keys, such as `Schema.Struct({})`'s. An erased input passes; the native server
 * refuses what the types cannot see when the layer is built.
 */
type ObjectInput<E> = 0 extends 1 & E
  ? true
  : unknown extends E
    ? true
    : true extends IsUnion<E>
      ? false
      : E extends ReadonlyArray<unknown>
        ? false
        : E extends object
          ? [keyof E] extends [never]
            ? false
            : true
          : false;

/** The names of the actions among `A` whose input is not one object with keys. */
type NotObjectInput<A> = A extends Action.Any
  ? ObjectInput<A["input"]["Encoded"]> extends true
    ? never
    : A["name"]
  : never;

/**
 * Nothing when every action `Apps` implement has input MCP can serve; otherwise a property no
 * implementation has, naming the actions whose input is not one object, so the call is a
 * type error that names them. The entry is selected by a key distributed over `Apps`, so
 * where `Apps` is a helper's own type parameter, alone or spread into a list, the compiler
 * reads the key through the helper's constraint, whose erased input is served; a conditional
 * type would instead demand that its `Apps` satisfy the refusal too. A list holding a type
 * parameter is refused, its input unread. A union argument takes each member's key, and so
 * passes when one member is served.
 */
type McpInputs<Apps> = {
  readonly served: unknown;
  readonly refused: {
    readonly "MCP tool input must be one object with keys, such as a struct": NotObjectInput<
      ActionOf<Member<Apps>>
    >;
  };
}[Apps extends unknown
  ? [NotObjectInput<ActionOf<Member<Apps>>>] extends [never]
    ? "served"
    : "refused"
  : never];

/**
 * The native server supplies its own request context to every tool call, and over HTTP
 * the router its own, such as the request.
 */
type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext>;

type HttpToolRequestContext<R> = Exclude<ToolRequestContext<R>, HttpRouter.Provided>;

/**
 * MCP has a JSON-only wire contract. Success uses its documented `{ value }`
 * structured-content envelope; declared failures are returned as JSON text. The native
 * server refuses undeclared arguments, publishes closed input schemas, and rejects any
 * input whose JSON Schema root is not an object. A step-up refusal is recorded, so that
 * under `Authentication.make` it answers the request.
 */
const tools: Projection = {
  label: "MCP tool",
  tool: (action, errors) =>
    Tool.make(action.name, {
      description: action.description,
      parameters: Schema.toCodecJson(action.input),
      success: Schema.toCodecJson(Schema.Struct({ value: action.success })),
      failure: Schema.toCodecJson(Schema.Union(errors)),
      failureMode: "return",
    }).annotate(Tool.Strict, true),
  handler: (run) => (input) => Effect.map(recordStepUp(run(input)), (value) => ({ value })),
};

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
) => {
  const binding = bindTools(apps, tools);

  // Registered with only the registry and the tool handlers: the native server lays the
  // context it registers in over every call's. Each handler keeps what it was built with,
  // which, as in a `Toolkit` call, fills in only what the call's request lacks.
  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    const handlers = yield* Layer.build(binding.layer);

    yield* McpServer.registerToolkit(binding.toolkit).pipe(
      Effect.setContext(Context.add(handlers, McpServer.McpServer, registry)),
    );
  });

  return Layer.effectDiscard(register).pipe(
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one. Only
    // the registry: handlers are provided outside it, so builders stay shared.
    Layer.fresh,
    provideHandlers(apps),
  );
};

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * An endpoint is one route: middleware provided around this layer, such as
 * authentication, covers every tool of it, tool listing included, with the normal HTTP
 * lifetime. Tools under different middleware go on endpoints of their own. Under
 * `Authentication.make`, a call refused with `Unauthenticated`, or with `Forbidden` naming
 * scopes, is answered with its HTTP status and challenge, 401 or 403, as MCP authorization
 * requires; any other failure, and every failure without it, is a tool result. What
 * middleware provides per request wins over what the endpoint was built with; still, never
 * provide an identity at startup, which a route no authentication covers serves to anyone.
 */
export function layerHttp<const Apps extends Served>(
  implementations: Apps & NoInfer<McpInputs<Apps>>,
  options: LayerHttpOptions,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  | BuildContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", HttpToolRequestContext<RequestContext<Member<Apps>>>>
>;
export function layerHttp(apps: Served, options: LayerHttpOptions) {
  return server(
    toList(apps),
    McpServer.layerHttp({
      ...options,
      path: options.path ?? defaultPath,
      protocols: [httpProtocol],
    }),
  );
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28 or any earlier revision back to 2024-11-05, as the host negotiates: the whole
 * program of an MCP subprocess, which succeeds when the host closes its side. A signal
 * interrupts it.
 *
 * Effect logs go to stderr, since stdout carries the protocol. The host supplies the
 * `Stdio` service and the identity. Arguments are tool input only and never establish
 * request identity or authority; each implementation's `before` hook runs.
 */
export function runStdio<const Apps extends Served>(
  implementations: Apps & NoInfer<McpInputs<Apps>>,
  options: Options,
): Effect.Effect<
  void,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  BuildContext<Member<Apps>> | StdioService | ToolRequestContext<RequestContext<Member<Apps>>>
>;
export function runStdio(apps: Served, options: Options) {
  const transport = server(
    toList(apps),
    McpServer.layerStdio({ ...options, protocols: stdioProtocols }),
  );

  // The native transport ends by interrupting the fiber that built it once the host closes
  // its side. Built in a child, that is a normal end, while an interruption of the program
  // itself, such as a signal, stays one. Stdout carries the protocol, so logs go to stderr.
  return Layer.launch(transport).pipe(
    Effect.provideServiceEffect(
      Console.Console,
      Effect.zipWith(Effect.service(Console.Console), Effect.service(Clock.Clock), stderrConsole),
    ),
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.void,
    ),
  );
}
