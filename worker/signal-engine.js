const MINUTE = 60_000;

function parseCandle(c) {
  const time = Date.parse(`${String(c.datetime).replace(" ", "T")}Z`);
  const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close };
}

function aggregate(candles, minutes) {
  const span = minutes * MINUTE;
  const buckets = new Map();
  for (const c of candles) {
    const start = Math.floor(c.time / span) * span;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(c);
  }
  const result = [];
  for (const [start, group] of buckets) {
    group.sort((a, b) => a.time - b.time);
    if (group.length !== minutes) continue;
    let contiguous = true;
    for (let i = 0; i < group.length; i++) {
      if (group[i].time !== start + i * MINUTE) contiguous = false;
    }
    if (!contiguous) continue;
    result.push({
      time: start,
      open: group[0].open,
      high: Math.max(...group.map(x => x.high)),
      low: Math.min(...group.map(x => x.low)),
      close: group[group.length - 1].close
    });
  }
  return result.sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return ranges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function wait(reason, details = {}) {
  return { status: "WAIT", reason, details, strategy: "GD-MTF-1.0" };
}

export function analyseXauusd(values, now = Date.now()) {
  if (!Array.isArray(values) || values.length < 2400) {
    return wait("Insufficient one-minute history; need at least 2,400 candles for stable H1 context.");
  }

  const candles = values.map(parseCandle).filter(Boolean).sort((a, b) => a.time - b.time);
  const completed = candles.filter(c => c.time + MINUTE <= now - 5_000);
  if (completed.length < 2400) return wait("Not enough completed candles yet.");

  const latest = completed[completed.length - 1];
  const age = Math.floor((now - (latest.time + MINUTE)) / 1000);
  if (age > 180 || age < 0) return wait("Market feed is stale or candle timing is invalid.", { candleAgeSeconds: age });

  const m5 = aggregate(completed, 5);
  const m15 = aggregate(completed, 15);
  const h1 = aggregate(completed, 60);
  if (m5.length < 60 || m15.length < 60 || h1.length < 55) {
    return wait("Insufficient complete M5/M15/H1 candles after gap checks.", {
      m5: m5.length, m15: m15.length, h1: h1.length
    });
  }

  const h1Close = h1.map(c => c.close);
  const m15Close = m15.map(c => c.close);
  const h1Fast = ema(h1Close, 20), h1Slow = ema(h1Close, 50);
  const m15Fast = ema(m15Close, 20), m15Slow = ema(m15Close, 50);
  const m15Atr = atr(m15), m5Atr = atr(m5), m5Rsi = rsi(m5);
  if (![h1Fast, h1Slow, m15Fast, m15Slow, m15Atr, m5Atr, m5Rsi].every(Number.isFinite)) {
    return wait("Indicator warm-up incomplete.");
  }

  const h1Last = h1[h1.length - 1];
  const m15Last = m15[m15.length - 1];
  const m15Prev = m15[m15.length - 2];
  const m5Last = m5[m5.length - 1];
  const priorM5 = m5.slice(-4, -1);
  const priorHigh = Math.max(...priorM5.map(c => c.high));
  const priorLow = Math.min(...priorM5.map(c => c.low));

  const bullishH1 = h1Fast > h1Slow && h1Last.close > h1Fast;
  const bearishH1 = h1Fast < h1Slow && h1Last.close < h1Fast;
  const bullishM15 = m15Fast > m15Slow && m15Last.close > m15Fast;
  const bearishM15 = m15Fast < m15Slow && m15Last.close < m15Fast;
  const longPullback = m15Prev.low <= m15Fast + 0.35 * m15Atr && m15Last.close > m15Fast;
  const shortPullback = m15Prev.high >= m15Fast - 0.35 * m15Atr && m15Last.close < m15Fast;
  const longTrigger = m5Last.close > priorHigh && m5Rsi >= 52 && m5Rsi <= 70;
  const shortTrigger = m5Last.close < priorLow && m5Rsi >= 30 && m5Rsi <= 48;

  let direction = null;
  if (bullishH1 && bullishM15 && longPullback && longTrigger) direction = "BUY";
  if (bearishH1 && bearishM15 && shortPullback && shortTrigger) direction = "SELL";
  if (!direction) {
    return wait("No complete multi-timeframe setup. Waiting for H1 trend, M15 pullback and M5 trigger to align.", {
      h1: bullishH1 ? "bullish" : bearishH1 ? "bearish" : "mixed",
      m15: bullishM15 ? "bullish" : bearishM15 ? "bearish" : "mixed",
      m5Rsi: Number(m5Rsi.toFixed(1)),
      completedAt: new Date(m5Last.time + 5 * MINUTE).toISOString()
    });
  }

  const entry = m5Last.close;
  const risk = Math.max(1.5 * m5Atr, 0.01);
  const stopLoss = direction === "BUY" ? entry - risk : entry + risk;
  const takeProfit = direction === "BUY" ? entry + 2 * risk : entry - 2 * risk;
  const signalTime = new Date(m5Last.time + 5 * MINUTE).toISOString();
  return {
    status: "CANDIDATE",
    strategy: "GD-MTF-1.0",
    symbol: "XAU/USD",
    brokerSymbol: "XAUUSD.s",
    direction,
    timeframe: "M5 trigger / M15 setup / H1 trend",
    entry: Number(entry.toFixed(2)),
    entryZone: [
      Number((entry - 0.1 * m5Atr).toFixed(2)),
      Number((entry + 0.1 * m5Atr).toFixed(2))
    ],
    stopLoss: Number(stopLoss.toFixed(2)),
    takeProfit: Number(takeProfit.toFixed(2)),
    riskReward: "1:2",
    atrM5: Number(m5Atr.toFixed(2)),
    rsiM5: Number(m5Rsi.toFixed(1)),
    signalTime,
    signalId: `${direction}-${m5Last.time}`,
    reason: `H1 ${direction === "BUY" ? "bullish" : "bearish"} trend; M15 aligned pullback; M5 completed-candle breakout; RSI ${m5Rsi.toFixed(1)}.`,
    dataSource: "Twelve Data XAU/USD spot",
    brokerCheckRequired: true,
    warning: "Research candidate only. Twelve Data spot is not the Kudo executable quote. Verify Kudo bid/ask, floating spread and price alignment before any manual decision. No order is placed."
  };
}
