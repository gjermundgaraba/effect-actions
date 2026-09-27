// The consumer fixture imports the quickstart as sibling modules. Inside the
// assembled consumer, `scripts/test-package.mjs` replaces this file and its server
// sibling with `examples/quickstart*.ts`, their imports rewritten to the published
// package name. In the repository, these re-exports let the fixture type-check against
// the same source, so a drift is caught by `vp check` before the slower package test.
export * from "../../examples/quickstart.js";
