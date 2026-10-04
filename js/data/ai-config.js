// The AI worker's settings (address, access token, model) follow the
// owner's sign-in: they live in the vault's private settings document as
// `aiWorker`, which only the owner's Google account can read, so every
// browser they sign into is connected. Each browser keeps its own copy too
// (sv_ai_config) for offline and signed-out use.
// Pure: plain objects in, a decision or a copy out.

// Settings that can reach a worker: an address, at least. Half-typed ones
// (a token pasted before its address, a field cleared to retype it) stay in
// the browser they were typed in: spread to the vault, they disconnected
// every other browser.
function isUsableAIWorker(config) {
  return !!(config && String(config.endpoint || '').trim());
}

// What to do with this browser's copy and the vault's: 'adopt' the vault's,
// 'push' this browser's, or 'none'. Only usable settings ever move. Between
// two usable copies the newer change wins; a browser whose copy predates
// syncing (no updatedAt) seeds a vault that has none, and otherwise gives
// way.
function resolveAIWorkerSync(local, cloud) {
  var localOK = isUsableAIWorker(local);
  var cloudOK = !!cloud && typeof cloud === 'object' && isUsableAIWorker(cloud);
  if (!cloudOK) return localOK ? 'push' : 'none';
  if (!localOK) return 'adopt';
  var localAt = Number(local.updatedAt) || 0;
  var cloudAt = Number(cloud.updatedAt) || 0;
  if (cloudAt > localAt) return 'adopt';
  if (localAt > cloudAt) return 'push';
  return 'none';
}

function aiWorkerRecord(config, at) {
  return {
    endpoint: String(config && config.endpoint || '').trim(),
    token: String(config && config.token || '').trim(),
    model: String(config && config.model || '').trim(),
    updatedAt: Number(at) || Date.now()
  };
}

// Settings as they go into a backup file: without the worker's access
// token, which belongs to the vault and the worker, not to a file that may
// be copied anywhere.
function stripVaultSecrets(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  var copy = Object.assign({}, settings);
  delete copy.aiWorker;
  return copy;
}
