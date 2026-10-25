import { Array as Arr, Cause, Effect, Layer, Predicate, Schema, Stream as Elements } from "effect";
import type { Scope, Context } from "effect";
import { Anyone, assertCaller } from "./caller.js";
import { assertDistinctTags, errorList, projectedErrors } from "./declared.js";
import { assertKnown, assertName, assertOnce, heldOnce } from "./names.js";
import { type Call, inputOf, onProgressOf } from "./call.js";
import { type BuiltIn, InvalidInput } from "./errors.js";
import { progressSink, type ReportingOf } from "./progress.js";
import { type Answer, elementOf } from "./stream.js";
import {
  type Authorizer,
  authorizerOf,
  type Deferred,
  type ErasedAuthorizer,
} from "./authorizer.js";
import type { NoInput } from "./codec.js";
import { type Codec, type CodecOf, codecOf, type Fields } from "./codec.js";
import {
  type ActionOf,
  type Authorize,
  type BuildServices,
  type BuildError,
  acquire,
  builtWith,
  elementsOf,
  type ErasedHandler,
  type ErasedValue,
  type Handlers as ErasedHandlers,
  Implementation,
  type Member,
  memoized,
  provideBuilders,
  type RequestOf,
  type Protected,
  type Holding,
  type Known,
  type Offered,
  type OptionalUnless,
  type SelectedOf,
  type Serving,
  select,
  type Served,
  toList,
  type Written,
  type WrittenHandler,
} from "./implementation.js";

export type { BuildServices } from "./implementation.js";

export type { BuildError } from "./implementation.js";

export type { Implementation } from "./implementation.js";

export type { Authorize } from "./implementation.js";

export type { AnyImplementation } from "./implementation.js";

export { Anyone } from "./caller.js";

export { Stream } from "./stream.js";

export type { StreamOf } from "./stream.js";

/**
 * How the action's tool presents itself over MCP, in MCP's own names; every field is optional
 * and none enforces anything. A hint left out is MCP's default, but `destructiveHint`, which is
 * `false` for a read-only action. `readOnlyHint` is not one: it is always the contract's
 * `readOnly`, so a tool cannot say otherwise than its contract.
 */
export interface Mcp {
  /** The tool's display name, `annotations.title`, beside its name. */
  readonly title?: string | undefined;
  /**
   * `annotations.destructiveHint`, meaningful for a write only. Left out, a write is listed as
   * destructive, MCP's default: state `false` for one that only adds, MCP's "only additive
   * updates". One that replaces, removes or interrupts, such as an edit or a restart, stays
   * destructive, an update of a stored flag such as "read" included.
   */
  readonly destructiveHint?: boolean | undefined;
  /** `annotations.idempotentHint`, meaningful for a write only. */
  readonly idempotentHint?: boolean | undefined;
  /** `annotations.openWorldHint`: whether the tool reaches entities outside its own domain. */
  readonly openWorldHint?: boolean | undefined;
  /** The tool's `_meta`, JSON such as an MCP App's UI resource, sent as given. */
  readonly _meta?: { readonly [key: string]: Schema.Json } | undefined;
}

export {
  BuiltIn,
  Forbidden,
  InvalidInput,
  type Issue,
  Refusal,
  Unauthenticated,
} from "./errors.js";

export { Image } from "./media.js";

