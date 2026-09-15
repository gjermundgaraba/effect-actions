# Generic API + MCP registration with Effect v4

Research date: 2026-09-14. This is design research, not an implemented library.

## Bottom line

**There is room for an Effect-native registration library, but a new contract DSL is not the only sensible design.** Effect already has three plausible sources of truth: `Tool`/`Toolkit`, `Rpc`/`RpcGroup`, and `HttpApi`. The missing work is mostly projections, execution-policy integration, and honest transport semantics.

For this project I would compare **Toolkit-first** against **a small transport-neutral Action contract**. Keep **RpcGroup-first** as a strong alternative if “API” means typed application RPC. Choose **HttpApi-first** if preserving an existing public REST contract is the primary goal.

Treat two decisions independently:

1. **What owns the operation contract and handler?** Toolkit, RpcGroup, HttpApi, or Action.
2. **What speaks MCP?** Effect's native server or the official TypeScript SDK.

An Action contract does not require an SDK adapter; a Toolkit contract does not require Effect's MCP transport.

## Method and version boundary

I waited for `w83:p1` to finish, read its consolidated findings, then inspected its saved source reports. Its artifacts are in `/tmp/effect-actions-prior-research/`. I independently searched for implementations, cloned relevant repositories, inspected the current upstream Effect source, and ran a small compatibility experiment.

Version evidence matters unusually much here:

- npm `effect` tags: **latest = 3.22.2; rc = 4.0.0-rc.115**. Effect v4 is still prerelease.
- I installed and tested **the published `effect@4.0.0-rc.115` tarball**, not merely a checkout whose package.json happens to say rc.115.
- I separately inspected Effect upstream commit **`abb93c221bc65a32450685eec2077e7280a24175`**. Its package.json also says rc.115, but its MCP implementation differs substantially from the published tarball.
- Published rc.115's `McpProtocol` exports protocol revisions through **2025-11-25**. The inspected upstream commit additionally exports **2026-07-28** and changes request-context handling.
- The SDK experiment used **`@modelcontextprotocol/server@2.0.0`**.

