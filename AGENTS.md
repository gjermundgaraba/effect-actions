<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# effect-actions

`@gjermundgaraba/effect-actions` at the root, and `@gjermundgaraba/effect-actions-cloudflare` in `packages/cloudflare`, a pnpm workspace package released with it.

## Working safely and validating

These rules override the regenerated Vite+ block above; do not edit that block.

- Preserve other agents' work. Reviewers leave the worktree untouched: installs, builds, tests that write and scratch work run in an isolated copy including relevant uncommitted changes. Clean up only your own artifacts. Never use bare `git stash` or `git stash pop`.
- Commit only when asked. The staged hook runs `vp check --fix` and may rewrite files or encounter others' unfinished changes.
- Code/tooling changes, including executable examples: run focused checks, then `vp check`, `vp test` and `vp run test:package`. Coordinate one final run after concurrent edits settle. Prose-only changes need relevant formatting, docs and skill-sync checks. Reviews run checks needed for their assessment, under the isolation rule.
- Rerun a load-related timeout alone with `vp test <file>` and report both results. State review scope, unrelated failures and checks not run; claim only completed work.

## Design

- These rules hold for both packages. `packages/cloudflare` imports the core by its package name, its public modules alone, and its tests run on workerd through `@cloudflare/vitest-plugin`, as the root `vp test`'s second project.
- Keep flat `src/<domain>/` folders: PascalCase public modules beside lowercase private files. Shared behavior belongs in `contract`, the shared kernel, which imports no other domain; name each of its private files for the one concept it holds (`caller`, `declared`, `status`), never a catch-all such as `rules` or `utils`. Each surface owns its projection and validates only names it serves. Public modules expose consumer types as `Options`, `<Function>Options` and `Any`, or a named options interface two functions share, or a named type a consumer writes, such as a method's parameter. Reach another domain through its public module; `oxlint.config.ts` names the few shared private files, and domains import without cycles.
- Use native Effect servers, clients and composition; add no protocol runtime. Consult pinned `node_modules/effect` before inventing helpers or assuming APIs. Remove restrictions that obstruct useful native composition. Support the pinned TypeScript, without older-compiler workarounds.
- Applications own verification, login, consent and authorization policy; the library enforces it. Operational limits belong in handlers with declared errors, record checks in data access. Separate startup dependencies from request requirements; never provide request identity at server startup.
- An expected failure is a tagged error whose fields say what failed. Several failures of one operation are one error with a tagged `reason`, as Effect's `HttpClientError`, never one message standing for them all; a `message` is a declared field built in one place from the others.
- Minimize the complete consumer workflow: one obvious path, useful defaults, library-owned wiring and optional advanced composition through the same model. Do not simplify internals by making consumers rebuild the wiring. Breaking changes are welcome; no compatibility shims, deprecations or migration aliases.
- Justify new public concepts against existing ones. API/workflow proposals show before/after consumer code and concepts added or removed, for the common case and any affected advanced case.
- For consumer-visible changes, update the guiding docs and `CHANGELOG.md`'s `Unreleased`; explain breaking-change migration. Update examples when application usage changes. For opt-in options, an example is required only when application structure or deployment changes; otherwise a focused test and concise documentation suffice. Name and explain reversals of recorded design constraints or consumer guarantees in the changelog; routine implementation refactors need no reversal record. For untested documented guarantees, test intended behavior and correct unsupported promises instead of building machinery to preserve them.

## Documentation

The readers are coding agents, and they read two ways. Each fact has one home, chosen by how it is reached.

