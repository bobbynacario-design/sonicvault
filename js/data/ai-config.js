// The AI worker's settings (address, access token, model) follow the
// owner's sign-in: they live in the vault's private settings document as
// `aiWorker`, which only the owner's Google account can read, so every
// browser they sign into is connected. Each browser keeps its own copy too
// (sv_ai_config) for offline and signed-out use.
// Pure: plain objects in, a decision or a copy out.

// What to do with this browser's copy and the vault's: 'adopt' the vault's,
// 'push' this browser's, or 'none'. The newer change wins. A browser whose
// copy predates syncing (no updatedAt) seeds an empty vault, and otherwise
// gives way. An empty copy -- nothing set -- never seeds the vault.
function resolveAIWorkerSync(local, cloud) {
  var localAt = Number(local && local.updatedAt) || 0;
  var hasLocal = !!(local && (local.endpoint || local.token));
  if (!cloud || typeof cloud !== 'object') return hasLocal ? 'push' : 'none';
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
