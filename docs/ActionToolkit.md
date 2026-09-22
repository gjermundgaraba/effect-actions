# ActionToolkit

Implementations as Effect's native AI `Toolkit`, for programs that call tools in-process
with `LanguageModel` or by hand. No server, no MCP envelope.

## API

```ts
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";

function make<const Apps extends ReadonlyArray<AnyImplementation>, Errors = [], RB = never>(
  options: Options<Errors, RB>,
  ...apps: Apps
): Binding<
  ToolkitTools<Apps, Errors[number], RB>,
  BuildError<Apps[number]>,
  BuildContext<Apps[number]>
>;

interface Options<Errors = [], RB = never> {
  readonly errors?: Errors; // declared on every tool of this binding
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], RB>;
}

interface Binding<Tools, E, R> {
  readonly toolkit: Toolkit.Toolkit<Tools>; // native; tool names, schemas and requirements stay typed
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Tools>, E, R>;
}

// Each MCP-enabled action becomes:
Tool.Tool<
  McpName,
  {
    parameters: A["input"];
    success: A["success"];
    failure: Schema.Union<ReadonlyArray<A["errors"][number] | Errors[number]>>;
    failureMode: "return";
  },
  HandlerRequirements | RB
>;
```

## Canonical

```ts
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { actors, authorize, CurrentActor, Forbidden } from "./auth.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

// The in-process caller binds the same rule as the guarded servers.
const binding = ActionToolkit.make({ errors: [Forbidden], before: authorize }, UserApp);

const program = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("get_user", { id: "1" }); // encoded arguments
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(
  Effect.provideService(CurrentActor, actors.alice), // identity around the whole invocation
  Effect.provide(binding.layer.pipe(Layer.provide(Users.layerMemory))), // startup services only
);

program.pipe(NodeRuntime.runMain);
```

With a model: pass `binding.toolkit` as `toolkit` to `LanguageModel.generateText` and provide `binding.layer`.

## Rules

- Selects MCP-enabled actions only, named by `mcp.name`, with the resolved hints. Groups with no selected tools are not built. The options object is required; pass `{}` for a binding with no hook.
- Successes are the action's native values. There is no `{ value }` wrapper. Declared failures are returned as native tool results (`failureMode: "return"`), not raised.
- `tools.handle(name, encodedInput)` takes encoded arguments and returns an Effect producing a result stream. The handler starts while that stream is constructed, so request services must be provided around the entire `handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not only around the stream.
- `binding.layer` acquires each implementation once, in the layer's scope. Build-time requirements belong to the whole selected implementation.
- Each tool carries only its own handler's request requirements, plus the hook's, not those of sibling or disabled tools.
- Supply identity at invocation, never when building the layer. Native context capture is not a security boundary.
- This is not an MCP server. Use `ActionMcp` to expose the same actions to external clients.
- `errors` are the failures the caller answers with rather than a handler. They join every tool's declared failures, so a refusal is an ordinary returned tool failure. A schema an action already declares is not repeated.
- `before` runs once per call, with the selected action contract, after the arguments are decoded and before the handler. Its services join each tool's requirements, and the caller supplies them as it does a handler's.

## Failure modes

- Tool missing from the toolkit: the action has `mcp: false`. The Toolkit selects by MCP enablement.
- Type error on `before`'s error channel: it fails with an error this binding does not declare. Add its schema to `errors`.
- `Duplicate MCP tool: <name>` thrown at `make`: two apps expose the same tool name. Rename with `mcp.name`.
- `Service not found` for a request tag at call time: it was provided only to the stream, or only to the layer. Provide it around the whole call effect.
- Type error on `binding.layer` requirements: a build-time service is missing. Provide its Layer before `binding.layer`.
- Result is `{ value: ... }` when a plain value was expected: you are reading an MCP response, not a Toolkit result. The Toolkit never wraps.
