# anti-slop provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (`main` as of 2026-09-16)
- Copied assets: `skills/install-anti-slop/assets/anti-slop/` from that commit
- Installed paths:
  - generic plugin: `tools/oxlint/anti-slop/index.ts`
  - Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`

## Verification

These files are excluded from this repository's own lint and format runs so they keep
upstream's style. They are type-checked through the regression tests that import them.
Upstream's test suite at the pinned commit is the evidence for unchanged rules; the local
corrections below are covered by `tools/oxlint/tests/rules.test.ts` (rule level, via
`RuleTester`) and `tools/oxlint/tests/configuration.test.ts` (through `vp lint` and the
registered configuration). A bump of `Source commit` must preserve the corrections below
and re-run both.

Policy: [`docs/lint-policy.md`](../../../docs/lint-policy.md).

## Local rule corrections

Preserve these when updating from upstream.

- `rules/no-unknown-parameters.ts`: removed the name-based exemption for parameters named
  `cause`. A name grants no evidence; thrown-value boundaries use an explained directive.
- `rules/no-module-mocking.ts`: `vi` imported from `vite-plus/test` (this repository's test
  import, Vite+'s re-export of Vitest) is recognized alongside `vitest`. Without this the
  rule was enabled but never matched a real test file here.
- `rules/no-known-value-widening.ts`: a destructured `const` binding now resolves to the
  property or element it selects from a literal initializer (`selectFromPattern`), instead of
  inheriting the whole initializer object's evidence. A spread that could supply or override
  the position, a computed key, a rest binding, or a non-literal initializer yields no
  evidence. A computed key that is not a literal is treated like a spread. Previously
  `const { user } = { user: load() }` counted as a known literal.
- `shared/dictionary-types.ts`, `classifyWideningTarget`: an inline mapped type is an open
  dictionary only when its key constraint is broad (`isBroadMappedKey`), matching the alias
  path below it. Previously `{ readonly [K in "a" | "b"]: number }` was reported as widening,
  which the baseline forbids for finite mapped keys.
- `shared/dictionary-types.ts`: `unsafeMembers[0] ?? null` so the file type-checks under
  `noUncheckedIndexedAccess`, which the regression tests' program requires.

## Intentional deviations

- Plugin authoring imports use `vite-plus/lint/plugins` instead of `@oxlint/plugins`.
  Vite+ bundles Oxlint (`oxlint@1.82.0` via `vite-plus@0.3.2`) and documents this
  re-export so local JS plugins stay pinned to the toolchain copy. Neither
  `oxlint` nor `@oxlint/plugins` is added as a direct dependency.
- Effect rules are enabled because this package depends on `effect` directly
  (peer and development) and the install requested the Effect rule group.

Vendored ESLint Stylistic license and provenance remain at
`vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md`.
