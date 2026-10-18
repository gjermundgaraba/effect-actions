import { globSync } from "node:fs";
import { basename } from "node:path";
import type { PackUserConfig } from "vite-plus/pack";

export const pack = (): PackUserConfig => {
  const entry = Object.fromEntries(
    globSync("src/*/*.ts")
      .map((path): [string, string] => [basename(path, ".ts"), path])
      .filter(([module]) => /^[A-Z]/u.test(module)),
  );

  const loneEntryAsItsSubpath = (exports: Record<string, string>) => {
    const [only, ...others] = Object.keys(entry);

    return only === undefined || others.length > 0
      ? exports
      : Object.fromEntries(
          Object.entries(exports).map(([path, target]) => [
            path === "." ? `./${only}` : path,
            target,
          ]),
        );
  };

  return {
    entry,
    unbundle: true,
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: { devExports: true, customExports: loneEntryAsItsSubpath },
  };
};
