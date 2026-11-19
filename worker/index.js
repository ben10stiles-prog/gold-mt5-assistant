import { getNotificationStatus, sendTestNotifications, sendTradeNotifications } from "./notifications.js";
import { analyseXauusd } from "./signal-engine.js";
import { runBacktest, runBacktestM5 } from "./backtest.js";

const APP_ORIGIN = "https://ben10stiles-prog.github.io";
const BUILD_ID = "gold-desk-kv-scan-2026-11-18-1";
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

    if (url.pathname === "/backtest/history/start" && request.method === "POST") {
      if (!env.TWELVE_DATA_API_KEY) return json({ error: "Twelve Data API secret is not configured" }, 503);
      if (!env.KV) return json({ error: "Historical backtest storage (KV) is not configured" }, 503);
      try {
        const body = await request.json();
        const months = Number(body.months || 6);
        if (![3,6,12].includes(months)) return json({ error: "Choose 3, 6 or 12 months." }, 400);
        const end = new Date(Math.floor(Date.now()/300000)*300000-300000);
        const start = new Date(end); start.setUTCMonth(start.getUTCMonth()-months);
        const chunkMs = 20*24*60*60*1000, stepMs=300000, chunks=[];
        for(let cursor=start.getTime();cursor<=end.getTime();){
          const chunkEnd=Math.min(cursor+chunkMs-stepMs,end.getTime());
          chunks.push({start:new Date(cursor).toISOString().replace("T"," ").slice(0,19),end:new Date(chunkEnd).toISOString().replace("T"," ").slice(0,19)});
          cursor=chunkEnd+stepMs;
        }
        const id=crypto.randomUUID();
        const job={id,months,start:start.toISOString(),end:end.toISOString(),chunks,completed:0,totalBars:0,createdAt:new Date().toISOString(),status:"running"};
        await env.KV.put("backtest-job:"+id,JSON.stringify(job),{expirationTtl:86400});
        return json({jobId:id,months,totalChunks:chunks.length,completed:0,totalBars:0,status:"running",message:"Historical download prepared. Each step requests one 20-day window."},200,{"Cache-Control":"no-store"});
      } catch(error) { return json({error:error instanceof Error?error.message:"Could not start historical backtest"},400); }
    }

    if (url.pathname === "/backtest/history/step" && request.method === "POST") {
      if (!env.TWELVE_DATA_API_KEY || !env.KV) return json({error:"Historical data service is not configured"},503);
      try {
        const body=await request.json(),id=String(body.jobId||"");
        if(!/^[0-9a-f-]{36}$/i.test(id)) return json({error:"Invalid backtest job ID"},400);
        const key="backtest-job:"+id,raw=await env.KV.get(key);
        if(!raw)return json({error:"Backtest job expired or not found. Start a new test."},404);
        const job=JSON.parse(raw);
        if(job.status==="complete")return json({jobId:id,status:"complete",completed:job.completed,totalChunks:job.chunks.length,totalBars:job.totalBars});
        const chunk=job.chunks[job.completed];
        if(!chunk)return json({error:"Backtest job has no remaining download windows"},409);
        const upstream=new URL("https://api.twelvedata.com/time_series");
        upstream.searchParams.set("symbol","XAU/USD");
        upstream.searchParams.set("interval","5min");
        upstream.searchParams.set("start_date",chunk.start);
        upstream.searchParams.set("end_date",chunk.end);
        upstream.searchParams.set("timezone","UTC");
        upstream.searchParams.set("order","asc");
        const response=await fetch(upstream.toString(),{headers:{Authorization:"apikey "+env.TWELVE_DATA_API_KEY}});
        const data=await response.json();
        if(!response.ok||data.status!=="ok"||!Array.isArray(data.values)){
          const rateLimited=response.status===429||data.code===429;
          return json({error:data.message||"Twelve Data did not return historical candles",providerCode:data.code||null,completed:job.completed,totalChunks:job.chunks.length,retryAfterSeconds:rateLimited?60:null},rateLimited?429:502,rateLimited?{"Retry-After":"60","Cache-Control":"no-store"}:{"Cache-Control":"no-store"});
        }
        const values=data.values.map(c=>({datetime:c.datetime,open:c.open,high:c.high,low:c.low,close:c.close}));
        await env.KV.put("backtest-job:"+id+":chunk:"+job.completed,JSON.stringify(values),{expirationTtl:86400});
        job.completed++;job.totalBars+=values.length;
        if(job.completed===job.chunks.length)job.status="downloaded";
        await env.KV.put(key,JSON.stringify(job),{expirationTtl:86400});
        return json({jobId:id,status:job.status,completed:job.completed,totalChunks:job.chunks.length,totalBars:job.totalBars,window:chunk},200,{"Cache-Control":"no-store"});
      } catch(error){return json({error:error instanceof Error?error.message:"Historical download step failed"},400,{"Cache-Control":"no-store"});}
    }

    if (url.pathname === "/backtest/history/run" && request.method === "POST") {
      if(!env.KV)return json({error:"Historical backtest storage is not configured"},503);
      try{
        const body=await request.json(),id=String(body.jobId||"");
        if(!/^[0-9a-f-]{36}$/i.test(id))return json({error:"Invalid backtest job ID"},400);
        const raw=await env.KV.get("backtest-job:"+id);
        if(!raw)return json({error:"Backtest job expired or not found"},404);
        const job=JSON.parse(raw);
        if(job.completed!==job.chunks.length)return json({error:"Historical download is not complete",completed:job.completed,totalChunks:job.chunks.length},409);
        const candles=[];
        for(let i=0;i<job.chunks.length;i++){
          const part=await env.KV.get("backtest-job:"+id+":chunk:"+i);
          if(!part)return json({error:"A historical data segment is missing. Restart the download."},409);
          candles.push(...JSON.parse(part));
        }
        const result=runBacktestM5(candles);
        job.status="complete";job.finishedAt=new Date().toISOString();
        await env.KV.put("backtest-job:"+id,JSON.stringify(job),{expirationTtl:86400});
        return json({...result,dataSource:"Twelve Data XAU/USD spot, 5-minute OHLC",download:{months:job.months,chunks:job.completed,totalBars:candles.length},historyNote:"Multi-month 5-minute history. M15 and H1 bars are aggregated from complete M5 candles. Gross results exclude spread, commission, slippage and swap."},200,{"Cache-Control":"no-store"});
      }catch(error){return json({error:error instanceof Error?error.message:"Historical backtest calculation failed"},400,{"Cache-Control":"no-store"});}
    }

    if (url.pathname === "/backtest/automatic" && request.method === "POST") {
      if (!env.TWELVE_DATA_API_KEY) {
        return json({ error: "Twelve Data API secret is not configured" }, 503, { "Cache-Control": "no-store" });
      }

      try {
        const cache = caches.default;
        const cacheKey = new Request("https://gold-desk-api.ben10stiles.workers.dev/__gold-desk-cache/backtest-history-1min-v1");
        let data = cache ? await cache.match(cacheKey) : null;

        if (data) {
          data = await data.json();
        } else {
          const upstream = new URL("https://api.twelvedata.com/time_series");
          upstream.searchParams.set("symbol", "XAU/USD");
          upstream.searchParams.set("interval", "1min");
          upstream.searchParams.set("outputsize", "5000");
          upstream.searchParams.set("order", "ASC");
          upstream.searchParams.set("timezone", "UTC");
          upstream.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

          const response = await fetch(upstream.toString());
          data = await response.json();
          if (!response.ok || data.status !== "ok" || !Array.isArray(data.values)) {
            const message = data.message || "Twelve Data could not return historical XAU/USD candles";
            return json({ error: message, provider: "Twelve Data", providerCode: data.code || null }, 502, { "Cache-Control": "no-store" });
          }

          if (cache) {
            await cache.put(cacheKey, json(data, 200, { "Cache-Control": "public, max-age=3600" }), { expirationTtl: 3600 });
          }
        }

        const candles = data.values.map(c => ({
          datetime: c.datetime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }));
        const result = runBacktest(candles);
        return json({ ...result, dataSource: "Twelve Data XAU/USD spot", cachedHistory: Boolean(cache), historyNote: "Up to 5,000 latest one-minute bars. This is a short diagnostic sample, not enough on its own to establish a durable trading edge." }, 200, { "Cache-Control": "no-store" });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Automatic backtest failed" }, 400, { "Cache-Control": "no-store" });
      }
    }

    if (url.pathname === "/backtest" && request.method === "POST") {
      try {
        const body = await request.json();
        return json(runBacktest(body.candles), 200, { "Cache-Control": "no-store" });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Backtest failed" }, 400, { "Cache-Control": "no-store" });
      }
    }

    if (url.pathname === "/signals/latest" && request.method === "GET") {
      if (!env.KV) return json({ status: "CONFIG_ERROR", message: "The GOLD_DESK_SIGNALS KV binding is missing.", build: BUILD_ID }, 503, { "Cache-Control": "no-store" });
      const saved = await env.KV.get("signals-latest");
      if (!saved) return json({ status: "NOT_SCANNED", message: "The scheduled scanner has not completed its first run yet.", build: BUILD_ID }, 200, { "Cache-Control": "no-store" });
      return json(JSON.parse(saved), 200, { "Cache-Control": "no-store" });
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
      if (!configured.telegram) {
        return json({ error: "Telegram is not configured" }, 503);
      }

      try {
        const delivery = await sendTestNotifications(env);
        return json({
          message: delivery.sent ? "Telegram test notification sent" : "Telegram test notification failed",
          delivery: { telegram: delivery },
          build: BUILD_ID
        }, delivery.sent ? 200 : 502, { "Cache-Control": "no-store" });
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
  if (!env.KV) {
    console.error("Gold Desk scheduled scan cannot start: GOLD_DESK_SIGNALS KV binding is missing.");
    return;
  }

  try {
    let values;
    const cachedHistory = await env.KV.get("signal-history-v1");
    if (cachedHistory) {
      values = JSON.parse(cachedHistory).values;
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
      // KV is shared across Worker locations, unlike the local Cache API.
      await env.KV.put("signal-history-v1", JSON.stringify({
        values,
        fetchedAt: new Date().toISOString()
      }), { expirationTtl: 60 });
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
      const dedupeKey = `signal-sent:${analysis.signalId}`;
      const alreadySent = await env.KV.get(dedupeKey);
      if (!alreadySent && getNotificationStatus(env).telegram) {
        const delivery = await sendTradeNotifications(env, analysis);
        result.notifications.telegram = delivery.telegram.sent ? "sent" : "failed";
        if (delivery.telegram.sent) {
          await env.KV.put(dedupeKey, "sent", { expirationTtl: 86400 });
        }
      } else if (alreadySent) {
        result.notifications.telegram = "duplicate_suppressed";
      } else {
        result.notifications.telegram = "not_configured";
      }
    }

    await env.KV.put("signals-latest", JSON.stringify(result), { expirationTtl: 86400 });
    console.log("Gold Desk scheduled scan completed", {
      status: result.status,
      scannedAt: result.scannedAt,
      signalId: result.signalId || null
    });
  } catch (error) {
    const failure = {
      status: "ERROR",
      reason: "Scheduled scan failed; no signal was generated.",
      detail: error instanceof Error ? error.message : "Unknown scanner error",
      scannedAt: new Date().toISOString(),
      executionMode: "ALERTS_ONLY_NO_ORDERS",
      build: BUILD_ID
    };
    await env.KV.put("signals-latest", JSON.stringify(failure), { expirationTtl: 86400 });
    console.error("Gold Desk scheduled scan failed", error);
  }
}
