[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/suwanangcrew025-ops/makefun-btc-race-24h/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/suwanangcrew025-ops/makefun-btc-race-24h/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# Suwanang Trend — cbBTC trading bot (btc-race-24h-20261123-0511)

Long-only trend bot for the make.fun BTC race: 1-minute cbBTC/USDC bars from
the Orca Whirlpool, $1,000 paper, fills at the next bar's open with 4 bps fee
+ 2 bps slippage + pool price impact.

## Strategy (original work)

Patient trend-following, because 1-minute noise (~8 bps/min) is large next
to the ~26 bps round-trip cost — the fast EMA(8)/EMA(21) cross the baselines
use whipsaws itself to death (ema-cross: −$114.83 on dev).

- **Entry**: EMA(24) above EMA(96), price above EMA(96), RSI(14) ≤ 80, and
  either a fresh cross up or a 60-bar return > +0.4% (and > +0.2% in any
  case). One genuine breakout per window is enough.
- **Sizing**: volatility-based — one 60-minute move risks ~0.5% of equity,
  clamped to 50–100% of equity. Calm markets get full size.
- **Exits** (whole position): hard stop −2.5% under cost, trailing stop −3%
  under the peak close since entry, or a confirmed reversal (EMA cross down
  while the 60-bar return is < −1%). No fixed take-profit.
- **After a losing exit**: re-entry needs a 60-bar return > +1.5% and a
  120-bar cooldown, so a slow bleed cannot make it buy every bounce.
- **Probes**: no trade by bar 720 with the slow trend up → 40% probe; still
  no trade by bar 1200 → 25% probe if RSI ≤ 60. Guarantees the 1-trade
  guardrail even in a monotonic down window, at a bounded cost.
- **Hard guard**: equity 8% below its peak → stop trading for the window
  (race guardrail allows 25% drawdown).

Deterministic: float64 arithmetic only, no clock, no environment, no
randomness. Two runs on the same bars produce identical orders
(grade-local L1 regrade: reproduced byte for byte).

## Local verification (grade-local, `--driver process`)

```
node cli/makefun.mjs grade-local --kit <kit> --bot <this dir> --driver process
```

Dev window (24h, 1,440 bars): **net PnL +$30.79, 1 trade, max drawdown
1.98%, 0 rejected, guardrails met**. At 2x fees: +$29.97.

## Dev-window comparison (grade-local, same command)

| bot | net PnL | trades | max DD |
| --- | --- | --- | --- |
| Suwanang Trend (this) | **+$30.79** | 1 | 1.98% |
| momentum (baseline) | +$34.94 | 1 | 1.98% |
| buy-and-hold (baseline) | +$32.17 | 1 | 1.98% |
| hold-cash (baseline) | $0.00 | 0 | 0% |
| rsi-bollinger (baseline) | −$9.32 | 10 | 2.06% |
| adx-momentum (baseline) | −$11.20 | 24 | 4.16% |
| ema-cross (baseline) | −$114.83 | 76 | 11.65% |

Note: momentum/buy-and-hold score slightly higher on dev only because they
buy at bar 0/24 and hold through a window that rose +3.64% with no real
reversal; they have no exit at all, so in a falling race window they would
ride the whole fall. This bot keeps ~95% of that upside while exiting
reversals and staying out of slow bleeds.

## Robustness (Python backtester replicating the fill model)

Same parameters, no re-tuning, on synthetic windows built from the dev
window's own returns:

| window | net PnL | trades |
| --- | --- | --- |
| dev (actual) | +$30.79 | 1 |
| rotated returns (big move late) | +$29.91 | 1 |
| down-drift −3.5% (same chop) | −$8.15 | 2 |
| flat (zero drift) | −$1.05 | 2 |
| shuffled returns (3 seeds) | +$27.23 / +$1.44 / +$12.72 | 1–2 |
| hard monotonic down −3.5% | −$1.87 | 1 (late probe) |

Worst drawdown across all windows: 3.14% (limit 25%).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript)
- `makefun-bars.ts` — byte-identical copy of the kit SDK shim
  (`sdk/makefun-bars.ts`, sha256
  9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8)

Backtest scripts used during development are kept outside this repo at
`~/workspace/makefun/btc-race-work/`.
