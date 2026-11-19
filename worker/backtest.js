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
  const hour = new Date(iso).getUTCHours();
  if (hour >= 0 && hour < 7) return "Asia";
  if (hour >= 7 && hour < 13) return "London";
  if (hour >= 13 && hour < 17) return "New York";
  return "Late US";
}

export function runBacktest(input) {
  const candles = validCandles(input);
  const trades = [];
  const seen = new Set();
  for (let i=3599;i<candles.length-1;i+=5) {
    const t = Date.parse(candles[i].datetime.replace(" ","T")+"Z");
    const analysis = analyseXauusd(candles.slice(Math.max(0, i - 3599), i+1), t + MINUTE + 5000);
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
    assumptions:{entry:"Signal candle close; evaluate exits from the next one-minute candle",stopTarget:"Fixed 1R stop / 2R target from strategy",sameCandle:"If stop and target both touch in one candle, count as stop first",costs:"Spread, commission, slippage and swap NOT included",data:"User-supplied OHLC; confirm timezone and broker feed"},
    summary:{signals:trades.length,closed:closed.length,open:trades.length-closed.length,wins:wins.length,losses:losses.length,winRate:closed.length?Number((100*wins.length/closed.length).toFixed(1)):null,totalR:Number(totalR.toFixed(2)),expectancyR:closed.length?Number((totalR/closed.length).toFixed(3)):null,profitFactor:losses.length?Number((wins.length*2/losses.length).toFixed(2)):null,maxDrawdownR:Number(maxDrawdown.toFixed(2))},
    sessions:grouped,trades:trades.slice(-250)
  };
}


const FIVE_MINUTES = 300_000;

function parseFiveMinuteCandles(input) {
  if (!Array.isArray(input) || input.length < 720 || input.length > 120000) {
    throw new Error("Historical dataset must contain between 720 and 60,000 five-minute candles.");
  }
  const parsed = input.map(c => {
    const raw = String(c.datetime || "");
    const time = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
    const open=Number(c.open), high=Number(c.high), low=Number(c.low), close=Number(c.close);
    if (![time,open,high,low,close].every(Number.isFinite) || high < Math.max(open,close) || low > Math.min(open,close) || high < low) return null;
    return { time, open, high, low, close };
  }).filter(Boolean).sort((a,b)=>a.time-b.time);
  const unique=[];
  for (const c of parsed) if (!unique.length || unique[unique.length-1].time!==c.time) unique.push(c);
  if (unique.length < 720) throw new Error("Not enough valid five-minute candles after validation.");
  return unique;
}

function aggregateFiveMinute(candles, factor) {
  const span=FIVE_MINUTES*factor, groups=new Map();
  for (const c of candles) {
    const start=Math.floor(c.time/span)*span;
    if (!groups.has(start)) groups.set(start,[]);
    groups.get(start).push(c);
  }
  const result=[];
  for (const [time,g] of groups) {
    g.sort((a,b)=>a.time-b.time);
    if (g.length!==factor) continue;
    let contiguous=true;
    for(let i=0;i<factor;i++) if(g[i].time!==time+i*FIVE_MINUTES) contiguous=false;
    if(!contiguous) continue;
    result.push({time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[g.length-1].close});
  }
  result.sort((a,b)=>a.time-b.time);
  return result;
}

function emaSeries(values, period) {
  const out=new Array(values.length).fill(null);
  if(values.length<period) return out;
  const k=2/(period+1);
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1]=v;
  for(let i=period;i<values.length;i++){v=values[i]*k+v*(1-k);out[i]=v;}
  return out;
}

