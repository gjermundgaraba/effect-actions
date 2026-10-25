import { type Context, Effect, type Layer, Schema, SchemaGetter } from "effect";
import { type Prompt, Tool, Toolkit } from "effect/ai";
import type * as Action from "../contract/Action.js";
import type { BuiltIns } from "../contract/errors.js";
import { projectedErrors } from "../contract/declared.js";
import { hintsOf } from "../contract/hints.js";
import type { Codec } from "../contract/codec.js";
import { progressSink } from "../contract/progress.js";
import { assertOnce, heldOnce } from "../contract/names.js";
import { type ToolSuccess, toolSuccessOf } from "../contract/stream.js";
import {
  acquire,
  type ActionOf,
  answeringWhole,
  type AnyImplementation,
  type BuildServices,
  type BuildError,
  type Holding,
  Implementation,
  type Known,
  type Member,
  type Offered,
  type OptionalUnless,
  provideHandlers,
  type RequestOf,
  select,
  type Served,
  toList,
  type SelectedOf,
  type Serving,
  type ErasedValue,
} from "../contract/implementation.js";

type NativeTool<A extends Action.Any, R> = Tool.Tool<
  A["name"],
  {
    readonly parameters: Schema.toCodecJson<A["input"]>;
    readonly success: A["progress"] extends Codec
      ? Schema.toCodecJson<
          Schema.Union<readonly [ProgressOf<A["progress"]>, ToolSuccess<A["success"]>]>
        >
      : Schema.toCodecJson<ToolSuccess<A["success"]>>;
    readonly failure: Schema.toCodecJson<
      Schema.Union<ReadonlyArray<A["error"][number] | BuiltIns>>
    >;
    readonly failureMode: "return";
  },
  R
>;

type ToolFor<App, Listed extends Action.Any> = App extends unknown
  ? Serving<App, Listed> extends infer A extends Action.Any
    ? A extends Action.Any
      ? NativeTool<A, RequestOf<App, A>>
      : never
    : never
  : never;

/**
 * Native tools bound to their action implementations: a native `Toolkit` and the layer of
 * its handlers, for `LanguageModel`, `Toolkit.merge` or `handle`. Tools belong to their
 * implementations: the `layer` of a `make` call serves the tools it selected in any `toolkit`
 * of the same implementations, while two implementations never run each other's handlers,
 * even with tools of one name.
 *
 * **Gotchas**
 *
 * - Two `make` calls of one implementation share their handlers: their `layer`s, given different startup services and provided together, serve both toolkits with one of them; use separate implementations for separate services.
 * - Another implementation's `layer` with tools of the same names type-checks, and the first call dies with Effect's `Cannot read properties of undefined (reading 'context')`: provide the `layer` the same `make` returned.
 * - `handle(name, arguments)` on `yield* toolkit` takes the JSON a model sends; its handler starts when `handle` runs, so the caller is provided around the whole `handle(...).pipe(Effect.flatMap(Stream.runCollect))`, never around the stream alone.
 */
export interface Tools<T extends Record<string, Tool.Any>, E, R> {
  /**
   * The native toolkit: its `tools` are the definitions, by name, with schemas, hints and approval.
   */
  readonly toolkit: Toolkit.Toolkit<T>;
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Tool.HandlersFor<T>, E, R>;
}

/**
 * One call of a tool, as `needsApproval` receives it: its action's name, the action, and
 * the call's decoded input.
 */
export type ToolCall<A extends Action.Any = Action.Any> = A extends Action.Any
  ? {
      readonly name: A["name"];
      readonly action: A;
      readonly input: A["input"]["Type"];
    }
  : never;

/** How `make` projects its tools, the actions `A`. */
export interface Options<A extends Action.Any> {
  /**
   * The actions that are tools, among the implementations' actions: `[GetUser, RenameUser]`.
   * Each keeps its implementation's authorization and builder. Defaults to every action of them,
   * one added to an implementation later included.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * Whether a model's call needs approval before it runs: a boolean, or an Effect of one, for
   * each call, with Effect's native approval context. `LanguageModel` asks for approval
   * instead of calling the tool when it is `true`, and when the Effect fails, so a policy that
   * cannot be read asks; a defect, a throw included, ends the turn as Effect's own does. The
   * Effect runs in the caller's context and requires nothing, so it reads the caller with
   * `Effect.serviceOption`. Defaults to none.
   *
   * **Gotchas**
   *
   * - `call` ranges over every action of the implementations, whatever `actions` lists: check `call.name` to narrow `action` and `input`.
   * - Approval authorizes nothing, which stays `authorize`'s, and only a model's turn asks for it: `handle` and `ActionMcp` never do.
   */
  readonly needsApproval?: (
    call: ToolCall<A>,
    context: Tool.NeedsApprovalContext,
  ) => boolean | Effect.Effect<boolean, unknown>;
}