- **Learning, read whole in order**: `docs/README.md`, the nearest example, `docs/Action.md`, then one page per surface. A page is the concept, the one way to do each task, whole example files as its snippets, and links to the example files that show the rest; it names the symbol whose JSDoc holds the rules instead of restating them, and keeps only the traps no declaration and no example can hold, such as a choice between modules or a deployment. A trap a learner must see lives in the code and names of the example file that shows it, since examples are copied whole, product decisions and defects included: an example reuses a contract's schemas (`Schema.Array(CreateNote.input)`), and a change to one is reviewed as "what happens when this is copied verbatim?". Keep each page under 16,000 bytes, checked by `tests/docs.test.ts`: a longer page read through a tool loses its middle to the output cap, unnoticed, so split by topic when needed. Every `ts` fence in `docs/` is `example=<path>`, equal to a whole file under `examples/`, which compiles and is tested: add a small file to the nearest example rather than write a fragment.
- **Looking up, by grepping one symbol or one message**: a rule about an option lives in that option's JSDoc; a wire fact in the JSDoc of the declaration that produces it, and in an example test that asserts it as sent; the fix for a failure the library throws in its message, one fix per check, chosen by the check and not by which claimant collided. A declaration's JSDoc is one paragraph saying what it is, then optional `**Gotchas**`: one line per trap, symptom and consequence on that line, since a grep returns one line. `<Module>-failures.md` holds only what is found by a fragment of a message the library does not own, a compiler diagnostic or Effect's own error, one line per entry; its reader arrives by the message, so an entry may repeat a gotcha's sentence.
- `README.md` is the human pitch and quickstart, not a reference: its fences are plain snippets showing the shape of the code, no imports, exports or comments, and the whole files are the examples it links. Route readers through `docs/README.md`. Define a term where it is first used, and prefer Effect's and TypeScript's words to new ones.
- Examples are independent, complete applications following `examples/README.md`, importing the package by name and no other example. Their domains declare services; a Layer reaching a technology (a file, a database, an upstream API) is an adapter in `src/platform/`, which no domain imports. Name each deployment shortcut for what it is (`demoMembers`, `layerMemory`, `layerDemo`).
- The Cloudflare package's pages and examples are its own, in `packages/cloudflare/docs/` and `packages/cloudflare/examples/`, and ship with it, under the same rules: its `ts` fences are whole files of its own examples, it links inside that package alone and names the core's pages in prose, and it defines its terms where first used.
- Edit `docs/`, never generated `skills/effect-actions/`; run `vp run docs:sync` after docs changes.

## Tests

- Mirror domains under `tests/`; shared guarantees go in `tests/guarantees/`, helpers in `tests/support/`, shared application in `tests/support/app/`, repository checks at the root. Type pins use `*.test-d.ts`, `expectTypeOf` and negative expressions under `@ts-expect-error`; check each surface's requirements separately, never a union that can hide an omission.
- Test shared runtime behavior at its owning layer. Use integration tests to cover surface wiring and differences; repeating every shared outcome on every surface is unnecessary.
- Import Vitest through `@effect/vitest`. Default Effect tests to `it.effect` with scoped `Testing.layer(routes)`; use `it.live` for real time. Keep promise tests for raw web handlers, absent-layer/per-request-context behavior, downstream promise harnesses and runPromise-level missing-requirement assertions. Give each test the layers whose state/builds it observes.
- Use schema-derived properties for input rules and behavioral laws, and models for stateful sequences. Derive expected values from inputs or an independent model, never by copying implementation logic. Comparing observations, including repeated calls or different surfaces, is valid when their relationship is the contract; include an independent outcome or state assertion. Prove new properties with a planted violation and record it in the commit message, or report if no commit is requested. Keep case tests for component interfaces, tautological property oracles and readable examples.
- Match upstream errors by stable fragments unless docs quote them; test upstream behavior only to uphold documented promises. One test pins a library message whole; every other site matches a fragment. To count reports, use `tests/support/reporter.ts`'s `recorder`: `ErrorReporter.make` deduplicates them.

## Lint

- `vp check` formats, lints and type checks both packages; `vp check --fix` applies the fixes. Lint comes from `@clanker-stuff/oxlint-config` through `config()` in `oxlint.config.ts`, with this repository's overrides there; formatting from `oxfmt.config.ts`, which leaves AGENTS.md to `vp config`, since it rewrites its Vite+ block on every install. `vp install` patches Vite+'s Oxlint for the Effect rules through the root `prepare` script.
- Every exception to the preset lives in `oxlint.config.ts`, scoped to the files it names. Fix the code rather than add a lint exception. The only inline suppressions are the `oxlint-disable-next-line typescript/no-unsafe-type-assertion` directives on casts at erased generic boundaries; add no others.
- `oxlint.config.ts` also holds the import fences: a relative import in `src/` is a sibling, another domain's public module, the contract's or a shared private file, `src/contract` imports nothing outside itself, and `packages/*/src` imports the core by its package name. `tools/oxlint/tests/configuration.test.ts` pins them.
- Fix the owning cause, not the diagnostic's spelling. Do not hide findings through renaming, inference to `any`, casts, one-use helpers or excluded files. Preserve external-input and third-party boundary safety.
- In `src/`, put consumer JSDoc on the declaration that ships, including private-module types, not its re-export.

