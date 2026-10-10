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

const root = fileURLToPath(new URL("../", import.meta.url));

const consumer = mkdtempSync(join(tmpdir(), "effect-actions-consumer-"));

const run = (command: string, args: ReadonlyArray<string>, cwd = consumer) =>
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
        declaration: true,
        types: [],
        lib: ["es2023", "esnext.disposable", "dom", "dom.iterable"],
      },
      include: ["*.ts"],
    }),
  );
  cpSync(join(root, "scripts/package-consumer"), consumer, { recursive: true });

  for (const file of ["quickstart.ts", "quickstart-server.ts"]) {
    cpSync(join(root, "examples", file), join(consumer, file));
  }

  run("vp", ["install", "--ignore-scripts", "--no-frozen-lockfile"]);
  const installedDocs = join(consumer, "node_modules", manifest.name, "docs");

  for (const page of readdirSync(join(root, "docs"))) {
    if (!existsSync(join(installedDocs, page)))
      throw new Error(`docs/${page} is not in the package`);
  }

  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc")]);

  const internalKeysInDeclarations = readFileSync(
    join(consumer, "declarations.d.ts"),
    "utf8",
  ).match(/"~[^"]*"/g);

  if (internalKeysInDeclarations !== null) {
    throw new Error(
      `declarations.d.ts prints internal keys: ${[...new Set(internalKeysInDeclarations)].join(", ")}`,
    );
  }

  run(process.execPath, ["index.js"]);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
