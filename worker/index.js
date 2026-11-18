import { getNotificationStatus, sendTestNotifications } from "./notifications.js";

const APP_ORIGIN = "https://ben10stiles-prog.github.io";
const BUILD_ID = "gold-desk-dual-notifications-2026-11-18-1";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (origin && origin !== APP_ORIGIN) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": APP_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin"
        }
      });
    }

    if (origin && origin !== APP_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403);
    }

    const url = new URL(request.url);

    if (url.pathname === "/notifications/status" && request.method === "GET") {
      return json({
        service: "Gold Desk notifications",
        configured: getNotificationStatus(env),
        build: BUILD_ID
      }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/alerts/test" && request.method === "POST") {
      if (!env.ALERT_TEST_SECRET) {
        return json({ error: "Notification test is not configured" }, 503);
      }

      const authorization = request.headers.get("Authorization") || "";
      if (authorization !== `Bearer ${env.ALERT_TEST_SECRET}`) {
        return json({ error: "Unauthorized" }, 401);
      }

      const configured = getNotificationStatus(env);
      if (!configured.telegram && !configured.iphone) {
        return json({ error: "No notification channels are configured" }, 503);
      }

      try {
        const delivery = await sendTestNotifications(env);
        const allConfiguredChannelsSent =
          (!configured.telegram || delivery.telegram.sent) &&
          (!configured.iphone || delivery.iphone.sent);

        return json({
          message: allConfiguredChannelsSent
            ? "Test notification sent"
            : "One or more notification channels failed",
          delivery,
          build: BUILD_ID
        }, allConfiguredChannelsSent ? 200 : 502, { "Cache-Control": "no-store" });
      } catch {
        return json({ error: "Notification delivery failed", build: BUILD_ID }, 502);
      }
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "Gold Desk API",
        endpoint: "/price",
        status: "ready",
        build: BUILD_ID,
        marketData: "provider-check-required",
        notifications: getNotificationStatus(env)
      }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname !== "/price") {
      return json({ error: "Not found", build: BUILD_ID }, 404);
    }

    if (!env.TWELVE_DATA_API_KEY) {
      return json({ error: "API secret not configured", build: BUILD_ID }, 500);
    }

    const upstream = new URL("https://api.twelvedata.com/time_series");
    upstream.searchParams.set("symbol", "XAU/USD");
    upstream.searchParams.set("interval", "1min");
    upstream.searchParams.set("outputsize", "2");
    upstream.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

    try {
      const response = await fetch(upstream.toString());
      const data = await response.json();

      if (!response.ok || data.status !== "ok") {
        console.error("Twelve Data returned an error", {
          httpStatus: response.status,
          status: data.status || null,
          message: data.message || null,
          code: data.code || null
        });
        return json({
          error: "Market data request failed",
          provider: "Twelve Data",
          providerHttpStatus: response.status,
          providerStatus: data.status || null,
          providerCode: data.code || null,
          details: data.message || "Provider returned an unsuccessful response",
          build: BUILD_ID
        }, 502);
      }

      return json({
        symbol: data.meta?.symbol || "XAU/USD",
        interval: data.meta?.interval || "1min",
        values: data.values || [],
        receivedAt: new Date().toISOString(),
        source: "Twelve Data"
      }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return json({
        error: "Market data connection failed",
        details: error instanceof Error ? error.message : "Unknown fetch or parsing error",
        errorName: error instanceof Error ? error.name : "UnknownError",
        build: BUILD_ID
      }, 502);
    }
  }
};
