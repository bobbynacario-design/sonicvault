// A song's saved translations, one per language (js/features/translate.js):
// track.translations = { English: { key, from, same, lines, about, notes,
// at }, Filipino: {...} }. Songs translated before 2026-10-05 carry a single
// track.translation with its lang inside; it counts as one of them until
// the next translation folds it in. key is lyricSyncKey(lyrics): a
// translation of lyrics since edited no longer applies.
// Pure: tracks in, plain objects out.

function translationEntry(source) {
  return {
    key:String(source.key || ''),
    from:String(source.from || ''),
    same:!!source.same,
    lines:(source.lines || []).map(function(line) { return String(line || ''); }),
    about:String(source.about || ''),
    notes:(source.notes || []).map(function(item) { return { line:Number(item && item.line) || 0, note:String(item && item.note || '') }; }),
    at:String(source.at || '')
  };
}

// { lang: entry with lang } for every saved translation.
function savedTranslations(track) {
  var out = {};
  var map = track && track.translations;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    Object.keys(map).forEach(function(lang) {
      if (map[lang] && typeof map[lang] === 'object') out[lang] = Object.assign(translationEntry(map[lang]), { lang:lang });
    });
  }
  var old = track && track.translation;
  if (old && old.lang && !out[old.lang]) out[old.lang] = Object.assign(translationEntry(old), { lang:String(old.lang) });
  return out;
}

// The translations map with `entry` saved for `lang`: the old single
// translation folded in, and any made for other lyrics (another key) let go.
function withTranslation(track, lang, entry, key) {
  var all = savedTranslations(track);
  var out = {};
  Object.keys(all).forEach(function(name) {
    if (name !== lang && all[name].key === key) out[name] = translationEntry(all[name]);
  });
  out[lang] = translationEntry(entry);
  return out;
}

// The one a share page shows, for these lyrics: English when there is one,
// else the newest.
function publicTranslationOf(track, key) {
  var all = savedTranslations(track);
  var current = Object.keys(all).map(function(lang) { return all[lang]; }).filter(function(tr) { return tr.key === key; });
  return current.filter(function(tr) { return tr.lang === 'English'; })[0]
    || current.sort(function(a, b) { return String(b.at).localeCompare(String(a.at)); })[0]
    || null;
}