interface ErasedOptions {
  readonly actions?: ReadonlyArray<Action.Any> | undefined;
  needsApproval?(
    this: void,
    call: ToolCall<Action.Any>,
    context: Tool.NeedsApprovalContext,
  ): boolean | Effect.Effect<boolean, unknown>;
}

const annotateIfGiven = <I, S>(tool: Tool.Any, key: Context.Key<I, S>, value: S | undefined) =>
  value === undefined ? tool : tool.annotate(key, value);

// Why: Every hint is annotated from the `hintsOf` MCP's listing spreads, so the two cannot
// disagree: MCP's default where the contract leaves one out, except `destructiveHint`, which MCP
// defaults to `true` for every tool and the library to `false` for a read. 0.10.0 annotated a
// hint only where given and left the rest to Effect's defaults, which MCP's listing no longer
// reads.
const annotateFromContract = (tool: Tool.Any, action: Action.Any) => {
  const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = hintsOf(action);
  const { title, _meta } = action.mcp;

  const hinted = tool
    .annotate(Tool.Readonly, readOnlyHint)
    .annotate(Tool.Destructive, destructiveHint)
    .annotate(Tool.Idempotent, idempotentHint)
    .annotate(Tool.OpenWorld, openWorldHint);

  return annotateIfGiven(
    annotateIfGiven(hinted, Tool.Title, title),
    Tool.Meta,
    _meta === undefined ? undefined : { ..._meta },
  );
};

/** A value an action reported, as a toolkit's preliminary result holds it. */
class Reported<A> {
  readonly _tag = "Progress";

  constructor(readonly value: A) {}
}

// Why: Progress tagged, and tried first: a preliminary result is encoded with the tool's one
// success schema, where an untagged value the success also accepts would be encoded as a success,
// cut to its fields, or as `null` against a `Void` one. Its member accepts only a `Reported`, so
// a success shaped `{ _tag: "Progress", value }` itself is encoded as the success, however its
// fields overlap a progress value's.
/** A preliminary result of a tool whose action declares `progress`: one value it reported. */
const ProgressOf = (progress: Codec) =>
  Schema.TaggedStruct("Progress", { value: progress }).pipe(
    Schema.decodeTo(
      Schema.declare((input): input is Reported<unknown> => input instanceof Reported),
      {
        decode: SchemaGetter.transform(({ value }) => new Reported(value)),
        encode: SchemaGetter.transform((reported) => ({
          _tag: "Progress" as const,
          value: reported.value,
        })),
      },
    ),
  );

type ProgressOf<P> = P extends Codec
  ? Schema.decodeTo<
      Schema.declare<Reported<P["Type"]>>,
      Schema.TaggedStruct<"Progress", { readonly value: P }>
    >
  : never;

const jsonToolOf = (action: Action.Any) => {
  const success = toolSuccessOf(action.success);

  return Tool.make(action.name, {
    description: action.description,
    parameters: Schema.toCodecJson(action.input),
    success: Schema.toCodecJson(
      action.progress === undefined
        ? success
        : Schema.Union([ProgressOf(action.progress), success]),
    ),
    failure: Schema.toCodecJson(Schema.Union(projectedErrors(action))),
    failureMode: "return",
  });
};

type ErasedTools = Tools<Record<string, Tool.Any>, unknown, unknown>;

/**
 * Project implementations into Effect's native AI toolkit: one tool per action, keyed by its
 * name, of the listed `actions` or, without them, of every action of the implementations.
 * Startup services build `layer`; request services, the identity `authorize` reads included,
 * are provided around each turn or call the toolkit handles. Guide: `docs/ActionToolkit.md` in
 * this package; a loop served behind a route, with approval:
 * `examples/kitchen-sink/src/assistant/`.
 *
 * **Gotchas**
 *
 * - An action answering a stream, `Action.Stream`, answers its elements collected into one array once the stream ends, its tool's success that array.
 * - An action declaring `progress` streams each value as a result with `preliminary: true` before its success, its `result` `{ _tag: "Progress", value }`, so its tool's success schema is that or `success`; a model reads the success alone.
 * - A success is a result with `isFailure: false`, `result` the value and `encodedResult` its JSON; a declared error a result with `isFailure: true` and `result` the error, which the model reads, never a raised failure; a refusal as `Action.Unauthenticated` and `Action.Forbidden` say.
 * - Arguments that do not decode are a result with `isFailure: true` whose `result` is an `AiError` with `reason` a `ToolParameterValidationError`, never `InvalidInput`, and neither `authorize` nor the handler runs; undeclared arguments are dropped and the call runs.
 * - A defect, or a failure the action's errors reject, is the call's defect; a success or an error that does not encode fails the call with an `AiError`, `Failed to encode result for tool …`.
 */
