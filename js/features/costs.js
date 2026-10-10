// AI usage and cost, on Insights: where the AI spend goes, like Daybook's
// tracker. The worker keeps a ledger of what every paid call used (POST
// /costs, with the token); js/data/costs.js prices it from one rate table.
// One line per feature and model, a total, what was billed today, this week
// and this month, Workers AI against its free daily allowance, and today's
// spend cap.

var COSTS_FRESH_MS = 2 * 60 * 1000;
var _costs = { data:null, at:0, loading:false, error:'' };
var COST_FEATURES = {
  'describe':'Describing songs',
  'lyrics':'Write with Claude (Create)',
  'song-lab':'Song lab',
  'ask':'Ask your vault',
  'translate':'Translate and explain',
  'story':'Story behind a song',
  'transcribe':'Lyric timing and transcribing',
  'cover':'Covers',
  'embed':'Search by meaning',
  'lyria':'Songs made with Lyria'
};

async function loadCosts() {
  if (_costs.loading || !_aiConfig || !_aiConfig.endpoint) return;
  _costs.loading = true;
  _costs.error = '';
  renderCosts();
  try {
    var response = await workerRequest('/costs', {});
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.error || ('The worker answered ' + response.status + '.'));
    _costs.data = data;
    _costs.at = Date.now();
  } catch (e) {
    _costs.error = (e && e.message) || 'Couldn’t load the costs.';
  } finally {
    _costs.loading = false;
    renderCosts();
  }
}

function costInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

// What a Workers AI or Lyria line used, in its own unit.
function costUnits(line) {
  if (/whisper/.test(line.model)) return (Math.round(line.units / 6) / 10) + ' min of audio';
  if (/flux/.test(line.model)) return costInt(line.units) + (line.units === 1 ? ' image' : ' images');
  if (/bge/.test(line.model)) return costInt(line.units) + ' tokens';
  if (/^lyria/.test(line.model)) return costInt(line.units || line.calls) + (line.units === 1 ? ' song' : ' songs');
  return '—';
}

function costLineHTML(line) {
  var tokens = !line.workersAI && !/^lyria/.test(line.model);
  // On a phone the model moves under the feature, and the token columns go.
  return '<tr>'
    + '<td>' + esc(COST_FEATURES[line.feature] || line.feature) + '<div class="cost-model-sub">' + esc(line.model) + '</div></td>'
    + '<td class="cost-model cost-wide">' + esc(line.model) + '</td>'
    + '<td class="num">' + costInt(line.calls) + '</td>'
    + '<td class="num cost-wide">' + (tokens
        ? costInt(line.input) + (line.cached ? ' <span class="cost-note">(' + costInt(line.cached) + ' cached)</span>' : '')
        : esc(costUnits(line))) + '</td>'
    + '<td class="num cost-wide">' + (tokens ? costInt(line.output) : '—') + '</td>'
    + '<td class="num">' + (line.cost == null ? '<span class="cost-note">unpriced</span>' : fmtUsd(line.cost)) + '</td>'
    + '</tr>';
}