/** What `make` needs to define an action. */
export interface Options {
  /**
   * Who may call the action: `Action.Anyone`, or the identity service a caller must have,
   * which every surface enforces whether or not the handler reads it. Required: an action that
   * names no caller is not public. A remote surface gets the identity by authenticating the
   * request; on a local surface the host provides it.
   *
   * **Gotchas**
   *
   * - Declare the identity as a `Context.Service`, in a contract file, apart from its verifier.
   * - One identity per action, and every protected action one remote surface serves names the same one; a tenant is a request-time requirement of the handler, not a second identity.
   * - No surface provides a public action an identity: an action whose answer depends on the caller is protected.
   * - Never provide an identity at startup, to a surface's layer: a call no authentication reaches, a public action's or a local surface's, runs as that identity, and the types do not stop it.
   */
  readonly caller:
    | typeof Anyone
    | (Context.Key<unknown, unknown> & {
        readonly defaultValue?: "An identity is a Context.Service, not a Context.Reference";
      });
  /** A model reads it beside the tool; a CLI prints it in `--help`. */
  readonly description: string;
  /**
   * A schema or struct fields. Omit, or give `{}`, for an action without arguments. A field's
   * `description` annotation is what a model reads in a tool's listing and a flag's help in a CLI.
   *
   * **Gotchas**
   *
   * - Never `Schema.Struct({})` for no arguments: it accepts any value but `null` and `undefined`, and MCP refuses it as a tool's input. Omit `input`: the action then takes `{}`.
   * - A field callers may omit is `Schema.optional`: on the wire `null` is also accepted and read as left out, as a tool's schema lists, while a typed client refuses `null`. `Schema.optionalKey` takes omission alone; `Schema.NullOr` keeps `null` as a value.
   * - A field with a decoding default, `Schema.withDecodingDefault`, is still required in a typed client's argument, whose type is the decoded one; the argument itself may be left out only when every field has one, as `{}` then encodes.
   * - An input that is a class encodes only its instances: a typed client given a plain object fails with `InvalidInput`, `Expected <Class>`.
   * - A `Schema.makeFilter` check adds nothing to a tool's listed input schema, and `Schema.isPattern` its `pattern` only for a RegExp with the `u` flag: say such a rule in the field's `description`, annotated before the check, since after a custom one it is lost too.
   */
  readonly input?: Codec | Fields | undefined;
  /**
   * A schema or struct fields, or `Action.Stream(element)` for an action answering a stream of
   * elements. Omit for an action that returns nothing, `Schema.Void`; what each surface answers
   * is on its `layer`, `layerHttp`, `runStdio`, `make` or `command`. A top-level field whose
   * schema is `Action.Image` is a media field: see `Action.Image`.
   */
  readonly success?: Codec | Fields | undefined;
  /**
   * A schema or struct fields: what the handler reports while it runs, through its second
   * argument's `progress`, before it answers. Omit for an action that reports nothing; the
   * handler then takes its input alone. A client's call takes `onProgress` after the input;
   * how each surface carries progress is on `ActionHttp.layer`, `ActionRpc.make`,
   * `ActionMcp.layerHttp`, `ActionToolkit.make` and `ActionCli.command`.
   *
   * **Gotchas**
   *
   * - Progress is a snapshot to show, not an event to count: values a caller falls behind on are dropped, the oldest first, while the answer never is.
   * - A value breaking the schema is the call's defect, as an answer breaking `success` is.
   * - A caller's `onProgress` that fails or dies is logged as a warning, and the call goes on and answers: the handler is never interrupted for it.
   * - In process, `Action.client`, the toolkit and a local command hand `onProgress` each value as reported, checked by the schema and never encoded: a value with no JSON form reaches them, and is the call's defect on a surface sending JSON.
   * - A value the caller's `progress` schema cannot decode, where client and server differ, is logged and dropped by MCP's client; RPC's and HTTP's clients decode it with the response, so the call fails with a `SchemaError`, `onProgress` given or not.
   */
  readonly progress?: Codec | Fields | undefined;
  /**
   * The declared failures: one schema, or a list of them, as `HttpApiEndpoint` takes them;
   * each keeps its own HTTP status annotation, the third argument of
   * `Schema.TaggedError<NoteNotFound>()("NoteNotFound", { id: Schema.String }, { httpApiStatus: 404 })`.
   * Defaults to none. A handler fails only with these and the built-in errors; every client
   * decodes each as a typed value.
   *
   * **Gotchas**
   *
   * - Over HTTP a declared error answers with its `httpApiStatus`, 422 without one; what the other surfaces answer is on their `layerHttp`, `runStdio`, `layer`, `make` or `command`.
   * - Two schemas sharing a `_tag` throw at `make`, `error _tag "<tag>" names two error schemas`, or at a binding's `make`, `binding of "<name>"`, for one of its errors against the action's or the authentication's; the message says the fix.
   * - A schema reached twice, listed again, through a union or `Schema.suspend`, is one schema; a union is its members unless it has its own `httpApiStatus`, checks or a transformation, so each member's `_tag` is checked against every other error's.
   * - Errors without a `_tag` are told apart by their other fields, the first that decodes winning: a failure an earlier schema also accepts is decoded as that one.
   * - An entry that is a `Schema.suspend` whose thunk reads a `const` declared further down throws a `ReferenceError` at `make`, which reads every `_tag` when called: declare the error first.
   * - A failure the schemas reject, undeclared or breaking a check, is the call's defect on every surface, beside the `SchemaError` saying why; a class error built with `disableChecks` is accepted and fails to encode instead.
   */
  readonly error?: Codec | ReadonlyArray<Codec> | undefined;
  /**
   * Whether the action leaves its resource unchanged. Required: an action nobody classified
   * is the one a reviewer must check. An implementation's `authorize` may read it, and MCP's
   * `readOnlyHint` is it; the library itself authorizes nothing with it. Derive authorization
   * from it, never from an `mcp` hint: changing an action's `readOnly` then changes who may
   * call it.
   */
  readonly readOnly: boolean;
  /** How the action's tool presents itself over MCP, and on a native Toolkit's tools. */
  readonly mcp?: Mcp;
}

