import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The repository root, found from the working directory (apps/web when Next builds,
 * the root when the tests run). Build-time only.
 */
export function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, "examples", "quickstart")) && existsSync(join(dir, "apps", "web"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`repository root not found above ${process.cwd()}`);
    dir = up;
  }
}
