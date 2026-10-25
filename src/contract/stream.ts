import { type Effect, Predicate, Schema, Stream as Elements } from "effect";
import { type Codec, type CodecOf, codecOf, type Fields } from "./codec.js";

const TypeId = "~effect-actions/Stream";

/** The success of an action answering a stream: a schema of `Stream`s, holding its element's. */
export interface StreamOf<Element extends Codec> extends Schema.declare<
  Elements.Stream<Element["Type"]>
> {
  readonly Rebuild: StreamOf<Element>;
  readonly [TypeId]: typeof TypeId;
  /** The schema of each element. */
  readonly element: Element;
}

const streams = Schema.declare(Elements.isStream);

/**
 * A success that is a stream of `element`, a schema or struct fields: the handler returns a
 * `Stream` of them, which may fail with the action's errors, and every client's call returns
 * one. How each surface carries it is on `ActionHttp.layer`, `ActionRpc.make`,
 * `ActionMcp.layerHttp`, `ActionToolkit.make` and `ActionCli.command`.
 * Guide: `docs/Action-streams.md` in this package; in an application: build-events' `tailLog`.
 *
 * **Gotchas**
 *
 * - A tool answers one result, so MCP and a toolkit collect the whole stream before they answer, its elements as one array: a stream that never ends never answers there.
 * - An element breaking its schema is the call's defect, as an answer breaking `success` is.
 * - With `progress`, values and elements are each in their order, not against each other: a value may reach `onProgress` after an element yielded after it.
 */
export const Stream = <const E extends Codec | Fields>(element: E): StreamOf<CodecOf<E>> =>
  Schema.make<StreamOf<CodecOf<E>>>(streams.ast, { [TypeId]: TypeId, element: codecOf(element) });

/** The element schema of an action answering a stream, `undefined` for any other action. */
export const elementOf = (success: Codec): Codec | undefined =>
  isStreamOf(success) ? success.element : undefined;

const isStreamOf = (success: Codec): success is StreamOf<Codec> =>
  Predicate.hasProperty(success, TypeId);

// Why: Not distributive, and `never` answering one value: a handler of an erased list's action,
// `Extract`ed by a name it may not hold, is a `Handler<never>`, which any handler satisfies.
/** What a handler or a call of an action with success `S` answers: a stream, or one value. */
export type Answer<S extends Codec, E, R> = [S] extends [never]
  ? Effect.Effect<never, E, R>
  : [S] extends [StreamOf<infer Element>]
    ? Elements.Stream<Element["Type"], E, R>
    : Effect.Effect<S["Type"], E, R>;

/**
 * The success a tool answers for an action with success `S`: an array of the elements of one
 * answering a stream, collected whole, or `S`.
 */
export type ToolSuccess<S extends Codec> = [S] extends [StreamOf<infer Element>]
  ? Schema.$Array<Element>
  : S;

/** The success a tool answers for an action with `success`, as `ToolSuccess` types it. */
export const toolSuccessOf = (success: Codec): Codec => {
  const element = elementOf(success);

  return element === undefined ? success : Schema.Array(element);
};

/** What a call of an action with success `S` gives one at a time: an element, or its answer. */
export type Each<S extends Codec> = [S] extends [StreamOf<infer Element>]
  ? Element["Type"]
  : S["Type"];