## Release

- To release: bump the version in `package.json` and `packages/cloudflare/package.json`, which carry one, commit, tag `v<version>` and push the tag. `.github/workflows/npm.yml` publishes both, the core first, skipping a version npm already has. A new package's first version is published by hand, as README.md's Releasing section says.
- After adding, renaming or removing public modules, run `vp run -r build` and include each package's generated `package.json` exports in the change. The build keeps each module its own file (`unbundle`): bundled declarations emit a dangling `__exportAll` export.
- `package.json`'s `engines` (`>=26.13.0`) is the floor stated to consumers. CI builds and tests on `.node-version`, inside that range; raising the floor is a breaking change.
- Upgrade Effect development packages together, in the catalog of `pnpm-workspace.yaml` both packages read, and rerun full validation. `pnpm-workspace.yaml` exempts the Effect, Vite+ toolchain and our own scopes' package families from the package manager's release-age check so their releases land the day they publish; respect the check for every other package. Raise the `~` peer's floor only when the library needs a later patch's API or fix, and record that raise as breaking.

## Effect

Before writing or reviewing Effect code, read `node_modules/effect/AGENTS.md` in the package you are changing and the examples it links under `ai-docs/`. They ship with the installed `effect`, so they match the APIs the code compiles against. For exact signatures, read that package's installed source and types in `node_modules/effect` and `node_modules/@effect/*`. Do not write Effect APIs from memory or from examples for another version.

## Upstream behavior the code depends on

Recheck these on an upgrade of the dependency named.

- Effect, HTTP:
  - `HttpApiBuilder.group` lays the context it is built in over each request's, so `ActionHttp.layer` builds its groups in an empty context.
  - A body with no `Content-Type` is read as JSON, which a page on another site sends without a CORS preflight, so `ActionHttp` refuses one.
  - `HttpApi` query parameters take only fields that encode to strings, so every route is a POST.
  - `HttpApiSecurity` types an `Http` scheme's name as `string`, so `assertPublishableResource` tells Bearer apart at runtime.
  - `OpenApi.fromApi` merges equal security schemes of one key silently, so an authentication name that is no OpenAPI component key throws.
  - A raw client fails a status with `StatusCodeError`, a native `HttpApiClient` an undeclared one with `DecodeError`; `status.ts` lists the statuses of `HttpClient.isTransientResponse`, which takes a response where `mcp/watch.ts` and `idempotency.ts` hold a number.
  - The native SSE decoder and `Sse.decode` stop at a `retry:` field, so `mcp/reply.ts` feeds the parser by hand.
  - `HttpServerResponse.raw` takes its status from its options, not from the web `Response`.
  - `HttpApiSchema.StreamSse` encodes `data` through `Schema.toCodecJson` since 4.1.1, so `http/events.ts` passes the schema as is.
  - `HttpApiSchema.StreamSse`'s `keepAlive`, since 4.1.3, writes `: keepalive` on a fixed tick from the response's start until the events end, not after a silence, so `http/streamed.ts` sets it on an action's streams, which start with their first event; an event's stream already sends a `Checked` every 30 seconds.
  - A server or client span records a request's query in `url.full` and `url.query`, and its headers only where `TracerHeaderFilter` admits them, redacting only `CurrentRedactedNames`; `HttpApi.RedactedNames` (4.1.4, unstable) adds names for an `HttpApi`'s endpoints alone, so `http/redacted.ts` names an API key's query parameter or header there, and `ActionMcp` and `protect`ed routes, not `HttpApi` endpoints, get no such names.
  - `HttpApiSchema` reads `httpApiStatus` from the checks, last to first and into groups, then the schema's annotations, then its key's, an explicit `undefined` clearing it; that reader is private, so `contract/status.ts` mirrors it.