Source links: [npm tags](https://registry.npmjs.org/-/package/effect/dist-tags), [published rc.115 McpServer](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/ai/McpServer.ts), [published McpProtocol](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/ai/McpProtocol.ts), [inspected upstream](https://github.com/Effect-TS/effect/tree/abb93c221bc65a32450685eec2077e7280a24175).

## 1. Projects worth studying

These are implementation precedents, not claims that every project is a polished library or has proven production reliability.

### A. workout-planner — an actual Effect v4 HttpApi-to-MCP bridge

**Effect `^4.0.0-beta.99`; inspected commit `55ea305c203171fdc4b8d63ad0da8ef07479d05d`.**

Flow:

```text
Effect HttpApi → OpenAPI operation table → MCP descriptors
                                       → HTTP client → existing API
```

`httpapi-mcp.ts` loops operations, builds `McpSchema.Tool`, registers through `server.addTool`, decodes a grouped `{ body, headers, params, query }` input, and calls an API client. It wraps non-object results and maps failures into tool errors. Hints are inferred from HTTP methods.

**Useful:** demonstrates that generic registration can be added without creating another domain contract. HTTP execution retains the existing API boundary rather than bypassing its middleware.

**Limits:** the intermediary is OpenAPI, not the original Effect codec; hints inferred from verbs are only heuristics; raw exception messages need scrutiny; tool curation is limited. Its `layerHttp` call lacks the `protocols` option required by rc.115, so this is pattern evidence, not drop-in code.

Sources: [bridge](https://github.com/billyhawkes/workout-planner/blob/55ea305c203171fdc4b8d63ad0da8ef07479d05d/src/lib/httpapi-mcp.ts), [helpers](https://github.com/billyhawkes/workout-planner/blob/55ea305c203171fdc4b8d63ad0da8ef07479d05d/src/lib/httpapi-helpers.ts), [client](https://github.com/billyhawkes/workout-planner/blob/55ea305c203171fdc4b8d63ad0da8ef07479d05d/src/lib/httpapi-client.ts).

### B. Maple — Effect v4 registry, tenant-aware dispatcher, curated tools

**Effect `4.0.0-rc.112`; inspected commit `1937cd8729a05c3c0648cec3dba0e4072e989b5b`.**

Maple has a public Effect `HttpApi`, a separate MCP tool registry, and a dispatcher shared by external MCP and internal Worker RPC. Tools reuse backend services and some API schemas; they are **not automatically generated from HttpApi endpoints**. For example, alert creation offers agent-friendly templates over the underlying alert service.

`McpToolsLive` iterates descriptors and calls native `server.addTool`; calls enter `executor.execute(tenant, name, payload, "mcp")`. The raw dispatcher is kept private so callers cannot accidentally omit tenant context. The registry centralizes decode and JSON Schema publication. It also contains schema normalization patches and tests, illustrating the cost of bridging schemas incorrectly. Prompts are implemented too.

**Useful:** explicit request tenant, one execution entry, workflow-oriented projection, and separation of public API stability from internal interfaces. The docs explicitly say the proposed internal Effect RpcGroup tier is not built yet; Worker RPC should not be confused with Effect RPC.

**Limits:** custom transport and schema repairs reflect its pinned version and Cloudflare deployment. Do not copy those repairs wholesale into rc.115.

Sources: [API design](https://github.com/MapleTechLabs/maple/blob/1937cd8729a05c3c0648cec3dba0e4072e989b5b/docs/api-v2.md), [MCP server](https://github.com/MapleTechLabs/maple/blob/1937cd8729a05c3c0648cec3dba0e4072e989b5b/apps/ai/src/mcp/server.ts), [dispatcher](https://github.com/MapleTechLabs/maple/blob/1937cd8729a05c3c0648cec3dba0e4072e989b5b/apps/ai/src/mcp/dispatcher.ts), [registry](https://github.com/MapleTechLabs/maple/blob/1937cd8729a05c3c0648cec3dba0e4072e989b5b/apps/ai/src/mcp/tools/registry.ts).

### C. Executor — Effect v4 capability catalog, API and code-mode MCP

**Effect catalog pins `4.0.0-beta.59`; inspected commit `cc0fd8f6099f3d05c73a285ef14932c01ac212fa`.**

Executor ingests MCP, OpenAPI, GraphQL, and other integrations into a governed catalog. It exposes conventional Effect HttpApi handlers and an SDK-backed MCP host. The HTTP tools endpoints delegate to `ExecutorService.tools.list/schema`; MCP exposes `execute`, documentation via `skills`, approval/resumption behavior, and optional per-integration search tools.

**Useful:** a capability catalog need not become one giant `tools/list`. Registration, discovery, and execution can have different public shapes. The same execution engine can support API, CLI, and agent-facing code execution.

**Limits:** a substantial integration platform, not a small HttpApi→Toolkit converter. Sandbox execution, credential isolation, approval resumption, and catalog consistency add major complexity.

Sources: [project](https://github.com/UsefulSoftwareCo/executor/tree/cc0fd8f6099f3d05c73a285ef14932c01ac212fa), [HTTP tools handlers](https://github.com/UsefulSoftwareCo/executor/blob/cc0fd8f6099f3d05c73a285ef14932c01ac212fa/packages/core/api/src/handlers/tools.ts), [MCP tool server](https://github.com/UsefulSoftwareCo/executor/blob/cc0fd8f6099f3d05c73a285ef14932c01ac212fa/packages/hosts/mcp/src/tool-server.ts).

### D. orpc-mcp — the closest small registration-adapter precedent

**Not Effect. Community oRPC v2 package; inspected commit `ba535f2c792114565e2f26c7c64c3b925cdcfa35`.**

Procedures opt in via `mcp.tool`, `mcp.resource`, or `mcp.prompt` metadata. A registry walks procedure contracts, resolves implementations, derives schemas, and exposes the same router through MCP alongside RPC/OpenAPI. Calls retain the procedure pipeline.

Its authorization API separates three concerns: transport authentication, catalog visibility/name-level admission, and ordinary procedure authorization. Visibility decisions run per request and also gate guessed names, not just enumeration.

**Borrow:** opt-in projections, namespacing/collision checks, descriptor compilation, resources/prompts as separate projections, and execution-time enforcement of exposure.

**Do not infer:** this proves Effect endpoint middleware is automatically reusable. oRPC has a procedure pipeline to invoke; Effect HttpApi is structured differently.

Sources: [README and auth model](https://github.com/mi3lix9/orpc-mcp/blob/ba535f2c792114565e2f26c7c64c3b925cdcfa35/README.md), [registry implementation](https://github.com/mi3lix9/orpc-mcp/blob/ba535f2c792114565e2f26c7c64c3b925cdcfa35/src/registry.ts).

### E. orpc-agent — the closest shared execution-host precedent

**Not Effect. Inspected commit `31d5fcc55e68cc906b63ed09326ad3022d126089`; MCP package manifest says 5.0.0 and SDK v1 peer.** The README still advertises 2.0.0; use source/manifest rather than treating the site as release authority.

It places a capability registry and governed runtime between adapters and existing oRPC procedures. The MCP adapter uses `runtime.describe("mcp", ...)` for discovery and `runtime.invoke(..., { surface: "mcp", actor, context })` for execution. The runtime covers exposure, policies, approvals, cancellation, error normalization, redaction, and audit; procedure middleware still runs.

**Borrow:** registration alone is insufficient. Make discovery and invocation separate functions over the same contract; keep the actor out of model-controlled arguments; hardcode the surface in each adapter; bind approvals to actor + validated input; test capability exposure as a versioned artifact.

**Caution:** its ordinary oRPC surface is not automatically forced through agent-specific governance merely because it shares procedures. If our API and MCP need identical policies, both adapters must explicitly invoke our shared executor.

Sources: [MCP adapter](https://github.com/Wiseair-srl/orpc-agent/blob/31d5fcc55e68cc906b63ed09326ad3022d126089/packages/mcp/src/index.ts), [execution pipeline](https://github.com/Wiseair-srl/orpc-agent/blob/31d5fcc55e68cc906b63ed09326ad3022d126089/docs/architecture/execution-pipeline.md), [architecture decisions](https://github.com/Wiseair-srl/orpc-agent/blob/31d5fcc55e68cc906b63ed09326ad3022d126089/docs/architecture/decisions.md).

### Additional version-checked examples

- [tim-smart/effect-mcp](https://github.com/tim-smart/effect-mcp/tree/83a768303839b9e125f6c286369a5d9cc26c666e): Effect `4.0.0-beta.12`, native Toolkit/MCP composition. A documentation MCP application, **not** a generic dual-registration library.
- [dotflowy ADR](https://github.com/cameronapak/dotflowy/blob/1e53ffce8db55fb2f1d8c219fb1e4466af60ac44/docs/adr/0026-agent-native-mcp-server.md): Effect `4.0.0-beta.90`, schema-backed curated registry and shared mutation path. Explains Workers/session tradeoffs and planned SDK v2 adoption. Its historical rejection of stateful transports must not be applied to newer stateless implementations.
- [ebay-mcp defineTool](https://github.com/jcoffi/ebay-mcp/blob/0c47bcf9c278bcdb9d8876b1098de29c5a64f546/src/tools/defineTool.ts): Effect **3.x**, not v4. Co-locates definition, typed handler, and optional MCP Apps UI projection. Useful registry/UI design, not v4 API evidence or a dual HTTP-server implementation.
- The prior local-project report already gives us the strongest nearby prototypes: **wtf** for Toolkit-first, **clanker-okf** for Action contract + execution host, and **clankerdesk extensions** for plugin registration. Avoid rebuilding all three without a clear reason.

## 2. What Effect v4 already supplies

### Toolkit is more than metadata

Published rc.115 provides:

- `Tool.make(name, { parameters, success, failure, failureMode, dependencies, ... })`.
- `Toolkit.make`, typed `.of`, `.toHandlers`, `.toLayer`.
- Yielding the Toolkit produces `WithHandler`, whose `.handle(name, encodedInput)` decodes parameters, executes the registered Effect handler, and streams typed **and encoded** results.
- `Tool.getJsonSchema` and `Tool.getJsonSchemaFromSchema`.
- `McpServer.registerToolkit`, which loops tools and registers native MCP descriptors/handlers.

This already covers much of the proposed “action registry + execution funnel.” What it does **not** give us is a transport-neutral authorization policy, HTTP routing/status semantics, generic OpenAPI projection, or our desired public error envelope.

[Published Toolkit source](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/ai/Toolkit.ts) · [Tool source](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/ai/Tool.ts)

### RpcGroup is a good contract, not automatically a shared execution boundary

An `Rpc` carries name, payload/success/error schemas, middleware and annotations; `RpcGroup.requests` is iterable and `.toLayer` gives exhaustive typed handlers. This maps naturally to tools.

**Important:** `RpcGroup.accessHandler` calls the stored handler with its captured context; it does not run the RpcServer middleware pipeline. A “generic bridge” that retrieves raw handlers and invokes them can silently bypass authorization. Either invoke through a real RPC client/server path, or put the required policy in a shared application executor and make both transports call it.

[Published RpcGroup source](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/rpc/RpcGroup.ts)

### HttpApi is reflectable, but not an abstract action dispatcher

`HttpApi.reflect` exposes endpoint schemas, merged annotations, middleware descriptors, and response alternatives. That is enough to derive selected tools, with mapping rules.

`HttpApiClient.makeClient` looks attractive because its callback supplies `endpointFn`. However, **it is marked `@internal` and types that callback as `Function` in rc.115**. I would not base a stable library on it without explicitly accepting that dependency. Prefer public `HttpApi.reflect` + `HttpApiClient.make`, or generate explicit bindings.

`HttpApiBuilder.handler` is a typing helper returning the supplied callback, not a universal invoke-existing-endpoint API. The HTTP boundary owns path/query/header/body decoding, status alternatives, and middleware.

[HttpApi reflection](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/httpapi/HttpApi.ts) · [HttpApiClient](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/httpapi/HttpApiClient.ts) · [HttpApiBuilder](https://unpkg.com/effect@4.0.0-rc.115/src/unstable/httpapi/HttpApiBuilder.ts)

## 3. Design options

| Option                                    | Source of truth                                       | What we build                                                                       | Best fit                                                                 | Main cost                                                                  |
| ----------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **A. Toolkit-first**                      | Tool schemas + Toolkit handlers                       | HTTP/OpenAPI projection; policy wrapper; optional SDK adapter                       | Agent-first actions with a JSON API mirror                               | AI-specific errors/stream semantics leak into generic core                 |
| **B. RpcGroup-first**                     | Rpc contracts + handlers                              | Opt-in MCP projection and safe invocation binding                                   | Typed application RPC is the primary API                                 | Preserving middleware and request context; REST remains separate           |
| **C. Action-first**                       | Small Effect Schema action descriptor + handler layer | Toolkit/RPC/HttpApi projections and shared executor                                 | Reusable multi-surface library, plugins, explicit access/error semantics | New abstraction and generic typing to maintain                             |
| **D. HttpApi-first**                      | Existing Effect HttpApi                               | Annotation-driven tool compiler; grouped/curated arguments; typed client invocation | Established public REST contract                                         | Mapping HTTP semantics and transformed codecs; not all endpoints are tools |
| **E. OpenAPI gateway/codegen**            | OpenAPI document                                      | Filter/overlay + MCP generator or gateway                                           | Existing/remote APIs, cross-language integration                         | Loses Effect-native types/services; extra HTTP and deployment boundary     |
| **F. Shared services, separate adapters** | Services and shared schemas                           | Small hand-written Toolkit + HttpApi adapters                                       | Small or intentionally different surfaces                                | Registration remains duplicated; parity tests matter                       |

### A. Toolkit-first: the smallest credible library

```text
Tool / Toolkit + access/exposure annotations
           ├── native MCP registration OR SDK adapter
           ├── generated POST /actions/<name>
           └── in-process AI use
                   ↓
          shared policy + handlers
```

Start with JSON request/response actions. Derive `HttpApiEndpoint.post` contracts from parameters/success/failure schemas if typed HTTP clients and OpenAPI matter; raw HttpRouter routes alone will not magically generate those artifacts.

Keep generic policy in the registered handlers/shared executor so direct LLM Toolkit use cannot bypass it. Inspect Toolkit's decode/result behavior before adding a second, duplicate host implementation.

### B. RpcGroup-first: the strongest “reuse Effect” option for RPC APIs

Add MCP exposure metadata to selected RPCs and compile their schemas into tools. Invoke through an RPC-aware path or explicit shared policy entry; do not silently bypass middleware using `accessHandler`.

An HTTP-hosted Effect RPC protocol is **not REST**. If public REST is a requirement, budget for a separate HttpApi projection. Streaming RPCs need explicit MCP mapping; reject unsupported ones rather than buffering unbounded streams.

### C. Action-first: clearest transport-neutral semantics

Conceptual contract, **not an existing API**:

```text
Action = name + input codec + output codec + error schema
       + access policy reference + behavioral hints
       + explicit per-surface exposure/projection

ActionGroup.toLayer(exhaustive handlers)
ActionExecutor.invoke(action, decodedInput, trustedInvocation)

HTTP decoder ─┐
MCP decoder ──┼─> executor → domain services → output encoder → transport result
local caller ─┘
```

Separate a pure contract package from handler implementation and adapters. Preserve `Effect<A, E, R>` requirements rather than turning all handlers into `Promise<unknown>` or hiding dependencies in an ambient singleton runtime.

Keep the initial core small: schemas, names, handler binding, access hook, and error classification. OAuth servers, durable approvals, jobs, CLI generation, sandboxing and MCP Apps should be independent additions, not prerequisites for registration.

### D. HttpApi-first: curated projection, not “flatten every endpoint”

Default to explicit opt-in and a deterministic nested input such as `{ params, query, body }`. This avoids collisions like path `id` versus body `id`. Allow a curated flat schema with explicit input/output mappings when the agent-facing shape benefits.

Never offer authorization headers, tenant identity, or privileged execution options as ordinary model arguments. Handle multipart, downloads, redirects, multiple success statuses, and streams with explicit opt-in adapters or clear registration errors.

For invocation, an HTTP client path preserves server middleware. An in-process HTTP adapter could avoid a network socket while preserving HTTP semantics, but needs a targeted compatibility spike. Calling the endpoint's raw business callback is not equivalent.

### E/F. Useful baselines, not failures to abstract

OpenAPI generation is entirely reasonable when the API already exists or the output is an internal tool. Separate adapters are entirely reasonable for a dozen deliberately curated workflows. Compare their actual maintenance cost against building and maintaining a generic DSL.

There is no universal optimal tool count. Share an operation list when it already represents good agent actions; curate or aggregate when it mirrors a large resource API. Generic registration and curation are compatible.

## 4. MCP backend choice — independent of the contract choice

|                                 | Effect native McpServer                                               | Official SDK v2                                                                                |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Effect integration              | Direct Effect/Layer/Toolkit; resources and prompts available          | ManagedRuntime boundary; explicit Scope/lifetime and abort handling                            |
| Schema support                  | Tool helpers use Effect Schema directly                               | Effect Standard Schema + Standard JSON Schema composition works in the tested case             |
| Protocol situation checked here | Published rc.115 supports through 2025-11-25; upstream has newer work | v2 targets the newer protocol and supplies per-request Fetch hosting plus legacy compatibility |
| Rich tool result                | `addTool` escape hatch; automatic Toolkit adapter is more restrictive | Explicit content/structuredContent/result construction                                         |
| Error parity                    | Automatic mapping is opinionated and loses domain structure           | We own mapping; more code, more control                                                        |
| Deployment                      | Check the pinned transport's session/runtime behavior                 | `createMcpHandler` provides a Fetch boundary suitable for multiple hosts                       |

**Recommendation:** keep backend selection behind an adapter. If shipping remote support for the new protocol now is required, the **published SDK v2** is the clearer starting point than depending on unreleased Effect main. If native Effect composition is more important and supported clients use the older revisions, native McpServer is attractive. Revisit when the newer Effect implementation is published.

### Actual interoperability experiment

`schema-toolkit-spike.ts` was typechecked under strict TypeScript and run with the versions above. It proves:

1. The following composition satisfies SDK v2's `StandardSchemaWithJSON` without casts or a hand-written validator:

   ```ts
   const input = Schema.Struct({ amount: Schema.FiniteFromString }).pipe(
     Schema.toStandardSchemaV1,
     Schema.toStandardJSONSchemaV1,
   );
   ```

2. Through SDK `createMcpHandler` with legacy 2025-06-18 requests, `tools/list` publishes `amount` as a **string**, `tools/call` decodes `"21"` to numeric `21`, and the callback returns `42`. Invalid finite-number input produces `isError: true`.
3. `Toolkit.handle` separately decodes the same wire input, runs an Effect handler, and emits `{ result, encodedResult, isFailure, preliminary }`.
4. On the installed rc.115, `Schema.Struct({})` emits `{"not":{"type":"null"}}`, **not an MCP object schema**. `Tool.EmptyParams` emits `{"type":"object","additionalProperties":false}`. Use the intended empty-parameter schema rather than rewriting arbitrary JSON Schema roots.

Run in an isolated directory with `effect@4.0.0-rc.115`, `@modelcontextprotocol/server@2.0.0`, TypeScript and Node types installed:

```sh
bunx tsc --noEmit --strict --skipLibCheck --types node --module nodenext --target es2022 schema-toolkit-spike.ts
bun run schema-toolkit-spike.ts
```

The original environment and output remain at `/tmp/effect-actions-spike/`. This is **not** a full conformance, auth, cancellation, output-schema, or generic-adapter test.

## 5. Invariants a generic registration layer must preserve

1. **One deliberate decode per logical boundary.** SDK Standard Schema callbacks receive decoded values; `Toolkit.handle` expects encoded values. Feeding SDK-decoded input into Toolkit.handle can decode a transform twice. Provide a clearly typed decoded executor or keep the wire path wire-shaped. Likewise publish output schemas for the actual JSON representation, not an internal Date/class representation. Separate transport processes can legitimately each decode their own wire boundary.
2. **Authorization is not an MCP hint.** `readOnlyHint`/`destructiveHint` describe behavior; they do not establish permission. An operation can be read-only and highly sensitive. Keep permission/policy metadata distinct; derive hints from declared behavior, not authorization from hints or HTTP methods alone.
3. **Discovery filtering is not enforcement.** Recheck exposure and authorization on every call, including guessed names. Decide whether API/MCP have different audiences without manufacturing separate identities. Authenticate at each edge; share the policy evaluator.
4. **Identity is invocation-scoped.** Registration should capture long-lived application services, not the first caller's tenant or credentials. Exercise two concurrent actors. Do not confuse MCP client metadata with authenticated identity. Router co-mounting alone does not prove context survives into registered handlers.
5. **Parity means domain semantics, not identical envelopes.** Share error codes and safe details, but let HTTP use statuses and MCP use protocol errors or `isError` tool results appropriately. Unexpected defects must be sanitized and logged privately.
6. **Native Toolkit-to-MCP error mapping needs attention.** In published rc.115, `registerToolkit` maps yielded results to `isError: false`; `failureMode: "return"` can yield a result marked `isFailure`. Its error-channel path turns declared Error failures into text and sanitizes other failures. Thus “declare a failure schema” does not produce structured cross-surface error parity automatically. This is source inspection, not a reproduced end-to-end failure test; cover it in the first adapter spike.
7. **Streaming is explicit.** Native `registerToolkit` consumes the last Toolkit stream result. Preliminary results are not automatically HTTP SSE/MCP progress. Define unary, stream, and durable-job operation kinds separately if needed.
8. **No accidental lifecycle semantics.** Caller abort, timeout, accepted writes, retries, and durable work are different contracts. Default to no automatic retry of mutations; do not inherit deliberate non-cancellation from a local project without deciding it explicitly.
9. **Schema publication is a testable contract.** Test empty inputs, absent/undefined/null, excess properties, refs/recursion, transforms, finite numbers, arrays/primitives, tagged errors, and output encoding. Verify actual SDK and client behavior, not just that JSON Schema generation succeeds.
10. **Static and dynamic registration differ.** A build-time ActionGroup can provide an exhaustive typed client. Arbitrary runtime-loaded plugins cannot give the host the same compile-time union. Keep a typed static API and a schema-validated dynamic registry instead of pretending they are equally typed.

## 6. Suggested comparison spike before selecting a design

Implement the **same three operations**, outside a full framework:

- `search`: optional/defaulted input and a bounded list result.
- `get`: branded ID plus a declared not-found error.
- `mutate`: tenant authorization, transformed input, and an intentional failure path.

Compare A (Toolkit-first) and C (Action-first); include B only if typed RPC is central. For each, demonstrate:

- adding one contract + one handler exposes the selected HTTP and MCP surfaces;
- HTTP/OpenAPI and MCP descriptors are generated without losing literal names;
- schema transformations execute correctly, with errors/defects mapped safely;
- concurrent tenant contexts do not leak;
- denied/hidden operations cannot be called by name;
- cancellation and invalid output have explicit behavior;
- both a typed HTTP client and an MCP client can call the action;
- no unsafe casts are needed at application call sites and dependencies stay in `R`.

**My preference:** begin with Toolkit-first as the minimum-cost baseline. Choose Action-first only for capabilities the baseline cannot express cleanly—especially stable transport-neutral errors, typed RPC/REST projections, and independent policy semantics. If Action wins, keep it small and project to Toolkit rather than cloning all of Toolkit's machinery.

## 7. Changes to the initial research's conclusions

- “No bridge exists” is too strong: workout-planner implements an OpenAPI-mediated Effect v4 bridge. I did not find a maintained general-purpose v4 package that solves the whole problem; that is a search result, not proof of nonexistence.
- There is no need to assume a new schema shim: the two Effect Standard Schema converters compose into the SDK v2 interface in a typechecked, wire-exercised example.
- “RpcGroup conversion is mechanically trivial” is true for descriptor shape, not for preserving middleware, context, or streaming semantics.
- `HttpApiClient.makeClient` is exported but marked internal; it should not be described as a stable public integration hook.
- Published rc.115 and current main are materially different even though package.json carries the same version. Treat unreleased MCP work separately.
- A shared operation list is not intrinsically an anti-pattern. It is appropriate when the actions are already curated; generation should allow exclusion and reshaping rather than forbid sharing.

Further design guidance, already covered more broadly in the prior report: [Anthropic on tool design](https://www.anthropic.com/engineering/writing-tools-for-agents), [FastMCP OpenAPI integration](https://gofastmcp.com/integrations/openapi), [Cloudflare code mode](https://developers.cloudflare.com/agents/model-context-protocol/codemode/). Those motivate curation and alternate projections, not one mandatory architecture.
