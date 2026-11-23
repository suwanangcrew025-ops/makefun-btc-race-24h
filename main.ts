// "Suwanang Trend" — a long-only cbBTC trend bot for btc-race-24h-20261123-0511.
//
// Original strategy, written for this competition. It is deliberately a
// *patient* trend follower: on 1-minute bars the noise (about 8 bps of
// 1-minute return volatility) is large next to the round-trip cost (about
// 26 bps), so the fast EMA(8)/EMA(21) cross the baselines use whipsaws
// itself to death (ema-cross: -114.83 USDC on the dev window). This bot
// instead waits for a real move, rides it, and refuses to churn:
//
//   - Trend: EMA(24) vs EMA(96) on closes, plus the 60-bar return.
//     A strong entry needs the fast EMA above the slow one, price above
//     the slow EMA, RSI(14) at or below 80 (not chasing an extreme top),
//     and either a fresh cross up or a 60-bar return above +0.4% — and
//     the 60-bar return above +0.2% in any case. One genuine breakout
//     per window is enough; the bot does not need to trade often.
//   - Sizing: volatility-based. The position is sized so that one
//     60-minute volatility move is about 0.5% of equity, clamped to
//     50%-100% of equity. Calm markets get full size, wild ones less.
//   - Exits (whole position): a hard stop 2.5% under cost, a trailing
//     stop 3% under the peak close since entry, or a confirmed reversal
//     (EMA(24) crossing back under EMA(96) while the 60-bar return is
//     below -1%). No fixed take-profit: in a real trend the trailing
//     stop is what banks the move.
//   - After a losing exit the bot demands much stronger proof before
//     re-entering (60-bar return above +1.5% instead of +0.2%) and waits
//     120 bars instead of 60. A slow bleed cannot make it buy every
//     bounce; it buys the bounce only when the bounce is a real move.
//   - Probes, so the bot is never left with zero trades: if it has
//     made no trade by bar 720 and the slow trend is up, it takes a
//     40% probe; if it still has made no trade by bar 1200 (a window
//     with no uptrend at all), it takes a small 25% probe provided
//     RSI(14) is at or below 60. A probe in a falling window costs at
//     most its 2.5% stop on a quarter of equity, and it keeps the entry
//     above every entry that fails the 1-trade guardrail.
//   - Hard guard: if equity ever falls 8% below its peak, the bot
//     flattens (via the normal exits) and stops trading for the rest
//     of the window. The race guardrail allows 25% drawdown; this bot
//     aims to stay far inside it.
//
// Everything is deterministic: float64 arithmetic only, no clock, no
// environment, no randomness. Indicators are seeded exactly like the
// textbook definitions (EMA seeded on the mean of its first span of
// closes, RSI by Wilder's smoothing), so two runs on the same bars give
// the same orders.

import { runBars, type BarsState, type Bar, type BuyInput, type SellInput } from './makefun-bars.ts';

const SYMBOL = 'CBBTC';
const EMA_FAST = 24;
const EMA_SLOW = 96;
const RSI_BARS = 14;
const VOL_BARS = 60;

/** Strong entry: 60-bar return above this. */
const ENTRY_RET60 = 0.004;
/** Strong entry also needs the 60-bar return above this in any case. */
const ENTRY_RET60_MIN = 0.002;
/** Re-entry after a losing exit needs a 60-bar return above this. */
const REENTRY_RET60 = 0.015;
/** Do not buy when RSI(14) is above this (chasing an extreme top). */
const RSI_HI = 80;
/** Hard stop: sell when the position is this far under its cost. */
const STOP_PCT = 0.025;
/** Trailing stop: sell when the close is this far under the peak close since entry. */
const TRAIL_PCT = 0.03;
/** Confirmed reversal: cross down while the 60-bar return is below this. */
const REV_RET60 = -0.01;
/** Bars to wait after an exit before re-entering (120 after a losing exit). */
const COOLDOWN = 60;
const COOLDOWN_LOSS = 120;
/** Equity drawdown guard: halt trading below this fraction under peak equity. */
const DD_GUARD = 0.08;
/** Volatility sizing: one 60-minute move should risk about this of equity. */
const RISK = 0.005;
const MIN_FRAC = 0.5;
const MAX_FRAC = 1.0;
/** Mid-window probe: bar, max size, RSI band. */
const PROBE_BAR = 720;
const PROBE_FRAC = 0.4;
const PROBE_RSI_LO = 40;
/** Late probe when no trade has happened yet: bar, max size, RSI cap. */
const LATE_BAR = 1200;
const LATE_FRAC = 0.25;
const LATE_RSI_HI = 60;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

/** RSI(14) by Wilder's smoothing. */
interface Rsi {
  last: number | null;
  first: number[];
  gain: number | null;
  loss: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function rsiStep(s: Rsi, close: number): void {
  if (s.last !== null) {
    const change = close - s.last;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_BARS) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      s.gain = (s.gain * (RSI_BARS - 1) + (change > 0 ? change : 0)) / RSI_BARS;
      s.loss = (s.loss * (RSI_BARS - 1) + (change < 0 ? -change : 0)) / RSI_BARS;
    }
  }
  s.last = close;
}

