import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSkill, skillDirectory } from "./skill.ts";

const files = renderSkill();

rmSync(skillDirectory, { recursive: true, force: true });

mkdirSync(skillDirectory, { recursive: true });

for (const file of files) {
  writeFileSync(join(skillDirectory, file.path), file.content);
}

console.log(`skill: wrote ${files.length} files to ${skillDirectory}`);
