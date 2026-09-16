import { execFileSync } from "node:child_process";
import { existsSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const consumer = mkdtempSync(join(tmpdir(), "effect-actions-consumer-"));
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
  cpSync(join(root, "scripts/package-consumer"), consumer, { recursive: true });
  writeFileSync(
    join(consumer, "quickstart.ts"),
    readFileSync(join(root, "examples/quickstart.ts"), "utf8").replace(
      "../src/index.js",
      manifest.name,
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
  ]);
  cpSync(join(root, "scripts/package-testing-consumer.ts"), join(consumer, "testing.ts"));
  run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc")]);
  run(process.execPath, ["testing.js"]);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
