# anti-slop provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (`main` as of 2026-09-16)
- Copied assets: `skills/install-anti-slop/assets/anti-slop/` from that commit
- Installed paths:
  - generic plugin: `tools/oxlint/anti-slop/index.ts`
  - Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`

## Verification

These files are excluded from this repository's own lint and format runs and have no
local tests. The evidence that the rules work is upstream's test suite at the pinned
commit; a bump of `Source commit` should re-run it there. Locally, `vp check` exercising
the rules against `src/` and `tests/` is the only smoke test.

## Intentional deviations

- Plugin authoring imports use `vite-plus/lint/plugins` instead of `@oxlint/plugins`.
  Vite+ bundles Oxlint (`oxlint@1.82.0` via `vite-plus@0.3.2`) and documents this
  re-export so local JS plugins stay pinned to the toolchain copy. Neither
  `oxlint` nor `@oxlint/plugins` is added as a direct dependency.
- Effect rules are enabled because this package depends on `effect` directly
  (peer and development) and the install requested the Effect rule group.

Vendored ESLint Stylistic license and provenance remain at
`vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md`.