type UnknownMcp<O> = O extends { readonly mcp?: infer H }
  ? Exclude<H extends unknown ? keyof H : never, keyof Mcp>
  : never;

type KnownMcp<O> = { readonly mcp?: { readonly [K in UnknownMcp<O>]: never } };

type ErrorMembers<G> = G extends ReadonlyArray<infer E> ? E : G;

type OnlyOptions<O> = {
  readonly [K in Exclude<O extends unknown ? keyof O : never, keyof Options>]: never;
};

// Why: `O` is inferred from the argument, which the compiler then never checks for excess
// properties: a misspelled option or hint would be ignored. Options that fail `Options` itself
// infer as `Options`, whose error the compiler already reports; checked against the rules too,
// a missing option would be reported as the whole argument not being assignable.
type Rules<O> = Options extends O ? unknown : OnlyOptions<O> & KnownMcp<O>;

type OptionOf<O, K extends keyof Options, Default> = O extends unknown
  ? K extends keyof O
    ?
        | Exclude<O[K], undefined>
        | ({} extends Pick<O, K> ? Default : undefined extends O[K] ? Default : never)
    : Default
  : never;

type SchemaOf<O, K extends "input" | "success", Default extends Codec> = CodecOf<
  Extract<OptionOf<O, K, Default>, Codec | Fields>
>;

type ProgressOf<O> = [Extract<OptionOf<O, "progress", never>, Codec | Fields>] extends [never]
  ? undefined
  : CodecOf<Extract<OptionOf<O, "progress", never>, Codec | Fields>>;

type ErrorSchemasOf<O> = ReadonlyArray<
  ErrorMembers<Extract<OptionOf<O, "error", []>, Codec | ReadonlyArray<Codec>>>
>;

/**
 * A pure contract: schemas and transport metadata, bound to handlers by `implement`. Its
 * `name`, `input`, `success`, `error` and `readOnly` are public: reuse them, as in
 * `Schema.Array(SaveLink.input)`.
 */
export interface Action<
  Name extends string,
  Input extends Codec,
  Success extends Codec,
  Errors extends ReadonlyArray<Codec>,
  ReadOnly extends boolean = boolean,
  Caller extends Options["caller"] = Options["caller"],
  Progress extends Codec | undefined = Codec | undefined,
