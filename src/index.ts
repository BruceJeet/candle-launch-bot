/** Library entry: the types a custom exit strategy is written against, and the config parser. */
export type { Decision, ExitStrategy, MarketView, PositionView, StrategyFactory } from "./strategies/types.ts";
export { HOLD, StrategyConfigError } from "./strategies/types.ts";
export { parseConfig, loadConfig, ConfigError, LAUNCH_MODES } from "./config.ts";
export type { Config } from "./config.ts";
