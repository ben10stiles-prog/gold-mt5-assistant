# Gold Desk XAUUSD market-data integration plan

## User requirements
- Instrument: XAU/USD spot reference, compared against the user's Kudo MT5 quote before any strategy evaluation.
- Scan target: sample the latest market state every 15 seconds during market hours.
- Style: short-term scalping research.
- Timeframes: M5, M15, H1.
- Alert policy: strict/high-quality-only.
- Execution: paper research only. No broker login, order placement, or live trading.

## Current state
The GitHub Pages app is a client-side paper-trading interface. It does not currently have a live feed, backend, persistent server-side scanner, push-notification service, or MT5 connection. The 15-second interval is a requested target only; it is not running yet.

## Data-provider candidate
Twelve Data documents XAU/USD spot data and a WebSocket price stream. Its commodity page says REST commodity data is updated minutely and WebSocket prices can stream with low latency. The WebSocket documentation describes price events and symbol subscription. Its support FAQ says full WebSocket access is available only on the Pro plan, although lower-tier plans can test symbols. Confirm current plan entitlements, XAU/USD availability, latency, and permitted use before subscribing.

References:
- https://twelvedata.com/commodities
- https://twelvedata.com/docs/websocket/websocket-getting-started
- https://support.twelvedata.com/en/articles/5194610-websocket-faq

## Proposed architecture
1. Hosted backend owns the provider API key as a secret. Never put provider keys in index.html, browser JavaScript, GitHub Pages, or a public repository.
2. Backend opens one authenticated provider WebSocket for XAU/USD and maintains a heartbeat/reconnect loop.
3. Backend records incoming ticks and samples current bid/ask/last price every 15 seconds while the feed is open.
4. Backend builds its own M5, M15 and H1 OHLC candles from timestamped ticks. Mark gaps, stale ticks, market closures and feed outages; never silently fill missing data.
5. Backend compares provider quotes with a manually observed Kudo MT5 quote during validation. Provider spot prices are not guaranteed to match the broker's CFD symbol, spread, or execution price.
6. Scanner evaluates only completed candles for the selected rule set. The 15-second sampling interval must not create repeated duplicate signals from the same candle.
7. Store each candidate, rejected condition, timestamp, feed source, spread estimate, and later paper outcome for audit/backtesting.
8. Push notifications are delivered by a separate service (for example, Web Push with an installed iPhone web app); test iOS permission, delivery, expiry and duplicate suppression.
9. Keep paper-only controls. No Kudo credentials, MT5 account access, or order execution.

## High-quality filter (initial research rules, not a proven strategy)
A candidate should be rejected if any required data is stale, spread is unknown/unacceptable, volatility is abnormal, a high-impact event window is active, M15/H1 context conflicts, or the M5 trigger is not confirmed on a closed candle. Thresholds must be selected from historical testing rather than invented as performance claims.

## Required before implementation
- User-created market-data provider account and API key, entered only into the chosen hosting provider's secret manager.
- Selection and setup of a backend host with persistent WebSocket support.
- Confirmation of the provider's current licensing, plan and XAU/USD data entitlement.
- Historical dataset and explicit paper-testing protocol.
- Separate push-notification setup.

## Safety and validation
Do not present a candidate as a guaranteed signal. Do not claim a win rate until an out-of-sample backtest and forward paper test are complete, including spread, slippage assumptions, sample size and drawdown. Do not connect a live brokerage account or execute orders.
