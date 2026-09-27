import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { build } from "vite";
import manifest from "../package.json" with { type: "json" };
import { published } from "./published.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const consumer = mkdtempSync(join(tmpdir(), "effect-actions-consumer-"));

/** What a browser client may add, gzipped, to Effect's own `HttpApiClient`: docs/setup.md. */
const browserBudget = 2048;

/**
 * Each bundler a browser app may use: an entry of the consumer to its minified bundle.
 * esbuild refuses a Node built-in outright, and keeps barrel namespaces whole.
 *
 * @type {Record<string, (entry: string) => Promise<string>>}
 */
const bundlers = {
  esbuild: async (entry) => {
    const { outputFiles } = await esbuild.build({
      entryPoints: [join(consumer, entry)],
      bundle: true,
      minify: true,
      write: false,
      format: "esm",
      platform: "browser",
    });

    return outputFiles.map((file) => file.text).join("");
  },
  vite: async (entry) => {
    const result = await build({
      root: consumer,
      configFile: false,
      logLevel: "silent",
      build: { write: false, minify: true, lib: { entry, formats: ["es"] } },
    });

    const [output] = Array.isArray(result) ? result : [result];

    if (output === undefined || !("output" in output)) throw new Error("No browser bundle");

    return output.output.map((file) => (file.type === "chunk" ? file.code : "")).join("");
  },
};

/** Bound what `browser.ts` costs a browser bundle beyond `browser-baseline.ts`. */
const checkBrowserBundles = async () => {
  for (const [name, bundle] of Object.entries(bundlers)) {
    const [client, baseline] = await Promise.all([
      bundle("browser.ts"),
      bundle("browser-baseline.ts"),
    ]);

    const cost = gzipSync(client).length - gzipSync(baseline).length;

    console.log(`browser client, ${name}: ${cost} bytes gzipped beyond HttpApiClient`);

    if (cost > browserBudget) {
      throw new Error(`The browser client costs ${cost} bytes, over ${browserBudget}`);
    }
  }
};

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
  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc")]);
  run(process.execPath, ["index.js"]);
  await checkBrowserBundles();
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
