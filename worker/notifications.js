function configured(env) {
  return {
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    iphone: Boolean(env.NTFY_TOPIC)
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

async function sendIphonePush(env, title, message) {
  if (!env.NTFY_TOPIC) {
    return { configured: false, sent: false };
  }

  if (!/^[A-Za-z0-9_-]{16,64}$/.test(env.NTFY_TOPIC)) {
    return { configured: true, sent: false, reason: "invalid_topic_format" };
  }

  const headers = {
    "Title": title,
    "Priority": "4",
    "Tags": "chart_with_upwards_trend",
    "Content-Type": "text/plain; charset=utf-8"
  };

  if (env.NTFY_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${env.NTFY_ACCESS_TOKEN}`;
  }

  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: "POST",
    headers,
    body: message
  });

  return {
    configured: true,
    sent: response.ok,
    providerStatus: response.status
  };
}

async function deliver(env, title, message) {
  const results = await Promise.allSettled([
    sendTelegram(env, `${title}\n\n${message}`),
    sendIphonePush(env, title, message)
  ]);

  const telegram = results[0].status === "fulfilled"
    ? results[0].value
    : { configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), sent: false, reason: "delivery_error" };

  const iphone = results[1].status === "fulfilled"
    ? results[1].value
    : { configured: Boolean(env.NTFY_TOPIC), sent: false, reason: "delivery_error" };

  return { telegram, iphone };
}

export function getNotificationStatus(env) {
  return configured(env);
}

export function sendTestNotifications(env) {
  return deliver(
    env,
    "GOLD DESK — NOTIFICATION TEST",
    "Your Gold Desk notification connection is being tested. This is a test only, not a trade signal."
  );
}

export function sendTradeNotifications(env, alert) {
  const message = [
    `Instrument: ${alert.symbol || "XAU/USD"}`,
    `Direction: ${alert.direction}`,
    `Entry: ${alert.entry}`,
    `Stop loss: ${alert.stopLoss}`,
    `Take profit: ${alert.takeProfit}`,
    `Risk/reward: ${alert.riskReward || "Not supplied"}`,
    `Reason: ${alert.reason || "See Gold Desk analysis"}`,
    `Signal time: ${alert.timestamp || new Date().toISOString()}`,
    "",
    "Research alert only. Confirm the quote and risk independently; no order has been placed."
  ].join("\n");

  return deliver(env, `GOLD DESK — ${String(alert.direction).toUpperCase()} SETUP`, message);
}
