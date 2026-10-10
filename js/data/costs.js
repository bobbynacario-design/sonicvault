// AI usage and cost (js/features/costs.js), the way Daybook keeps it: the
// worker's ledger holds what each call used -- tokens, or units and neurons
// (cloudflare-worker/worker.js, recordUsage) -- and prices are applied here,
// once, from this rate table, so every figure can be checked against it. A
// model with no rate here is shown as unpriced, never guessed.
// Pure: ledger rows in, plain values out.

// Claude: USD per million tokens. Anthropic counts input apart from cache
// reads and writes; a 5-minute cache write is 1.25 times input, a read a
// tenth. Haiku 5.5 bills a prompt over 100K tokens on a second card, which
// the worker records as its own model.
// Lyria: USD per song. Workers AI: neurons per unit, for calls that didn't
// report their neurons -- Whisper per second of audio (46.63 a minute),
// embeddings per input token (1,075 a million), and a cover per 1024px,
// 6-step image (249.6, measured 2026-10-10: steps are charged per tile).
var AI_RATES = {
  'claude-haiku-5-5': { input:0.10, output:0.50, cacheRead:0.01, cacheWrite:0.125 },
  'claude-haiku-5-5/over-100k': { input:0.50, output:2.50, cacheRead:0.05, cacheWrite:0.625 },
  'claude-sonnet-5-5': { input:2, output:10, cacheRead:0.20, cacheWrite:2.50 },
  'claude-opus-5-5': { input:4, output:20, cacheRead:0.20, cacheWrite:5 },
  'claude-haiku-4-5': { input:1, output:5, cacheRead:0.10, cacheWrite:1.25 },
  'lyria-3.5': { perUnit:0.08 },
  'lyria-3-pro-preview': { perUnit:0.08 },
  'lyria-3-clip-preview': { perUnit:0.04 },
  '@cf/openai/whisper-large-v3-turbo': { neuronsPerUnit:46.63 / 60 },
  '@cf/black-forest-labs/flux-1-schnell': { neuronsPerUnit:249.6 },
  '@cf/baai/bge-m3': { neuronsPerUnit:1075 / 1e6 }
};
var AI_RATES_AS_OF = 'Claude 6 Oct 2026, Lyria and Workers AI 10 Oct 2026';
// Workers AI: $0.011 per 1,000 neurons, after 10,000 free each UTC day.
var WORKERS_AI_USD_PER_NEURON = 0.011 / 1000;
var WORKERS_AI_FREE_NEURONS = 10000;

function costNumber(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? n : 0;
}

function isWorkersAIModel(model) {
  return /^@cf\//.test(String(model || ''));
}

// The neurons a Workers AI row cost: as reported, else from its units.
function rowNeurons(row) {
  if (costNumber(row.neurons)) return costNumber(row.neurons);
  var rate = AI_RATES[row.model];
  return rate && rate.neuronsPerUnit ? costNumber(row.units) * rate.neuronsPerUnit : 0;
}

// A row's cost at list price, or null for a model with no rate.
function priceRow(row) {
  var rate = AI_RATES[row && row.model];
  if (!rate) return null;
  if (rate.perUnit != null) return (costNumber(row.units) || costNumber(row.calls)) * rate.perUnit;
  if (rate.neuronsPerUnit != null) return rowNeurons(row) * WORKERS_AI_USD_PER_NEURON;
  return (costNumber(row.input_tokens) * rate.input + costNumber(row.cache_read_tokens) * rate.cacheRead
    + costNumber(row.cache_write_tokens) * rate.cacheWrite + costNumber(row.output_tokens) * rate.output) / 1e6;
}

// What was billed: everything at list price, except Workers AI, which is
// billed only for neurons past each day's free 10,000.
function billedCost(rows) {
  var cost = 0;
  var neuronsByDay = {};
  (rows || []).forEach(function(row) {
    if (isWorkersAIModel(row.model)) {
      neuronsByDay[row.day] = (neuronsByDay[row.day] || 0) + rowNeurons(row);
    } else {
      cost += priceRow(row) || 0;
    }
  });
  Object.keys(neuronsByDay).forEach(function(day) {
    cost += Math.max(0, neuronsByDay[day] - WORKERS_AI_FREE_NEURONS) * WORKERS_AI_USD_PER_NEURON;
  });
  return cost;
}

// The UTC day `days` before `today` ('YYYY-MM-DD').
function dayBefore(today, days) {
  var d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// The report: one line per feature and model, most expensive first (the
// unpriced last), with totals, and what was billed today, over the last 7
// days, this month and since the ledger began.
function summarizeCosts(rows, today) {
  var all = rows || [];
  var lines = {};
  all.forEach(function(row) {
    var key = row.feature + '|' + row.model;
    var line = lines[key] || (lines[key] = { feature:row.feature, model:row.model, calls:0, input:0, cached:0, written:0, output:0, units:0, neurons:0, rows:[] });
    line.calls += costNumber(row.calls);
    line.input += costNumber(row.input_tokens) + costNumber(row.cache_read_tokens) + costNumber(row.cache_write_tokens);
    line.cached += costNumber(row.cache_read_tokens);
    line.written += costNumber(row.cache_write_tokens);
    line.output += costNumber(row.output_tokens);
    line.units += costNumber(row.units);
    line.neurons += rowNeurons(row);
    line.rows.push(row);
  });
  var list = Object.keys(lines).map(function(key) {
    var line = lines[key];
    var priced = AI_RATES[line.model] ? line.rows.reduce(function(sum, row) { return sum + priceRow(row); }, 0) : null;
    delete line.rows;
    line.cost = priced;
    line.workersAI = isWorkersAIModel(line.model);
    return line;
  }).sort(function(a, b) {
    return (b.cost == null ? -1 : b.cost) - (a.cost == null ? -1 : a.cost) || a.feature.localeCompare(b.feature);
  });
  var within = function(from) { return all.filter(function(row) { return row.day >= from && row.day <= today; }); };
  var listCost = 0;
  var workersAIList = 0;
  list.forEach(function(line) {
    if (line.cost == null) return;
    listCost += line.cost;
    if (line.workersAI) workersAIList += line.cost;
  });
  var neuronsToday = within(today).filter(function(row) { return isWorkersAIModel(row.model); })
    .reduce(function(sum, row) { return sum + rowNeurons(row); }, 0);
  return {
    lines:list,
    calls:list.reduce(function(sum, line) { return sum + line.calls; }, 0),
    input:list.reduce(function(sum, line) { return sum + line.input; }, 0),
    output:list.reduce(function(sum, line) { return sum + line.output; }, 0),
    listCost:listCost,
    unpriced:list.some(function(line) { return line.cost == null; }),
    workersAIList:workersAIList,
    workersAIBilled:billedCost(all.filter(function(row) { return isWorkersAIModel(row.model); })),
    neuronsToday:neuronsToday,
    since:all.length ? all.reduce(function(first, row) { return !first || row.day < first ? row.day : first; }, '') : '',
    today:billedCost(within(today)),
    week:billedCost(within(dayBefore(today, 6))),
    month:billedCost(within(today.slice(0, 8) + '01')),
    all:billedCost(all)
  };
}

// Dollars the way Daybook shows them: four places under a dollar.
function fmtUsd(value) {
  if (value == null) return '—';
  if (value === 0) return '$0';
  return value < 1 ? '$' + value.toFixed(4) : '$' + value.toFixed(2);
}