- Effect, RPC:
  - `reconnectUntil` copies `defaultRetryPolicy` from effect 4.1.4 `src/rpc/RpcClient.ts`, which Effect does not export.
  - Only the HTTP protocol lacks chunk acknowledgement (`supportsAck: false`), so only it gets a watch's silence rule.
  - The HTTP protocol reads any status's body as frames, and the server answers an unserved tag with `Unknown request tag: <tag>`; `tests/rpc/rpc.test.ts` pins that message, `tests/rpc/events.test.ts` what the client does with both.
- Effect, MCP (4.1.4):
  - `registerToolkit` sends every success as `structuredContent` plus one JSON text block, with no option, so `ActionMcp` registers tools through `addTool`; since 4.1.3 a success without a value is sent with no content and no `structuredContent`, though it lists a `null` output schema, where `ActionMcp` sends `null`.
  - `addTool` reads the `McpServer.middleware` stacks, `visibility` included, from its `services`, and lays the rest under each request's context, less the request's own keys, so `ActionMcp` passes its build context there.
  - The registry is one layer per layer graph, so each endpoint is `Layer.fresh`.
  - A registration layer needs `McpServer`, and `registrations` build before the server reads a request, so `ActionMcp` registers its features and tools there.
  - A handler's services are `McpRequest<"Requires", X>`, which `Layer.provide` does not satisfy; `layerHttp` turns them into `Request<"Requires", X>`, and `ActionMcp.runStdio` into `X`.
  - A transport's layer outputs `McpServer`, and `toWebHandler` lays a layer's output over each request's context, so `ActionMcp` provides the transport to `Layer.empty` and outputs nothing: two endpoints in one graph would each read the other's registry.
  - The runtime decodes `Mcp-Name` as sent or between `=?base64?` and `?=`, checks routing headers against the body only for stateless requests and core methods, and never for `initialize`. `McpServer.decodeNameHeader` exports that decoding, which `ActionMcp`'s authentication gate and `bridge.ts` call.
  - An unreadable body is answered `-32700` in a 200, and a body past `MaxBodySize` is a 413.
  - The notification sender exists only where subscriptions are allowed.
  - The stdio parser fails on a non-JSON line, and its retry drops the rest of that read; the transport ends by interrupting the fiber that built it.
  - The server is forked with `forkScoped`, so a defect while installing handlers ends only that fiber.
  - `bridge.ts` reaches an adapter's groups and `handlerRpcs`, off the public interface; `tests/mcp/bridge.test.ts` and `events.test.ts` fail if they move. `toolJsonSchema`, which inlines a top-level `$ref` and follows it through a definition that is itself a `$ref`, as an identified alias of an identified schema writes one, is private, so `mcp/protocol.ts` does the same.
- Effect, SQL:
  - A SQLite client shares one connection through a semaphore, which `withTransaction` holds until it ends and each statement outside one takes, so a log's `transaction` in `log.ts` takes the connection before the log's own lock: taken the other way, a publish in a handler's transaction deadlocks with a read or publish outside it.
  - `@effect/sql-sqlite-do` 4.1.4's client runs `withTransaction` through `storage.transaction()`, which closes the object's input gate, only when built with `storage`, and fails it when given `db` alone, so `Stored.layerEvents`, whose every log append and read is a transaction, needs `storage`.
