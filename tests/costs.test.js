"use strict";
// AI usage and cost: pricing the worker's ledger from the one rate table.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./helpers/data-scripts.js").loadDataScripts();

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, (label || "") + " " + actual + " != " + expected);

test("Claude is priced per million tokens, with cache reads and writes at their own rates", () => {
  // Haiku 5.5: 10,000 in, 2,000 out, 50,000 read from the cache, 8,000 written to it.
  near(g.priceRow({ model: "claude-haiku-5-5", input_tokens: 10000, output_tokens: 2000, cache_read_tokens: 50000, cache_write_tokens: 8000 }),
    (10000 * 0.10 + 2000 * 0.50 + 50000 * 0.01 + 8000 * 0.125) / 1e6);
  near(g.priceRow({ model: "claude-sonnet-5-5", input_tokens: 3000, output_tokens: 2500 }), (3000 * 2 + 2500 * 10) / 1e6, "a Song lab draft");
  near(g.priceRow({ model: "claude-haiku-5-5/over-100k", input_tokens: 120000, output_tokens: 1000 }), (120000 * 0.5 + 1000 * 2.5) / 1e6, "the dearer card");
  assert.equal(g.priceRow({ model: "claude-mystery-9", input_tokens: 5 }), null, "no rate: unpriced, never guessed");
});

test("Lyria is per song; Workers AI by the neurons it reports, else by its units", () => {
  near(g.priceRow({ model: "lyria-3.5", calls: 2, units: 2 }), 0.16);
  near(g.priceRow({ model: "lyria-3-clip-preview", calls: 1, units: 0 }), 0.04, "falls back to calls");
  near(g.priceRow({ model: "@cf/black-forest-labs/flux-1-schnell", units: 1, neurons: 249.6 }), 249.6 * 0.011 / 1000);
  near(g.rowNeurons({ model: "@cf/openai/whisper-large-v3-turbo", units: 180 }), 46.63 * 3, "three minutes of audio, not reported");
  near(g.rowNeurons({ model: "@cf/baai/bge-m3", units: 1e6 }), 1075);
  near(g.rowNeurons({ model: "@cf/black-forest-labs/flux-1-schnell", units: 2 }), 499.2, "measured per image");
});

test("Workers AI is billed only past each day's 10,000 free neurons", () => {
  const flux = (day, neurons) => ({ day, model: "@cf/black-forest-labs/flux-1-schnell", calls: 1, units: 1, neurons });
  near(g.billedCost([flux("2026-10-09", 9000), flux("2026-10-10", 4000)]), 0, "under the allowance each day");
  near(g.billedCost([flux("2026-10-10", 9000), flux("2026-10-10", 4000)]), 3000 * 0.011 / 1000, "3,000 over on one day");
  near(g.billedCost([flux("2026-10-10", 100), { day: "2026-10-10", model: "lyria-3.5", calls: 1, units: 1 }]), 0.08, "other models at list price");
});

test("the report: lines by feature and model, dearest first, totals and periods", () => {
  const rows = [
    { day: "2026-09-30", feature: "describe", model: "claude-haiku-5-5", calls: 10, input_tokens: 20000, output_tokens: 6000, cache_read_tokens: 0, cache_write_tokens: 0, units: 0, neurons: 0 },
    { day: "2026-10-04", feature: "song-lab", model: "claude-sonnet-5-5", calls: 2, input_tokens: 6000, output_tokens: 5000, cache_read_tokens: 0, cache_write_tokens: 0, units: 0, neurons: 0 },
    { day: "2026-10-10", feature: "ask", model: "claude-haiku-5-5", calls: 3, input_tokens: 1000, output_tokens: 900, cache_read_tokens: 40000, cache_write_tokens: 20000, units: 0, neurons: 0 },
    { day: "2026-10-10", feature: "cover", model: "@cf/black-forest-labs/flux-1-schnell", calls: 1, units: 1, neurons: 249.6 },
    { day: "2026-10-10", feature: "odd", model: "some-new-model", calls: 1, input_tokens: 5 }
  ];
  const s = g.summarizeCosts(rows, "2026-10-10");
  assert.deepEqual(s.lines.map((l) => l.feature), ["song-lab", "describe", "ask", "cover", "odd"], "dearest first: describing $0.0050 beats ask $0.0035");
  const ask = s.lines.find((l) => l.feature === "ask");
  assert.equal(ask.input, 61000, "input counts cache reads and writes too");
  assert.equal(ask.cached, 40000);
  assert.equal(s.lines.find((l) => l.feature === "odd").cost, null);
  assert.equal(s.unpriced, true);
  assert.equal(s.calls, 17);
  assert.equal(s.since, "2026-09-30");
  const songLab = (6000 * 2 + 5000 * 10) / 1e6;
  const askCost = (1000 * 0.1 + 900 * 0.5 + 40000 * 0.01 + 20000 * 0.125) / 1e6;
  const describe = (20000 * 0.1 + 6000 * 0.5) / 1e6;
  near(s.today, askCost, "today: the cover was within the free allowance");
  near(s.week, songLab + askCost, "the last 7 days");
  near(s.month, songLab + askCost, "October");
  near(s.all, songLab + askCost + describe);
  near(s.workersAIList, 249.6 * 0.011 / 1000);
  near(s.workersAIBilled, 0);
  near(s.neuronsToday, 249.6);
  assert.deepEqual(g.summarizeCosts([], "2026-10-10").lines, []);
});

test("dollars as Daybook shows them", () => {
  assert.equal(g.fmtUsd(null), "—");
  assert.equal(g.fmtUsd(0), "$0");
  assert.equal(g.fmtUsd(0.01234), "$0.0123");
  assert.equal(g.fmtUsd(3.456), "$3.46");
  assert.equal(g.dayBefore("2026-10-01", 6), "2026-09-25");
});
