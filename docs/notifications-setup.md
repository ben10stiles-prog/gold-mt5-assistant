# Gold Desk dual-notification setup

This change adds notification delivery plumbing only. It does not generate trade signals, run a background scanner, connect to MT5, or place orders. The test route sends a clearly labelled test message.

## Channels

- Telegram bot messages, sent with the Telegram Bot API.
- iPhone push notifications through the ntfy iOS app and a private ntfy topic.

## Cloudflare Worker secrets

In Cloudflare Dashboard → Workers & Pages → gold-desk-api → Settings → Variables and Secrets, add these as **Secrets** in the Production environment:

| Secret name | Value |
| --- | --- |
| TELEGRAM_BOT_TOKEN | Token created by Telegram's @BotFather |
| TELEGRAM_CHAT_ID | Your private Telegram chat ID |
| NTFY_TOPIC | A unique random topic name, 16–64 characters using letters, numbers, _ or - |
| ALERT_TEST_SECRET | A separate long random password used only to authorize test sends |
| NTFY_ACCESS_TOKEN | Optional ntfy access token, if using an authenticated ntfy topic |

Do not put any of these values in GitHub, index.html, a screenshot, or a chat message. Do not reuse your Twelve Data API key as any notification secret.

## Telegram setup

1. Open Telegram and message @BotFather.
2. Send /newbot and follow its instructions. Save the bot token privately.
3. Open the new bot's private chat and press Start (or send /start).
4. Obtain your numeric Telegram user/chat ID using a trusted Telegram ID helper such as @userinfobot.
5. Add the bot token as TELEGRAM_BOT_TOKEN and the numeric ID as TELEGRAM_CHAT_ID in Cloudflare Worker Production secrets.

## iPhone push setup

1. Install the ntfy app on your iPhone from the App Store.
2. Generate a unique random topic name between 16 and 64 characters. Do not use a guessable name such as gold-desk or your username.
3. In the ntfy app, subscribe to that exact topic on ntfy.sh.
4. Allow notifications for ntfy in iOS Settings.
5. Add the same topic name as the Cloudflare secret NTFY_TOPIC.

A private random topic is a bearer-style address: anyone who learns it may be able to publish to or subscribe to it. Keep it private. For stronger access control, configure an ntfy access token and set NTFY_ACCESS_TOKEN as a Worker secret.

## Test access secret

Create a separate long random value for ALERT_TEST_SECRET. This is not the Telegram token, ntfy topic, or market-data API key. It is entered temporarily into Gold Desk's Settings screen to authorize a test message. The website does not save it.

## Test after deployment

1. Deploy the Worker containing this change.
2. Open https://gold-desk-api.ben10stiles.workers.dev/notifications/status. It should show whether each channel is configured (true/false only; it never returns secret values).
3. Open the Gold Desk website → Settings → Telegram + iPhone push.
4. Enter ALERT_TEST_SECRET and press Send test to configured channels.
5. Confirm that the test arrives in the Telegram bot chat and as an iPhone ntfy notification.

## API routes

- GET /notifications/status — reports configured booleans only.
- POST /alerts/test — requires Authorization: Bearer <ALERT_TEST_SECRET>; sends a test message to configured channels.
- The Worker exports sendTradeNotifications(env, alert) for later use by the signal engine.

## Important current limitation

The notification transport is not the strategy or scanner. No live trade alert is generated automatically by this change. A later implementation must add a tested signal engine, deduplication, stale-feed/spread/news filters, and a scheduled or streaming background scanner before trade alerts can be enabled. Keep execution manual and paper-test all signals before considering any real-money use.