> {
  readonly caller: Caller;
  readonly name: Name;
  readonly description: string;
  /**
   * The input as a schema, a `Schema.Struct` where fields were given: reuse it as it is, as in
   * `Schema.Array(action.input)`.
   */
  readonly input: Input;
  readonly success: Success;
  /** The declared failures, as a list: one given alone is a list of one. */
  readonly error: Errors;
  /** What the handler reports while it runs, as a schema; `undefined` where none is declared. */
  readonly progress: Progress;
  readonly readOnly: ReadOnly;
  /** The `mcp` options as given, none when left out. */
  readonly mcp: Mcp;
}

/** Any action, with its schemas erased. */
export type Any = Action<string, Codec, Codec, ReadonlyArray<Codec>>;

/**
 * A list of declared errors, as an action's `error` holds it, and a binding's or an
 * authentication descriptor's: `<E extends Action.Errors>` constrains one.
 */
export type Errors = ReadonlyArray<Codec>;

/**
 * Receives decoded input, and what it reports progress by where `A` declares `progress`; may
 * fail only with the declared errors and the built-in ones.
 */
export type Handler<A extends Any, R = never> = (
  input: A["input"]["Type"],
  ...reporting: ReportingOf<A>
) => Answer<A["success"], A["error"][number]["Type"] | BuiltIn, R>;

/**
 * The handlers of the actions `A`, keyed by name, as `implement` takes them: what a builder
 * written apart from `implement` returns, `satisfies Action.Handlers<typeof actions>`, so its
 * handlers are typed from their contracts, as another authorizer of the same handlers needs.
 */
export type Handlers<A extends ReadonlyArray<Any>, R = never> = {
  readonly [Action in A[number] as Action["name"]]: Handler<Action, R>;
};

/**
 * Define an action contract: what it takes and answers, whether it changes anything, and who
 * may call it. The name is also the route segment, the client method and the tool name.
 * Guide: `docs/Action.md` in this package; in an application: `examples/notes-service/src/notes/`.
 *
 * **Gotchas**
 *
 * - A name is unique within each binding, MCP endpoint, Toolkit, CLI and client holding it; its form is in the message `Invalid action name` throws.
 * - A contract says nothing about where it is served: an HTTP or RPC binding, or a surface given `actions`, serves an action only once it is listed; MCP, a Toolkit and a CLI given implementations alone serve every action they hold.
 * - Surfaces match an implementation to a contract by object identity, never by name: implement, bind and list the one exported value. A list narrowed at run time is still typed as holding every member.
 * - In a helper whose type parameter stands for `mcp`, `make` refuses the option, since it cannot check the hints: type the parameter `Action.Mcp`, or spread a constant.
 */
export function make<const Name extends string, const O extends Options>(
  name: Name,
  options: O & NoInfer<Rules<O>>,
): Action<
  Name,
  SchemaOf<O, "input", typeof NoInput>,
  SchemaOf<O, "success", typeof Schema.Void>,
  ErrorSchemasOf<O>,
  O["readOnly"],
  O["caller"],
  ProgressOf<O>
>;
export function make(name: string, options: Options): Any {
  assertName(name);

  const { caller, readOnly } = options;

  assertCaller(caller);

  if (readOnly !== true && readOnly !== false) {
    throw new Error(`Invalid readOnly: ${String(readOnly)} (set true or false)`);
  }

  const action: Any = {
    caller,
    name,
    description: options.description,
    input: codecOf(options.input ?? {}),
    success: options.success === undefined ? Schema.Void : codecOf(options.success),
    error: errorList(options.error),
    progress: options.progress === undefined ? undefined : codecOf(options.progress),
    readOnly,
    mcp: { ...options.mcp },
  };

  assertDistinctTags(`Action "${action.name}"`, projectedErrors(action));

  return action;
}

