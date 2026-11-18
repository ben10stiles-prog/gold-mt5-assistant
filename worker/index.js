const APP_ORIGIN = "https://ben10stiles-prog.github.io";
const BUILD_ID = "gold-desk-live-feed-diagnostics-2026-11-18-1";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
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
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        }
      });
    }

    if (origin && origin !== APP_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403);
    }

    const url = new URL(request.url);

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "Gold Desk API",
        endpoint: "/price",
        status: "ready",
        build: BUILD_ID,
        marketData: "provider-check-required"
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