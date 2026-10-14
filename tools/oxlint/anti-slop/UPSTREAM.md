# anti-slop provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (`main` as of 2026-09-16)
- Copied assets: `skills/install-anti-slop/assets/anti-slop/` from that commit
- Installed paths:
  - generic plugin: `tools/oxlint/anti-slop/index.ts`
  - Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`

## Verification

These files are excluded from this repository's own lint and format runs so they keep
upstream's style. Only the rules imported by the regression tests and their transitive
dependencies are included in the repository's TypeScript program; the full vendored plugin
is not type-checked here.
Upstream's test suite at the pinned commit is the evidence for unchanged rules; the local
corrections below are covered by `tools/oxlint/tests/rules.test.ts` (rule level, via
`RuleTester`) and `tools/oxlint/tests/configuration.test.ts` (through `vp lint` and the
registered configuration). A bump of `Source commit` must preserve the corrections below
and re-run both.

Policy: [`AGENTS.md`](../../../AGENTS.md#lint).

## Rules that are off, and why

`vite.config.ts` holds each rule's severity. These are off on purpose: do not turn one on
without answering its reason.

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
- `anti-slop-effect/no-manual-tag-comparison` and `no-manual-tagged-construction` are off in
  `*.test.ts` and `*.spec.ts`: expected `_tag` literals describe observations, and direct tag
  assertions use TypeScript's native narrowing. Requiring production constructors for expected
  values can couple an oracle to the code it checks. Type-aware safety rules still apply, and
  both tag rules remain enabled outside test files. Configuration probes cover that boundary.

## Local rule corrections

Preserve these when updating from upstream.

- `rules/no-unknown-parameters.ts`: removed the name-based exemption for parameters named
  `cause`. A name grants no evidence; thrown-value boundaries use an explained directive.
- `rules/no-module-mocking.ts`: `vi` imported from `@effect/vitest` (this repository's test
  import, Effect's re-export of Vitest) or `vite-plus/test` (Vite+'s) is recognized alongside
  `vitest`. Without this the rule was enabled but never matched a real test file here.
- `rules/no-known-value-widening.ts`: a destructured `const` binding now resolves to the
  property or element it selects from a literal initializer (`selectFromPattern`), instead of
  inheriting the whole initializer object's evidence. A spread that could supply or override
  the position, a computed key, a rest binding, or a non-literal initializer yields no
  evidence. A computed key that is not a literal is treated like a spread. Previously
  `const { user } = { user: load() }` counted as a known literal. An array pattern stops at
  the first spread element, which narrows each remaining element to an expression.
- `shared/dictionary-types.ts`, `classifyWideningTarget`: an inline mapped type is an open
  dictionary only when its key constraint is broad (`isBroadMappedKey`), matching the alias
  path below it. Previously `{ readonly [K in "a" | "b"]: number }` was reported as widening,
  which the baseline forbids for finite mapped keys.
- `shared/dictionary-types.ts`, `unsafeDirectValue`: a top-level interface is the value a
  reference names only when no type parameter or nearer declaration shadows it
  (`isProgramTypeBinding` in `shared/type-alias-resolution.ts`, beside `visibleTypeAlias`, which
  the alias path already used). Previously `interface Value {}` made `Record<string, Value>`
  under `<Value extends string>`, or under an inner `type Value = string`, an empty-object
  dictionary.
- `shared/dictionary-types.ts`: `unsafeMembers[0] ?? null` so the file type-checks under
  `noUncheckedIndexedAccess`, which the regression tests' program requires.

## Intentional deviations

- Plugin authoring imports use `vite-plus/lint/plugins` instead of `@oxlint/plugins`.
  Vite+ supplies the pinned Oxlint copy (inspect current versions with `vp toolchain`)
  and documents this re-export so local JS plugins stay pinned to the toolchain copy. Neither
  `oxlint` nor `@oxlint/plugins` is added as a direct dependency.
- Effect rules are enabled because this package depends on `effect` directly
  (peer and development) and the install requested the Effect rule group.

Vendored ESLint Stylistic license and provenance remain at
`vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md`.
