---
name: candle-launch-bot
description: Install, configure and operate candle-launch-bot, a bot that buys Candle (candle.tv) launches as they appear and exits them by a strategy. Use when someone wants to snipe or auto-buy Candle launches, set up the bot's config, run a dry run, go live, or operate a running bot (stop, pause buys, sell, read status).
---

# candle-launch-bot

A Node CLI (`npx candle-launch-bot`). One JSON config, one process per state folder, a SQLite ledger in that folder.
Read `npx candle-launch-bot --help` and the package README before changing anything.

## 1. Install and check

- Node 22.18 or newer: `node --version`.
- `npx candle-launch-bot --help` must print the commands. Nothing else is installed globally.

## 2. Key and wallet

- The user needs a Candle agent API key (`cndl_live_...`) with the `swap:write` scope. It lives in an environment
  variable (default `CANDLE_API_KEY`). Never print it, never write it into the config, never paste it into a file.
- Payer, pick one with the user:
  - `embedded`: the account's embedded Solana wallet; Candle signs. Needs only the key. The wallet is shared by the
    whole account (other keys, the app, hand trades).
  - `linked`: a TEE trading wallet bound to the key, signed on this machine with the key's P-256 signer (made with the
    Candle CLI; see the README's "TEE wallet and its signer").
- With the key in the environment, `init` looks the wallet up itself.

## 3. Write the config

Ask the user for: payer, ticket SOL, max open positions, lifetime SOL cap, launch modes, max coin age, max price
impact, exit strategy and its params. Then:

```sh
npx candle-launch-bot init --yes --out bot.json --payer embedded --sol 0.01 --max-open 3 --lifetime-sol 0.1 \
  --modes open,exp-custom --max-age 60 --max-impact 300 --exit tpsl --take-profit 2 --stop-loss 0.5
```

It validates the config the same way `run` does and writes it in dry mode. Exits: `hold`, `tpsl` (takeProfit,
stopLoss, trailing), `time` (afterSec), `ladder` (rungs at:sell), `preGrad` (progress, fraction, stopLoss), or a file
via `--exit-module ./my-exit.js` (see `examples/strategies/`).

## 4. Watch before trading

1. `npx candle-launch-bot scan --config bot.json --for 600`: prints each launch and the decision (buy, skip with the
   reason, or wait). It never trades. Launches can be hours apart; a quiet scan is normal.
2. `npx candle-launch-bot run --config bot.json --mode dry`: the full loop with paper fills from Candle's quote.
   Run it as a long-lived service (systemd, launchd, a process manager), not in a shell that may close.
3. Show the user `<stateDir>/status.json` after a launch: open positions, multiples, caps used, detection latency.

## 5. Go live (only when the user says so)

- Fund the paying wallet: tickets x entries allowed, plus about 0.003 SOL per coin for rent and fees, plus Candle's
  platform fee per buy.
- Set `"mode": "live"` and the real wallet (or `init --mode live --force` with the same flags), then `run`.
- On start the bot checks the key, the wallet and the signer and refuses to run when any is wrong; read its message.

## 6. Operate

- Stop: `touch <stateDir>/STOP` (or SIGTERM). It finishes the cycle and exits; remove the file before restarting.
- Pause entries, keep exits: `touch <stateDir>/PAUSE_BUYS`; remove it to resume.
- Sell by hand: `npx candle-launch-bot sell <mint> --config bot.json --fraction 0.5`. With the bot running it hands
  the request to the bot.
- Status: `npx candle-launch-bot status --config bot.json`, or read `status.json`. Events are in `events.jsonl`.
- Alerts: set `alerts.command` or `alerts.webhookEnv` in the config so stuck exits and unreadable fills reach a person.
- A restart resumes from the ledger: open positions, orders in flight, caps used. Never delete `ledger.sqlite` while
  positions are open.

## Rules of thumb

- Dry run first, every time the config changes.
- Keep `buy.lifetimeSol` small until the user has seen real fills.
- One state folder per config; a state folder holds one mode (dry or live) only.