- Effect, Cluster (4.1.4):
  - An entity's handler defect restarts it and replays the message unless `toLayer` sets `disableFatalDefects`, so `ActionEntity.layer`, whose concealed defects would replay forever, always sets it.
  - `toLayer`'s build takes no typed error, and Effect's own runners retry a build that fails on their default schedule (`defaultRetryPolicy` in `cluster/internal/entityManager.ts`), so a builder's failure is a defect of the activation; `@effect/platform-cloudflare` 4.1.4's runtime instead fails the calls waiting on that build and builds again on the next call (`getHandlers` in `internal/entityRuntime.ts`).
  - A handler receives an `Entity.Request`, which carries its envelope's `headers` and `requestId`, as `Entity.HandlersFrom` types it; Effect's runners and `Entity.makeTestClient` also pass the rpc server's options second, untyped, and `@effect/platform-cloudflare` 4.1.4's runtime passes nothing more, so `ActionEntity.layer` builds an action handler's options from the request alone, the same on every runtime, and authenticates from its `headers`, and passes the request to a native handler as it came; `tests/entity/headers.test.ts` and the package's `tests/cluster/headers.test.ts` fail if the headers a handler reads differ from those its client sent.
  - Both runtimes honour a handler's `Rpc.fork` (Effect's server skips the entity's concurrency for it, and `@effect/platform-cloudflare`'s `entityRuntime.ts` its permit), so `ActionEntity.layer` maps a native answer through `Rpc.wrapMap` to provide `services`' output, keeping its wrapper; `tests/entity/natives.test.ts` and the package's `tests/cluster/natives.test.ts` fail if a forked native waits behind another call.
  - `Entity.client`'s client is a Proxy keyed by tag, and `RpcGroup.Rpcs` drops string tags from its type, so `ActionEntity.client` calls it by tag through `erasedCallOf`.
  - `@effect/platform-cloudflare` 4.1.4's runtime runs a call that died again in place under the registration's `defectRetryPolicy` (`runWithDefectRetry` in `internal/entityRuntime.ts`), and builds the entity's handlers again after any call that died (`rebuildAfterDefect`), whatever `disableFatalDefects` says; an action's concealed defect is a die, so `ActionEntity.LayerOptions` leaves `defectRetryPolicy` out, which would run a post that died after its write again; the package's `tests/cluster/defects.test.ts` fails if an action that died runs again or the entity keeps its handlers.
  - An rpc is volatile unless annotated `ClusterSchema.Persisted`, and an entity's concurrency defaults to 1, so a stream rpc holds its one slot until it ends on Effect's runners; `@effect/platform-cloudflare` 4.1.4 frees the slot while a frame waits for its client's acknowledgement (`pause` in `internal/entityRuntime.ts`).
  - `Sharding` retries a volatile request's `EntityNotAssignedToRunner` every `sendRetryInterval` (100 ms by default) without limit, failing it only while the runner shuts down or the entity's manager is not alive, so a watch through `ActionEntity` does not retry it.
  - `Entity.makeTestClient` joins `RpcClient.makeNoSerialization` to `RpcServer.makeNoSerialization`, with no runner, mailbox or encoding.
  - `Entity.makeTestClient`'s `Sharding` has no `makeClient`, so `ActionEntity.layer` builds the client sending an entity's wakes to itself when it sends the first; `tests/entity/natives.test.ts` fails if it is built with the entity.
  - The `EntityReaper` (`internal/entityReaper.ts`) stops an entity idle for `entityMaxIdleTime`, 1 minute by default, unless it has an rpc request in flight or `keepAlive` on; a timer or a forked fiber of its own does not count, so `ActionEntity.layer` gives its `services` the `Wake` of `contract/wake.ts`, through which `Webhook.layer` makes every retry wait a persisted wake, which builds a stopped entity again, and `rpc/erased.ts` refuses an entity's webhook subscription to a check source not `notified`, whose reads are on a timer; `tests/entity/wakes.test.ts` fails if a retry wait the reaper cut, under 10 seconds or over, is not delivered.
  - `SqlMessageStorage` hands an entity only messages whose `deliver_at` has passed, read each `entityMessagePollInterval`, 10 seconds by default, so on Effect's SQL runners a webhook retry wait ends up to that long after it is due, and `tests/entity/wakes.test.ts` sets 250 milliseconds.
  - Both storages keep a persisted message's `PrimaryKey` against its processed row too: `SqlMessageStorage` inserts with `ON CONFLICT (message_id) DO NOTHING`, and `@effect/platform-cloudflare` 4.1.4's `persistRequest` (`internal/entityMailbox.ts`) answers `Duplicate` for any row of that `message_id`, so a key processed early, as a test's moved `deliver_at` processes one, is never delivered again: `wakes.ts` gives a wake no `PrimaryKey`, and a wake ends every wait due by its time.
