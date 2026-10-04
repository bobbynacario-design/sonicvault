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

// Until 2026-10-04 the local tagger (used when a browser has no AI worker)
// wrote a confident two-sentence review from templates -- "leans into
// coastal reset and night-drive escape as a energetic synthwave release" --
// from keyword hits inside other words. Those reviews were stored like
// Claude's, so they are dropped when read: no description beats a wrong one,
// and the song then offers to be described properly.
var LOCAL_SUMMARY_TEMPLATE = /^["“][\s\S]+?["”] (lands as an? |leans into |plays like an? |reads like an? )/;
var LOCAL_SUMMARY_FILLER = 'A curated SonicVault release shaped from the track title, prompt, and lyrics.';

function getTrackSummary(track) {
  var summary = String(track && track.aiSummary || '').trim();
  if (summary === LOCAL_SUMMARY_FILLER) return '';
  if (lower(track && track.aiSource) === 'local' && LOCAL_SUMMARY_TEMPLATE.test(summary)) return '';
  return summary;
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

// The most frequent content words, most frequent first; with minCount, only
// words used at least that often.
function deriveTextTags(text, limit, minCount) {
  var stop = {
    a:1, ah:1, an:1, and:1, are:1, around:1, at:1, away:1, be:1, been:1, before:1, behind:1, but:1,
    by:1, can:1, chorus:1, come:1, could:1, did:1, doing:1, don:1, down:1, ever:1, for:1, from:1,
    get:1, gotta:1, had:1, has:1, have:1, he:1, her:1, him:1, his:1, into:1, just:1, know:1, like:1,
    line:1, lines:1, lot:1, me:1, more:1, much:1, my:1, now:1, oh:1, ooh:1, our:1, out:1, over:1,
    pre:1, really:1, repeat:1, she:1, some:1, still:1, than:1, that:1, the:1, their:1, them:1, then:1,
    there:1, these:1, they:1, this:1, those:1, through:1, under:1, very:1, verse:1, verses:1, vocal:1,
    vocals:1, wanna:1, was:1, were:1, what:1, when:1, where:1, who:1, with:1, would:1, yeah:1, your:1,
    you:1, song:1, track:1,
    // Counting words say nothing about a song.
    one:1, two:1, three:1, four:1, five:1, six:1, seven:1, eight:1, nine:1, ten:1,
    twenty:1, thirty:1, forty:1, fifty:1, hundred:1, thousand:1
  };
  var counts = {};
  String(text || '').toLowerCase().split(/[^a-z0-9]+/).forEach(function(word) {
    if (!word || word.length < 3 || stop[word]) return;
    counts[word] = (counts[word] || 0) + 1;
  });
  return Object.keys(counts).filter(function(word) {
    return counts[word] >= (minCount || 1);
  }).sort(function(a, b) {
    return counts[b] - counts[a] || b.length - a.length || a.localeCompare(b);
  }).slice(0, limit || 8);
}

// Whether a keyword (or phrase) appears as whole words: "run" is not in
// "turn", "sun" is not in "Sunday". Matching inside words made the local
// tagger call a song about a birthday energetic and coastal.
function hasKeyword(body, word) {
  var escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])').test(body);
}

