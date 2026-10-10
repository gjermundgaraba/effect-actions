# Contributing

For people and agents changing the library. Consumers read [docs/](docs/README.md) instead.

## Setup

Requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` (`devEngines` in `package.json`; CI tests 22, 24 and 26) and [Vite+](https://viteplus.dev). Run `vp install`, then see
[AGENTS.md](AGENTS.md) for the commands, the repository map, and the validation rules.
`devEngines` is Vite+'s own Node floor, which only developing the package needs; `engines`,
`^22.12.0 || ^24.0.0 || >=26.0.0`, is the floor the published package states to consumers.

Vocabulary: [docs/CONTEXT.md](docs/CONTEXT.md). Use its terms in names, docs, and tests.

## Documentation rules

- `README.md` sells the library to humans: the pitch, one showcase snippet, why, install, links. No reference material.
- `docs/` is for coding agents. Each public-module reference card has the same sections: **API**, **Canonical**, **Rules**, **Failure modes**. State what holds and what breaks, without tutorials or narrative. Routing, setup, vocabulary, and shared guarantees use the structure their role needs.
- `docs/README.md` is the routing table and doubles as the skill body. One line per page saying when to read it.
- A change to public behavior changes the matching `docs/` page in the same commit. Then run `vp run docs:sync`, which renders the skill before deleting the old one, so a failed read leaves it untouched; `tests/skill.test.ts` fails if the generated skill is stale.
- API sections inventory exports and options; do not hand-copy complex generic declarations. Exported TypeScript declarations are the exact signature reference.
- A snippet fenced as ` ```ts example=<file> ` stays byte-identical to that file in `examples/`, which `tests/docs.test.ts` checks, so it stays type-checked; the first snippet of every Canonical section is one. Edit the example, then paste. Compile-only tests assert public API behavior directly, without maintaining a second type definition.
- `docs/CONTEXT.md` defines terms. Add a term there before using it in docs.
- A rule that holds on every surface lives once, in `docs/guarantees.md`. A module card states what is its own and links there; a restated rule drifts.
- Docs describe behavior, not the code: no page names a `src/` path, and `tests/docs.test.ts` checks it. Implementation rationale belongs in tests and design notes, not in code comments ([No prose comments](design/no-prose-comments.md)), nor in names: a name says what a thing is, not why; if the why is worth keeping, a design note or the commit message holds it.
- Tests assert this library's behavior. Effect's or MCP's own wording is matched by its stable fragment (`toContain('at ["value"]')`), never in full, unless a doc quotes it. A test of Effect's own behavior stays only when a doc promises that behavior: the 415, CORS preflight, the generic MCP defect text.
- Every file in `examples/` is listed in `examples/README.md`, which `tests/docs.test.ts` checks; `docs/README.md` links there rather than keeping a list of its own.

## Tests

