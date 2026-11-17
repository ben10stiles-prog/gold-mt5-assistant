const APP_ORIGIN = "https://ben10stiles-prog.github.io";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const corsHeaders = {
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (origin && origin !== APP_ORIGIN) {
      return Response.json({ error: "Origin not allowed" }, {
        status: 403, headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/price" || request.method !== "GET") {
      return Response.json({
        service: "Gold Desk API",
        endpoint: "/price",
        status: "ready"
      }, { headers: corsHeaders });
    }

    if (!env.TWELVE_DATA_API_KEY) {
      return Response.json({ error: "API secret not configured" }, {
        status: 500, headers: corsHeaders
      });
    }

    const cache = caches.default;
    const cacheKey = new Request("https://gold-desk-cache.local/price");
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("Access-Control-Allow-Origin", APP_ORIGIN);
      headers.set("Vary", "Origin");
      return new Response(cached.body, { status: cached.status, headers });
    }

    const upstream = new URL("https://api.twelvedata.com/time_series");
    upstream.searchParams.set("symbol", "XAU/USD");
    upstream.searchParams.set("interval", "1min");
    upstream.searchParams.set("outputsize", "2");
    upstream.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

    try {
      const response = await fetch(upstream);
      const data = await response.json();

      if (!response.ok || data.status !== "ok") {
        return Response.json({
          error: "Market data request failed",
          details: data.message || data.status || "Unknown error"
        }, { status: 502, headers: corsHeaders });
      }

      const result = Response.json({
        symbol: data.meta.symbol,
        interval: data.meta.interval,
        values: data.values,
        receivedAt: new Date().toISOString(),
        source: "Twelve Data"
      }, {
        headers: {
          ...Object.fromEntries(corsHeaders),
          "Cache-Control": "public, max-age=45"
        }
      });

      ctx.waitUntil(cache.put(cacheKey, result.clone()));
      return result;
    } catch {
      return Response.json({ error: "Market data connection failed" }, {
        status: 502, headers: corsHeaders
      });
    }
  }
};
