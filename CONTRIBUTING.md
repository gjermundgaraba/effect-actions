# Contributing

For people and agents changing the library. Consumers read [docs/](docs/README.md) instead.

## Setup

Requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` (`devEngines` in `package.json`; CI tests 22, 24 and 26) and [Vite+](https://viteplus.dev). Run `vp install`, then see
[AGENTS.md](AGENTS.md) for the commands, the repository map, and the validation rules.

Vocabulary: [docs/CONTEXT.md](docs/CONTEXT.md). Use its terms in code comments, docs, and tests.

## Documentation rules

- `README.md` sells the library to humans: the pitch, one showcase snippet, why, install, links. No reference material.
- `docs/` is for coding agents. Every module card has the same sections: **API**, **Canonical**, **Rules**, **Failure modes**. No tutorials, no narrative. State what holds and what breaks. `setup.md`, `guarantees.md` and `CONTEXT.md` are cross-cutting pages with the structure their role needs.
- `docs/README.md` is the routing table and doubles as the skill body. One line per page saying when to read it.
- A change to public behavior changes the matching `docs/` page in the same commit. Then run `vp run docs:sync`; `tests/skill.test.ts` fails if the generated skill is stale.
- API sections inventory exports and options; do not hand-copy complex generic declarations. Exported TypeScript declarations are the exact signature reference.
- `tests/docs.test.ts` compares the README showcase and selected executable examples with files in `examples/`, so those snippets stay type-checked. Edit the example, then paste. Compile-only tests assert public API behavior directly, without maintaining a second type definition.
- `docs/CONTEXT.md` defines terms. Add a term there before using it in docs.
- A rule that holds on every surface lives once, in `docs/guarantees.md`. A module card states what is its own and links there; a restated rule drifts.
- Tests assert this library's behavior. Effect's or MCP's own wording is matched by its stable fragment (`toContain('at ["value"]')`), never in full, unless a doc quotes it. A test of Effect's own behavior stays only when a doc promises that behavior.

## Design notes

- HTTP input is strict through `HttpApi.PayloadParseOptions` alone. A strict `ParseOptions` would also govern error encoding, where it could turn a declared error into an empty 500. An action without input is `Schema.Record(Schema.String, Schema.Never)`: `Schema.Struct({})` accepts any value but `null`, and has no object root for MCP.
- MCP sends the encoded success itself as `structuredContent`. This reverses the `{ value }` object every tool output was rooted at through 0.7.0: MCP 2026-07-28, the only revision served, allows any JSON value there and any `outputSchema` root, and the specification's own examples send the value directly.
- A text field (`mcp.text`) is moved out of what native `McpServer.registerToolkit` registers, which always sends the whole success as structured content. `ActionMcp` runs `registerToolkit` against a copy of the server whose `addTool` removes the field from the listed `outputSchema` and, when it holds a string, from each success, and sends it as a raw text block. Any other result is the native one, so decoding, failures and defects stay the native server's. The tool carries its field as an annotation. A native option for this would delete the copy.

## Release

The package publishes to the `latest` tag. The `effect` peer accepts any Effect 4.0 release
candidate from `4.0.0-rc.118` on (the peer's lower bound); the package is built and tested
against the release candidate in `devDependencies`. When
adopting a newer release candidate, bump `devDependencies`, re-run the full check, and raise the
peer's lower bound only if the package starts to depend on the newer release.

To release: set `version` in `package.json`, add its section to [CHANGELOG.md](CHANGELOG.md)
(every breaking change and how a consumer migrates), commit as `Prepare <version>`, tag
`v<version>`, and push the commit and tag. The tag runs `.github/workflows/npm.yml`, which checks that the tag
matches `version`, repeats the CI checks, and publishes. It authenticates as the package's npm
trusted publisher (this repository and that workflow file, set under the package's npm
settings), so there is no registry token, and npm attaches provenance.
`prepublishOnly` builds; `files` ships `dist` and `docs`. The skill is not in the tarball:
`npx skills add` reads it from GitHub, and agents reading node_modules get `docs/` directly.

## Lint policy

`vite.config.ts` is the source of truth for rule severities; this section explains the
decisions behind it. The vendored plugin's provenance and local corrections are in
[`tools/oxlint/anti-slop/UPSTREAM.md`](tools/oxlint/anti-slop/UPSTREAM.md).

Strict rules are the goal, and lint passes because the code is correct, not because it was
rewritten to satisfy a pattern matcher. A passing lint run is not evidence of type safety by
itself: type safety comes from the compiler flags below and the type-aware `typescript/no-unsafe-*`
rules.

### What is checked

Every owned file: `src`, `tests`, `examples`, `scripts` (including the package-consumer fixture
and `scripts/test-package.mjs`, checked as JavaScript with `allowJs`/`checkJs` and owner-derived
JSDoc types), the plugin regression tests in `tools/oxlint/tests`, and `vite.config.ts`. Lint runs
type-aware with type checking, so `vp check` is one command for format, lint, and compiler
diagnostics.

Excluded: build output (`dist`), agent caches (`.claude`, `.codex`, …), and the vendored plugin
sources under `tools/oxlint/anti-slop`, which follow upstream's own style and are covered by the
regression tests beside them. Nothing owned is excluded to hide findings.

Compiler flags required by policy and set in `tsconfig.json`: `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. The assembled package consumer
(`scripts/test-package.mjs`) compiles with the same three flags, so a child configuration does
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
5. Exceptions are line-level (`oxlint-disable-next-line <rule> -- <reason>`) or a tightly bounded
   disable/enable pair. The reason names the boundary and what the operation still guarantees.
   An unused directive is an error (`reportUnusedDisableDirectives: "deny"`).