export function make<
  const Apps extends Served,
  const O extends Options<ActionOf<Member<Apps>>> = {},
>(
  implementations: Apps,
  ...options: OptionalUnless<
    O,
    Options<ActionOf<Member<Apps>>> & O & NoInfer<Known<O, Options<Action.Any>>>
  >
): Tools<
  {
    readonly [T in ToolFor<Member<Apps>, Offered<O, ActionOf<Member<Apps>>>> as T["name"]]: T;
  },
  BuildError<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>,
  BuildServices<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
>;
export function make(apps: Served, options?: ErasedOptions): ErasedTools {
  const served = select(toList(apps), options?.actions);

  const needsApproval = options?.needsApproval;

  assertOnce(
    "tool",
    served.flatMap((app) => app.actions),
    heldOnce,
  );

  // Why: Effect finds a tool's handler by the tool's `id`, which no type states, so the id carries
  // its implementation's key. A key per `make` call separates nothing its implementation does not,
  // and a toolkit and a layer from two calls then type-check, as `Tool.HandlersFor` is keyed by
  // name, and die on the first call.
  const toolOf = (action: Action.Any, app: AnyImplementation) =>
    Object.assign(
      needsApproval === undefined
        ? jsonToolOf(action)
        : jsonToolOf(action).setNeedsApproval((input, context) => {
            const decided = needsApproval({ name: action.name, action, input }, context);

            // Why: A policy that cannot be read asks, where Effect's own default on a failure runs the
            // call; a defect is a bug, left to end the turn as Effect ends it.
            return Effect.isEffect(decided)
              ? Effect.catch(decided, () => Effect.succeed(true))
              : decided;
          }),
      { id: `${Implementation.runKey(app)}/${action.name}` },
    );

  const toolkit = Toolkit.make(
    ...served.flatMap((app) =>
      app.actions.map((action) => annotateFromContract(toolOf(action, app), action)),
    ),
  );

  const layer = toolkit.toLayer(
    Effect.map(acquire(served), (bound) =>
      Object.fromEntries(
        bound.map(([action, handler]) => {
          const run = answeringWhole(action, handler);

          return [
            action.name,
            (input: ErasedValue, { preliminary }: Toolkit.HandlerContext<Tool.Any>) =>
              run(
                input,
                progressSink((value) => preliminary(new Reported(value))),
              ),
          ];
        }),
      ),
    ),
  );

  return { toolkit, layer: layer.pipe(provideHandlers(served)) };
}

/** A tool call a model asked to have approved, which no answer has resolved yet. */
export interface Approval {
  /** What a `tool-approval-response` names to answer it. */
  readonly approvalId: string;
  readonly toolCallId: string;
  /** The tool's name, the action's. */
  readonly name: string;
  /**
   * The call's arguments as the model sent them: show them as JSON, and decode them with
   * `Schema.toCodecJson(<action>.input)`, the tool's parameters, only where you read a field.
   */
  readonly params: unknown;
}

/**
 * The approval requests still open in a conversation's history, such as a `Chat`'s, in the
 * order they were asked: those with neither an answer nor a tool result. An answer recorded
 * without a result, as a `streamText` turn that failed while its call ran leaves it, is not
 * open: the next turn acts on it unasked, and another answer would run the call twice. A turn's
 * response lists only the requests that turn made, and the answering turn's none, so read every
 * open one here. Each names the call an answer would run, found as Effect finds it: the last
 * request with its `approvalId`, listed where it was asked, and the last call with its id.
 * Guide: `docs/ActionToolkit.md` in this package; in an application:
 * `examples/kitchen-sink/src/assistant/handlers.ts`.
 */
export const openApprovals = ({ content: messages }: Prompt.Prompt): ReadonlyArray<Approval> => {
  const said = messages.flatMap((message) => (message.role === "assistant" ? message.content : []));
  const told = messages.flatMap((message) => (message.role === "tool" ? message.content : []));

  const answered = new Set(
    told.flatMap((part) => (part.type === "tool-approval-response" ? [part.approvalId] : [])),
  );

  const ran = new Set(told.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])));

  const calls = new Map(
    said.flatMap((part) => (part.type === "tool-call" ? [[part.id, part] as const] : [])),
  );

  const requests = said
    .filter((part) => part.type === "tool-approval-request")
    .filter(
      ({ approvalId }, place, all) =>
        all.findLastIndex((later) => later.approvalId === approvalId) === place,
    );

  return requests.flatMap(({ approvalId, toolCallId }) => {
    const call = calls.get(toolCallId);

    return call === undefined || answered.has(approvalId) || ran.has(toolCallId)
      ? []
      : [{ approvalId, toolCallId, name: call.name, params: call.params }];
  });
};
