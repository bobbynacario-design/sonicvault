// Reading a track's words: lyrics and prompt helpers, the local metadata
// suggestion engine, and normalising whatever a remote AI endpoint returns.
// Pure: no DOM, no app state, nothing outside js/data.

var AI_METADATA_VERSION = 2;

function sanitizeMetadataArray(value, limit) {
  if (!Array.isArray(value)) value = typeof value === 'string' ? value.split(/[,|\n]/) : [];
  return uniqueStrings(value, limit || 10);
}

function getTrackLyrics(track) {
  return String(track && track.lyrics || '').trim();
}

function hasLyrics(track) {
  return !!getTrackLyrics(track);
}

function getLyricsExcerpt(track, max) {
  return trimText(getTrackLyrics(track).replace(/\s+/g, ' ').trim(), max || 220);
}

function getTrackSummary(track) {
  return String(track && track.aiSummary || '').trim();
}

function getTrackAITheme(track) {
  return String(track && track.aiTheme || '').trim();
}

// Until 2026-10-04, saving the AI's answer padded its tags with the
// lyrics' most frequent words up to ten, so stored tags read "Love Song,
// Poetic, got, weather, whole". The padding always trails the AI's own tags
// and matches the track's top words, so it is dropped when read; nothing in
// the vault has to be rewritten. The local tagger chose its words on
// purpose, so its tags are kept as they are.
function getTrackAITags(track) {
  var tags = sanitizeMetadataArray(track && track.aiTags, 12);
  if (!tags.length || lower(track && track.aiSource) === 'local') return tags;
  // Padding words are bare lowercase words; skip the scan when the last tag
  // is anything else (this runs for every track on every render).
  if (!/^[a-z0-9]+$/.test(tags[tags.length - 1])) return tags;
  var padding = {};
  deriveTextTags(getTrackMetadataText(track), 30).forEach(function(word) { padding[word] = 1; });
  while (tags.length && padding[tags[tags.length - 1]]) tags.pop();
  return tags;
}

function getTrackAIInstruments(track) {
  return sanitizeMetadataArray(track && track.aiInstruments, 8);
}

function getLyricContentLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(function(line) {
    return String(line || '').trim();
  }).filter(function(line) {
    return line && !/^\[[^\]]+\]$/.test(line);
  });
}

function getLyricSectionCounts(text) {
  var counts = { verse:0, chorus:0, bridge:0, outro:0, intro:0, pre:0 };
  String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').forEach(function(line) {
    var trimmed = String(line || '').trim().toLowerCase();
    if (!/^\[[^\]]+\]$/.test(trimmed)) return;
    if (trimmed.indexOf('[verse') === 0) counts.verse++;
    else if (trimmed.indexOf('[chorus') === 0) counts.chorus++;
    else if (trimmed.indexOf('[bridge') === 0) counts.bridge++;
    else if (trimmed.indexOf('[outro') === 0) counts.outro++;
    else if (trimmed.indexOf('[intro') === 0) counts.intro++;
    else if (trimmed.indexOf('[pre') === 0) counts.pre++;
  });
  return counts;
}

function deriveTextTags(text, limit) {
  var stop = {
    a:1, ah:1, an:1, and:1, are:1, around:1, at:1, away:1, be:1, been:1, before:1, behind:1, but:1,
    by:1, can:1, chorus:1, come:1, could:1, did:1, doing:1, don:1, down:1, ever:1, for:1, from:1,
    get:1, gotta:1, had:1, has:1, have:1, he:1, her:1, him:1, his:1, into:1, just:1, know:1, like:1,
    line:1, lines:1, lot:1, me:1, more:1, much:1, my:1, now:1, oh:1, ooh:1, our:1, out:1, over:1,
    pre:1, really:1, repeat:1, she:1, some:1, still:1, than:1, that:1, the:1, their:1, them:1, then:1,
    there:1, these:1, they:1, this:1, those:1, through:1, under:1, very:1, verse:1, verses:1, vocal:1,
    vocals:1, wanna:1, was:1, were:1, what:1, when:1, where:1, who:1, with:1, would:1, yeah:1, your:1,
    you:1, song:1, track:1
  };
  var counts = {};
  String(text || '').toLowerCase().split(/[^a-z0-9]+/).forEach(function(word) {
    if (!word || word.length < 3 || stop[word]) return;
    counts[word] = (counts[word] || 0) + 1;
  });
  return Object.keys(counts).sort(function(a, b) {
    return counts[b] - counts[a] || b.length - a.length || a.localeCompare(b);
  }).slice(0, limit || 8);
}

