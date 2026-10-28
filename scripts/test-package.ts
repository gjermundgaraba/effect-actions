import { execFileSync, spawnSync } from "node:child_process";
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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";
import { API, SymbolFlags } from "typescript/unstable/sync";

import manifest from "../package.json" with { type: "json" };
import cloudflareManifest from "../packages/cloudflare/package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

const cloudflare = path.join(root, "packages/cloudflare");

const decodeInstalled = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String })
);

const versionIn = (directory: string, name: string) =>
  decodeInstalled(
    createRequire(path.join(directory, "package.json"))(`${name}/package.json`)
  ).version;

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
  const keys = readFileSync(declarations, "utf-8").match(/"~[^"]*"/gu);

  if (keys !== null) {
    throw new Error(
      `${declarations} prints internal keys: ${[...new Set(keys)].join(", ")}`
    );
  }
};

const entriesOf = (
  installed: string,
  exports: Readonly<Record<string, string>>
) =>
  Object.entries(exports).flatMap(([subpath, file]) =>
    subpath === "./package.json"
      ? []
      : [path.join(installed, file.replace(/\.mjs$/u, ".d.mts"))]
  );

const refuseUndocumented = (directory: string, entries: readonly string[]) => {
  const project = path.join(directory, "documented.json");

  writeFileSync(
    project,
    JSON.stringify({
      compilerOptions: { ...compilerOptions, skipLibCheck: true, types: [] },
      files: entries,
    })
  );

  const api = new API({ cwd: directory });

  try {
    const [opened] = api
      .updateSnapshot({ openProjects: [project] })
      .getProjects();

    if (opened === undefined) {
      throw new Error(`TypeScript opened no project from ${project}`);
    }

    const { program, checker } = opened;

    const undocumented = entries.flatMap((entry) => {
      const source = program.getSourceFile(entry);

      const module =
        source === undefined ? undefined : checker.getSymbolAtLocation(source);

      if (module === undefined) {
        return [`${entry} (not found)`];
      }

      return checker
        .getExportsOfModule(module)
        .filter(
          (exported) =>
            checker.getDocumentationCommentOfSymbol(
              (exported.flags & SymbolFlags.Alias) === 0
                ? exported
                : checker.getAliasedSymbol(exported)
            ) === ""
        )
        .map((exported) => `${entry}: ${exported.name}`);
    });

    if (undocumented.length > 0) {
      throw new Error(
        `The public API ships without JSDoc: ${undocumented.join(", ")}: put the comment on the exported declaration`
      );
    }
  } finally {
    api.close();
  }
};

const refuseUnshipped = (source: string, installed: string) => {
  for (const directory of ["docs", "examples"]) {
    for (const entry of readdirSync(path.join(source, directory))) {
      if (!existsSync(path.join(installed, directory, entry))) {
        throw new Error(`${directory}/${entry} is not in ${installed}`);
      }
    }
  }
};

const untracked = spawnSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "*.d.ts"],
  {
    cwd: root,
    encoding: "utf-8",
  }
);

const strayDeclarations =
  untracked.status === 0
    ? untracked.stdout.split("\n").filter((line) => line !== "")
    : [];

if (strayDeclarations.length > 0) {
  throw new Error(
    `The build wrote ${strayDeclarations.join(", ")} beside the sources: build a package's declarations from a tsconfig reaching its sources alone`
  );
}

const consumer = mkdtempSync(path.join(tmpdir(), "effect-actions-consumer-"));

const run = (command: string, args: readonly string[], cwd = consumer) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  const tarball = path.join(consumer, "effect-actions.tgz");
  run("vp", ["pm", "pack", "--out", tarball], root);

  const cloudflareTarball = path.join(
    consumer,
    "effect-actions-cloudflare.tgz"
  );

  run("vp", ["pm", "pack", "--out", cloudflareTarball], cloudflare);
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      devEngines: manifest.devEngines,
      dependencies: {
        [manifest.name]: `file:${tarball}`,
        [cloudflareManifest.name]: `file:${cloudflareTarball}`,
        "@cloudflare/workers-types": versionIn(
          cloudflare,
          "@cloudflare/workers-types"
        ),
        effect: versionIn(root, "effect"),
        typescript: manifest.devDependencies.typescript,
      },
    })
  );

  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        skipLibCheck: false,
        types: [],
        lib: ["es2023", "esnext.disposable", "dom", "dom.iterable"],
      },
      include: ["*.ts", "quickstart/**/*.ts"],
    })
  );
  cpSync(path.join(root, "scripts/package-consumer"), consumer, {
    recursive: true,
  });

  run("vp", ["install", "--ignore-scripts", "--no-frozen-lockfile"]);
  const installed = path.join(consumer, "node_modules", manifest.name);

  const installedCloudflare = path.join(
    consumer,
    "node_modules",
    cloudflareManifest.name
  );

  refuseUnshipped(root, installed);
  refuseUnshipped(cloudflare, installedCloudflare);
  refuseUndocumented(consumer, [
    ...entriesOf(installed, manifest.publishConfig.exports),
    ...entriesOf(installedCloudflare, cloudflareManifest.publishConfig.exports),
  ]);

  const quickstart = path.join(installed, "examples", "quickstart", "src");

  for (const file of [
    "Api.ts",
    "routes.ts",
    "greeting/Greeting.ts",
    "greeting/handlers.ts",
  ]) {
    cpSync(
      path.join(quickstart, file),
      path.join(consumer, "quickstart", file)
    );
  }

  writeFileSync(
    path.join(consumer, "quickstart.ts"),
    'export { Http } from "./quickstart/Api.js";\nexport { Greet } from "./quickstart/greeting/Greeting.js";\n'
  );

  writeFileSync(
    path.join(consumer, "quickstart-server.ts"),
    'export { routes } from "./quickstart/routes.js";\n'
  );

  run(process.execPath, [
    path.join(consumer, "node_modules/typescript/bin/tsc"),
  ]);

  refuseInternalKeys(path.join(consumer, "declarations.d.ts"));

  run(process.execPath, ["index.js"]);

  cpSync(
    path.join(cloudflare, "scripts/package-consumer"),
    path.join(consumer, "cloudflare"),
    {
      recursive: true,
    }
  );
  cpSync(
    path.join(installedCloudflare, "examples", "chat-rooms", "src"),
    path.join(consumer, "cloudflare", "chat-rooms"),
    { recursive: true }
  );

  writeFileSync(
    path.join(consumer, "cloudflare", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        skipLibCheck: true,
        types: ["@cloudflare/workers-types"],
        lib: ["es2023"],
      },
      include: ["*.ts", "chat-rooms/**/*.ts"],
    })
  );

  run(process.execPath, [
    path.join(consumer, "node_modules/typescript/bin/tsc"),
    "-p",
    path.join(consumer, "cloudflare"),
  ]);

  refuseInternalKeys(path.join(consumer, "cloudflare", "worker.d.ts"));
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
