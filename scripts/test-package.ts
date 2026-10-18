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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import cloudflareManifest from "../packages/cloudflare/package.json" with { type: "json" };
import manifest from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

const cloudflare = join(root, "packages/cloudflare");

const decodeInstalled = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));

const versionIn = (directory: string, name: string) =>
  decodeInstalled(createRequire(join(directory, "package.json"))(`${name}/package.json`)).version;

const compilerOptions = {
  target: "es2023",
  module: "nodenext",
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  declaration: true,
};

const refuseInternalKeys = (declarations: string) => {
  const keys = readFileSync(declarations, "utf8").match(/"~[^"]*"/g);

  if (keys !== null) {
    throw new Error(`${declarations} prints internal keys: ${[...new Set(keys)].join(", ")}`);
  }
};

const refuseUnshipped = (source: string, installed: string) => {
  for (const directory of ["docs", "examples"]) {
    for (const entry of readdirSync(join(source, directory))) {
      if (!existsSync(join(installed, directory, entry)))
        throw new Error(`${directory}/${entry} is not in ${installed}`);
    }
  }
};

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
        "@cloudflare/workers-types": versionIn(cloudflare, "@cloudflare/workers-types"),
        effect: versionIn(root, "effect"),
        typescript: manifest.devDependencies.typescript,
      },
    }),
  );

  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        skipLibCheck: false,
        types: [],
        lib: ["es2023", "esnext.disposable", "dom", "dom.iterable"],
      },
      include: ["*.ts", "quickstart/**/*.ts"],
    }),
  );
  cpSync(join(root, "scripts/package-consumer"), consumer, { recursive: true });

  run("vp", ["install", "--ignore-scripts", "--no-frozen-lockfile"]);
  const installed = join(consumer, "node_modules", manifest.name);
  const installedCloudflare = join(consumer, "node_modules", cloudflareManifest.name);

  refuseUnshipped(root, installed);
  refuseUnshipped(cloudflare, installedCloudflare);

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

  refuseInternalKeys(join(consumer, "declarations.d.ts"));

  run(process.execPath, ["index.js"]);

  cpSync(join(cloudflare, "scripts/package-consumer"), join(consumer, "cloudflare"), {
    recursive: true,
  });
  cpSync(
    join(installedCloudflare, "examples", "chat-rooms", "src"),
    join(consumer, "cloudflare", "chat-rooms"),
    { recursive: true },
  );

  writeFileSync(
    join(consumer, "cloudflare", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        skipLibCheck: true,
        types: ["@cloudflare/workers-types"],
        lib: ["es2023"],
      },
      include: ["*.ts", "chat-rooms/**/*.ts"],
    }),
  );

  run(process.execPath, [
    join(consumer, "node_modules/typescript/bin/tsc"),
    "-p",
    join(consumer, "cloudflare"),
  ]);

  refuseInternalKeys(join(consumer, "cloudflare", "worker.d.ts"));
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