- Tests import Vitest through `@effect/vitest`, which re-exports it. The pnpm catalog pins `vitest` to the version Vite+ depends on (`vp toolchain vitest`), and an override holds every package to it, Vite+ included, so one Vitest is installed.
- A test running an Effect is `it.effect`, which provides a scope, a `TestClock` and a `TestConsole`: it serves its routes with `Testing.layer(routes)` in its scope, sending a raw request with `send`, and what it logs is captured. A command's lines are read from a console of its own run (`logged`, `printed`), so a test running several reads each one's. A codec that completes later awaits a resolved promise, `Effect.promise(() => Promise.resolve())`, which no `TestClock` holds, where `Effect.yieldNow` would still complete synchronously; a test whose handler waits on real time is `it.live`.
- A test that runs no Effect stays `async`, such as one sending raw requests to a web handler, which `serve` releases when the test finishes. So does a test of an Effect run under no layer, of a context given per request (`serveWithContext`), of `Testing.layer(handler)` run from a Promise test, as a downstream harness runs it, and one pinning a missing requirement with `@ts-expect-error` on `Effect.runPromise`, which `it.effect` would report at the test instead. An `it.effect` test takes `serve`'s handler only to wrap it, recording what a client sends, or to answer a program that provides its own client.
- Each test provides the layers whose state or builds it reads, such as `Users.layerMemory`, rather than sharing one through `it.layer`.
- A suite lives in the folder of the domain it tests, as `src/` is laid out: `tests/http/` for `ActionHttp`. A suite of a rule every surface keeps goes in `tests/guarantees/`, what is not a suite, a helper or a script a suite runs, in `tests/support/`, and a check of the whole repository (docs, skill, browser imports) at the root.
- A rule over many inputs is a property (`it.prop`, `it.effect.prop`) over inputs `Arbitrary.schema` derives; behavior that depends on earlier calls is a model checked after generated command sequences. The expected value comes from the generated input or the model, never from the code under test or another surface's answer, and a new property is proven by a planted violation, named in the commit message ([Properties and models](design/properties-and-models.md)).
- `vp run test:package` installs the packed tarball into a consumer that runs `examples/quickstart*.ts`, copied over the fixture's siblings in `scripts/package-consumer/`, which re-export them so `vp check` type-checks the fixture against them. The examples import the package by name, as the consumer does: `package.json` exports point at the source in the repository, and `pack` swaps in `publishConfig.exports`, which the build writes beside them. The consumer is installed outside the repository, without its workspace overrides or source imports, and compiles the published declarations themselves (`skipLibCheck: false`) with the DOM library and no Node types, so the core stays browser-safe. It compiles with `declaration: true`, as a library built on this one does: every exported value must be nameable from the published modules, and what it emits names nothing internal, no `~` key binding its declarations to this package's private type-only fields.
- Type pins live in `*.spec.ts` and use `expectTypeOf`; a compile failure is an expression under `@ts-expect-error`, which a runtime test may also put on a call it makes as plain JavaScript would. A pin of what a layer owes checks each surface on its own, since over a union one surface's requirements hide the other's absence. Pins over large implementations live in their own file, `tests/guarantees/large-types.spec.ts`, checked beside the others; their fixtures write each identity out rather than passing it to their class as a type argument, which would double their instantiations, a cost no contract `make` returns has.
- `ErrorReporter.make` drops a second report of one cause, so it shows which causes were reported, never how often. A test asserting a cause is reported once writes its reporter out (`recorder` in `tests/support/reporter.ts`), which records each report; one asserting which causes were reported may use `make`, as over HTTP, where the server's own report of a 500 repeats the route's.

## Design notes

