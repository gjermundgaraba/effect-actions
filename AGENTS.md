<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

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

`@gjermundgaraba/effect-actions`. Use the vocabulary in [docs/CONTEXT.md](docs/CONTEXT.md).

## Working safely and validating

These rules override the regenerated Vite+ block above; do not edit that block.

- Preserve other agents' work. Reviewers leave the worktree untouched: installs, builds, tests that write and scratch work run in an isolated copy including relevant uncommitted changes. Clean up only your own artifacts. Never use bare `git stash` or `git stash pop`.
- Commit only when asked. The staged hook runs `vp check --fix` and may rewrite files or encounter others' unfinished changes.
- Code/tooling changes, including executable examples: run focused checks, then `vp check`, `vp test` and `vp run test:package`. Coordinate one final run after concurrent edits settle. Prose-only changes need relevant formatting, docs and skill-sync checks. Reviews run checks needed for their assessment, under the isolation rule.
- Rerun a load-related timeout alone with `vp test <file>` and report both results. State review scope, unrelated failures and checks not run; claim only completed work.

## Design

- Keep flat `src/<domain>/` folders: PascalCase public modules beside lowercase private files. Shared behavior belongs in `contract`; each surface owns its projection and validates only names it serves. Public modules expose consumer types as `Options`, `<Function>Options` and `Any`.
- Use native Effect servers, clients and composition; add no protocol runtime. Consult pinned `node_modules/effect` before inventing helpers or assuming APIs. Remove restrictions that obstruct useful native composition. Support the pinned TypeScript, without older-compiler workarounds.
- Applications own verification, login, consent and authorization policy; the library enforces it. Operational limits belong in handlers with declared errors, record checks in data access. Separate startup dependencies from request requirements; never provide request identity at server startup.
- Minimize the complete consumer workflow: one obvious path, useful defaults, library-owned wiring and optional advanced composition through the same model. Do not simplify internals by making consumers rebuild the wiring. Breaking changes are welcome; no compatibility shims, deprecations or migration aliases.
- Justify new public concepts against existing ones. API/workflow proposals show before/after consumer code and concepts added or removed, for the common case and any affected advanced case.
- For consumer-visible changes, update the example, guiding docs and `CHANGELOG.md`'s `Unreleased` together; explain breaking-change migration. Name and explain reversals of decisions in `// Why:` comments or the changelog. For untested documented guarantees, test intended behavior and correct unsupported promises instead of building machinery to preserve them.

## Documentation

- `README.md` is the human pitch and quickstart, not a reference. `docs/` guides consumer agents through tasks, choices, traps, boundaries and failures; omit behavior already shown by types, JSDoc or working examples. Link to the example files that show a task; embed a snippet only where a few lines orient faster than opening the file. Edit README quickstart examples at their source first.
- Keep docs flat. Module pages inventory exports/options in **API**, without copying generic signatures, then link examples by task. Put independently readable symptoms and fixes in `<Module>-failures.md`. Route readers through `docs/README.md`; define new terms in `docs/CONTEXT.md`; keep wire behavior once in `docs/guarantees.md`.
- Examples are independent, complete applications following `examples/README.md`, importing the package by name and no other example. Comments teach why; mark deployment shortcuts `DEMO ONLY`.
- Edit `docs/`, never generated `skills/effect-actions/`; run `vp run docs:sync` after docs changes.

## Tests

- Mirror domains under `tests/`; shared guarantees go in `tests/guarantees/`, helpers in `tests/support/`, shared application in `tests/support/app/`, repository checks at the root. Type pins use `*.spec.ts`, `expectTypeOf` and negative expressions under `@ts-expect-error`; check each surface's requirements separately, never a union that can hide an omission.
- Import Vitest through `@effect/vitest`. Default Effect tests to `it.effect` with scoped `Testing.layer(routes)`; use `it.live` for real time. Keep promise tests for raw web handlers, absent-layer/per-request-context behavior, downstream promise harnesses and runPromise-level missing-requirement assertions. Give each test the layers whose state/builds it observes.
- Use schema-derived properties for input rules and models for stateful sequences. Derive expected values from input/model, never the implementation or another surface. Prove new properties with a planted violation and record it in the commit message, or report if no commit is requested. Keep case tests for component interfaces, tautological property oracles and readable examples.
- Match upstream errors by stable fragments unless docs quote them; test upstream behavior only to uphold documented promises. To count reports, use `tests/support/reporter.ts`'s `recorder`: `ErrorReporter.make` deduplicates them.

## Lint

- Fix the owning cause, not the diagnostic's spelling. Do not hide findings through renaming, inference to `any`, casts, one-use helpers or excluded files. Preserve external-input and third-party boundary safety. Fix defective vendored rules with regression tests and an entry in `tools/oxlint/anti-slop/UPSTREAM.md`, which also says why each rule that is off is off; legitimate exceptions must explain the boundary and surviving guarantee.
- In `src/`, put consumer JSDoc on the declaration that ships, including private-module types, not its re-export. Use `// Why:` for a non-obvious decision and what would break if reversed, in one to three sentences; other rationale belongs in names, types, test titles or commit messages. Example comments teach.

## Release

- When asked to release: set `package.json`'s version, rename `Unreleased` to it, commit as `Prepare <version>`, tag `v<version>` and push both. The tag publishes via `.github/workflows/npm.yml`. Manual publishing must use `vp pm publish` so `publishConfig.exports` is applied.
- After adding, renaming or removing public modules, run `vp run build` and include the generated `package.json` exports in the change. The build keeps each module its own file (`unbundle`): bundled declarations emit a dangling `__exportAll` export.
- `package.json`'s `engines` is the floor stated to consumers, lower than `devEngines` on purpose: do not align them.
- Upgrade Effect development packages and its `~` peer together, respect package-manager release-age checks, and rerun full validation.