// Why: No signature refuses a list narrowed at run time, which is typed as holding members it may
// not. Rejected: keying a list of unknown length by `string`, which holds only under
// `noUncheckedIndexedAccess`, and requiring a tuple of single-named actions, which a variadic tuple
// or a union of tuples still passes.
/**
 * `actions` keyed by name, each its exact contract: `byName(actions).getUser`, its schemas
 * where a test or a mock reads them, and its types where a helper takes a name,
 * `(typeof contracts)[K]["input"]["Type"]`, which resolves under a generic `K` where
 * `Extract` over the list does not. The list is typed by its members, as every surface types
 * one. A name held twice is refused, as a surface refuses it.
 */
export function byName<const Actions extends ReadonlyArray<Any>>(
  actions: Actions,
): { readonly [A in Actions[number] as A["name"]]: A };
export function byName(actions: ReadonlyArray<Any>): { readonly [name: string]: Any } {
  assertOnce("action", actions);

  return Object.fromEntries(actions.map((action) => [action.name, action]));
}

type Target = Any | ReadonlyArray<Any>;

// Why: A sentence in the parameter's type, where the error TypeScript reports for a call without
// `authorize` ends. Rejected: a constraint named `ProtectedActionsTakeAuthorize`, the earlier
// decision. The error named it for one action alone, a list's named its member type, and both
// ended in `'typeof CurrentUser' is not assignable to type 'unique symbol'`.
type TakesNoAuthorize<T extends Target> = [Protected<ActionsOf<T>>] extends [never]
  ? unknown
  : "A protected action takes { authorize }: your rule, or Action.allowAll";

type ActionsOf<T extends Target> = T extends ReadonlyArray<Any> ? T[number] : Extract<T, Any>;

type NamesOf<T extends Target> = ActionsOf<T>["name"];

// Why: This must stay a named alias carrying `R`. While a builder's inner call, such as
// `Effect.gen`, is inferred, TypeScript keeps an alias's arguments marked as not yet inferred,
// where `never` or this type written inline becomes a candidate, and the builder's record loses its
// handlers' parameter types.
type NoHandler<R> = { readonly "~list": R };

// Why: `Handler` written out, not the alias, for the reason on `NoHandler`: an alias whose argument
// `R` is not yet inferred gives an `Effect.fn(...)` a builder returns nothing to infer from, and it
// takes an `any` input.
type Single<T extends Target, R> = T extends Any
  ? (
      input: T["input"]["Type"],
      ...reporting: ReportingOf<T>
    ) => Answer<T["success"], T["error"][number]["Type"] | BuiltIn, R>
  : NoHandler<R>;

// Why: Mapped over `RequestServices`, not over the actions' names: TypeScript infers it from the
// record key by key, so each handler, an `Effect.fn` included, is typed from its contract.
type Several<T extends Target, RequestServices> = {
  readonly [K in keyof RequestServices]: K extends NamesOf<T>
    ? Handler<Extract<ActionsOf<T>, { readonly name: K }>, RequestServices[K]>
    : never;
};

type HandlersOf<T extends Target, R, RequestServices> = Single<T, R> | Several<T, RequestServices>;

type Implemented<T extends Target, RequestServices, R, EX, RX, RA, EAX, RAX> = Implementation<
  ActionsOf<T>,
  {
    readonly [K in NamesOf<T>]: Exclude<
      T extends ReadonlyArray<Any> ? RequestServices[K & keyof RequestServices] : R,
      Scope.Scope
    >;
  },
  Deferred<EX>,
  Deferred<Exclude<RX, Scope.Scope>>,
  Exclude<RA, Scope.Scope>,
  Deferred<EAX>,
  Deferred<Exclude<RAX, Scope.Scope>>
>;

type Built = ErasedHandlers<unknown> | WrittenHandler<unknown>;

/** Every authenticated caller may call a protected action. */
export const allowAll: Authorize<Any> = () => Effect.void;

