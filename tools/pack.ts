import { globSync } from "node:fs";
import path from "node:path";

import type { PackUserConfig } from "vite-plus/pack";

const everyModuleAtItsOwnSubpath = (exports: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(exports).map(([subpath, target]) => [
      subpath === "."
        ? `./${path.basename(target, path.extname(target))}`
        : subpath,
      target,
    ])
  );

export const pack = (tsconfig = "tsconfig.json"): PackUserConfig => ({
  entry: Object.fromEntries(
    globSync("src/*/*.ts")
      .map((file): [string, string] => [path.basename(file, ".ts"), file])
      .filter(([module]) => /^[A-Z]/u.test(module))
  ),
  unbundle: true,
  deps: { resolveDepSubpath: true },
  dts: {
    generator: "tsgo",
    tsconfig,
  },
  exports: { devExports: true, customExports: everyModuleAtItsOwnSubpath },
});
