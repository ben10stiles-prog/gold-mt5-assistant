# Gold Desk Telegram notification setup

Gold Desk sends research-only alerts through a Telegram bot. The notification test sends a clearly labelled test message; it is not a trade signal.

## Cloudflare Worker secrets

In Cloudflare Dashboard → Workers & Pages → gold-desk-api → Settings → Variables and Secrets, configure these as **Production Secrets**:

| Secret name | Value |
| --- | --- |
| TELEGRAM_BOT_TOKEN | Token created by Telegram's @BotFather |
| TELEGRAM_CHAT_ID | Your private Telegram chat ID |
| ALERT_TEST_SECRET | A separate long random password used only to authorize test sends |

Do not put these values in GitHub, index.html, a screenshot, or a chat message. Do not reuse your Twelve Data API key as a notification secret.

## Telegram setup

1. Open Telegram and message @BotFather.
2. Send /newbot and follow its instructions. Save the bot token privately.
3. Open the new bot's private chat and press Start (or send /start).
4. Obtain your numeric Telegram user/chat ID using a trusted Telegram ID helper.
5. Add the bot token as TELEGRAM_BOT_TOKEN and the numeric ID as TELEGRAM_CHAT_ID in Cloudflare Worker Production secrets.

## Test access secret

Create a separate long random value for ALERT_TEST_SECRET. This is not the Telegram token or market-data API key. It is entered temporarily into Gold Desk's Settings screen to authorize a test message. The website does not save it.

## Test after deployment

1. Deploy the Worker containing the Telegram-only notification code.
2. Open https://gold-desk-api.ben10stiles.workers.dev/notifications/status. It should report whether Telegram is configured (true/false only; it never returns secret values).
3. Open the Gold Desk website → Settings → Telegram alerts.
4. Enter ALERT_TEST_SECRET and press Send Telegram test.
5. Confirm that the test arrives in the Telegram bot chat.

## API routes

- GET /notifications/status — reports whether Telegram is configured.
- POST /alerts/test — requires Authorization: Bearer <ALERT_TEST_SECRET>; sends a test message to Telegram.
- The Worker exports sendTradeNotifications(env, alert) for the signal engine.

## Important limitations

Telegram delivery is only the notification channel. The signal engine and scheduled scanner must be validated separately, including data freshness, spread and broker-quote differences, deduplication, and missed/duplicate alert behaviour. Alerts are research-only. No MT5 connection or order execution is provided by this notification code. Paper-test signals before considering any real-money use.