function detectMappedValue(text, map, fallback) {
  var body = lower(text);
  var best = { value:fallback, score:0 };
  map.forEach(function(entry) {
    var score = 0;
    entry.words.forEach(function(word) {
      if (hasKeyword(body, word)) score += 1;
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
    if (entry.words.some(function(word) { return hasKeyword(body, word); })) found.push(entry.value);
  });
  return uniqueStrings(found, 5);
}

function detectExplicit(text) {
  return /\b(fuck|shit|bitch|damn|asshole|motherfucker)\b/i.test(String(text || ''));
}

function getTrackMetadataText(input) {
  return [input && input.title, input && input.prompt, input && input.lyrics].join('\n');
}

// A theme only when the words make it plain: two different keywords of it,
// whole words. One stray "sun" or "lights" used to make a song coastal or
// a night drive. '' when nothing clears that bar.
function inferThemeLabel(text) {
  var body = lower(text);
  var themes = [
    { label:'Coastal reset', words:['water', 'ocean', 'shore', 'shoreline', 'salt', 'tide', 'waves', 'sunset', 'beach'] },
    { label:'Family devotion', words:['wife', 'kids', 'family', 'daddy', 'dad', 'mama', 'home', 'childhood'] },
    { label:'Faith and gratitude', words:['god', 'lord', 'church', 'pray', 'grace', 'blessing'] },
    { label:'Romantic afterglow', words:['love', 'kiss', 'touch', 'heart', 'forever'] },
    { label:'Night-drive escape', words:['midnight', 'neon', 'city', 'drive', 'highway', 'headlights'] },
    { label:'Heartbreak fallout', words:['broken', 'goodbye', 'tears', 'alone', 'ache', 'empty'] }
  ];
  var found = themes.filter(function(entry) {
    return entry.words.filter(function(word) { return hasKeyword(body, word); }).length >= 2;
  }).map(function(entry) {
    return entry.label;
  });
  if (found.length >= 2) return found[0] + ' and ' + lower(found[1]);
  return found[0] || '';
}

// Only what the words say: an instrumental has no lyrics, and a few kinds of
// delivery name themselves. Anything else is just a lead vocal -- "anthemic"
// from counting choruses was a guess.
function inferVocalStyle(input) {
  var body = lower(getTrackMetadataText(input));
  if (!getTrackLyrics(input)) return 'Instrumental';
  if (/\b(rap|trap|808|freestyle|bars|spit)\b/.test(body)) return 'Rap lead';
  if (/\b(duet|call and response)\b/.test(body)) return 'Duet';
  if (/\b(choir|choral|hymn|gospel)\b/.test(body)) return 'Choir-led';
  if (/\b(whisper|hush|breathy)\b/.test(body)) return 'Hushed lead';
  return 'Lead vocal';
}

// An era only when the words name one.
function inferEra(text) {
  var body = lower(text);
  if (/\b(80s|vhs|arcade|outrun|synthwave)\b/.test(body)) return '1980s';
  if (/\b(90s|boom bap|grunge)\b/.test(body)) return '1990s';
  if (/\b(2000s|bloghouse|millennial)\b/.test(body)) return '2000s';
  if (/\b(vinyl|analog|dusty)\b/.test(body)) return 'Vintage';
  return '';
}

function normalizeAIMetadata(raw, input) {
  var text = getTrackMetadataText(input);
  var local = lower(raw && raw.aiSource) === 'local';
  var tags = sanitizeMetadataArray(raw && (raw.aiTags || raw.tags), 10);
  var instruments = sanitizeMetadataArray(raw && (raw.aiInstruments || raw.instruments), 6);
  var metadata = {
    aiGenre: String(raw && (raw.aiGenre || raw.genre) || '').trim() || 'Other',
    aiMood: String(raw && (raw.aiMood || raw.mood) || '').trim() || 'Dreamy',
    // Theme, era and description are left empty rather than invented: the
    // player shows only the facts a track has.
    aiTheme: String(raw && (raw.aiTheme || raw.theme) || '').trim(),
    aiEnergy: String(raw && (raw.aiEnergy || raw.energy) || '').trim() || 'Medium',
    aiVocalStyle: String(raw && (raw.aiVocalStyle || raw.vocalStyle) || '').trim() || 'Lead vocal',
    aiEra: String(raw && (raw.aiEra || raw.era) || '').trim(),
    aiInstruments: instruments,
    // The AI's tags as given. Words from the lyrics stand in only when a
    // remote AI gave none: padding a short list with them buried the real
    // tags. The local tagger's tags are already its pick of the words.
    aiTags: tags.length || local ? tags : deriveTextTags(text, 8),
    aiSummary: String(raw && (raw.aiSummary || raw.summary) || '').trim(),
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

// Suggestions for a browser without the AI worker: only what the words show.
// Genre, mood and energy come from whole-word keyword hits, else they keep
// the values already chosen; tags are content words the song uses at least
// three times; and there is no description, because a template cannot
// describe a song. Until 2026-10-04 it wrote one anyway, and matched
// keywords inside other words ("run" in "turn"), so a reflective song about
// turning 47 came out as "energetic synthwave" with "low energy".
function buildLocalMetadataSuggestion(input) {
  var text = getTrackMetadataText(input);
  var genre = detectMappedValue(text, [
    { value:'Synthwave', words:['synthwave', 'neon', 'outrun', 'retro', '80s', 'arcade'] },
    { value:'Lo-fi', words:['lofi', 'lo-fi', 'study', 'dusty', 'cassette', 'bedroom'] },
    { value:'Electronic', words:['electronic', 'edm', 'club', 'drop', 'house', 'techno'] },
    { value:'Ambient', words:['ambient', 'cinematic', 'drone', 'atmospheric', 'floating'] },
    { value:'Hip Hop', words:['rap', 'hip hop', '808', 'bars', 'trap'] },
    { value:'Rock', words:['rock', 'riff', 'anthem', 'band', 'guitar'] },
    { value:'Pop', words:['pop', 'hook', 'radio', 'anthemic'] },
    { value:'Folk', words:['folk', 'acoustic', 'campfire', 'americana'] },
    { value:'Jazz', words:['jazz', 'swing', 'blue note', 'sax'] },
    { value:'Classical', words:['classical', 'orchestra', 'string quartet', 'sonata'] },
    { value:'R&B', words:['r&b', 'soul', 'slow jam', 'silky'] },
    { value:'Metal', words:['metal', 'blast beat', 'scream', 'distorted'] },
    { value:'Country', words:['whiskey', 'southern', 'boots', 'backroad', 'pickup', 'honky tonk'] }
  ], input && input.genre || 'Other');
  var mood = detectMappedValue(text, [
    { value:'Energetic', words:['run', 'fire', 'ignite', 'wild', 'chase', 'rush', 'midnight drive'] },
    { value:'Chill', words:['coast', 'slow', 'breeze', 'afterglow', 'soft', 'easy', 'ocean'] },
    { value:'Intense', words:['war', 'battle', 'storm', 'rage', 'burning', 'explosive'] },
    { value:'Dreamy', words:['dream', 'moon', 'starlight', 'velvet', 'floating'] },
    { value:'Warm', words:['golden', 'sunset', 'home', 'ember', 'warm', 'wife', 'kids', 'family'] },
    { value:'Playful', words:['bounce', 'smile', 'glitter', 'playful', 'cheeky'] },
    { value:'Melancholic', words:['alone', 'ache', 'broken', 'tears', 'empty', 'goodbye'] },
    { value:'Uplifting', words:['rise', 'hope', 'brighter', 'alive', 'victory', 'survive'] },
    { value:'Dark', words:['shadow', 'void', 'haunted', 'blackout'] }
  ], input && input.mood || 'Dreamy');
  // "still" is not a tempo: it is how half of all lyrics say "yet".
  var energy = detectMappedValue(text, [
    { value:'High', words:['fast', 'rush', 'ignite', 'drop', 'club', 'wild'] },
    { value:'Low', words:['slow', 'haze', 'whisper', 'soft', 'drift', 'lullaby'] }
  ], mood === 'Energetic' || mood === 'Intense' ? 'High' : mood === 'Chill' || mood === 'Dreamy' ? 'Low' : 'Medium');
  var theme = inferThemeLabel(text);
  var instruments = detectInstruments(text);
  var tags = deriveTextTags(text, 6, 3);
  return normalizeAIMetadata({
    aiGenre: genre,
    aiMood: mood,
    aiTheme: theme,
    aiEnergy: energy,
    aiVocalStyle: inferVocalStyle(input),
    aiEra: inferEra(text),
    aiInstruments: instruments,
    aiTags: tags,
    aiSummary: '',
    coverStyle: inferCoverStyle(input, {
      aiGenre: genre,
      aiMood: mood,
      aiTheme: theme,
      aiEnergy: energy,
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

// Whether an AI (not the local tagger) wrote this track's description.
function hasAIDescription(track) {
  return !!getTrackSummary(track) && !!String(track && track.aiSource || '').trim() && lower(track.aiSource) !== 'local';
}

function applyAIMetadataToDraft(item, metadata, forceManualFields) {
  if (!item || !metadata) return;
  // Basic suggestions carry no description, theme or era, and their tags
  // are only repeated words. Over a song an AI already described they would
  // blank what it wrote -- saving them in a browser without the worker would
  // wipe Claude's work from another -- so they leave it alone.
  if (metadata !== item && lower(metadata.aiSource) === 'local' && hasAIDescription(item)) return;
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
