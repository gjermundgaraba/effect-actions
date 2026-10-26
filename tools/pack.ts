import { globSync } from "node:fs";
import { basename, extname } from "node:path";
import type { PackUserConfig } from "vite-plus/pack";

const everyModuleAtItsOwnSubpath = (exports: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(exports).map(([path, target]) => [
      path === "." ? `./${basename(target, extname(target))}` : path,
      target,
    ]),
  );

export const pack = (tsconfig = "tsconfig.json"): PackUserConfig => ({
  entry: Object.fromEntries(
    globSync("src/*/*.ts")
      .map((path): [string, string] => [basename(path, ".ts"), path])
      .filter(([module]) => /^[A-Z]/u.test(module)),
  ),
  unbundle: true,
  deps: { resolveDepSubpath: true },
  dts: {
    generator: "tsgo",
    tsconfig,
  },
  exports: { devExports: true, customExports: everyModuleAtItsOwnSubpath },
});