Never launder a finding: renaming a parameter, dropping an annotation so inference yields `any`,
casting, moving a `typeof` into a one-use helper, or moving code to an unchecked file leaves the
code exactly as unsafe.

### Rule families

- **Unknown and broad inputs** (`no-unknown-parameters`, `no-unknown-returns`,
  `no-unknown-type-aliases`, `no-object-parameters`, `no-unsafe-dictionary-type`): decode at the
  I/O boundary and pass owner contracts inward. There is no name-based exemption; a parameter named
  `cause` is as unknown as any other, and thrown-value boundaries use an explained directive.
- **Evidence loss** (`no-known-value-widening`, `no-widen-then-assert`,
  `no-chained-type-assertions`, `require-safety-comment-for-type-assertion`,
  `typescript/no-unsafe-type-assertion`): keep inference or validate with `satisfies`. A SAFETY
  comment is necessary, not sufficient; the type-aware assertion rule needs its own explained
  directive when an assertion is a genuine erasure boundary.
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
  recognizes `vi` from `vite-plus/test`, this repository's test import, as well as `vitest`.
- **Compile-failure fixtures** (`tests/types.spec.ts`): an expression under `@ts-expect-error`
  yields an error type, which the `no-unsafe-*` rules see as `any`. Those lines carry a directive
  stating that nothing runs; the fixture's purpose is the compile failure itself.

Off, with reasons recorded beside the setting in `vite.config.ts`:

- `anti-slop/no-array-filter-map`: both forms are linear; rewrites change callback order and
  sparse-array semantics without establishing a performance gain.
- `anti-slop/no-conditional-empty-object-spread`: conditional spread preserves omission semantics
  without mutable builders.
- `anti-slop/no-shape-in-symbol-names`: a substring cannot establish domain ownership; naming is
  reviewed by people.

### Verification

- `tools/oxlint/tests/rules.test.ts` runs the corrected rules through Oxlint's `RuleTester`,
  with an accepted and a still-rejected case for each correction, and a justified directive
  paired with its unused counterpart for each corrected rule.
- `tools/oxlint/tests/configuration.test.ts` runs `vp lint` on fixtures inside the repository, so
  the probes go through the registered plugin and the effective configuration: unknown parameters
  named `cause`, module mocking via `vite-plus/test`, `typeof` inside and outside predicates, a
  justified directive and its unused counterpart, maintained JavaScript, and the three disabled
  rules.

### History

Historical measurement, not a backlog: when the baseline was adopted (2026-09-19) the repository
had zero findings under the previous configuration. Enabling the `typescript/no-unsafe-*` rules and
widening coverage to the scripts surfaced 60 findings, all resolved by refactor or by the
explained directives listed above. Two rule-behavior gaps (`cause` exemption, unrecognized
`vite-plus/test` import) and two false positives in `no-known-value-widening` (destructured
bindings inheriting the initializer's evidence, finite mapped keys classified as open
dictionaries) were corrected in the vendored rules.