function rsiValue(s: Rsi): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

const fast: Ema = { span: EMA_FAST, warm: [], value: null };
const slow: Ema = { span: EMA_SLOW, warm: [], value: null };
const rsi: Rsi = { last: null, first: [], gain: null, loss: null };
/** Closes seen so far, as floats of the raw price units. */
const closes: number[] = [];
/** fast - slow after the previous bar, once both EMAs are set. */
let prevGap: number | null = null;
/** Batches seen so far (the bar index of the batch being answered). */
let seen = 0;
/** Peak close since the current entry (raw price units). */
let peakPrice = 0;
/** Trades sent so far (buys and sells). */
let trades = 0;
/** First batch index at which a new entry may be sent. */
let cooldownUntil = -1;
/** Whether the last exit sold below its cost. */
let lastExitLoss = false;
/** Whether the equity guard has halted trading. */
let halted = false;
/** Highest equity seen (quote units). */
let peakEquity = 0n;

/** 60-bar return of the latest close, or null before 60 bars. */
function ret60(): number | null {
  if (closes.length <= VOL_BARS) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - VOL_BARS]!;
  return now / then - 1;
}

/** Population std of the last 60 one-minute log returns, or null before 60 bars. */
function vol60(): number | null {
  if (closes.length <= VOL_BARS) return null;
  const rs: number[] = [];
  let sum = 0;
  for (let k = closes.length - VOL_BARS; k < closes.length; k++) {
    const r = Math.log(closes[k]! / closes[k - 1]!);
    rs.push(r);
    sum += r;
  }
  const mean = sum / VOL_BARS;
  let v = 0;
  for (const r of rs) v += (r - mean) * (r - mean);
  return Math.sqrt(v / VOL_BARS);
}

/** Volatility-sized fraction of equity for a new position, 50%-100%. */
function sizeFrac(): number {
  const v = vol60();
  if (v === null || v <= 0) return MAX_FRAC;
  const volHour = v * Math.sqrt(60);
  const frac = RISK / Math.max(volHour, 1e-6);
  return Math.max(MIN_FRAC, Math.min(MAX_FRAC, frac));
}

function pushBar(bar: Bar): void {
  const c = Number(bar.c);
  closes.push(c);
  emaStep(fast, c);
  emaStep(slow, c);
  rsiStep(rsi, c);
}

await runBars({
  onHello(state) {
    peakEquity = state.equity;
  },

  onBatch(state: BarsState, batch): (BuyInput | SellInput)[] | void {
    const idx = seen;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushBar(bar);
    }
    seen++;
    if (state.warmingUp) return [];

    const equity = state.equity;
    if (equity > peakEquity) peakEquity = equity;
    if (halted) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);
    const gap = fast.value !== null && slow.value !== null ? fast.value - slow.value : null;
    const r = rsiValue(rsi);
    const r60 = ret60();
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const pnlPct = cost > 0n ? Number(value) / Number(cost) - 1 : 0;
      if (c > peakPrice) peakPrice = c;
      const crossDown = gap !== null && prevGap !== null && gap < 0 && prevGap >= 0;
      const reversal = crossDown && r60 !== null && r60 < REV_RET60;
      const stop = pnlPct <= -STOP_PCT;
      const trail = c <= peakPrice * (1 - TRAIL_PCT);
      if (reversal || stop || trail) {
        const lastExitLossNow = value < cost;
        lastExitLoss = lastExitLossNow;
        cooldownUntil = idx + (lastExitLossNow ? COOLDOWN_LOSS : COOLDOWN);
        if (equity * 1000n < peakEquity * 920n) halted = true;
        trades++;
        prevGap = gap;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      prevGap = gap;
      return [];
    }

    if (idx < cooldownUntil) {
      prevGap = gap;
      return [];
    }
    const trendUp = gap !== null && gap > 0 && slow.value !== null && c > slow.value;
    const rsiOk = r !== null && r <= RSI_HI;
    const crossUp = gap !== null && prevGap !== null && gap > 0 && prevGap <= 0;
    const strong = r60 !== null && r60 > ENTRY_RET60;
    const need60 = lastExitLoss ? REENTRY_RET60 : ENTRY_RET60_MIN;
    const enterStrong = trendUp && rsiOk && (crossUp || strong) && r60 !== null && r60 > need60;
    const enterProbe =
      trades === 0 && idx >= PROBE_BAR && trendUp && r !== null && r >= PROBE_RSI_LO && r <= RSI_HI;
    const enterLate = trades === 0 && idx >= LATE_BAR && r !== null && r <= LATE_RSI_HI;

    prevGap = gap;
    if (!enterStrong && !enterProbe && !enterLate) return [];

    let frac = sizeFrac();
    if (enterProbe && !enterStrong) frac = Math.min(frac, PROBE_FRAC);
    if (enterLate && !enterStrong && !enterProbe) frac = Math.min(frac, LATE_FRAC);
    let spend = BigInt(Math.floor(Number(equity) * frac));
    if (spend > state.cash) spend = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (spend > room) spend = room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peakPrice = c;
    trades++;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