function detectMappedValue(text, map, fallback) {
  var body = lower(text);
  var best = { value:fallback, score:0 };
  map.forEach(function(entry) {
    var score = 0;
    entry.words.forEach(function(word) {
      if (body.indexOf(word) !== -1) score += 1;
    });
    if (score > best.score) best = { value:entry.value, score:score };
  });
  return best.value;
}

function detectInstruments(text) {
  var hints = [
    { value:'Synth', words:['synth', 'analog', 'arp', 'pad', 'synthwave'] },
    { value:'Guitar', words:['guitar', 'riff', 'acoustic', 'strum'] },
    { value:'Piano', words:['piano', 'keys', 'keyboard'] },
    { value:'Strings', words:['strings', 'violin', 'cello', 'orchestra'] },
    { value:'Bass', words:['bass', 'sub bass', '808'] },
    { value:'Drums', words:['drums', 'snare', 'kick', 'percussion'] },
    { value:'Sax', words:['sax', 'saxophone'] },
    { value:'Choir', words:['choir', 'choral', 'harmony stack'] }
  ];
  var body = lower(text);
  var found = [];
  hints.forEach(function(entry) {
    if (entry.words.some(function(word) { return body.indexOf(word) !== -1; })) found.push(entry.value);
  });
  return uniqueStrings(found, 5);
}