function atrSeries(candles, period=14) {
  const out=new Array(candles.length).fill(null), tr=[];
  for(let i=0;i<candles.length;i++){
    if(i===0){tr.push(candles[i].high-candles[i].low);}
    else {const c=candles[i],p=candles[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
    if(i>=period) out[i]=tr.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period;
  }
  return out;
}

function rsiSeries(candles, period=14) {
  const out=new Array(candles.length).fill(null);
  for(let i=period;i<candles.length;i++){
    let gains=0,losses=0;
    for(let j=i-period+1;j<=i;j++){
      const change=candles[j].close-candles[j-1].close;
      if(change>0) gains+=change; else losses-=change;
    }
    out[i]=losses===0?100:100-(100/(1+(gains/period)/(losses/period)));
  }
  return out;
}

function utcSession(iso) {
  const h=new Date(iso).getUTCHours();
  if(h<7)return "Asia";
  if(h<13)return "London";
  if(h<17)return "New York";
  return "Late US";
}


function executionMetrics(trades, options) {
  const {spread,slippagePerSide,commissionPerLotRoundTurn,contractSize=100,from=null,to=null}=options;
  const candidates=trades.filter(t=>t.r!==null&&t.exitTime&&(!from||t.signalTime>=from)&&(!to||t.exitTime<=to))
    .sort((a,b)=>a.signalTime.localeCompare(b.signalTime));
  const chosen=[];let availableAt=-Infinity;
  for(const t of candidates){
    const signalMs=Date.parse(t.signalTime);
    if(signalMs<availableAt)continue;
    const risk=Math.abs(t.entry-t.stopLoss);
    if(!(risk>0))continue;
    const roundTripCost=spread+2*slippagePerSide+commissionPerLotRoundTurn/contractSize;
    const costR=roundTripCost/risk;
    chosen.push({...t,grossR:t.r,netR:t.r-costR,costR});
    // Exit timestamp is the opening time of the exit M5 bar; lock until its close.
    availableAt=Date.parse(t.exitTime)+FIVE_MINUTES;
  }
  let equity=0,peak=0,maxDrawdown=0;
  for(const t of chosen){equity+=t.netR;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
  const wins=chosen.filter(t=>t.netR>0),losses=chosen.filter(t=>t.netR<0);
  const grossProfit=wins.reduce((s,t)=>s+t.netR,0),grossLoss=-losses.reduce((s,t)=>s+t.netR,0);
  return {
    trades:chosen.length,skippedOverlapping:candidates.length-chosen.length,
    wins:wins.length,losses:losses.length,
    winRate:chosen.length?Number((100*wins.length/chosen.length).toFixed(1)):null,
    grossR:Number(chosen.reduce((s,t)=>s+t.grossR,0).toFixed(2)),
    totalCostsR:Number(chosen.reduce((s,t)=>s+t.costR,0).toFixed(2)),
    netR:Number(chosen.reduce((s,t)=>s+t.netR,0).toFixed(2)),
    expectancyR:chosen.length?Number((chosen.reduce((s,t)=>s+t.netR,0)/chosen.length).toFixed(3)):null,
    profitFactor:grossLoss?Number((grossProfit/grossLoss).toFixed(2)):null,
    maxDrawdownR:Number(maxDrawdown.toFixed(2))
  };
}

function buildExecutionResearch(trades, candles) {
  const filters=[
    ["Baseline",t=>true],
    ["New York only",t=>t.session==="New York"],
    ["SELL only",t=>t.direction==="SELL"],
    ["New York SELL only",t=>t.session==="New York"&&t.direction==="SELL"]
  ];
  const spreads=[0.30,0.51,0.75,1.00];
  const slippagePerSide=0.10,commissionPerLotRoundTurn=0,contractSize=100;
  const start=candles[0].time,end=candles[candles.length-1].time+FIVE_MINUTES;
  const split=start+Math.floor((end-start)*0.7);
  const dateIso=ms=>new Date(ms).toISOString();
  return {
    model:"Single position at a time; signals arriving before the prior position closes are skipped. Costs are deducted from each trade's R result.",
    assumptions:{observedSpread:0.51,spreadScenarios:spreads,slippagePerSide,commissionPerLotRoundTurn,contractSize,commissionNote:"Commission defaults to zero because the user's broker commission schedule has not been confirmed. Contract size assumes 100 troy ounces per standard lot.",priceNote:"Twelve Data spot OHLC is used as a mid-price proxy; actual Kudo bid/ask execution and spread variation are not reconstructed. Cost deduction is an approximation, not tick-level execution."},
    splitAt:dateIso(split),
    scenarios:spreads.map(spread=>({
      spread,
      filters:filters.map(([name,fn])=>({
        name,
        full:executionMetrics(trades.filter(fn),{spread,slippagePerSide,commissionPerLotRoundTurn,contractSize}),
        train:executionMetrics(trades.filter(fn),{spread,slippagePerSide,commissionPerLotRoundTurn,contractSize,from:dateIso(start),to:dateIso(split)}),
        outOfSample:executionMetrics(trades.filter(fn),{spread,slippagePerSide,commissionPerLotRoundTurn,contractSize,from:dateIso(split),to:dateIso(end)})
      }))
    }))
  };
}

export function runBacktestM5(input) {
  const candles=parseFiveMinuteCandles(input);
  const m15=aggregateFiveMinute(candles,3), h1=aggregateFiveMinute(candles,12);
  const m15Index=new Map(m15.map((c,i)=>[c.time,i]));
  const h1Index=new Map(h1.map((c,i)=>[c.time,i]));
  const m15Fast=emaSeries(m15.map(c=>c.close),20), m15Slow=emaSeries(m15.map(c=>c.close),50), m15Atr=atrSeries(m15);
  const h1Fast=emaSeries(h1.map(c=>c.close),20), h1Slow=emaSeries(h1.map(c=>c.close),50);
  const m5Atr=atrSeries(candles), m5Rsi=rsiSeries(candles);
  const trades=[], seen=new Set();
  for(let i=719;i<candles.length-1;i++){
    const c=candles[i], closeTime=c.time+FIVE_MINUTES;
    const m15Start=Math.floor((closeTime-15*60_000)/(15*60_000))*(15*60_000);
    const h1Start=Math.floor((closeTime-60*60_000)/(60*60_000))*(60*60_000);
    const mi=m15Index.get(m15Start), hi=h1Index.get(h1Start);
    if(mi===undefined||hi===undefined||mi<50||hi<50||m15Atr[mi]===null||m5Atr[i]===null||m5Rsi[i]===null)continue;
    const h1Last=h1[hi],m15Last=m15[mi],m15Prev=m15[mi-1];
    const bullishH1=h1Fast[hi]>h1Slow[hi]&&h1Last.close>h1Fast[hi];
    const bearishH1=h1Fast[hi]<h1Slow[hi]&&h1Last.close<h1Fast[hi];
    const bullishM15=m15Fast[mi]>m15Slow[mi]&&m15Last.close>m15Fast[mi];
    const bearishM15=m15Fast[mi]<m15Slow[mi]&&m15Last.close<m15Fast[mi];
    const longPullback=m15Prev.low<=m15Fast[mi]+0.35*m15Atr[mi]&&m15Last.close>m15Fast[mi];
    const shortPullback=m15Prev.high>=m15Fast[mi]-0.35*m15Atr[mi]&&m15Last.close<m15Fast[mi];
    const prior=candles.slice(i-3,i);
    const priorHigh=Math.max(...prior.map(x=>x.high)),priorLow=Math.min(...prior.map(x=>x.low));
    const longTrigger=c.close>priorHigh&&m5Rsi[i]>=52&&m5Rsi[i]<=70;
    const shortTrigger=c.close<priorLow&&m5Rsi[i]>=30&&m5Rsi[i]<=48;
    let direction=null;
    if(bullishH1&&bullishM15&&longPullback&&longTrigger)direction="BUY";
    if(bearishH1&&bearishM15&&shortPullback&&shortTrigger)direction="SELL";
    if(!direction)continue;
    const signalTime=new Date(closeTime).toISOString(),id=direction+"-"+c.time;
    if(seen.has(id))continue;seen.add(id);
    const entry=c.close,risk=Math.max(1.5*m5Atr[i],0.01);
    const stop=direction==="BUY"?entry-risk:entry+risk,target=direction==="BUY"?entry+2*risk:entry-2*risk;
    let outcome="OPEN",exitPrice=null,exitTime=null,r=null;
    for(let j=i+1;j<candles.length;j++){
      const bar=candles[j],stopHit=direction==="BUY"?bar.low<=stop:bar.high>=stop,targetHit=direction==="BUY"?bar.high>=target:bar.low<=target;
      if(stopHit){outcome="LOSS";exitPrice=stop;exitTime=new Date(bar.time).toISOString();r=-1;break;}
      if(targetHit){outcome="WIN";exitPrice=target;exitTime=new Date(bar.time).toISOString();r=2;break;}
    }
    trades.push({id,direction,entry:Number(entry.toFixed(2)),stopLoss:Number(stop.toFixed(2)),takeProfit:Number(target.toFixed(2)),signalTime,session:utcSession(signalTime),outcome,exitPrice,exitTime,r});
  }
  const closed=trades.filter(t=>t.r!==null),wins=closed.filter(t=>t.r>0),losses=closed.filter(t=>t.r<0);
  const totalR=closed.reduce((s,t)=>s+t.r,0),grossWin=wins.reduce((s,t)=>s+t.r,0),grossLoss=-losses.reduce((s,t)=>s+t.r,0);
  let equity=0,peak=0,maxDrawdown=0;
  for(const t of closed){equity+=t.r;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
  const sessions={};
  for(const name of ["Asia","London","New York","Late US"]){
    const a=closed.filter(t=>t.session===name),w=a.filter(t=>t.r>0);
    sessions[name]={trades:a.length,wins:w.length,winRate:a.length?Number((100*w.length/a.length).toFixed(1)):null,totalR:Number(a.reduce((s,t)=>s+t.r,0).toFixed(2))};
  }

  const metricSet = list => {
    const a=list.filter(t=>t.r!==null).sort((x,y)=>x.signalTime.localeCompare(y.signalTime));
    const w=a.filter(t=>t.r>0),l=a.filter(t=>t.r<0),sum=a.reduce((s,t)=>s+t.r,0);
    const gw=w.reduce((s,t)=>s+t.r,0),gl=-l.reduce((s,t)=>s+t.r,0);
    let eq=0,peak=0,dd=0;
    for(const t of a){eq+=t.r;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
    return {trades:a.length,wins:w.length,losses:l.length,winRate:a.length?Number((100*w.length/a.length).toFixed(1)):null,totalR:Number(sum.toFixed(2)),expectancyR:a.length?Number((sum/a.length).toFixed(3)):null,profitFactor:gl?Number((gw/gl).toFixed(2)):null,maxDrawdownR:Number(dd.toFixed(2))};
  };
  const directionBreakdown={
    BUY:metricSet(trades.filter(t=>t.direction==="BUY")),
    SELL:metricSet(trades.filter(t=>t.direction==="SELL"))
  };
  const variants={
    baseline:metricSet(trades),
    newYorkOnly:metricSet(trades.filter(t=>t.session==="New York")),
    londonOnly:metricSet(trades.filter(t=>t.session==="London")),
    asiaOnly:metricSet(trades.filter(t=>t.session==="Asia")),
    lateUsOnly:metricSet(trades.filter(t=>t.session==="Late US")),
    buyOnly:metricSet(trades.filter(t=>t.direction==="BUY")),
    sellOnly:metricSet(trades.filter(t=>t.direction==="SELL"))
  };
  const ordered=trades.filter(t=>t.r!==null).sort((a,b)=>a.signalTime.localeCompare(b.signalTime));
  const split=Math.floor(ordered.length*0.7);
  const chronological={
    first70Percent:metricSet(ordered.slice(0,split)),
    last30Percent:metricSet(ordered.slice(split)),
    splitAt:ordered[split]?.signalTime||null,
    note:"Chronological diagnostic only, not a clean out-of-sample test: trade outcomes can extend beyond the signal-time split and the variants are filtered subsets of the same baseline trades."
  };
  return {
    strategy:"GD-MTF-1.0",symbol:"XAU/USD",interval:"5min",bars:candles.length,
    period:{from:new Date(candles[0].time).toISOString(),to:new Date(candles[candles.length-1].time+FIVE_MINUTES).toISOString()},
    assumptions:{signal:"Same GD-MTF-1.0 H1/M15/M5 conditions; M15 and H1 built from complete M5 bars",entry:"Signal M5 close; exits begin on next M5 candle",stopTarget:"ATR M5 stop at 1.5x ATR; target at 2R",sameCandle:"If stop and target both touch in one M5 candle, count as stop first",costs:"Spread, commission, slippage and swap NOT included; gross results only",sessions:"UTC hour buckets; not daylight-saving-adjusted London/New York exchange sessions",positionModel:"Each signal is scored independently; overlapping signals are allowed and this is not a single-position portfolio simulation"},
    summary:{signals:trades.length,closed:closed.length,open:trades.length-closed.length,wins:wins.length,losses:losses.length,winRate:closed.length?Number((100*wins.length/closed.length).toFixed(1)):null,totalR:Number(totalR.toFixed(2)),expectancyR:closed.length?Number((totalR/closed.length).toFixed(3)):null,profitFactor:grossLoss?Number((grossWin/grossLoss).toFixed(2)):null,maxDrawdownR:Number(maxDrawdown.toFixed(2))},
    sessions,directionBreakdown,variants,chronological,executionResearch:buildExecutionResearch(trades,candles),trades:trades.slice(-500)
  };
}
