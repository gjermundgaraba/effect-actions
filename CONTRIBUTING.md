# Contributing

For people and agents changing the library. Consumers read [docs/](docs/README.md) instead.

## Setup

Requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` (`devEngines` in `package.json`; CI tests 22, 24 and 26) and [Vite+](https://viteplus.dev). Run `vp install`, then see
[AGENTS.md](AGENTS.md) for the commands, the repository map, and the validation rules.
`engines` in `package.json` is the lower floor the published package states to consumers.

Vocabulary: [docs/CONTEXT.md](docs/CONTEXT.md). Use its terms in names, docs, and tests.

## Documentation rules

The source is the truth for behavior, and the examples are the reference for how code is
written. `docs/` guides a reader between the two and restates neither.

- `README.md` sells the library to humans: the pitch, the quickstart and what else its implementation becomes, why, install, links, status. No reference material.
- `examples/` holds complete applications, one directory each, in the layout `examples/README.md` states: a folder per domain, the PascalCase file in it the contract, `routes.ts` the surfaces as one Layer, one entrypoint per way of running it, tests under `test/` mirroring `src/`. An example imports the package by name and no other example, runs as its README says, and marks each demo shortcut `DEMO ONLY`. It is what a consumer's agent copies: a subtle bad habit there is worse than a bug, and needless complexity is a defect.
- An example's comments teach a developer new to the library what to notice and why; they do not narrate the code. Its tests show how to test: a domain's in `test/<domain>/`, in process with `Action.client`; what the surfaces add in `test/routes.test.ts`, in memory with `Testing.layer`.
- `docs/` is for coding agents writing code against the library. A module page has a title and a few sentences, **API** (every export and option, one line each) and sections named for tasks, each linking the example files that show it. Beside it, `<Module>-failures.md` holds its failure modes (what you see when it is wrong, and the fix), read when something fails: each entry is true read alone, as a search for a message finds one line. A module whose tasks outgrow one read has a second page, `<Module>-<topic>.md`. The directory is flat. Setup, vocabulary and the wire table use the structure their role needs.
- A sentence stays on a page only if it says how to do a task, how to make a choice, a trap the types do not stop and an example cannot show by working, a boundary of the library, or a failure mode. Behavior the types, the JSDoc or an example already show is not restated: a restated rule drifts.
- A page links to the example files that show a task, as `[notes-service/src/routes.ts](../examples/notes-service/src/routes.ts)`, and embeds a snippet only when a few lines orient faster than opening the file. `tests/docs.test.ts` checks that every relative link and anchor in `README.md`, `docs/` and the examples' READMEs exists.
- `docs/README.md` is the routing table and doubles as the skill body: where the docs and examples are, which page answers which task, which example to start from.
- A page fits one read of an agent's tool, which cuts a longer output without the reader noticing: under 16 KB, which `tests/docs.test.ts` checks. A page that outgrows it loses what the types, the JSDoc or an example already say, or is split.
- A change to public behavior changes the example that shows it and the `docs/` page that guides it in the same commit. Then run `vp run docs:sync`; `tests/skill.test.ts` fails if the generated skill is stale.
- API sections inventory exports and options; do not hand-copy complex generic declarations. Exported TypeScript declarations are the exact signature reference.
- A snippet fenced as ` ```ts example=<path> ` stays byte-identical to that file in `examples/`, which `tests/docs.test.ts` checks. The root `README.md` uses it for the quickstart. Edit the example, then paste.
- `docs/CONTEXT.md` defines terms. Add a term there before using it in docs.
- What each case looks like on the wire, on every surface, lives once, in the table of `docs/guarantees.md`. A module page links there.
- No page names a `src/` path of the library, which does not ship, and `tests/docs.test.ts` checks it. Where a reason goes: [Prose comments](#rule-families).
- Tests assert this library's behavior. Effect's or MCP's own wording is matched by its stable fragment (`toContain('at ["value"]')`), never in full, unless a doc quotes it. A test of Effect's own behavior stays only when a doc promises that behavior: the 415, CORS preflight, the generic MCP defect text.
- Every directory in `examples/` has a README and is listed in `examples/README.md`, which `tests/docs.test.ts` checks.

## Tests

- Tests import Vitest through `@effect/vitest`, which re-exports it. The pnpm catalog pins `vitest` to the version Vite+ depends on (`vp toolchain vitest`), and an override holds every package to it, Vite+ included, so one Vitest is installed.
- A test running an Effect is `it.effect`, which provides a scope, a `TestClock` and a `TestConsole`: it serves its routes with `Testing.layer(routes)` in its scope, sending a raw request with `send`, and what it logs is captured. A command's lines are read from a console of its own run (`logged`, `printed`), so a test running several reads each one's. A codec that completes later awaits a resolved promise, `Effect.promise(() => Promise.resolve())`, which no `TestClock` holds, where `Effect.yieldNow` would still complete synchronously; a test whose handler waits on real time is `it.live`.
- A test that runs no Effect stays `async`, such as one sending raw requests to a web handler, which `serve` releases when the test finishes. So does a test of an Effect run under no layer, of a context given per request (`serveWithContext`), of `Testing.layer(handler)` run from a Promise test, as a downstream harness runs it, and one pinning a missing requirement with `@ts-expect-error` on `Effect.runPromise`, which `it.effect` would report at the test instead. An `it.effect` test takes `serve`'s handler only to wrap it, recording what a client sends, or to answer a program that provides its own client.
- Each test provides the layers whose state or builds it reads, such as `Users.layerMemory`, rather than sharing one through `it.layer`.
- A suite lives in the folder of the domain it tests, as `src/` is laid out: `tests/http/` for `ActionHttp`. A suite of a rule every surface keeps goes in `tests/guarantees/`, what is not a suite, a helper or a script a suite runs, in `tests/support/`, with the demo application the suites share in `tests/support/app/`, and a check of the whole repository (docs, skill, browser imports) at the root.
- A rule over many inputs is a property (`it.prop`, `it.effect.prop`) over inputs `Arbitrary.schema` derives; behavior that depends on earlier calls is a model checked after generated command sequences. The expected value comes from the generated input or the model, never from the code under test or another surface's answer, and a new property is proven by a planted violation, named in the commit message. An example test stays for one interface between components, and for a rule whose oracle would restate the code, as a name pattern's would; the example suites are not rewritten as properties, since docs cite their readable cases.
- `vp run test:package` installs the packed tarball into a consumer, checks that every page of `docs/` and every example is in it, and runs the quickstart example copied out of the installed package. The fixture's `quickstart.ts` and `quickstart-server.ts` in `scripts/package-consumer/` re-export the example so `vp check` type-checks the fixture against it. The examples import the package by name, as the consumer does ([Release](#release)). The consumer is installed outside the repository, without its workspace overrides or source imports, and compiles the published declarations themselves (`skipLibCheck: false`) with the DOM library and no Node types, so the core stays browser-safe. It compiles with `declaration: true`, as a library built on this one does: every exported value must be nameable from the published modules, and what it emits names nothing internal, no `~` key binding its declarations to this package's private type-only fields.
- Type pins live in `*.spec.ts` and use `expectTypeOf`; a compile failure is an expression under `@ts-expect-error`, which a runtime test may also put on a call it makes as plain JavaScript would. A pin of what a layer owes checks each surface on its own, since over a union one surface's requirements hide the other's absence. Pins over large implementations live in their own file, `tests/guarantees/large-types.spec.ts`, checked beside the others; their fixtures write each identity out rather than passing it to their class as a type argument, which would double their instantiations, a cost no contract `make` returns has.
- `ErrorReporter.make` drops a second report of one cause, so it shows which causes were reported, never how often. A test asserting a cause is reported once writes its reporter out (`recorder` in `tests/support/reporter.ts`), which records each report; one asserting which causes were reported may use `make`, as over HTTP, where the server's own report of a 500 repeats the route's.

## Release

The package publishes to the `latest` tag. The `effect` peer is `~` and the Effect release in
`devDependencies`, the patches of the release the package is tested against; the install commands
name it, as `tests/docs.test.ts` checks. Effect marks every module the surfaces build on
(`effect/http`, `effect/http-api`, `effect/rpc`, `effect/ai`, `effect/cli`, and `Sse` of
`effect/encoding`)
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
`prepublishOnly` builds, keeping each source module its own file (`unbundle`), since bundled declarations emit a dangling `__exportAll` export with this toolchain; `files` ships `dist`, `docs` and `examples`. Each PascalCase file in `src/<domain>/` is an entry, and the build writes `package.json`'s exports, the source in the repository and `dist` under `publishConfig.exports`, which pnpm's `pack` and `publish` swap in and npm's would not: publish with `vp pm publish`, and run `vp run build` after adding, renaming or removing a public module, then commit `package.json`: CI fails when the build changes it. The skill is not in the tarball:
`npx skills add` reads it from GitHub, and agents reading node_modules get `docs/` and `examples/` directly.

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
regression tests beside them. The generated skill, `skills/effect-actions`, is excluded from
formatting alone: its links are rewritten after `docs/` is formatted, and `tests/skill.test.ts`
holds it equal to what the generator writes. Nothing owned is excluded to hide findings. `examples/` is exempt
from `no-prose-comments` alone: an example is what a consumer reads to learn the library, and
its comments teach.

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
- **Module mocking** (`no-module-mocking`): replace dependencies through real seams.
- **Prose comments** (`no-comments/no-prose-comments`): what a comment said a thing is goes in a
  name or a type, and why in a test title or the commit message. Three kinds remain. Everywhere, a
  line directive with its reason after `--`: `// oxlint-disable-next-line <rule> -- <reason>` or `//
  @ts-expect-error -- <reason>`. In `src/**`, which `vite.config.ts` gives the rule's
  `allowJsDoc` and `allowWhy`, two more. JSDoc, which is for consumers: what a declaration that
  ships is and does, read in an editor. The build keeps it on a public module's declarations and
  on the types they name, a private module's included, and drops it from a re-export, so the
  private declaration carries the text. A JSDoc comment holding `@ts-expect-error` or `@ts-ignore`
  is reported, since the compiler honors one on its last line. And a `// Why:` comment, for
  maintainers: a run of line comments whose first starts with `Why:`, the rest at its column,
  holding a reason whose loss would let a maintainer undo a deliberate choice or make a rejected
  one again: a workaround for Effect's or TypeScript's behavior, a deliberate difference from a
  native API, the alternative that reads as the obvious one. It gives the reason and what breaks,
  in one to three sentences, never what the code does nor its history. The rule checks the form,
  not the content: whether JSDoc reaches a consumer, and whether a comment is a reason, are a
  reviewer's to judge. The rule has no autofix, which would delete the reason with the comment.
- **Domain imports** (`no-restricted-imports`, `typescript/consistent-type-imports` and
  `typescript/no-import-type-side-effects` on `src/**`): a relative import is `./<file>.js`,
  another domain's private `../<domain>/<file>.js`, or the contract's; in `src/contract/`,
  `./<file>.js` alone. The patterns allow those forms and report every other relative specifier,
  since a pattern reads a specifier as written and a list of forbidden spellings is never complete.
  The package's own name, which resolves to source too, and an `import()` type, which no import
  pattern reads, are reported as well. The rule reporting that type, `consistent-type-imports`, has
  no option for it alone: in `src/` it reports every `import()` type, and an import used only as a
  type that lacks `type`. An import whose names all carry `type` inline satisfies it and still
  leaves `import "./<file>.js"` in the built module, which the bundler keeps in one build and drops
  in the next: `no-import-type-side-effects` reports it, and `import type { … }` is the form.
- **Compile-failure fixtures** (`*.spec.ts`): an expression under `@ts-expect-error`
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
  `no-unknown-parameters` directive and its unused counterpart, a prose comment reported
  beside a directive that gives its reason, and, in a fixture's own `src/`, which the
  configuration gives the overrides of the repository's, an export's JSDoc and a `// Why:` comment
  kept, both reported outside it, a private declaration's JSDoc reported, and each kind of import
  across domains reported.
  Every other lint, format, type check and test run ignores the fixtures, which hold findings on purpose:
  the run sets `LINT_PROBE`, which lifts their lint ignore pattern in `vite.config.ts`, so a
  `vp check` beside `vp test` never reports them.
