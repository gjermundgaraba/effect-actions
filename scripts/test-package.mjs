import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };
import { published } from "./published.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const consumer = mkdtempSync(join(tmpdir(), "effect-actions-consumer-"));

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} [cwd]
 */
const run = (command, args, cwd = consumer) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  const tarball = join(consumer, "effect-actions.tgz");
  run("vp", ["pm", "pack", "--out", tarball], root);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      devEngines: manifest.devEngines,
      dependencies: {
        [manifest.name]: `file:${tarball}`,
        effect: manifest.devDependencies.effect,
        typescript: manifest.devDependencies.typescript,
      },
    }),
  );
  // A typical strict consumer, compiling the published declarations themselves
  // (`skipLibCheck: false`) without Node types, so the core stays browser-safe.
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        skipLibCheck: false,
        types: [],
        lib: ["es2023", "esnext.disposable", "dom", "dom.iterable"],
      },
      include: ["*.ts"],
    }),
  );
  cpSync(join(root, "scripts/package-consumer"), consumer, { recursive: true });

  for (const file of ["quickstart.ts", "quickstart-server.ts"]) {
    writeFileSync(
      join(consumer, file),
      published(readFileSync(join(root, "examples", file), "utf8")),
    );
  }

  // Install outside the repository, without its workspace overrides or source imports.
  run("vp", ["install", "--ignore-scripts", "--no-frozen-lockfile"]);
  // The installed package carries the docs agents are sent to.
  const docs = join(consumer, "node_modules", manifest.name, "docs");

  for (const page of readdirSync(join(root, "docs"))) {
    if (!existsSync(join(docs, page))) throw new Error(`docs/${page} is not in the package`);
  }

  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc")]);
  run(process.execPath, ["index.js"]);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