/**
 * Bind handlers to contracts, behind authorization: one action and its handler, or a list of
 * actions and a record of handlers keyed by action name, given directly or built by an Effect
 * whose services are startup requirements, while what a handler yields is a request-time
 * requirement. `authorize` is required when the list holds a protected contract and runs only
 * for those.
 *
 * **Gotchas**
 *
 * - A builder runs once per layer graph, however many surfaces serve its implementation; two `implement` calls are two builders, even of one builder Effect.
 * - What the builder yields is shared by every call; what a handler yields is resolved per call, as the caller must be. A builder yielding the caller is refused where the server is launched.
 * - Each call has a scope of its own: a resource that must outlive a call is the builder's.
 * - Pass the builder to `implement` itself: through `.pipe(...)` or a wrapper such as `Effect.withSpan`, an `Effect.fn` handler it returns takes an `any` input. A builder written apart returns its record `satisfies Action.Handlers<typeof actions>`.
 * - A record holds one own function per action of the list and no other key, or `implement` throws, a builder's when its layer builds; an inherited method does not count.
 * - Calling the function you passed to `implement` skips authorization and the codecs: call the implementation through `Action.client`.
 * - What a plain `authorize` yields is a request-time requirement of every surface; to read a store once, make `authorize` an Effect that yields it and returns the function.
 * - An authorizer fails only with `Unauthenticated` or `Forbidden`; a limit callers should see, such as a rate limit, is the handler's, declared in the action's `error`.
 */
