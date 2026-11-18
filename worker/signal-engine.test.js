import test from "node:test";
import assert from "node:assert/strict";
import { analyseXauusd } from "./signal-engine.js";

test("rejects insufficient history", () => {
  const result = analyseXauusd([]);
  assert.equal(result.status, "WAIT");
});

test("rejects stale market data", () => {
  const now = Date.UTC(2026, 10, 18, 22, 0, 0);
  const values = [];
  for (let i = 0; i < 4000; i++) {
    const time = new Date(now - (4001 - i) * 60_000).toISOString().slice(0, 19).replace("T", " ");
    values.push({ datetime: time, open: "2700", high: "2701", low: "2699", close: "2700" });
  }
  const result = analyseXauusd(values, now);
  assert.equal(result.status, "WAIT");
  assert.match(result.reason, /stale/i);
});

test("flat candles do not produce a directional candidate", () => {
  const now = Date.UTC(2026, 10, 18, 22, 0, 0);
  const values = [];
  for (let i = 0; i < 4000; i++) {
    const time = new Date(now - (4001 - i) * 60_000).toISOString().slice(0, 19).replace("T", " ");
    values.push({ datetime: time, open: "2700", high: "2701", low: "2699", close: "2700" });
  }
  const result = analyseXauusd(values, now + 120_000);
  assert.notEqual(result.status, "CANDIDATE");
});