function renderCosts() {
  var el = document.getElementById('costs-card');
  if (!el) return;
  if (!_aiConfig || !_aiConfig.endpoint || _coverDemoActive) { el.innerHTML = ''; return; }
  if (!_costs.loading && !_costs.error && (!_costs.data || Date.now() - _costs.at > COSTS_FRESH_MS)) {
    loadCosts();
    return;
  }
  var body;
  var data = _costs.data;
  if (_costs.error && !data) {
    body = '<p class="listen-note">' + esc(_costs.error) + ' <button type="button" class="lyric-undo" onclick="loadCosts()">Try again</button></p>';
  } else if (!data) {
    body = '<p class="listen-note">Adding it up…</p>';
  } else if (!data.rows || !data.rows.length) {
    body = '<p class="listen-note">Nothing recorded yet. Every AI call the worker makes from now on is counted here.</p>';
  } else {
    var s = summarizeCosts(data.rows, data.today);
    var budget = data.budget || {};
    body = '<div class="cost-periods">'
      + [['Today', s.today], ['Last 7 days', s.week], ['This month', s.month], ['Since ' + askDate(s.since), s.all]].map(function(p) {
        return '<div class="stat-tile"><div class="stat-value">' + esc(fmtUsd(p[1])) + '</div><div class="stat-label">' + esc(p[0]) + '</div></div>';
      }).join('')
      + '</div>'
      + '<div class="cost-table-wrap"><table class="cost-table"><thead><tr><th>Feature</th><th class="cost-wide">Model</th><th class="num">Calls</th><th class="num cost-wide">Input</th><th class="num cost-wide">Output</th><th class="num">Est. cost</th></tr></thead><tbody>'
      + s.lines.map(costLineHTML).join('')
      + '<tr class="cost-total"><td>Total</td><td class="cost-wide"></td><td class="num">' + costInt(s.calls) + '</td><td class="num cost-wide">' + costInt(s.input) + '</td><td class="num cost-wide">' + costInt(s.output) + '</td>'
      + '<td class="num">' + fmtUsd(s.listCost) + (s.unpriced ? '+' : '') + '</td></tr>'
      + '</tbody></table></div>'
      + (s.workersAIList
        ? '<p class="cost-line">Workers AI (lyric timing, covers, search by meaning) comes to ' + esc(fmtUsd(s.workersAIList)) + ' at list price, but the first ' + costInt(WORKERS_AI_FREE_NEURONS) + ' neurons each day are free, so ' + esc(fmtUsd(s.workersAIBilled)) + ' of it was billed. Today: ' + costInt(s.neuronsToday) + ' of ' + costInt(WORKERS_AI_FREE_NEURONS) + ' free neurons.</p>'
        : '')
      + (budget.claude
        ? '<p class="cost-line">Today’s spend cap: Claude ' + costInt(budget.claude.used) + ' of ' + costInt(budget.claude.limit) + ' (a Haiku call counts 1, any larger model 10)'
          + (budget.lyria ? ' · Lyria ' + costInt(budget.lyria.used) + ' of ' + costInt(budget.lyria.limit) + ' songs' : '') + '.</p>'
        : '')
      + '<p class="cost-line cost-note">Rates as of ' + esc(AI_RATES_AS_OF) + ': Haiku 5.5 $0.10 / $0.50 per million tokens in / out (prompts over 100K tokens $0.50 / $2.50), Sonnet 5.5 $2 / $10, cache reads a tenth of input and cache writes 1.25 times; Lyria 3.5 8¢ a song; Workers AI 1.1¢ per 1,000 neurons past 10,000 free a day. Days run on UTC, turning over at 8am Philippine time. Raw API cost, no markup.'
      + (s.unpriced ? ' A model with no rate in the table is shown unpriced, never guessed.' : '') + '</p>';
  }
  el.innerHTML = '<div class="section-card"><div class="section-inner">'
    + '<div class="section-head"><div><div class="section-title">AI usage &amp; cost</div>'
    + '<div class="section-sub">Where the AI spend goes. The worker records the tokens and units every call uses; the cost is worked out here from each provider’s published rates.</div></div>'
    + '<div class="section-action-row"><button class="sec-action" onclick="loadCosts()"' + (_costs.loading ? ' disabled' : '') + '>Refresh</button></div></div>'
    + body
    + '<details class="cost-notes"><summary>Which feature uses which model</summary>'
    + '<p>Describing songs, Ask your vault and Write with Claude use Claude Haiku 5.5. Song lab, translations and the story behind a song use Claude Sonnet 5.5, which writes better. Lyric timing, the sung check and Tidy up’s transcribing use Whisper; covers use FLUX; search by meaning, radio and Ask use the BGE-M3 embeddings. Those three run on Cloudflare Workers AI. Songs made on the Create page use Google’s Lyria. Counting began when this tracker was deployed; earlier spend is in the Anthropic and Google consoles.</p>'
    + '</details>'
    + '</div></div>';
}
