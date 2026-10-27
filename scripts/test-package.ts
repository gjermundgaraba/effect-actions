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

const declared =
  /^(?:export )?(?:declare )?(?:const|function|class|interface|type|enum|namespace) (?<name>[\w$]+)/u;

const exportedHere =
  /^export (?:declare )?(?:const|function|class|interface|type|enum|namespace) (?<name>[\w$]+)/u;

const exportList = /^export \{(?<names>[^}]*)\};?$/u;

const namesIn = (list: string) =>
  list
    .split(",")
    .map(
      (entry) =>
        entry
          .trim()
          .replace(/^type /u, "")
          .split(" as ")[0]
          ?.trim() ?? ""
    )
    .filter((name) => name !== "");

const refuseUndocumented = (directory: string) => {
  for (const entry of readdirSync(directory, {
    recursive: true,
    encoding: "utf-8",
  })) {
    if (!entry.endsWith(".d.mts")) {
      continue;
    }

    const lines = readFileSync(path.join(directory, entry), "utf-8").split(
      "\n"
    );

    const documented = new Map<string, boolean>();

    for (const [index, line] of lines.entries()) {
      const name = declared.exec(line)?.groups?.["name"];

      if (name !== undefined && documented.get(name) !== true) {
        documented.set(
          name,
          lines[index - 1]?.trimEnd().endsWith("*/") === true
        );
      }
    }

    const exported = lines.flatMap((line) => {
      const here = exportedHere.exec(line)?.groups?.["name"];

      if (here !== undefined) {
        return [here];
      }

      const list = exportList.exec(line)?.groups?.["names"];

      return list === undefined ? [] : namesIn(list);
    });

    const undocumented = exported.filter(
      (name) => documented.get(name) === false
    );

    if (undocumented.length > 0) {
      throw new Error(
        `${path.join(directory, entry)} ships ${undocumented.join(", ")} without JSDoc: put the comment on the exported declaration`
      );
    }
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
  refuseUndocumented(path.join(installed, "dist"));
  refuseUndocumented(path.join(installedCloudflare, "dist"));

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
