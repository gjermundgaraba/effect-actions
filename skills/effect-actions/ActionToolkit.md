# ActionToolkit

Implementations as Effect's native AI `Toolkit`, for programs that call tools in-process
with `LanguageModel` or by hand. No server, no MCP envelope.

## API

```ts
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";

function make<const Apps extends ReadonlyArray<AnyImplementation>>(
  ...apps: Apps
): Binding<ToolkitTools<Apps>, BuildError<Apps[number]>, BuildContext<Apps[number]>>;

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
    failure: Schema.Union<A["errors"]>;
    failureMode: "return";
  },
  HandlerRequirements
>;
```

## Canonical

```ts
import { Effect, Stream } from "effect";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { UserApp } from "./handlers.js";

const binding = ActionToolkit.make(UserApp);

const program = Effect.gen(function* () {
  const tools = yield* binding.toolkit; // bound handlers
  const calls = yield* tools.handle("get_user", { id: "1" }); // encoded arguments
  const results = yield* Stream.runCollect(calls);

  return results;
}).pipe(
  Effect.provideService(CurrentActor, actor), // request service, around the whole call
  Effect.provide(binding.layer), // build services resolved here
);
```

With a model: pass `binding.toolkit` as `toolkit` to `LanguageModel.generateText` and provide `binding.layer`.

## Rules

- Selects MCP-enabled actions only, named by `mcp.name`, with the resolved hints. Groups with no selected tools are not built.
- Successes are the action's native values. There is no `{ value }` wrapper. Declared failures are returned as native tool results (`failureMode: "return"`), not raised.
- `tools.handle(name, encodedInput)` takes encoded arguments and returns an Effect producing a result stream. The handler starts while that stream is constructed, so request services must be provided around the entire `handle(...).pipe(Effect.flatMap(Stream.runCollect))`, not only around the stream.
- `binding.layer` acquires each implementation once, in the layer's scope. Build-time requirements belong to the whole selected implementation.
- Each tool carries only its own handler's request requirements, not those of sibling or disabled tools.
- Supply identity at invocation, never when building the layer. Native context capture is not a security boundary.
- This is not an MCP server. Use `ActionMcp` to expose the same actions to external clients.

## Failure modes

- Tool missing from the toolkit: the action has `mcp: false`. The Toolkit selects by MCP enablement.
- `Duplicate MCP tool: <name>` thrown at `make`: two apps expose the same tool name. Rename with `mcp.name`.
- `Service not found` for a request tag at call time: it was provided only to the stream, or only to the layer. Provide it around the whole call effect.
- Type error on `binding.layer` requirements: a build-time service is missing. Provide its Layer before `binding.layer`.
- Result is `{ value: ... }` when a plain value was expected: you are reading an MCP response, not a Toolkit result. The Toolkit never wraps.
