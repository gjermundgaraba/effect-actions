import { execFileSync } from "node:child_process";
import { existsSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };

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
  // The testing consumer needs the optional client peer; it joins in the second phase.
  cpSync(join(root, "scripts/package-consumer"), consumer, {
    recursive: true,
    filter: (source) => !source.endsWith("testing.ts"),
  });
  writeFileSync(
    join(consumer, "quickstart.ts"),
    readFileSync(join(root, "examples/quickstart.ts"), "utf8").replace(
      /"\.\.\/src\/(\w+)\.js"/g,
      `"${manifest.name}/$1"`,
    ),
  );
  // Install outside the repository, without its workspace overrides or source imports.
  run("vp", ["install", "--ignore-scripts", "--no-frozen-lockfile"]);
  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc")]);
  run(process.execPath, ["index.js"]);

  if (existsSync(join(consumer, "node_modules/@modelcontextprotocol/client"))) {
    throw new Error("The optional testing peer was installed for a core and raw-request consumer");
  }

  run("vp", [
    "add",
    "--ignore-scripts",
    `@modelcontextprotocol/client@${manifest.devDependencies["@modelcontextprotocol/client"]}`,
    `@types/node@${manifest.devDependencies["@types/node"]}`,
  ]);
  cpSync(join(root, "scripts/package-consumer/testing.ts"), join(consumer, "testing.ts"));
  // The optional official client exposes Buffer in its declarations. Keep Node
  // types out of the core/browser consumer above, and enable them only here.
  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc"), "--types", "node"]);
  run(process.execPath, ["testing.js"]);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
