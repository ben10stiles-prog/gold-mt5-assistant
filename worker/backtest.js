import { analyseXauusd } from "./signal-engine.js";

const MINUTE = 60_000;

function validCandles(input) {
  if (!Array.isArray(input) || input.length < 2400 || input.length > 20000) {
    throw new Error("Upload between 2,400 and 20,000 one-minute candles.");
  }
  const parsed = input.map(c => {
    const time = Date.parse(String(c.datetime || "").replace(" ", "T") + (String(c.datetime || "").endsWith("Z") ? "" : "Z"));
    const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close);
    if (![time, open, high, low, close].every(Number.isFinite) || high < low || high < Math.max(open, close) || low > Math.min(open, close)) return null;
    return { datetime: new Date(time).toISOString().slice(0,19).replace("T"," "), open, high, low, close };
  }).filter(Boolean).sort((a,b)=>Date.parse(a.datetime.replace(" ","T")+"Z")-Date.parse(b.datetime.replace(" ","T")+"Z"));
  if (parsed.length < 2400) throw new Error("Not enough valid candles after checking the CSV.");
  for (let i=1;i<parsed.length;i++) {
    const a=Date.parse(parsed[i-1].datetime.replace(" ","T")+"Z"), b=Date.parse(parsed[i].datetime.replace(" ","T")+"Z");
    if (b<=a) throw new Error("Duplicate or unordered candle timestamps detected.");
  }
  return parsed;
}

function sessionOf(iso) {
  const hour = new Date(iso.replace(" ","T")+"Z").getUTCHours();
  if (hour >= 0 && hour < 7) return "Asia";
  if (hour >= 7 && hour < 13) return "London";
  if (hour >= 13 && hour < 17) return "New York";
  return "Late US";
}

export function runBacktest(input) {
  const candles = validCandles(input);
  const trades = [];
  const seen = new Set();
  for (let i=2399;i<candles.length-1;i++) {
    const t = Date.parse(candles[i].datetime.replace(" ","T")+"Z");
    const analysis = analyseXauusd(candles.slice(0,i+1), t + MINUTE + 5000);
    if (analysis.status !== "CANDIDATE" || seen.has(analysis.signalId)) continue;
    seen.add(analysis.signalId);
    let outcome = "OPEN", exitPrice = null, exitTime = null, r = null;
    const risk = Math.abs(analysis.entry - analysis.stopLoss);
    for (let j=i+1;j<candles.length;j++) {
      const c=candles[j], stopHit=analysis.direction==="BUY" ? c.low<=analysis.stopLoss : c.high>=analysis.stopLoss;
      const targetHit=analysis.direction==="BUY" ? c.high>=analysis.takeProfit : c.low<=analysis.takeProfit;
      if (stopHit && targetHit) { outcome="LOSS"; exitPrice=analysis.stopLoss; exitTime=c.datetime; r=-1; break; }
      if (stopHit) { outcome="LOSS"; exitPrice=analysis.stopLoss; exitTime=c.datetime; r=-1; break; }
      if (targetHit) { outcome="WIN"; exitPrice=analysis.takeProfit; exitTime=c.datetime; r=2; break; }
    }
    trades.push({ id:analysis.signalId, direction:analysis.direction, entry:analysis.entry, stopLoss:analysis.stopLoss, takeProfit:analysis.takeProfit, signalTime:analysis.signalTime, session:sessionOf(analysis.signalTime), outcome, exitPrice, exitTime, r });
    // A signal's future outcome is evaluated once; continue scanning later bars without reusing its ID.
  }
  const closed=trades.filter(t=>t.r!==null), wins=closed.filter(t=>t.r>0), losses=closed.filter(t=>t.r<0);
  const totalR=closed.reduce((s,t)=>s+t.r,0);
  let equity=0, peak=0, maxDrawdown=0;
  for (const t of closed) { equity+=t.r; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,peak-equity); }
  const grouped={};
  for (const session of ["Asia","London","New York","Late US"]) {
    const a=closed.filter(t=>t.session===session);
    grouped[session]={trades:a.length,wins:a.filter(t=>t.r>0).length,winRate:a.length?Number((100*a.filter(t=>t.r>0).length/a.length).toFixed(1)):null,totalR:Number(a.reduce((s,t)=>s+t.r,0).toFixed(2))};
  }
  return {
    strategy:"GD-MTF-1.0", symbol:"XAU/USD", bars:candles.length,
    period:{from:candles[0].datetime,to:candles[candles.length-1].datetime},
    assumptions:{entry:"Signal close; next candle onward for exit",stopTarget:"Fixed 1R stop / 2R target from strategy",sameCandle:"If stop and target both touch in one candle, count as stop first",costs:"Spread, commission, slippage and swap NOT included",data:"User-supplied OHLC; confirm timezone and broker feed"},
    summary:{signals:trades.length,closed:closed.length,open:trades.length-closed.length,wins:wins.length,losses:losses.length,winRate:closed.length?Number((100*wins.length/closed.length).toFixed(1)):null,totalR:Number(totalR.toFixed(2)),expectancyR:closed.length?Number((totalR/closed.length).toFixed(3)):null,profitFactor:losses.length?Number((wins.length*2/losses.length).toFixed(2)):null,maxDrawdownR:Number(maxDrawdown.toFixed(2))},
    sessions:grouped,trades:trades.slice(-250)
  };
}
