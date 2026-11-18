function configured(env) {
  return {
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
  };
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { configured: false, sent: false };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    }
  );

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Keep provider response bodies and credentials out of public error messages.
  }

  return {
    configured: true,
    sent: response.ok && data.ok === true,
    providerStatus: response.status
  };
}

async function deliverTelegram(env, title, message) {
  try {
    return await sendTelegram(env, `${title}\n\n${message}`);
  } catch {
    return {
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      sent: false,
      reason: "delivery_error"
    };
  }
}

export function getNotificationStatus(env) {
  return configured(env);
}

export function sendTestNotifications(env) {
  return deliverTelegram(
    env,
    "GOLD DESK — NOTIFICATION TEST",
    "Your Gold Desk Telegram connection is being tested. This is a test only, not a trade signal."
  );
}

export function sendTradeNotifications(env, alert) {
  const message = [
    `Instrument: ${alert.symbol || "XAU/USD"}`,
    `Direction: ${alert.direction}`,
    `Indicative entry: ${alert.entry}`,
    alert.entryZone ? `Entry zone: ${alert.entryZone[0]}–${alert.entryZone[1]}` : null,
    `Stop loss: ${alert.stopLoss}`,
    `Take profit: ${alert.takeProfit}`,
    `Risk/reward: ${alert.riskReward || "Not supplied"}`,
    `Reason: ${alert.reason || "See Gold Desk analysis"}`,
    `Signal time: ${alert.signalTime || alert.timestamp || new Date().toISOString()}`,
    alert.warning || "Research alert only. Confirm the quote and risk independently; no order has been placed.",
    "No order has been placed."
  ].filter(Boolean).join("\n");

  return deliverTelegram(env, `GOLD DESK — ${String(alert.direction).toUpperCase()} SETUP`, message);
}
