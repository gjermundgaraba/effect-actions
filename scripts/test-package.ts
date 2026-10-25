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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

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

const declared =
  /^(?:export )?(?:declare )?(?:const|function|class|interface|type|enum|namespace) ([\w$]+)/;

const exportedHere =
  /^export (?:declare )?(?:const|function|class|interface|type|enum|namespace) ([\w$]+)/;

const exportList = /^export \{([^}]*)\};?$/;

const namesIn = (list: string) =>
  list
    .split(",")
    .map(
      (entry) =>
        entry
          .trim()
          .replace(/^type /, "")
          .split(" as ")[0]
          ?.trim() ?? "",
    )
    .filter((name) => name !== "");

const refuseUndocumented = (directory: string) => {
  for (const entry of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".d.mts")) continue;

    const lines = readFileSync(join(directory, entry), "utf8").split("\n");
    const documented = new Map<string, boolean>();

    for (const [index, line] of lines.entries()) {
      const name = declared.exec(line)?.[1];

      if (name !== undefined && documented.get(name) !== true)
        documented.set(name, lines[index - 1]?.trimEnd().endsWith("*/") === true);
    }

    const exported = lines.flatMap((line) => {
      const here = exportedHere.exec(line)?.[1];

      if (here !== undefined) return [here];

      const list = exportList.exec(line)?.[1];

      return list === undefined ? [] : namesIn(list);
    });

    const undocumented = exported.filter((name) => documented.get(name) === false);

    if (undocumented.length > 0) {
      throw new Error(
        `${join(directory, entry)} ships ${undocumented.join(", ")} without JSDoc: put the comment on the exported declaration`,
      );
    }
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

const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "*.d.ts"], {
  cwd: root,
  encoding: "utf8",
});

const strayDeclarations =
  untracked.status === 0 ? untracked.stdout.split("\n").filter((line) => line !== "") : [];

if (strayDeclarations.length > 0) {
  throw new Error(
    `The build wrote ${strayDeclarations.join(", ")} beside the sources: build a package's declarations from a tsconfig reaching its sources alone`,
  );
}

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

  refuseUnshipped(root, installed);
  refuseUndocumented(join(installed, "dist"));

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
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
