/** hold: never sells on its own. Exits only through the `sell` command. */
import { HOLD, checkParams, type ExitStrategy } from "./types.ts";

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, [], "hold");
  return { name: "hold", onTick: () => HOLD };
}
