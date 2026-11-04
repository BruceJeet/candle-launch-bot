# candle-launch-bot

> **Moved.** candle-launch-bot now lives in [BruceJeet/candle-bots](https://github.com/BruceJeet/candle-bots/tree/main/packages/launch-bot), with the other Candle bots on one shared core. This repo is archived at 0.1.3. The npm package name stays `candle-launch-bot`; versions from 0.2.0 on come from the new repo.

Buys [Candle](https://candle.tv) launches as they appear and exits them by a strategy you pick. One config
file, one process, a local SQLite ledger. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14).

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **Detection** from two sources at once: Candle's public token list, and the launch-curve program on chain
  (`logsSubscribe`, with signature polling as a fallback). The first sighting wins; both latencies are recorded.
- **Filters**: launch mode, coin age, price impact of your buy on the curve, creator allow/deny lists, name/symbol
  match, plus caps (ticket size, open positions, lifetime spend, entries per coin).
- **Execution** through Candle's trade API, from your account's embedded wallet (Candle signs) or from a TEE wallet
  signed on your machine. Fills are booked from the transaction, sells are clamped to the wallet balance, and retries
  are capped with backoff.
- **Exits** are plug-ins: `hold`, `tpsl`, `time`, `ladder`, `preGrad`, or your own file.
- **Dry mode** runs everything except the trade: it decides, logs and books paper fills from Candle's own curve quote.

Solana only for now.

Terms used below: a **launch mode** is how a Candle coin's bonding curve was set up (`open`, `exclusive`, and the
experimental `exp-a`, `exp-b`, `exp-c` and `exp-custom`, whose curves can take any shape); **graduation** is the moment
a curve fills and the coin moves to its DAMM v2 pool; a **TEE wallet** is a Candle trading wallet held in a secure
enclave (through Privy, Candle's wallet provider) and signed for by your key's signer.

## Quick start

Node 22.18 or newer.

```sh
npx candle-launch-bot init                               # a few questions; writes bot.json in dry mode
npx candle-launch-bot scan --config bot.json --for 600   # print what it would buy; never trades
npx candle-launch-bot run  --config bot.json             # dry run: the whole loop with paper fills
```

When the dry run looks right, set your API key, fund the wallet, and go live:

```sh
export CANDLE_API_KEY=cndl_live_...
npx candle-launch-bot init --mode live --force [your flags again]   # or edit bot.json: "mode": "live", your wallet
npx candle-launch-bot run  --config bot.json
```

`init` also runs without questions, from flags (`--yes`), for scripts and agents. `candle-launch-bot --help` lists the
flags:

```sh
npx candle-launch-bot init --yes --payer embedded --sol 0.01 --max-open 3 --lifetime-sol 0.1 \
  --modes open,exp-custom --max-age 60 --max-impact 300 --exit tpsl --take-profit 2 --stop-loss 0.5
```

With the API key in the environment, `init` looks up the key's wallet for you. Without a wallet, a dry config gets a
placeholder address; live mode needs the real one.

### Set it up with an agent

Paste this to a coding agent (Claude Code, or any agent with a shell):

> Install and set up candle-launch-bot for me. Read `npx candle-launch-bot --help` and the package's README.md. Ask me
> for: payer (embedded or linked), ticket size in SOL, max open positions, lifetime SOL cap, launch modes, and the exit
> strategy. My Candle API key is in the env var CANDLE_API_KEY; never print it. Run `npx candle-launch-bot init --yes`
> with my answers, then `scan --for 600` and show me what it would have bought. Then start a dry run
> (`run --mode dry`) and show me `status.json` after a launch. Do not go live until I say so.

The package also ships an agent skill, `skills/candle-launch-bot/SKILL.md`, that walks an agent through the same steps.

## Setup in detail

### 1. Install

`npx candle-launch-bot ...` needs nothing else. To keep a copy: `npm install -g candle-launch-bot`. From source:

```sh
git clone https://github.com/BruceJeet/candle-launch-bot && cd candle-launch-bot
npm ci
```

A source checkout runs the TypeScript in `src/` directly (Node strips the types); the package runs the compiled `dist/`.

### 2. Candle API key

Make an agent key for your Candle account (`cndl_live_…`; on candle.tv's agents page, or `candle keys create` with
the Candle CLI). Trading needs the **`swap:write`** scope, which a key only gets when it is asked for (pass it in the
key's scopes when you create it). The key decides which Candle profile the trades show under. Put the key in an
environment variable, never in the config file:

```sh
export CANDLE_API_KEY=cndl_live_...
```

If your account caps SOL per trade on the key, set the cap at or above `buy.sol`.

### 3. Pick a payer

| `payer` | Pays from | Signs | Needs |
|---|---|---|---|
| `embedded` | your Candle account's embedded Solana wallet | Candle, server-side, inside the trade call | the API key only |
| `linked` (default) | a TEE wallet bound to the API key | this machine, with the key's signer, through Candle's relay | the API key and the key signer (below) |

`embedded` is the simple one: it needs nothing but the API key, so it also suits a server with no OS keychain (a Linux
box without `secret-tool`, where the Candle CLI keeps its secrets in an encrypted file). At start the bot reads the key's
embedded wallet (`GET /api/v1/agent/wallets/embedded`) and refuses to run unless `wallet` is its Solana address, the key isn't denied the wallet, and the wallet is
delegated (so Candle can sign). There is no signer to set up: leave `signer`, `privyAppId`, `linkedWalletId` and
`privyWalletId` out (the config refuses them with `embedded`).

```json
{ "mode": "live", "payer": "embedded", "apiKeyEnv": "CANDLE_API_KEY", "wallet": "<your embedded wallet address>", ... }
```

With `embedded`, Candle signs and broadcasts inside the build call, so the bot can't save a signature before sending
(it can with `linked`). What it does instead:

- every order has one `clientTradeId` for life;
- a build that fails in any way other than Candle's own 4xx refusal before execution (no `stage`, or
  `stage: "not_broadcast"`, with no signature and nothing recorded) counts as possibly executed (it counts against
  `lifetimeSol` and `maxPerCoin`). Such a refusal is unspent only while every attempt of the order was one; after an
  attempt that may have run, the wallet and the token account's history are checked and the order stays counted. This
  applies to buys; a sell build refusal ends the order only on a stage-less refusal at its first attempt;
- the next attempt first reads Candle's trade job: `confirmed` is booked from its transaction, an id still in flight
  is waited on (also at the attempt cap), and a same-id rebuild is Candle's replay of that trade, never a second one.

The embedded wallet is shared by the whole account: other API keys, the candle.tv app and you by hand all trade from
it. The bot's caps (`lifetimeSol`, `maxOpen`, `maxPerCoin`) count only this bot's own orders, not the wallet's other
trades. A sell of the same coin by someone else shows up as a wallet shortfall: the position is written down to what
the wallet still holds (alert `shortfall`).

When a possibly executed buy can't be confirmed through Candle, the bot looks for its transaction in the history of
the wallet's token account for that coin (a buy since the order was made, for about the ticket's SOL, landed while one
of the order's attempts could have, not booked by another order, read back to the order's creation) and books that
(alert `found_tx`; two such transactions are a double execution, booked together, alert `double_execution`). Without
one, it adopts only tokens that arrived *after* the order was made in buys that spent SOL (never a transfer or
airdrop), and at most 1.5 x the order's expected fill plus slippage (alert `adopted`). Tokens that nothing explains yet may be an RPC that lags the balance: the order stays open and the scan repeats on the
backoff, up to 10 times (alert `rescan`). From then on the order only scans; it never builds again. A bag that was
already in the wallet, or anything bigger than this order could have bought, is left alone with an alert
(`unexplained_tokens`). `sell` on that coin reopens the ended buy's position by the same rule: its own transaction if the
history now shows it (its tokens, its cost), else only tokens bought since the order, capped (cost the ticket); never a
bag that was already there (alert `reopened`). Every 10 min the bot also compares the wallet's balance of each held coin
with what it booked (also for an hour after a position ends); more than booked on two readings a minute apart is
alerted (`surplus`), never adopted. Trading the bot's coins by hand in the same wallet confuses these checks; a wallet
of its own (a separate account, or `linked`) avoids all of it.

