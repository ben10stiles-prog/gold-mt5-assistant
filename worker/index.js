import { getNotificationStatus, sendTestNotifications, sendTradeNotifications } from "./notifications.js";
import { analyseXauusd } from "./signal-engine.js";

const APP_ORIGIN = "https://ben10stiles-prog.github.io";
const BUILD_ID = "gold-desk-live-signals-2026-11-18-1";
const SIGNAL_CACHE_ORIGIN = "https://gold-desk-api.ben10stiles.workers.dev";

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

    if (url.pathname === "/signals/latest" && request.method === "GET") {
      const key = new Request(`${SIGNAL_CACHE_ORIGIN}/__gold-desk-cache/signals-latest`);
      const saved = await caches.default.match(key);
      if (!saved) return json({ status: "NOT_SCANNED", message: "The scheduled scanner has not completed its first run yet.", build: BUILD_ID }, 200, { "Cache-Control": "no-store" });
      return json(await saved.json(), 200, { "Cache-Control": "no-store" });
    }

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

    // Reuse a successful response for 55 seconds to avoid exhausting
    // Twelve Data's 8-credit-per-minute Basic allowance on repeated refreshes.
    const cache = caches.default;
    const cacheKey = new Request(new URL("/__gold-desk-cache/price-v1", url.origin).toString());

    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedData = await cached.json();
        const latestTime = cachedData.latestCandleAt ? new Date(cachedData.latestCandleAt) : null;
        const candleAgeSeconds = latestTime && !Number.isNaN(latestTime.getTime())
          ? Math.max(0, Math.round((Date.now() - latestTime.getTime()) / 1000))
          : null;
        return json({
          ...cachedData,
          candleAgeSeconds,
          isFresh: candleAgeSeconds !== null && candleAgeSeconds <= 180,
          cache: "HIT"
        }, 200, {
          "Cache-Control": "no-store",
          "X-GoldDesk-Cache": "HIT"
        });
      }
    }

    if (!env.TWELVE_DATA_API_KEY) {
      return json({ error: "API secret not configured", build: BUILD_ID }, 500);
    }

    const upstream = new URL("https://api.twelvedata.com/time_series");
    upstream.searchParams.set("symbol", "XAU/USD");
    upstream.searchParams.set("interval", "1min");
    upstream.searchParams.set("outputsize", "2");
    upstream.searchParams.set("timezone", "UTC");
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
        const rateLimited = response.status === 429 || data.code === 429;
        return json({
          error: rateLimited ? "Market data rate limit reached" : "Market data request failed",
          provider: "Twelve Data",
          providerHttpStatus: response.status,
          providerStatus: data.status || null,
          providerCode: data.code || null,
          details: data.message || "Provider returned an unsuccessful response",
          retryAfterSeconds: rateLimited ? 60 : null,
          build: BUILD_ID
        }, 502, rateLimited
          ? { "Retry-After": "60", "Cache-Control": "no-store" }
          : { "Cache-Control": "no-store" });
      }

      const receivedAt = new Date();
      const values = Array.isArray(data.values) ? data.values : [];
      const latest = values[0] || null;
      const latestTime = latest?.datetime
        ? new Date(`${latest.datetime.replace(" ", "T")}Z`)
        : null;

      if (!latestTime || Number.isNaN(latestTime.getTime())) {
        return json({
          error: "Market data timestamp is missing or invalid",
          provider: "Twelve Data",
          build: BUILD_ID
        }, 502, { "Cache-Control": "no-store" });
      }

      const candleAgeSeconds = Math.round((receivedAt.getTime() - latestTime.getTime()) / 1000);
      if (candleAgeSeconds < -120) {
        return json({
          error: "Market data timestamp is ahead of server time",
          provider: "Twelve Data",
          latestCandleAt: latestTime.toISOString(),
          receivedAt: receivedAt.toISOString(),
          clockSkewSeconds: -candleAgeSeconds,
          build: BUILD_ID
        }, 502, { "Cache-Control": "no-store" });
      }

      const payload = {
        symbol: data.meta?.symbol || "XAU/USD",
        interval: data.meta?.interval || "1min",
        timezone: "UTC",
        values,
        latestCandleAt: latestTime.toISOString(),
        receivedAt: receivedAt.toISOString(),
        candleAgeSeconds,
        isFresh: candleAgeSeconds <= 180,
        source: "Twelve Data",
        cache: "MISS",
        build: BUILD_ID
      };

      const successResponse = json(payload, 200, {
        "Cache-Control": "public, max-age=55",
        "X-GoldDesk-Cache": "MISS"
      });

      if (cache) {
        await cache.put(cacheKey, successResponse.clone(), { expirationTtl: 55 });
      }

      return successResponse;
    } catch (error) {
      return json({
        error: "Market data connection failed",
        details: error instanceof Error ? error.message : "Unknown fetch or parsing error",
        errorName: error instanceof Error ? error.name : "UnknownError",
        build: BUILD_ID
      }, 502);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledScan(env));
  }
};