// Why: Two overloads that no call can both be a candidate for: one takes three arguments, the
// other two. TypeScript then reports a mismatch as that of the one signature the call could have
// matched, where three candidates read "No overload matches this call. The last overload gave the
// following error." before the cause. This one is first, so an authorizer is typed from it.
export function implement<
  const T extends Target,
  RequestServices extends (T extends ReadonlyArray<Any>
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
  RA = never,
  EAX = never,
  RAX = never,
>(
  actions: T,
  handlers:
    | HandlersOf<T, R, RequestServices>
    | Effect.Effect<HandlersOf<T, R, RequestServices>, EX, RX>,
  options: [Protected<ActionsOf<T>>] extends [never]
    ? { readonly authorize?: "A public-only target takes no authorize" } | undefined
    : { readonly authorize: Authorizer<Protected<ActionsOf<T>>, RA, EAX, RAX> },
): Implemented<T, RequestServices, R, EX, RX, RA, EAX, RAX>;
export function implement<
  const T extends Target,
  RequestServices extends (T extends ReadonlyArray<Any>
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
>(
  actions: T & TakesNoAuthorize<T>,
  handlers:
    | HandlersOf<T, R, RequestServices>
    | Effect.Effect<HandlersOf<T, R, RequestServices>, EX, RX>,
): Implemented<T, RequestServices, R, EX, RX, never, never, never>;
export function implement(
  actions: Target,
  handlers: Built | Effect.Effect<Built, unknown, unknown>,
  options?: { readonly authorize?: ErasedAuthorizer<Any> },
): Implementation<Any, {}, unknown, unknown, unknown, unknown, unknown> {
  const listed = Arr.ensure(actions);
  const names = listed.map((action) => action.name);

  assertOnce("action", listed);

  const authorizer = authorizerOf(
    { singular: "action", module: "Action" },
    listed.some((action) => action.caller !== Anyone),
    options?.authorize,
  );

  const pairWithActions = (built: Built): Written => {
    const keyed: ErasedHandlers<unknown> = Predicate.isFunction(built)
      ? Object.fromEntries(Array.isArray(actions) ? [] : listed.map(({ name }) => [name, built]))
      : built;

    assertKnown("handlers", Object.keys(keyed), names, "remove it, or list its action");

    const bound = listed.flatMap((action) => {
      const handle = Object.hasOwn(keyed, action.name) ? keyed[action.name] : undefined;

      return Predicate.isFunction(handle) ? [[action, handle] as const] : [];
    });

    const missing = names.filter((name) => !bound.some(([action]) => action.name === name));

    if (missing.length > 0) {
      throw new Error(
        `Missing handlers: ${missing.join(", ")} (return the handler for one action, or a record with an own function per listed action)`,
      );
    }

    return bound;
  };

  const recorded = Effect.isEffect(handlers)
    ? Effect.map(handlers, pairWithActions)
    : Effect.succeed(pairWithActions(handlers));

  return new Implementation(listed, memoized(recorded), authorizer);
}

// Why: Rejected: a warning for two live builds of one implementation, which parallel tests, a
// `Layer.fresh` surface and a CLI beside a server set off legitimately.
/**
 * The builders of `implementations`, as one layer providing nothing. Surfaces build them
 * themselves, once per layer graph, but routes under `HttpRouter.serve` or `Testing.layer`
 * are built in a graph of their own, sharing nothing they build: provided above the server and
 * its siblings, it runs each builder once for every surface, with the services it is given.
 *
 * **Gotchas**
 *
 * - It builds every implementation it is given, those no surface serves included, so it owes their startup services.
 * - A job merged beside `HttpRouter.serve` with no `Action.layer` above both shares the server's build only when its own side builds first, which depends on timing: put the job inside the layer the server serves, or provide this layer above both.
 * - Do not wrap a server in `Layer.fresh`: two servers already share no build. It is for two surfaces in one graph that must each have a build of their own; provide what they share, authentication included, outside it.
 */
export function layer<const Apps extends Served>(
  implementations: Apps,
): Layer.Layer<never, BuildError<Member<Apps>>, BuildServices<Member<Apps>>>;
export function layer(implementations: Served): Layer.Layer<never, unknown, unknown> {
  return Layer.empty.pipe(
    provideBuilders(toList(implementations).map((app) => Implementation.layerOf(app))),
  );
}

type Method<A extends Any, R> = Call<
  A,
  Answer<A["success"], A["error"][number]["Type"] | BuiltIn, R>
>;

/**
 * Every action of the implementations `Apps`, one or a list, as `client.<action>(input)`: what
 * `client` gives, each method owing per call what its handler and `authorize` read.
 */
export type Client<
  Apps extends Served,
  Listed extends Any = Extract<ActionOf<Member<Apps>>, Any>,
> = {
  readonly [A in Serving<Member<Apps>, Listed> as A["name"]]: Method<A, RequestOf<Member<Apps>, A>>;
};

type ErasedMethod = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown, unknown> | Elements.Stream<ErasedValue, unknown, unknown>;

const jsonRoundTrip = <S extends Codec>(schema: S) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  const encode = Schema.encodeUnknownEffect(codec, { errors: "all" });
  const decode = Schema.decodeUnknownEffect(codec, { errors: "all" });

  return (value: S["Type"]): Effect.Effect<S["Type"], Schema.SchemaError> =>
    Effect.flatMap(encode(value), (encoded) => decode(encoded));
};

const mapFailuresInPlace = (
  cause: Cause.Cause<unknown>,
  failure: (error: ErasedValue) => Effect.Effect<ErasedValue, Schema.SchemaError>,
): Effect.Effect<Cause.Cause<unknown>> =>
  Effect.map(
    Effect.forEach(cause.reasons, (reason) =>
      Cause.isFailReason(reason)
        ? Effect.match(failure(reason.error), {
            onFailure: (refused) => Cause.combine(Cause.die(refused), Cause.die(reason.error)),
            onSuccess: (decoded) =>
              Cause.fail(
                Predicate.isError(reason.error) && Predicate.isError(decoded)
                  ? Object.assign(decoded, { stack: reason.error.stack })
                  : decoded,
              ),
          }).pipe(Effect.map((mapped) => Cause.annotate(mapped, Cause.reasonAnnotations(reason))))
        : Effect.succeed(Cause.fromReasons([reason])),
    ),
    (causes) => Cause.fromReasons(causes.flatMap(({ reasons }) => reasons)),
  );

const methodOf = (action: Any, run: ErasedHandler<unknown>): ErasedMethod => {
  const input = jsonRoundTrip(action.input);
  const element = elementOf(action.success);
  const success = jsonRoundTrip(element ?? action.success);
  const failure = jsonRoundTrip(Schema.Union(projectedErrors(action)));

  const declared = (cause: Cause.Cause<ErasedValue>) =>
    Effect.flatMap(mapFailuresInPlace(cause, failure), Effect.failCause);

  const called = (args: ReadonlyArray<ErasedValue>) =>
    inputOf(action, args).pipe(
      Effect.flatMap(input),
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.map((value) => run(value, progressSink(onProgressOf(args)))),
    );

  if (element !== undefined)
    return (...args) =>
      Elements.unwrap(Effect.map(called(args), elementsOf)).pipe(
        Elements.catchCause((cause) => Elements.fromEffect(declared(cause))),
        Elements.mapEffect((value) => Effect.orDie(success(value))),
      );

  return (...args) =>
    called(args).pipe(
      Effect.flatMap((answer) => Effect.catchCause(answer, declared)),
      Effect.flatMap((value) => Effect.orDie(success(value))),
    );
};

/** What `client` takes: the actions to call. */
export interface ClientOptions<A extends Any> {
  /**
   * The actions to call, among the implementations': `[GetUser]`. Defaults to every action of
   * them. Options whose `actions` may be absent are typed as every action, as they may run.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
}

/**
 * Call implementations in process: one method per action, taking its input directly as
 * `ActionHttp.client`'s methods do, `client.renameUser({ id, name })`, so moving between the
 * two changes the line acquiring it. A call runs as a remote one does, its input and its answer
 * through their JSON codecs, the implementation's `authorize` and the handler in a scope of
 * their own, failing with the action's errors and the built-in ones. Acquiring it builds the
 * implementations' builders into the layer graph it is acquired in, as a layer does, and its
 * scope holds them: acquire it where builders live.
 *
 * **Gotchas**
 *
 * - Provide the caller around each call, and startup services around the acquisition: a call reads its own context, never the one the client was acquired in, so one client serves every caller.
 * - Acquiring it needs a `Scope`: `it.effect` supplies one, elsewhere `Effect.scoped` does; acquired in a handler, it builds on every request.
 * - Two acquisitions share a build only inside one layer graph, such as under a layer provided around the program; with none around them, each builds its own.
 * - Every implemented action has a method, whether or not a surface serves it; `actions` lists the ones to call, and an implementation holding none of them is left unbuilt.
 * - It drops undeclared input fields as it encodes, and fails with `InvalidInput`, running nothing, for an input that does not encode.
 * - A builder acquiring a client of its own implementation is refused by the compiler, TS7022, and with the types bypassed never completes: call the services both use instead.
 */
export function client<
  const Apps extends Served,
  const O extends ClientOptions<ActionOf<Member<Apps>>> = {},
>(
  implementations: Apps,
  ...options: OptionalUnless<
    O,
    ClientOptions<ActionOf<Member<Apps>>> & O & NoInfer<Known<O, ClientOptions<Any>>>
  >
): Effect.Effect<
  Client<Apps, Offered<O, ActionOf<Member<Apps>>>>,
  BuildError<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>,
  BuildServices<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>> | Scope.Scope
>;
export function client(
  served: Served,
  options?: { readonly actions?: ReadonlyArray<Any> | undefined },
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, unknown, unknown> {
  const apps = select(toList(served), options?.actions);

  assertOnce(
    "action",
    apps.flatMap((app) => app.actions),
    heldOnce,
  );

  return Effect.map(
    builtWith(
      apps.map((app) => Implementation.layerOf(app)),
      acquire(apps),
    ),
    (bound) =>
      Object.fromEntries(bound.map(([action, run]) => [action.name, methodOf(action, run)])),
  );
}