function normalizePhrase(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleCasePhrase(text) {
  return String(text || '').split(/\s+/).filter(Boolean).map(function(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function derivePhraseTags(input, limit) {
  var phrases = [];
  var title = normalizePhrase(input && input.title || '');
  var lyricLines = getLyricContentLines(input && input.lyrics);
  var repeated = {};
  var phraseCounts = {};

  if (title && title.split(' ').length > 1 && title.split(' ').length <= 6) phrases.push(titleCasePhrase(title));

  lyricLines.forEach(function(line) {
    var normalized = normalizePhrase(line);
    var words = normalized.split(' ').filter(Boolean);
    if (words.length >= 3 && words.length <= 9) repeated[normalized] = (repeated[normalized] || 0) + 1;
  });

  Object.keys(repeated).sort(function(a, b) {
    return repeated[b] - repeated[a] || a.length - b.length;
  }).forEach(function(phrase) {
    if (repeated[phrase] >= 2) phrases.push(titleCasePhrase(phrase));
  });

  lyricLines.join(' ').split(/[^a-z0-9']+/).filter(Boolean).forEach(function(_, idx, words) {
    [2, 3].forEach(function(size) {
      if (idx + size > words.length) return;
      var slice = words.slice(idx, idx + size).filter(Boolean);
      if (slice.length !== size) return;
      if (slice.filter(function(word) { return word.length >= 3; }).length < size) return;
      var phrase = slice.join(' ');
      if (/^(the|and|for|with|from|into|your|this|that)\b/.test(phrase)) return;
      phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
    });
  });

  Object.keys(phraseCounts).sort(function(a, b) {
    return phraseCounts[b] - phraseCounts[a] || b.length - a.length;
  }).forEach(function(phrase) {
    if (phraseCounts[phrase] >= 2) phrases.push(titleCasePhrase(phrase));
  });

  return uniqueStrings(phrases, limit || 4);
}

function buildThemeFromTags(tags) {
  if (!tags.length) return 'Personal narrative';
  if (tags.length === 1) return titleCasePhrase(tags[0]);
  return titleCasePhrase(tags[0]) + ' and ' + titleCasePhrase(tags[1]);
}

function detectExplicit(text) {
  return /\b(fuck|shit|bitch|damn|asshole|motherfucker)\b/i.test(String(text || ''));
}

function getTrackMetadataText(input) {
  return [input && input.title, input && input.prompt, input && input.lyrics].join('\n');
}

function inferThemeLabel(text, tags, phraseTags) {
  var body = lower(text);
  var themes = [
    { label:'Coastal reset', words:['water', 'ocean', 'shore', 'shoreline', 'salt', 'tide', 'sky', 'sun', 'sunset'] },
    { label:'Family devotion', words:['wife', 'kids', 'family', 'daddy', 'dad', 'home', 'present', 'childhood'] },
    { label:'Faith and gratitude', words:['god', 'lord', 'church', 'pray', 'grace', 'blessing'] },
    { label:'Romantic afterglow', words:['love', 'kiss', 'touch', 'heart', 'forever'] },
    { label:'Night-drive escape', words:['midnight', 'neon', 'city', 'drive', 'lights', 'highway'] },
    { label:'Heartbreak fallout', words:['broken', 'goodbye', 'tears', 'alone', 'ache', 'empty'] }
  ];
  var found = themes.filter(function(entry) {
    return entry.words.some(function(word) { return body.indexOf(word) !== -1; });
  }).map(function(entry) {
    return entry.label;
  });
  if (found.length >= 2) return found[0] + ' and ' + lower(found[1]);
  if (found.length === 1) return found[0];
  if (phraseTags.length) return phraseTags[0];
  return buildThemeFromTags(tags);
}

function inferVocalStyle(input, mood) {
  var body = lower(getTrackMetadataText(input));
  var sections = getLyricSectionCounts(input && input.lyrics);
  if (!getTrackLyrics(input)) return 'Instrumental';
  if (/\b(rap|trap|808|freestyle|bars|spit)\b/.test(body)) return 'Rap lead';
  if (/\b(duet|call and response)\b/.test(body)) return 'Duet';
  if (/\b(choir|choral|hymn|gospel)\b/.test(body)) return 'Choir-led';
  if (/\b(whisper|hush|breathy)\b/.test(body)) return 'Hushed lead';
  if (sections.chorus >= 2) return 'Anthemic lead';
  if (sections.verse >= 2) return mood === 'Melancholic' || mood === 'Warm' ? 'Reflective lead' : 'Narrative lead';
  return 'Lead vocal';
}

function inferEra(text, genre) {
  var body = lower(text);
  if (/\b(80s|vhs|arcade|retro|outrun|synthwave)\b/.test(body)) return '1980s';
  if (/\b(90s|boom bap|grunge)\b/.test(body)) return '1990s';
  if (/\b(2000s|bloghouse|millennial)\b/.test(body)) return '2000s';
  if (genre === 'Country' || genre === 'Folk') return 'Timeless';
  if (/\b(future|cyber|digital|neon)\b/.test(body)) return 'Future-facing';
  if (/\b(vinyl|analog|dusty|classic)\b/.test(body)) return 'Vintage';
  return 'Contemporary';
}

function inferProductionDetail(genre, instruments, text) {
  if (instruments.length) return instruments.join(', ').toLowerCase();
  if (genre === 'Country') return 'acoustic strums and open-air rhythm';
  if (genre === 'Folk') return 'acoustic guitar and intimate room detail';
  if (genre === 'Pop') return 'bright hooks and clean melodic framing';
  if (genre === 'Ambient') return 'soft pads and slow-bloom atmosphere';
  if (genre === 'Electronic') return 'pulsing low end and glossy synth detail';
  if (genre === 'Rock') return 'guitars and live-drum momentum';
  if (genre === 'Hip Hop') return '808 low end and pocketed percussion';
  if (/\b(ocean|water|tide|shore|salt|sky)\b/.test(lower(text))) return 'open-air detail and widescreen atmosphere';
  return 'focused production detail';
}

function buildEditorialSummary(title, genre, mood, theme, energy, vocalStyle, productionDetail, phraseTags) {
  var cue = lower(phraseTags[0] || theme);
  var openers = [
    '"' + title + '" lands as a ' + mood.toLowerCase() + ' ' + genre.toLowerCase() + ' cut built around ' + lower(theme) + ', with the writing anchored by ' + cue + '.',
    '"' + title + '" leans into ' + lower(theme) + ' as a ' + mood.toLowerCase() + ' ' + genre.toLowerCase() + ' release, framing the hook around ' + cue + '.',
    '"' + title + '" plays like a ' + mood.toLowerCase() + ' ' + genre.toLowerCase() + ' piece centered on ' + lower(theme) + ', with ' + cue + ' giving it the strongest image.'
  ];
  var closer = 'The lyric sheet points to a ' + energy.toLowerCase() + '-energy arrangement with ' + productionDetail + ' and a ' + vocalStyle.toLowerCase() + ' delivery.';
  return openers[hashString(title + '|' + theme) % openers.length] + ' ' + closer;
}

function normalizeAIMetadata(raw, input) {
  var text = getTrackMetadataText(input);
  var tags = sanitizeMetadataArray(raw && (raw.aiTags || raw.tags), 10);
  var instruments = sanitizeMetadataArray(raw && (raw.aiInstruments || raw.instruments), 6);
  var metadata = {
    aiGenre: String(raw && (raw.aiGenre || raw.genre) || '').trim() || 'Other',
    aiMood: String(raw && (raw.aiMood || raw.mood) || '').trim() || 'Dreamy',
    aiTheme: String(raw && (raw.aiTheme || raw.theme) || '').trim() || buildThemeFromTags(tags),
    aiEnergy: String(raw && (raw.aiEnergy || raw.energy) || '').trim() || 'Medium',
    aiVocalStyle: String(raw && (raw.aiVocalStyle || raw.vocalStyle) || '').trim() || 'Lead vocal',
    aiEra: String(raw && (raw.aiEra || raw.era) || '').trim() || 'Contemporary',
    aiInstruments: instruments,
    // The AI's tags as given. Words from the lyrics stand in only when it
    // gave none: padding a short list with them buried the real tags.
    aiTags: tags.length ? tags : deriveTextTags(text, 8),
    aiSummary: String(raw && (raw.aiSummary || raw.summary) || '').trim() || 'A curated SonicVault release shaped from the track title, prompt, and lyrics.',
    aiExplicit: raw && typeof raw.aiExplicit === 'boolean' ? !!raw.aiExplicit : detectExplicit(text),
    aiSource: String(raw && (raw.aiSource || raw.aiProvider || raw.provider || raw.source) || '').trim(),
    aiMetadataVersion: Number(raw && raw.aiMetadataVersion || AI_METADATA_VERSION),
    aiGeneratedAt: raw && raw.aiGeneratedAt || new Date().toISOString()
  };
  metadata.coverStyle = normalizeCoverStyle(raw && (raw.coverStyle || raw.aiCoverStyle), {
    title: input && input.title,
    genre: metadata.aiGenre,
    mood: metadata.aiMood,
    aiTheme: metadata.aiTheme,
    aiEnergy: metadata.aiEnergy,
    source: input && input.source || 'Suno'
  });
  if (!raw || !(raw.coverStyle || raw.aiCoverStyle)) metadata.coverStyle = inferCoverStyle(input, metadata);
  return metadata;
}

function getAIMetadataSourceLabel(item) {
  var source = lower(item && item.aiSource || '');
  if (source === 'claude') return 'Claude';
  if (source === 'gemini') return 'Gemini';
  if (source === 'remote') return 'Hosted AI';
  if (source === 'local') return 'Local';
  return item && item.aiGeneratedAt ? 'AI' : '';
}

function buildLocalMetadataSuggestion(input) {
  var text = getTrackMetadataText(input);
  var title = String(input && input.title || 'Untitled release').trim();
  var phraseTags = derivePhraseTags(input, 4);
  var tags = uniqueStrings(phraseTags.concat(deriveTextTags(text, 8)), 10);
  var genre = detectMappedValue(text, [
    { value:'Synthwave', words:['synthwave', 'neon', 'outrun', 'retro', '80s', 'arcade'] },
    { value:'Lo-fi', words:['lofi', 'lo-fi', 'study', 'dusty', 'cassette', 'bedroom'] },
    { value:'Electronic', words:['electronic', 'edm', 'club', 'drop', 'house', 'techno'] },
    { value:'Ambient', words:['ambient', 'cinematic', 'drone', 'atmospheric', 'floating'] },
    { value:'Hip Hop', words:['rap', 'hip hop', '808', 'bars', 'trap'] },
    { value:'Rock', words:['rock', 'riff', 'anthem', 'band', 'guitar'] },
    { value:'Pop', words:['pop', 'hook', 'radio', 'anthemic', 'chorus'] },
    { value:'Folk', words:['folk', 'acoustic', 'campfire', 'americana'] },
    { value:'Jazz', words:['jazz', 'swing', 'blue note', 'sax'] },
    { value:'Classical', words:['classical', 'orchestra', 'string quartet', 'sonata'] },
    { value:'R&B', words:['r&b', 'soul', 'slow jam', 'silky'] },
    { value:'Metal', words:['metal', 'blast beat', 'scream', 'distorted'] },
    { value:'Country', words:['highway', 'whiskey', 'dust', 'southern', 'boots', 'backroad', 'church', 'daddy'] }
  ], input && input.genre || 'Other');
  var mood = detectMappedValue(text, [
    { value:'Energetic', words:['run', 'fire', 'ignite', 'wild', 'chase', 'rush', 'midnight drive'] },
    { value:'Chill', words:['coast', 'slow', 'breeze', 'afterglow', 'soft', 'easy', 'ocean'] },
    { value:'Intense', words:['war', 'battle', 'storm', 'rage', 'burning', 'explosive'] },
    { value:'Dreamy', words:['dream', 'moon', 'neon', 'starlight', 'velvet', 'floating'] },
    { value:'Warm', words:['golden', 'sunset', 'home', 'ember', 'warm', 'wife', 'kids', 'family'] },
    { value:'Playful', words:['bounce', 'smile', 'glitter', 'playful', 'cheeky'] },
    { value:'Melancholic', words:['alone', 'ache', 'broken', 'tears', 'empty', 'goodbye'] },
    { value:'Uplifting', words:['rise', 'hope', 'brighter', 'alive', 'victory', 'survive'] },
    { value:'Dark', words:['shadow', 'midnight', 'void', 'haunted', 'blackout'] }
  ], input && input.mood || 'Dreamy');
  var theme = inferThemeLabel(text, tags, phraseTags);
  var energy = detectMappedValue(text, [
    { value:'High', words:['fast', 'rush', 'ignite', 'drop', 'club', 'wild'] },
    { value:'Low', words:['slow', 'still', 'haze', 'whisper', 'soft', 'drift'] }
  ], mood === 'Energetic' || mood === 'Intense' ? 'High' : mood === 'Chill' || mood === 'Dreamy' ? 'Low' : 'Medium');
  var vocalStyle = inferVocalStyle(input, mood);
  var era = inferEra(text, genre);
  var instruments = detectInstruments(text);
  var summary = '“' + title + '” reads like a ' + mood.toLowerCase() + ' ' + genre.toLowerCase() + ' piece centered on ' + lower(theme) + '. The lyrics and prompt suggest a ' + energy.toLowerCase() + '-energy arrangement with ' + (instruments.length ? instruments.join(', ').toLowerCase() : 'focused production detail') + ' and a ' + vocalStyle.toLowerCase() + ' delivery.';
  summary = buildEditorialSummary(title, genre, mood, theme, energy, vocalStyle, inferProductionDetail(genre, instruments, text), phraseTags);
  return normalizeAIMetadata({
    aiGenre: genre,
    aiMood: mood,
    aiTheme: theme,
    aiEnergy: energy,
    aiVocalStyle: vocalStyle,
    aiEra: era,
    aiInstruments: instruments,
    aiTags: tags,
    aiSummary: summary,
    coverStyle: inferCoverStyle(input, {
      aiGenre: genre,
      aiMood: mood,
      aiTheme: theme,
      aiEnergy: energy,
      aiVocalStyle: vocalStyle,
      aiEra: era,
      aiTags: tags
    }),
    aiExplicit: detectExplicit(text),
    aiSource: 'local'
  }, input);
}

function parseJSONFromText(text) {
  var raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {}
  var match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (err) { return null; }
}

function extractAIMetadataPayload(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return parseJSONFromText(payload);
  if (payload.metadata) return payload.metadata;
  if (payload.output_json) return payload.output_json;
  if (payload.result) return payload.result;
  if (payload.data && payload.data.metadata) return payload.data.metadata;
  if (payload.choices && payload.choices[0] && payload.choices[0].message) {
    return parseJSONFromText(payload.choices[0].message.content);
  }
  if (payload.output_text) return parseJSONFromText(payload.output_text);
  return payload;
}

function applyAIMetadataToDraft(item, metadata, forceManualFields) {
  if (!item || !metadata) return;
  item.aiTags = sanitizeMetadataArray(metadata.aiTags, 10);
  item.aiSummary = String(metadata.aiSummary || '').trim();
  item.aiMood = String(metadata.aiMood || '').trim();
  item.aiGenre = String(metadata.aiGenre || '').trim();
  item.aiTheme = String(metadata.aiTheme || '').trim();
  item.aiEnergy = String(metadata.aiEnergy || '').trim();
  item.aiVocalStyle = String(metadata.aiVocalStyle || '').trim();
  item.aiEra = String(metadata.aiEra || '').trim();
  item.aiInstruments = sanitizeMetadataArray(metadata.aiInstruments, 6);
  item.aiExplicit = !!metadata.aiExplicit;
  item.aiSource = String(metadata.aiSource || '').trim();
  item.aiMetadataVersion = Number(metadata.aiMetadataVersion || AI_METADATA_VERSION);
  item.aiGeneratedAt = metadata.aiGeneratedAt || new Date().toISOString();
  item.coverStyle = normalizeCoverStyle(metadata.coverStyle, item);
  if (forceManualFields || !item.genreEdited) item.genre = item.aiGenre || item.genre;
  if (forceManualFields || !item.moodEdited) item.mood = item.aiMood || item.mood;
  item.aiStatus = 'done';
  item.aiError = '';
  item.aiDirty = false;
}

function getAIGenerationInput(item) {
  return {
    title: String(item && item.title || '').trim(),
    prompt: String(item && item.prompt || '').trim(),
    lyrics: getTrackLyrics(item),
    genre: String(item && item.genre || '').trim(),
    mood: String(item && item.mood || '').trim()
  };
}

function derivePromptTags(prompt) {
  return deriveTextTags(prompt, 5);
}

// Discovery tags, most meaningful first, capped at eight: the AI's own tags
// and themes, words from the prompt, the genre/mood labels, and words pulled
// from the lyrics only to fill what is left. Lyric words used to come first,
// and common ones ("one", "take", "because") pushed the AI's tags past the
// cap. The source ("Suno") and the "Other" genre say nothing, so they are
// not tags.
function getTrackTags(track) {
  var labels = [track && track.genre, track && track.mood, track && track.aiGenre, track && track.aiMood, track && track.aiEra]
    .map(function(item) { return String(item || '').trim(); })
    .filter(function(item) { return item && lower(item) !== 'other'; });
  var tags = getTrackAITags(track)
    .concat(sanitizeMetadataArray(getTrackAITheme(track), 4))
    .concat(derivePromptTags(track && track.prompt))
    .concat(labels)
    .concat(deriveTextTags(getTrackLyrics(track), 6));
  return uniqueStrings(tags, 8);
}

// A neutral line for a track with no prompt, description or lyrics yet.
function promptFallback(track) {
  var mood = track && track.mood ? lower(track.mood) + ' ' : '';
  var source = track && track.source ? track.source : 'Suno';
  return 'A ' + mood + 'track from ' + source + '.';
}

function getTrackPromptExcerpt(track, max) {
  var prompt = String(track && track.prompt || '').trim();
  return trimText(prompt || getTrackSummary(track) || getLyricsExcerpt(track, max || 120) || promptFallback(track), max || 120);
}