async function runScheduledScan(env) {
  const cache = caches.default;
  const latestKey = new Request(`${SIGNAL_CACHE_ORIGIN}/__gold-desk-cache/signals-latest`);
  const historyKey = new Request(`${SIGNAL_CACHE_ORIGIN}/__gold-desk-cache/signal-history-v1`);

  try {
    let market = await cache.match(historyKey);
    let values;
    if (market) {
      const cached = await market.json();
      values = cached.values;
    } else {
      if (!env.TWELVE_DATA_API_KEY) throw new Error("Twelve Data API secret is not configured");
      const upstream = new URL("https://api.twelvedata.com/time_series");
      upstream.searchParams.set("symbol", "XAU/USD");
      upstream.searchParams.set("interval", "1min");
      upstream.searchParams.set("outputsize", "4000");
      upstream.searchParams.set("timezone", "UTC");
      upstream.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);
      const response = await fetch(upstream.toString());
      const data = await response.json();
      if (!response.ok || data.status !== "ok" || !Array.isArray(data.values)) {
        throw new Error(data.message || `Twelve Data returned HTTP ${response.status}`);
      }
      values = data.values;
      await cache.put(historyKey, new Response(JSON.stringify({ values, fetchedAt: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json" }
      }), { expirationTtl: 55 });
    }

    const analysis = analyseXauusd(values, Date.now());
    const result = {
      ...analysis,
      scannedAt: new Date().toISOString(),
      dataSource: "Twelve Data XAU/USD spot",
      executionMode: "ALERTS_ONLY_NO_ORDERS",
      notifications: { telegram: "not_sent" },
      build: BUILD_ID
    };

    if (analysis.status === "CANDIDATE") {
      const dedupeKey = new Request(`${SIGNAL_CACHE_ORIGIN}/__gold-desk-cache/signal-sent/${encodeURIComponent(analysis.signalId)}`);
      const alreadySent = await cache.match(dedupeKey);
      if (!alreadySent && getNotificationStatus(env).telegram) {
        const delivery = await sendTradeNotifications(env, analysis);
        result.notifications.telegram = delivery.telegram.sent ? "sent" : "failed";
        if (delivery.telegram.sent) {
          await cache.put(dedupeKey, new Response("sent"), { expirationTtl: 86400 });
        }
      } else if (alreadySent) {
        result.notifications.telegram = "duplicate_suppressed";
      } else {
        result.notifications.telegram = "not_configured";
      }
    }

    await cache.put(latestKey, new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" }
    }), { expirationTtl: 3600 });
  } catch (error) {
    const failure = {
      status: "ERROR",
      reason: "Scheduled scan failed; no signal was generated.",
      detail: error instanceof Error ? error.message : "Unknown scanner error",
      scannedAt: new Date().toISOString(),
      executionMode: "ALERTS_ONLY_NO_ORDERS",
      build: BUILD_ID
    };
    await cache.put(latestKey, new Response(JSON.stringify(failure), {
      headers: { "Content-Type": "application/json" }
    }), { expirationTtl: 3600 });
    console.error("Gold Desk scheduled scan failed", error);
  }
}