One file per decision in [`design/`](design/). Each note is titled, and cited by its title. It states the decision, why, what it costs, and the alternative it rejected; a reversal names the decision it reverses, by commit where one recorded it, in a sentence. History beyond that belongs in commit messages. A note holds a decision: a fact about one declaration in `src/` is its JSDoc, and a fact about a test is its title or a rule under [Tests](#tests).

- [Strict HTTP input](design/strict-http-input.md)
- [Schema failures](design/schema-failures.md)
- [MCP over HTTP](design/mcp-over-http.md)
- [MCP over stdio](design/mcp-over-stdio.md)
- [Successes unwrapped](design/successes-unwrapped.md)
- [Text field](design/text-field.md)
- [Request values win](design/request-values-win.md)
- [JSON-typed routes](design/json-typed-routes.md)
- [Authentication descriptor and provider](design/authentication-descriptor-and-provider.md)
- [One descriptor per name](design/one-descriptor-per-name.md)
- [Refusals outside the router](design/refusals-outside-the-router.md)
- [Built protected resource](design/built-protected-resource.md)
- [Request body size](design/request-body-size.md)
- [TypeScript 7](design/typescript-7.md)
- [Handler requirements](design/handler-requirements.md)
- [Deferred build channels](design/deferred-build-channels.md)
- [Contract identity](design/contract-identity.md)
- [Contract fields](design/contract-fields.md)
- [Error option](design/error-option.md)
- [Built authorization](design/built-authorization.md)
- [Limits](design/limits.md)
- [Toolkit tool ids](design/toolkit-tool-ids.md)
- [A scope per call](design/a-scope-per-call.md)
- [Approval](design/approval.md)
- [CLI failures](design/cli-failures.md)
- [CLI console](design/cli-console.md)
- [Error tags](design/error-tags.md)
- [Native MCP features](design/native-mcp-features.md)
- [Empty CLI arrays](design/empty-cli-arrays.md)
- [CLI services](design/cli-services.md)
- [In-process client](design/in-process-client.md)
- [Testing implementations](design/testing-implementations.md)
- [Binding selection](design/binding-selection.md)
- [Runtime checks](design/runtime-checks.md)
- [Enforced security](design/enforced-security.md)
- [Written return types](design/written-return-types.md)
- [Input values in messages](design/input-values-in-messages.md)
- [Builder memoization](design/builder-memoization.md)
- [One MCP URL](design/one-mcp-url.md)
- [Effect barrels](design/effect-barrels.md)
- [Testing a web handler](design/testing-a-web-handler.md)
- [A request, not a send](design/a-request-not-a-send.md)
- [Surface selection](design/surface-selection.md)
- [Contracts by name](design/contracts-by-name.md)
- [Local and remote CLI](design/local-and-remote-cli.md)
- [Verifier errors](design/verifier-errors.md)
- [Media fields](design/media-fields.md)
- [Stdin field](design/stdin-field.md)
- [RPC surface](design/rpc-surface.md)
- [Domain folders](design/domain-folders.md)
- [No prose comments](design/no-prose-comments.md)
- [Properties and models](design/properties-and-models.md)

## Release

The package publishes to the `latest` tag. The `effect` peer is `~` and the Effect release in
`devDependencies`, the patches of the release the package is tested against; the install commands
name it, as `tests/docs.test.ts` checks. Effect marks every module the surfaces build on
(`effect/http`, `effect/http-api`, `effect/ai`, `effect/cli`, `effect/encoding`)
`@stability unstable`, which a minor release may change, and none `experimental`, which a patch
may. The surfaces also rely on behavior of those
modules that no type states: a Toolkit finds a tool's handler by the tool's `id`,
`HttpApiBuilder.group` lays its build context over each request's, and the MCP HTTP runtime
refuses a stateless request whose `Mcp-Method` or `Mcp-Name` header disagrees with its body
(400, JSON-RPC `-32020`), which lets a mixed endpoint's authentication gate decide from those
headers alone. `.github/workflows/effect-latest.yml` runs the full check weekly against the
newest 4.x. To adopt a newer Effect release, once it is past pnpm's one-day release age, bump the
Effect packages in `devDependencies` and the peer with them, and re-run the full check; a new minor
is admitted that way once that check passes on it.

Record each change a consumer notices under `## Unreleased` at the top of
[CHANGELOG.md](CHANGELOG.md), in the change that makes it: every breaking change and how a
consumer migrates, and any earlier decision it reverses, and why. To release: set `version` in
`package.json`, rename `## Unreleased` to the version, commit as `Prepare <version>`, tag
`v<version>`, and push the commit and tag. The tag runs `.github/workflows/npm.yml`, which checks that the tag
matches `version`, repeats the CI checks, and publishes. It authenticates as the package's npm
trusted publisher (this repository and that workflow file, set under the package's npm
settings), so there is no registry token, and npm attaches provenance.
`prepublishOnly` builds, keeping each source module its own file (`unbundle`), since bundled declarations emit a dangling `__exportAll` export with this toolchain; `files` ships `dist` and `docs`. Each PascalCase file in `src/<domain>/` is an entry, and the build writes `package.json`'s exports, the source in the repository and `dist` under `publishConfig.exports`, which pnpm's `pack` and `publish` swap in and npm's would not: publish with `vp pm publish`, and run `vp run build` after adding, renaming or removing a public module, then commit `package.json`: CI fails when the build changes it. The skill is not in the tarball:
`npx skills add` reads it from GitHub, and agents reading node_modules get `docs/` directly.

## Lint policy

`vite.config.ts` is the source of truth for rule severities; this section explains the
decisions behind it. The vendored plugin's provenance and local corrections are in
[`tools/oxlint/anti-slop/UPSTREAM.md`](tools/oxlint/anti-slop/UPSTREAM.md); the repository's
own rule lives in `tools/oxlint/no-comments/`.

Strict rules are the goal, and lint passes because the code is correct, not because it was
rewritten to satisfy a pattern matcher. A passing lint run is not evidence of type safety by
itself: type safety comes from the compiler flags below and the type-aware `typescript/no-unsafe-*`
rules.

### What is checked

Every owned file: `src`, `tests`, `examples`, `scripts` (the package-consumer fixture included),
the `no-comments` rule and the plugin regression tests in `tools/oxlint`, and `vite.config.ts`.
All of it is TypeScript; a script runs with `node --import tsx`. Lint runs
type-aware with type checking, so `vp check` is one command for format, lint, and compiler
diagnostics.

Excluded: build output (`dist`), agent caches (`.claude`, `.codex`, …), and the vendored plugin
sources under `tools/oxlint/anti-slop`, which follow upstream's own style and are covered by the
regression tests beside them. Nothing owned is excluded to hide findings. `examples/` is exempt
from `no-prose-comments` alone: an example is a doc snippet, and its comments explain it where a
consumer reads it.

Compiler flags required by policy and set in `tsconfig.json`: `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. The assembled package consumer
(`scripts/test-package.ts`) compiles with the same three flags, so a child configuration does
not weaken them.

### Refactor before making an exception

For each finding:

1. Identify the invariant and who owns it. Does the diagnostic expose a missing boundary, erased
   type information, duplicate validation, or an unnecessary abstraction?
2. Prefer the refactor that removes the cause, even across owned APIs. Update callers and tests
   directly; do not add compatibility wrappers to keep an old shape.
3. Preserve concrete safety: third-party contracts, malformed external input, and runtime
   compatibility survive API changes.
4. Distinguish a rule defect from a legitimate exception. A defect is corrected in the vendored
   rule with a regression test and an `UPSTREAM.md` entry. A legitimate case intentionally caught
   by a broad rule gets the smallest justified exception.
5. Exceptions are line-level, `oxlint-disable-next-line <rule> -- <reason>`; `no-prose-comments`
   reports any other form. The reason names the boundary and what the operation still guarantees.
   An unused directive is an error (`reportUnusedDisableDirectives: "deny"`).

Never launder a finding: renaming a parameter, dropping an annotation so inference yields `any`,
casting, moving a `typeof` into a one-use helper, or moving code to an unchecked file leaves the
code exactly as unsafe.

### Rule families

- **Unknown and broad inputs** (`no-unknown-parameters`, `no-unknown-returns`,
  `no-unknown-type-aliases`, `no-object-parameters`, `no-unsafe-dictionary-type`): decode at the
  I/O boundary and pass owner contracts inward. There is no name-based exemption; a parameter named
  `cause` is as unknown as any other, and thrown-value boundaries use an explained directive.
- **Evidence loss** (`no-known-value-widening`, `no-chained-type-assertions`,
  `typescript/no-unsafe-type-assertion`): keep inference or validate with `satisfies`. An
  assertion that is a genuine erasure boundary takes the type-aware rule's directive, whose reason
  names the boundary and the invariant that makes the assertion hold.
- **`any` escape routes** (`typescript/no-unsafe-assignment`, `-argument`, `-call`,
  `-member-access`, `-return`): untyped JSON, SDK generics, callback registries. Type the value at
  its source, for example by importing `package.json` as a typed JSON module instead of parsing it.
- **Runtime probing** (`no-runtime-typeof` with `allowInTypeGuards`): a genuine type predicate may
  probe its subject; discriminating an already typed union takes a narrow explained exception.
- **Quadratic copies** (`no-reduce-accumulator-copy`, `oxc/no-accumulating-spread`): growing copies
  in a loop; fixed-size snapshots may justify an exception.
- **Reflection** (`no-reflect-apply`, `no-reflect-get`): prefer typed access; keep a concrete
  exception only where receiver or getter semantics matter.
- **Module mocking** (`no-module-mocking`): replace dependencies through real seams. The rule
  recognizes `vi` from `@effect/vitest`, this repository's test import, and `vite-plus/test`, as
  well as `vitest`.
- **Prose comments** (`no-comments/no-prose-comments`): what a comment said a thing is goes in a
  name or a type, and why in a test title, a design note or the commit message
  ([No prose comments](design/no-prose-comments.md)). Two kinds remain: a line directive with its
  reason after `--`, `// oxlint-disable-next-line <rule> -- <reason>` or
  `// @ts-expect-error -- <reason>`; and JSDoc in `src/**`, which `vite.config.ts` gives the rule's
  `allowJsDoc`. The rule has no autofix, which would delete the reason with the comment.
- **Domain imports** (`no-restricted-imports` on `src/**`): no domain imports another surface's
  public module, `src/contract/` imports nothing outside itself, and source imports source by
  relative path, since the package's own name resolves to source too and would pass the other two
  ([Domain folders](design/domain-folders.md)).
- **Compile-failure fixtures** (`tests/guarantees/types.spec.ts`): an expression under `@ts-expect-error`
  yields an error type, which the `no-unsafe-*` rules see as `any`. Those lines carry a directive
  stating that nothing runs; the fixture's purpose is the compile failure itself.

Off:

- `anti-slop/require-safety-comment-for-type-assertion`: an assertion the type-aware
  `typescript/no-unsafe-type-assertion` reports already carries a directive whose reason states the
  invariant, and one it does not report the compiler accepts; a `SAFETY:` comment justified the
  same assertion twice.
- `anti-slop/no-array-filter-map`: both forms are linear; rewrites change callback order and
  sparse-array semantics without establishing a performance gain.
- `anti-slop/no-conditional-empty-object-spread`: conditional spread preserves omission semantics
  without mutable builders.
- `anti-slop/no-shape-in-symbol-names`: a substring cannot establish domain ownership; naming is
  reviewed by people.
- `anti-slop/no-widen-then-assert`: the widening is `no-known-value-widening`'s and the narrowing
  assertion `typescript/no-unsafe-type-assertion`'s, which reads types; read from syntax, it took
  a destructured field's evidence from the whole initializer, which its sibling rule corrects.
- `anti-slop-effect/no-service-constructor-imports`: a `make[A-Z]` name cannot establish that an
  import is a dependency-bearing service constructor, and a namespace import bypasses it, which
  rewards the import change the policy calls laundering.

### Verification

- `tools/oxlint/tests/rules.test.ts` runs the corrected rules through Oxlint's `RuleTester`,
  with an accepted and a still-rejected case for each correction, and
  `tools/oxlint/tests/no-comments.test.ts` each kept and each reported form of comment.
- `tools/oxlint/tests/configuration.test.ts` runs `vp lint` once on fixtures inside the
  repository, so the probes go through the registered plugin and the effective configuration:
  unknown parameters named `cause`, module mocking via `@effect/vitest`, `typeof` inside and
  outside predicates, literal evidence in destructured bindings, a justified
  `no-unknown-parameters` directive and its unused counterpart, and a prose comment reported
  beside a directive that gives its reason.
  Every other lint, format, type check and test run ignores the fixtures, which hold findings on purpose:
  the run sets `LINT_PROBE`, which lifts their lint ignore pattern in `vite.config.ts`, so a
  `vp check` beside `vp test` never reports them.

### History

Historical measurement, not a backlog: when the baseline was adopted (2026-09-19) the repository
had zero findings under the previous configuration. Enabling the `typescript/no-unsafe-*` rules and
widening coverage to the scripts surfaced 60 findings, all resolved by refactor or by the
explained directives listed above. Two rule-behavior gaps (`cause` exemption, unrecognized
`vite-plus/test` import) and two false positives in `no-known-value-widening` (destructured
bindings inheriting the initializer's evidence, finite mapped keys classified as open
dictionaries) were corrected in the vendored rules.