- Effect, persistence (4.1.4, unstable):
  - `Persistence.layerBackingSql` forks a loop deleting expired rows every 5 minutes for as long as its layer lives, a pending timer that keeps a Durable Object from hibernating, so `Stored.layerIdempotency` builds on `layerBackingSqlMultiTable`, which deletes them once as each store is made and filters them out of every read; the package's `tests/cluster/eviction.test.ts`, whose `Seer` entity keeps `Stored.layerIdempotency` in its `services`, times out on the former.
- Effect, elsewhere:
  - `Layer.build` forks the memo map around its caller, so `implementation.ts` builds into the map itself.
  - `Stream.retry` restarts its schedule at the first element after a failure.
  - `Effect.provideContext` merges, so a webhook worker forked from the subscribe request replaces its context instead.
  - A request's `Scope` closes with its response, so a webhook delivery runs in the subscribe request's context but not the request itself.
  - `Webhook.layer`'s store lists its records once as it builds, with `KeyValueStore.keys` under a prefix; `keys` scans the whole backing store, `SELECT id FROM` the table on SQL and a directory read on the file store, whose `keys` lists `.DS_Store` and subdirectories but fails on a file name that is not percent-encoding, such as `100%.txt`.
  - `effect/crypto`'s `Mac` and `Digest` are services no runtime bundle provides, so webhook signing and `contract/digest.ts` call WebCrypto, which adds no requirement to any surface; `Mac.timingSafeEqual` is a pure function, which `webhook/signing.ts` compares signatures with.
  - A `Clock` keeps its methods on a class or in a closure, so a spread drops them.
  - The CLI's `withSubcommands` replaces earlier subcommands, and a schema's description is read from its last check.
  - The AI toolkit finds a handler by the tool's `id`, and its default on a failed approval policy runs the call.
- MCP and SEP-3415:
  - SEP-3415's error codes are provisional, pinned to its PR head `2ec39b9c49c583411b73cb460dea5f52b5c541a6`; it names the category `reason`, which `Event.CallbackFailed` calls `category`.
  - SEP-3415 keys a webhook subscription by its subscriber's principal, has a 410 abandon one delivery alone, an absent cursor be `null`, and a stream silent for twice its 30-second heartbeat be dead.
  - SEP-3415 asks a server to refuse callbacks to the IANA special-purpose IPv4 and IPv6 ranges that are not globally reachable; `address.ts` refuses NAT64's `64:ff9b::/96` too.
  - MCP keeps event names starting with `mcp.` for itself, and requires a tool schema with an object root.
  - Every 2026-07-28 result names the server in its `_meta`.
  - Python SDK releases before python-sdk#3345 read a `null` `structuredContent` as missing.
