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
import cloudflareManifest from "../packages/cloudflare/package.json" with { type: "json" };
import workersTypes from "../packages/cloudflare/node_modules/@cloudflare/workers-types/package.json" with { type: "json" };
import manifest from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

const cloudflare = join(root, "packages/cloudflare");

const consumer = mkdtempSync(join(tmpdir(), "effect-actions-consumer-"));

const run = (command: string, args: ReadonlyArray<string>, cwd = consumer) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  const tarball = join(consumer, "effect-actions.tgz");
  run("vp", ["pm", "pack", "--out", tarball], root);
  const cloudflareTarball = join(consumer, "effect-actions-cloudflare.tgz");
  run("vp", ["pm", "pack", "--out", cloudflareTarball], cloudflare);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      devEngines: manifest.devEngines,
      dependencies: {
        [manifest.name]: `file:${tarball}`,
        [cloudflareManifest.name]: `file:${cloudflareTarball}`,
        "@cloudflare/workers-types": workersTypes.version,
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
      include: ["*.ts", "quickstart/**/*.ts"],
    }),
  );
  cpSync(join(root, "scripts/package-consumer"), consumer, { recursive: true });

  run("vp", ["install", "--ignore-scripts", "--no-frozen-lockfile"]);
  const installed = join(consumer, "node_modules", manifest.name);

  for (const page of readdirSync(join(root, "docs"))) {
    if (!existsSync(join(installed, "docs", page)))
      throw new Error(`docs/${page} is not in the package`);
  }

  for (const example of readdirSync(join(root, "examples"))) {
    if (!existsSync(join(installed, "examples", example)))
      throw new Error(`examples/${example} is not in the package`);
  }

  const quickstart = join(installed, "examples", "quickstart", "src");

  for (const file of ["Api.ts", "routes.ts", "greeting/Greeting.ts", "greeting/handlers.ts"]) {
    cpSync(join(quickstart, file), join(consumer, "quickstart", file));
  }

  writeFileSync(
    join(consumer, "quickstart.ts"),
    'export { Http } from "./quickstart/Api.js";\nexport { Greet } from "./quickstart/greeting/Greeting.js";\n',
  );

  writeFileSync(
    join(consumer, "quickstart-server.ts"),
    'export { routes } from "./quickstart/routes.js";\n',
  );

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

  cpSync(join(cloudflare, "scripts/package-consumer"), join(consumer, "cloudflare"), {
    recursive: true,
  });

  writeFileSync(
    join(consumer, "cloudflare", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        declaration: true,
        types: ["@cloudflare/workers-types"],
        lib: ["es2023"],
      },
      include: ["*.ts"],
    }),
  );

  run(process.execPath, [
    join(consumer, "node_modules/typescript/bin/tsc"),
    "-p",
    join(consumer, "cloudflare"),
  ]);

  const cloudflareInternalKeys = readFileSync(
    join(consumer, "cloudflare", "worker.d.ts"),
    "utf8",
  ).match(/"~[^"]*"/g);

  if (cloudflareInternalKeys !== null) {
    throw new Error(
      `cloudflare/worker.d.ts prints internal keys: ${[...new Set(cloudflareInternalKeys)].join(", ")}`,
    );
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
