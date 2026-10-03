import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * The type instantiations TypeScript makes checking the fixture alone, under the project's
 * options, as `--extendedDiagnostics` counts them: the same on every run of one compiler and
 * one Effect release. A fixture that does not compile fails the run.
 */
const instantiations = (fixture: string): number => {
  const directory = mkdtempSync(join(tmpdir(), "effect-actions-type-budget-"));

  try {
    const config = join(directory, "tsconfig.json");

    // Node's types resolve from the project's directory alone, and no fixture reads them.
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        compilerOptions: { types: [] },
        include: [],
        files: [join(root, "tests/type-budget", fixture)],
      }),
    );

    const report = execFileSync(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), "-p", config, "--extendedDiagnostics"],
      { encoding: "utf8" },
    );

    const count = /^Instantiations:\s+(\d+)$/m.exec(report)?.[1];

    if (count === undefined) throw new Error(`No instantiation count in:\n${report}`);

    return Number(count);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// Design note 51 rests a hook's declared errors on their cost staying linear in the actions.
// Measured on TypeScript 7.0.2 and Effect 4.0.0, one `implement` of 400 actions, each of
// three errors of its own and a shared one, behind a hook failing with the shared one, costs
// 380k instantiations beyond its fixture's actions when they are a tuple, and 387k when they
// are an array of their union. A change multiplying that, as filtering every declared error
// against every action did, fails here. Re-measure when either release changes.
it.each([
  ["tuple.ts", 460_000],
  ["array.ts", 470_000],
] as const)(
  "keeps one implement of 400 actions in %s within its instantiation budget",
  (fixture, budget) => {
    expect(instantiations(fixture) - instantiations("baseline.ts")).toBeLessThanOrEqual(budget);
  },
  120_000,
);