- Cloudflare and workerd:
  - `@effect/platform-cloudflare` 4.1.4 owns each entity object's alarm, for scheduled tells, replays and `Entity.keepAlive`, so the package and chat-rooms set none.
  - `CloudflareCluster.layer`'s entity clients encode a call's `Headers` with `JSON.stringify` (`internal/entityWire.ts`) in a send fiber that `RpcClient` forks with the caller's context (`Effect.runForkWith(parentFiber.context)`, `RpcClient.ts:411`), so the caller's `Headers.CurrentRedactedNames` redacts them, and `ActionCluster.layer` sends a volatile call with it empty and a call of an rpc annotated `ClusterSchema.Persisted`, whose envelope `cluster_messages` keeps, as it is; `tests/cluster/redaction.test.ts` fails if a volatile call's credential arrives redacted, a persisted one's intact, or a log or a stored row holds it.
  - The runtime looks up two of its Durable Object classes by export name, through `state.exports` (`exportedNamespace` in `CloudflareDurableObjectPrograms.ts`): `ClusterEntity`, for an entity's hold and its replies, and `ClusterWorkflow`, for a workflow's delivery; `ClusterDurableQueue` and `ClusterSingleton` are reached only through the namespaces `ActionCluster.layer` is given. The test Worker and chat-rooms export all four under these names, which `wrangler.jsonc`'s bindings name, `ClusterEntity` as `ActionClusterEntity.make`'s class.
  - `CloudflareDurableObjects.setInitializer` treats a build pending after 15 seconds as abandoned and builds again, so `ActionCluster.initializer` builds a runtime per call until one finishes, keeps the first and disposes a failed or later one, answering the kept one to a call whose own build failed; the package's `tests/cluster/initializer.test.ts` stalls the first build past 15 seconds and fails if the replacement does not serve an object and the Worker's request waiting on the stalled build.
  - `setInitializer` throws on a second call in one isolate, so the package registers none: an application registers the callback `ActionCluster.initializer` returns.
  - Entity registration does not follow the initializer's choice of runtime: a stalled build that registered its entities refuses the replacement's registrations, and disposing it when it finishes later removes the isolate's only ones, leaving the kept runtime serving no entity type (inferred from `CloudflareCluster.ts` and `internal/registry.ts`, not reproduced, no upstream issue filed yet), so an application's build does no slow work, such as a migration or a remote fetch, after `ActionCluster.layer`'s, which chat-rooms' `application.ts` names, `ActionCluster.initializer`'s gotcha states and `docs/ActionCluster.md`'s "Boot once per isolate" in the package explains.
  - chat-rooms' `test/webhooks.test.ts`, through `test/support.ts`' `deliverNow`, which `docs/ActionCluster.md`'s "Test on workerd" in the package names, reads and moves `cluster_messages`' private columns `deliver_at`, `processed` and `envelope`, which the runtime's `internal/entityMailbox.ts` and `internal/entityStorage.ts` own, to deliver a webhook's wake early and count its rows.
  - workerd logs `uncaught exception; source = Uncaught (in promise)` for a Durable Object method that rejects, even where its caller handles the rejection, so chat-rooms' test of a room failing after its write, whose `test/worker.ts` rejects `invoke` once the post settled, prints that planted failure.
  - Durable Object SQLite binds at most 100 parameters to a query, so `event-tables.ts` deletes a log's entries 90 at a time, and `tests/contract/sql-store.test.ts` fails a statement binding more.
  - Durable Object SQLite's `exec` throws an `Error` whose message holds `no such table` for a query of a table not yet made, so `ActionClusterEntity`'s change signal reads that alone as no signal; `tests/host/polls.test.ts` fails if the text moves or another failure is read as none.
  - `makeClusterEntityProgram` (`CloudflareDurableObjectPrograms.ts`, 4.1.4) is the program Effect's `ClusterEntity` runs, and the class's wait on the initializer, `blockOnInitialization`, with the 15-second bound that keeps a replacement build inside the runtime's 30 seconds, is private, so `ActionClusterEntity` runs the program behind `blockConcurrencyWhile(initialize)` alone, without that bound. Subclassing Effect's `ClusterEntity` instead, handed `Object.create(ctx)` with `waitUntil` and `blockConcurrencyWhile` hooked (workerd's `DurableObject` constructor refuses a `Proxy` as the state), runs and passes the package's tests, but Effect's declarations strip the class's rpc methods, `@internal`, and type `fetch` as `() => never`, so a subclass counting `invoke`, `hold` and `acknowledge` no longer type-checks without the class-interface merging the lint refuses, and it would trade the exported program for three private behaviours: the class calling `blockConcurrencyWhile` once on the state it was given, the program reading `waitUntil` off that state, and workerd finding the state on an object's prototype chain.
  - The program runs every handler, of a call, a tell or a replay on its alarm, in a fiber whose promise it hands its `waitUntil` (`internal/entityRuntime.ts`), so `ActionClusterEntity` asks its parked polls again after each of those alone, and not after `invoke` or `alarm` themselves.
  - A pending timer keeps an object from hibernating, as the `RcMap` idle fiber's sleep does while it holds a subscription hook until its `lease` ends (`RcMap.ts`, effect 4.1.4), so `ActionClusterEntity`'s hook gotcha says a watched hooked source keeps its object awake, and `webhook/subscriptions.ts` sets no expiry timer where `Wake` is provided, a subscription ending at its first delivery past its expiry, as chat-rooms' `test/webhooks.test.ts` fails in `hibernated` if it does; `tests/host/hooks.test.ts` fails if that object hibernates, and `evictDurableObject` times out on it with `it still has active references`.
  - `persistRequest` (`internal/entityMailbox.ts`, 4.1.4) refuses a persisted message with `MailboxFull` once an object holds 4,096 rows with `processed = 0`, a `DeliverAt` row not yet due among them, so `wakes.ts` waits on a timer where its wake's send fails; a failing subscription holds one wake pending, and each refresh of it leaves one more, due within 5 minutes, which nothing bounds below that limit; `tests/entity/wakes.test.ts` fails if a delivering subscription's refreshes or expiry write one.
  - `CloudflareCluster.layer`'s `makeClient` answers synchronously once the cluster is built, for an entity in `ActionCluster.layer`'s `entities`, so `ActionClusterEntity` builds an entity's client with `Effect.runSync`; an entity of `sockets` missing from `entities` throws there, with `CloudflareCluster`'s message, which `ActionClusterEntity-failures.md` quotes and `tests/host/frames.test.ts` fails if it moves.
  - An `Entity.client` call an object makes to its own entity is a stub call to itself, `invoke`, so each parked poll asked again costs one, and interrupting that call sends `interrupt` through the stub; the counts `docs/ActionClusterEntity.md` states are measured with a subclass counting `invoke`, `hold` and `acknowledge`, as `tests/worker.ts`' and chat-rooms' `test/worker.ts` do, which chat-rooms' `vite.config.ts` names as `main`.
  - A hibernatable socket's attachment holds at most 16 KiB serialized, and the runtime keeps it with the socket across hibernation; a socket the client never closes stays in `getWebSockets()` with its attachment, so a test closes the sockets it opens.
  - `setWebSocketAutoResponse` answers a message equal to its request with its response without waking the object, so `frames.ts` registers Effect RPC's `Ping` frame, encoded by `RpcSerialization.json`, against its `Pong`.
  - workerd refuses a second `close()` of a closing socket and a frame sent to one, so `frames.ts` ignores both.
  - workerd (the `@cloudflare/vitest-plugin` 1.6.1 runtime, `compatibility_date` 2026-10-01) does not answer a page's close of a hibernatable socket itself, though `web_socket_auto_reply_to_close` is on from 2026-04-07, so `frames.ts`' `replyToClose` answers it; the package's `tests/host/frames.test.ts` close test times out without it.
  - Close codes 4000 to 4999 are private use (RFC 6455 §7.4.2 reserves 1000 to 3999), so a refusal closes with one, and 1012 is "service restart", which `ActionRpc.reconnectUntil` connects again after.
- Vitest and `@cloudflare/vitest-plugin`:
  - `@cloudflare/vitest-plugin` 1.6.1 hands its `miniflare` options to Miniflare in the Vitest process, a function given as `outboundService` included, which Miniflare calls in Node for each outbound fetch of the Worker, so chat-rooms' `test/receiver.ts` answers its webhook callbacks and the test's reads of what they received; `test/webhooks.test.ts` fails if it does not.
  - With `fsModuleCache` on, Vitest 5 answers a fresh worker's first module fetch with every module of its file's import graph already on disk (`fetchWarmModules`), and the plugin (1.6.1) inlines all their code, Effect's source maps included, into one message on the runner's socket; workerd closes a socket at a message over 32 MiB with 1009, and Vitest reports the file as "Worker exited unexpectedly". The package's former Durable Object tests' graphs came within 0.3 MiB of that with effect 4.1.3 and crossed it on CI's longer checkout path, so both workerd projects, the package and chat-rooms, set `fsModuleCache: false` until [cloudflare/workers-sdk#16349](https://github.com/cloudflare/workers-sdk/issues/16349) is fixed (still present in the plugin's 1.8.0).
- Web platform:
  - fetch follows redirects unless told not to, so a webhook POST runs with `redirect: "manual"`.
  - `EventSource` sends no body or headers, so a browser watches with `fetchClient`.
  - The URL parser copies `.well-known` as it is and strips tabs and newlines, which `Authentication`'s discovery prefilter admits.
  - Two installed copies of a module each have their own state, so implementation keys are random, not counted.
