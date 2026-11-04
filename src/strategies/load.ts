/** Load an exit strategy by name from this folder (`<name>.ts` or the built `<name>.js`), or by a file path. */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StrategyConfigError, type ExitStrategy, type StrategyFactory } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESERVED = new Set(["types", "load"]);

export async function loadStrategy(exit: { strategy: string; [k: string]: unknown }, baseDir = process.cwd()): Promise<ExitStrategy> {
  const { strategy, module: modulePath, ...params } = exit as { strategy: string; module?: unknown; [k: string]: unknown };
  let file: string | null = null;
  if (typeof modulePath === "string") {
    file = isAbsolute(modulePath) ? modulePath : resolve(baseDir, modulePath);
    if (!existsSync(file)) throw new StrategyConfigError(`exit.module: ${file} not found`);
  } else {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(strategy) || RESERVED.has(strategy)) throw new StrategyConfigError(`exit.strategy: "${strategy}" is not a strategy name`);
    for (const ext of [".ts", ".js"]) {
      const f = join(HERE, strategy + ext);
      if (existsSync(f)) { file = f; break; }
    }
    if (!file) throw new StrategyConfigError(`exit.strategy: no strategy named "${strategy}" (${HERE})`);
  }
  const mod = (await import(pathToFileURL(file).href)) as { create?: StrategyFactory };
  if (typeof mod.create !== "function") throw new StrategyConfigError(`exit strategy ${file} exports no create(params)`);
  const s = mod.create(params);
  if (!s || typeof s.onTick !== "function") throw new StrategyConfigError(`exit strategy ${file}: create() returned no onTick`);
  return s;
}