Everything else is the same for both payers: fills booked from the transaction, the sell clamp (on the wallet that
pays), capped retries, alerts.

### 4. TEE wallet and its signer (payer `linked`)

The bot pays from a Candle **TEE wallet bound to the API key**. At start it lists the wallets the key can trade
from (`GET /api/v1/agent/wallets/trading`) and refuses to run unless `wallet` is one of them. The same answer gives the
key's prefix and Candle's Privy app id, so `privyAppId`, `linkedWalletId` and `privyWalletId` need no config. Set them
only to pin values; a pin that disagrees with Candle stops the bot.

Signing happens on your machine with the key's P-256 **key signer**, made once with the Candle CLI on the machine that
will run the bot (`candle tee signer new --key <key prefix>`) and approved by the account owner
(`candle keys signer approve <code> --key <key prefix>`). Bind the wallet to the key with the CLI as Candle documents.
Then tell the bot where the signer is with `signer`:

| `signer.store` | Where the key is |
|---|---|
| `keychain` | Where the Candle CLI keeps it in the OS keychain (service `tv.candle.cli`): account `key_signer_<keyPrefix>_<spkiSha256>`, found through `keySigners.entries` in `~/.config/candle/config.json` by key prefix and the wallet's signer quorum, and checked against that index. For an imported (non-TEE) linked wallet, account `wallet_signer_<linkedWalletId>`. Uses `security` on macOS, `secret-tool` on Linux. A CLI that keeps its secrets in an encrypted file instead of an OS keychain can't be read this way: use `file` or `env`. |
| `file` | An `EncryptedFileSecretStore` file from the SDK (`path`, relative to the config file), passphrase in an env var (`passphraseEnv`), keyed by the wallet's linked-wallet id |
| `env` | The PEM (or the CLI's single-line base64 PKCS#8 form) in an env var (`pemEnv`) |

`keychain` reads where the Candle CLI stores the signer today (its config index and keychain account names). If a
later CLI version stores it differently, the bot reports the signer as missing at start; `file` or `env` don't depend
on the CLI.

### 5. Funding

Send SOL to the wallet that pays (embedded or TEE): tickets (`buy.sol` × the number of entries you allow) plus about 0.003 SOL per coin for
token-account rent and network fees. Every buy also pays Candle's platform fee on top of the ticket.

### 6. Run

```sh
candle-launch-bot init [--out bot.json]             # write a config
candle-launch-bot scan --config bot.json            # watch and print what it would buy; never trades
candle-launch-bot run  --config bot.json --mode dry # the whole loop with paper fills
candle-launch-bot run  --config bot.json            # live, if the config says "mode": "live"
candle-launch-bot status --config bot.json          # the last status.json
candle-launch-bot sell <mint> --config bot.json [--fraction 0.5]
```

`sell` goes through the same order path as the bot (balance clamp, retries). If the bot is running, `sell` hands it
the request through `<stateDir>/requests/` and the bot runs it. A position whose exits Candle keeps refusing
(`exit_stuck`) gets one automatic try every `retry.stuckRetryMs` and an alert until it sells; `sell` tries at once.

Each cycle runs exits first (sell orders, then the strategy's new exits), then entries, within a time budget. A slow
market read while filtering times out after 3 s, and STOP or a signal is checked between steps and between orders.

## Controls

Files in the state dir, read at the top of every cycle:

- `STOP`: finish the cycle, write status, exit 0. The file stays: a restart exits again at once until you remove it.
- `PAUSE_BUYS`: no new entries; exits keep running.

`SIGINT`/`SIGTERM` stop the same way as `STOP`. A restart picks up from the ledger: open positions, orders in flight
(a signed transaction is checked on chain before anything is rebuilt), caps used.

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions, orders, every attempt with its full error (program logs included), launches seen, alerts |
| `status.json` | written every cycle: equity, open positions with price and multiple, caps used, order-queue health, detection stats and latencies. `detection.chain.lastOkMs` is the last launch found on chain (still on a quiet day); `lastPollOkMs` (last answered signature poll) and `lastEventMs` (last logs-socket event) show the watcher is alive |
| `events.jsonl` | one JSON line per event (also on stdout) |
| `lock` | one process per state dir |

Every line that leaves the process is redacted first: the values of env vars whose names look secret
(`KEY`, `TOKEN`, `SECRET`, `PASSPHRASE`, `RPC`, …), the API key, the RPC URLs' keys, and common key patterns.

## Config reference

```json
{
  "mode": "live",
  "apiUrl": "https://api.alpha.candle.tv",
  "apiKeyEnv": "CANDLE_API_KEY",
  "rpcUrlEnv": "SOLANA_RPC_URL",
  "rpcWsUrlEnv": "SOLANA_WS_URL",
  "payer": "linked",
  "wallet": "<TEE wallet address>",
  "signer": { "store": "keychain" },
  "stateDir": "./state",
  "loopMs": 2000,
  "buy": { "sol": 0.05, "maxSlippageBps": 500, "maxOpen": 3, "lifetimeSol": 1, "maxPriorityFeeLamports": 200000 },
  "sell": { "maxSlippageBps": 1000 },
  "filters": {
    "chains": ["solana"],
    "launchModes": ["open", "exp-custom"],
    "maxAgeSec": 60,
    "maxImpactBps": 300,
    "creatorAllow": [],
    "creatorDeny": [],
    "nameMatch": "dog|cat",
    "symbolMatch": "^[A-Z]{3,6}$",
    "inferModeFromCurve": true
  },
  "detect": { "api": true, "chain": true, "apiPollMs": 3000, "chainPollMs": 15000, "apiLimit": 20 },
  "exit": { "strategy": "ladder", "rungs": [{ "at": 2, "sell": 0.5 }, { "at": 5, "sell": 0.25 }], "stopLoss": 0.4 },
  "retry": { "maxAttempts": 6, "baseDelayMs": 2000, "maxDelayMs": 120000, "maxExitOrders": 3, "stuckRetryMs": 600000, "builtProbeMs": 600000 },
  "alerts": { "command": ["/usr/local/bin/notify-me", "launch-bot"], "webhookEnv": "ALERT_WEBHOOK_URL", "renotifyMs": 3600000 }
}
```

Unknown keys are refused at every level, so a typo fails at start instead of being ignored.

| Key | Meaning |
|---|---|
| `mode` | `dry` (decide and log, paper fills) or `live` |
| `apiUrl` | Candle API host (must be https) |
| `apiKeyEnv` | name of the env var holding the API key |
| `rpcUrlEnv`, `rpcWsUrlEnv` | env vars with your Solana RPC http and websocket URLs. Default: the public mainnet RPC, websocket derived from the http URL |
| `payer` | `embedded` (Candle signs; API key only) or `linked` (TEE wallet, local key signer; default) |
| `wallet` | the wallet that pays: the key's embedded wallet, or the TEE wallet |
| `linkedWalletId`, `privyWalletId`, `privyAppId` | optional pins; Candle supplies all three, and a pin that disagrees stops the bot |
| `buy.sol` | SOL per ticket |
| `buy.maxSlippageBps` | slippage tolerance on buys |
| `buy.maxOpen` | most positions open at once (open, opening, or stuck) |
| `buy.lifetimeSol` | most SOL in tickets ever committed to buys by this state dir. Candle's platform fee (its `bps`, about 0.25 %) and network fees come on top. A buy refused before anything was signed, or reverted, doesn't count; a refusal after signing does, because it might have landed |
| `buy.maxPerCoin` | entries per coin: 1 (the only value; re-entering a coin is not supported) |
| `buy.maxPriorityFeeLamports`, `sell.maxPriorityFeeLamports` | priority-fee ceiling Candle's build may bid (Jupiter venue) |
| `sell.maxSlippageBps` | slippage tolerance on sells (default: the larger of the buy's and 1000) |
| `filters.launchModes` | Candle launch modes to buy: `open`, `exclusive`, `exp-a`, `exp-b`, `exp-c`, `exp-custom` (also `test-open`, `test-exclusive`); anything else is a config error |
| `filters.maxAgeSec` | skip a coin older than this at decision time (age from the launch transaction's block time) |
| `filters.maxImpactBps` | skip when your ticket's average fill price would be more than this above the spot price (`s1/s0 - 1` on the curve's square-root price, after the curve's fee), from the curve account; checked again before every buy retry |
| `filters.inferModeFromCurve` | a launch seen on chain before Candle's list has it counts as `open` when its curve account matches the open preset exactly (threshold, fee, both liquidity segments, start price). Every other curve, `exclusive` and all `exp-*` modes included, waits for Candle's `tier`, since an exp-custom curve can take any threshold. A launch whose mode did not come from Candle's list is bought only once Candle's market record says `candleLaunched: true` (and not `trade.routable: false`); until then it waits, re-read every 2 s, and is skipped with `no Candle market` at `maxAgeSec`. Candle refuses every build of a market it doesn't have. Default true |
| `filters.creatorAllow` / `creatorDeny` | addresses; matched against the token list's creator and the launch transaction's signer. The bot's own `wallet` is always denied |
| `filters.nameMatch` / `symbolMatch` | case-insensitive regular expressions |
| `detect.*` | turn a source off, set poll intervals |
| `exit` | `{ "strategy": "<name>", ...params }`, or `{ "strategy": "x", "module": "./my-exit.ts", ... }` |
| `retry.maxAttempts` | attempts per order before it is terminal |
| `retry.baseDelayMs`, `maxDelayMs` | exponential backoff with jitter, per order |
| `retry.maxExitOrders` | exit orders Candle *refuses* (or that revert) before a position goes `exit_stuck`. Orders that run out of attempts on network errors, timeouts, 5xx or rate limits don't count: the next exit is minted on the position's backoff, without limit |
| `retry.builtProbeMs` | payer `embedded`: a trade Candle still shows as `built` after this long (default 10 min) gets one same-id build that asks Candle for its signature. For a buy it runs only while the buy would still be placed (before its deadline, buys not paused, impact passing) |
| `retry.builtHoldMs` | payer `embedded`: a buy past its deadline whose job stays `built` this long (default 6 h) is ended after a wallet scan (alert `built_held`); it stays counted in `lifetimeSol` |
| `retry.stuckRetryMs` | an `exit_stuck` position still gets one more exit try this often (default 10 min), and its alert keeps repeating until an exit fills |
| `alerts.command` | argv run (no shell) for each alert; the alert is JSON on stdin and in `ALERT_KEY` / `ALERT_MESSAGE`. It gets a minimal environment: `PATH`, those two, and the names in `alerts.commandEnv`; never the API key, signer or RPC URL |
| `alerts.commandEnv` | extra env var names to pass to the alert command |
| `alerts.webhookEnv` | env var holding a URL that gets each alert as a JSON POST |
| `alerts.renotifyMs` | how often a condition that lasts (an `exit_stuck` position, a fill that can't be read) is announced again; default 1 h |
| `alerts.holdAlertMs` | exits held for want of a sell route (migrating, pool at its floor, no price, unreadable) longer than this reach the alert sinks as `no_route`; default 5 min |

A filter that needs a field the bot doesn't have yet (a launch seen on chain before Candle's list has its mode or
name) waits for it and asks Candle's market endpoint. A field that never arrives never counts as a pass.

## Exit strategies

| Strategy | Params | Does |
|---|---|---|
| `hold` | none | never sells by itself |
| `tpsl` | `takeProfit` (×), `stopLoss` (×), `trailing` (fraction off the peak) | sells all on any of them |
| `time` | `afterSec` | sells all N seconds after entry |
| `ladder` | `rungs: [{ at, sell }]`, `stopLoss` | sells `sell` of the original size at each multiple, keeps the rest as a core |
| `preGrad` | `progress` (0..1), `fraction`, `stopLoss` | sells before graduation at a curve-progress threshold |

Multiples are against your all-in entry price (SOL spent including Candle's fee, over tokens received). `preGrad`
exists because graduated Candle coins sell only through Jupiter, and `exp-custom` pools often sit at their price floor
with no sell route at all. Selling while the curve can still take it avoids that.

### Writing one

A strategy is one file that exports `create(params)` and returns `{ name, onTick }`. Put it next to your config and
point `exit.module` at it (a path relative to the config file); the other keys of `exit` are its params. The engine
needs no change. A `.js` file works everywhere; a `.ts` file works too on Node 22.18+ (outside `node_modules`).

```js
// my-exit.js   "exit": { "strategy": "breakeven", "module": "./my-exit.js", "arm": 1.5 }
export function create(params) {
  const arm = Number(params.arm ?? 1.5);
  return {
    name: "breakeven",
    onTick(p, m) {
      if (m.priceSol === null) return { action: "hold" };
      const armed = p.peakPriceSol >= p.entryPriceSol * arm;
      return armed && m.priceSol <= p.entryPriceSol ? { action: "sell", fraction: 1, reason: "back to entry" } : { action: "hold" };
    },
  };
}
```

`examples/strategies/` has three to start from: `timeboxed-tp.js` (take profit inside a time window, else sell when it
closes), `breakeven-stop.js` (a stop that arms at a multiple and sits at entry) and `stale-coin.js` (sell a coin that
has not moved after a while). Types for TypeScript authors: `import type { ExitStrategy } from "candle-launch-bot"`.

`onTick(position, market)` runs once per cycle for each open position with no exit order in flight:

- `position`: `mint, openedAtMs, qtyRaw, remainingRaw, decimals, entryPriceSol, peakPriceSol, soldFraction`
- `market`: `priceSol` (null if unreadable this cycle), `progress` (graduation, 0..1), `migrated`, `venue`
  (`curve` / `damm`), `nowMs`
- return `{ action: "hold" }` or `{ action: "sell", fraction, reason }`, where `fraction` is a share of what remains

## How the money paths work

- **Quantity is what the chain says.** After a fill the bot reads the transaction and books the wallet's token and
  SOL balance changes, with the network fee and token-account rent kept apart. If the transaction can't be read it
  keeps reading; after several failed reads it asks Candle again (`confirm` replay) for `actualOutRaw`, else books the
  build's `minOutRaw`, and raises
  an alert. Every position records which source it used.
- **Sells are clamped** to the wallet's on-chain balance when the order is made, less what the bot's other positions
  in the same coin own. The clamp only reduces, never sells more than the position holds (so tokens held by others in
  the same wallet are left alone), and a zero or unreadable balance refuses the sell and raises an alert. When the
  wallet holds less than the ledger, the position is written down to the balance (alert `shortfall`) so it can close.
- **One live transaction per order.** The signature and the transaction's blockhash are saved before submit. Before
  any rebuild, the saved signature is checked on chain, and the rebuild waits until the chain says that blockhash can no
  longer be used (`isBlockhashValid`, judged by block height, not by the clock). Rebuilds reuse the order's
  `clientTradeId`. `IDEMPOTENCY_CONFLICT` is never treated as a failure: `prior_attempt_on_chain` is booked as the fill,
  and anything else waits and reconciles.
- **Retries** have a cap, jittered exponential backoff on each order's own clock, and a terminal state. A throw costs
  an attempt like any failure. Errors are read by `code`, `status`, `stage` and `reason`, never by message text.
  Only Candle's own non-retryable 4xx refusal at build or sign (nothing broadcast yet) ends an order at once. Network
  errors (`fetch failed` with ECONNRESET, ENOTFOUND, …), timeouts and 5xx are always retried. A refusal from Candle's
  submit is treated as possibly broadcast, because it doesn't say whether the transaction went out: the bot waits and
  reconciles on chain before it builds again. Every SDK and RPC call has a timeout, and settling a fill never sleeps
  inside the loop.
- **Exits wait for a route.** While a coin is migrating to its pool (its curve full, or flagged migrated with the pool
  not there yet; about 3.5 min), has no readable price, or its pool sits at its price floor, no sell is placed and no
  exit attempt is used up.
- **A conflict is never a failure.** An order Candle answered with `IDEMPOTENCY_CONFLICT` is not rebuilt and can't go
  terminal until Candle's trade job settles: `confirmed` is booked, gone or failed allows a same-id rebuild.
- **Stale buys stop.** A buy order carries a deadline (launch time + `maxAgeSec`) and is never built past it, nor
  while `PAUSE_BUYS` is set. A dry run never touches live orders, and a state dir holds one mode only.
- **Alerts** carry the worsening dimension in their key (attempt buckets, terminal states, stuck exits), so a
  condition that gets worse raises a new alert; a repeat of the same one is announced again every `alerts.renotifyMs`.

## Known limits

- **Thin curves.** Candle curves start thin: a ticket of a few tenths of a SOL can move the price several percent.
  `filters.maxImpactBps` is checked against the curve before every buy.
- **Graduated coins.** After graduation a coin trades in its DAMM v2 pool and sells route through Jupiter. Some
  `exp-custom` pools sit at their price floor with no sell route; the bot holds exits until a route exists and alerts
  when that lasts (`alerts.holdAlertMs`). `preGrad` sells while the curve can still take it.
- **Shared embedded wallet.** With `payer: "embedded"` the wallet belongs to the whole account (see "Pick a payer").
- **One entry per coin.** `buy.maxPerCoin` is 1; re-entering a coin is not supported.
- **The keychain signer follows the Candle CLI's storage layout** (see "TEE wallet and its signer").
- **Solana only.**

## Development

`npm run typecheck` checks types and `npm run build` compiles `dist/` (run on `npm pack`).

## License

MIT
