# Gold Desk live signal scanner — first paper version

## What this adds

- A Cloudflare scheduled scan every minute.
- One Twelve Data XAU/USD 1-minute history request per scan, cached for 55 seconds.
- UTC aggregation into completed M5, M15 and H1 candles. Incomplete buckets and stale feeds are rejected.
- A deliberately strict trend/pullback/breakout candidate rule.
- Telegram-only candidate alerts with a duplicate guard. No broker connection and no order placement.
- GET /signals/latest to inspect the most recent scan result.

## GD-MTF-1.0 rule

A candidate is considered only when all of these align:

1. H1: EMA20 above EMA50 and last completed H1 close above EMA20 for BUY; inverse for SELL.
2. M15: EMA20/EMA50 agree with H1; the prior completed M15 candle tests the EMA20 area and the latest completed M15 candle closes back on the trend side.
3. M5: latest completed M5 candle closes beyond the previous three completed M5 highs/lows.
4. M5 RSI(14): 52–70 for BUY or 30–48 for SELL.
5. M5 ATR(14) is available; initial research stop is 1.5 × ATR and target is 2 × that distance (nominal 1:2 before spread/slippage).

This is a transparent technical rule set, not an AI prediction and not a claim of profitability. The first release is a candidate generator for observation and paper journaling, not a validated strategy.

## Data and broker limitations

The scanner uses Twelve Data XAU/USD spot candles. The user's MT5 symbol is Kudo XAUUSD.s, where buys execute at Ask and sells at Bid, while the chart is Bid and spread floats. Twelve Data is not the broker's executable quote. Therefore every alert explicitly requires checking Kudo bid/ask, live spread and price alignment; the entry/SL/TP are indicative research levels only. No alert should be treated as an instruction to place a live trade.

A reliable broker-side spread/quote feed and calibration are still required before any executable signal can be considered. High-impact news filtering is also not included in this first version.

## Risk and testing guardrails

- Telegram notifications only; iPhone/ntfy is not required.
- Manual observation / paper testing only; no MT5 login, order API or automatic execution.
- No martingale, grid or averaging down.
- Historical candle data can change and spot prices can differ from broker quotes.
- Track every candidate, including skipped and losing outcomes. Do not judge performance from a handful of alerts.
- The previous planning limits (0.20% risk per idea, 1.2% aggregate open risk, 2% daily loss stop and 8% hard drawdown stop) are research guardrails only; this scanner does not calculate account risk or enforce broker-side limits.

## Endpoints

- GET /signals/latest — most recent scheduled scan, including WAIT / CANDIDATE / ERROR.
- GET /price — existing short-cached two-candle price check.
- GET /notifications/status — configured notification channels.

## Before relying on alerts

1. Confirm the scheduled Worker deployment succeeded.
2. Confirm /signals/latest updates once per minute and shows candle counts / WAIT reasons.
3. Confirm Telegram delivery with a candidate only if the rule occurs; do not force a test trade.
4. Backtest GD-MTF-1.0 on quality historical XAU/USD data including spread, slippage and realistic execution.
5. Paper-forward-test over a meaningful sample and review expectancy, drawdown, missed signals and duplicate suppression.
