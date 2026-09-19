// The consumer fixture imports the quickstart as a sibling module. Inside the
// assembled consumer, `scripts/test-package.mjs` replaces this file with
// `examples/quickstart.ts`, its imports rewritten to the published package name.
// In the repository, this re-export lets the fixture type-check against the same
// source, so a drift is caught by `vp check` before the slower package test.
export * from "../../examples/quickstart.js";
