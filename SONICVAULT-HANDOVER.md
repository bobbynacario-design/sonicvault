# SonicVault — Claude Code Handover

## What This Is
SonicVault is a personal music curation web app for managing AI-generated songs (primarily from Suno). It's a buildless vanilla HTML/CSS/JS app deployed on GitHub Pages with Firebase (Firestore) + Cloudinary backend. Built to match the architecture of an existing app (PokerHQ) by the same developer, including PokerHQ's `js/data` + `js/features` file layout.

## Repository Setup
- **Hosting:** GitHub Pages (static files, served as-is)
- **Structure:** `index.html` (markup only) + `styles/app.css` + scripts under `js/` — see **Code Layout** below
- **No build tools** — no bundler, no transpiler, no React. Pure vanilla. `package.json` exists only for the tests and the watcher.
- **Watcher:** `watcher.js` — separate Node.js script, runs locally, NOT deployed to GitHub Pages

## Code Layout
- `js/app.js` — the only ES module: Firebase auth, private vault sync, public share docs. It runs after every classic script and talks to them only through `window.*` (`fbSave`, `svApplyRemoteTracks`, `refreshAll`, ...).
- `js/data/*.js` — pure helpers (formatting, ordering, cover identity, metadata inference, waveform math, routes, backup format). No DOM, no app state, nothing outside `js/data`. Unit-tested in Node (`tests/*.test.js`).
- `js/features/*.js` — one file per feature, each owning its own state (`player.js` owns `_audio` and the queue, `library.js` the filters and shelf, `vault.js` the `tracks`/`playlists`/`appSettings` arrays, ...).
- `js/boot.js` — loads last; paints the first frame, so everything it calls must already be defined.
- All classic scripts share one global scope. That is what lets inline `onclick="playTrack(...)"` handlers reach feature functions, so: top-level `var`/`function` only (never `let`/`const`/`class`), and no name declared in two files. Code that *runs* while a file loads may only use files loaded before it; code inside functions can call anything.
- Every local script and `styles/app.css` carry one shared `?v=` token in `index.html`. Bump it on every deploy — `sw.js` serves same-origin files cache-first. A new script must also be listed in `sw.js` `SHELL_ASSETS`. `npm test` checks all of this.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS, no frameworks
- **Fonts:** Bebas Neue (display), DM Sans (body), DM Mono (mono/labels) — loaded via Google Fonts CDN
- **Metadata storage:** Firebase Firestore (shared project with PokerHQ and Daily Briefer apps)
  - Collection: `sonicvault-bob` — docs: `tracks`, `playlists`, `settings`
  - Real-time sync via `onSnapshot` listeners
- **Audio storage:** Cloudinary (free plan, 25GB)
  - Cloud name: `dtw4em0ob`
  - Upload preset (unsigned, for web UI): `sonicvault_web`
  - Folder: `sonicvault-bob/audio`
  - Both the web UI upload and the watcher upload to Cloudinary
- **Offline:** localStorage with offline queue pattern — saves locally first, syncs to Firebase when online
- **PWA-ready:** Manifest, apple-touch-icon, mobile bottom nav

## Firebase Config (shared project: pokerhq-a67e4)
```javascript
const firebaseConfig = {
  apiKey: "AIzaSyB_6PnXWdtpR-x-jcJIuzOaROoVRplY5SM",
  authDomain: "pokerhq-a67e4.firebaseapp.com",
  projectId: "pokerhq-a67e4",
  storageBucket: "pokerhq-a67e4.firebasestorage.app",
  messagingSenderId: "91226487101",
  appId: "1:91226487101:web:0cf1b3411ff9d17a00ad54"
};
```

Firebase imports used (ES modules via CDN):
```javascript
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
```

Note: Firebase Storage is NOT used. Audio files are stored in Cloudinary.

## Cloudinary Config
```javascript
// In js/features/upload.js (web UI — unsigned upload via preset)
var CLOUDINARY_CLOUD_NAME    = 'dtw4em0ob';
var CLOUDINARY_UPLOAD_PRESET = 'sonicvault_web';  // unsigned preset

// In watcher.js (Node.js — signed upload via environment variables)
const CLOUDINARY_CLOUD   = process.env.CLOUDINARY_CLOUD_NAME || 'dtw4em0ob';
const CLOUDINARY_KEY     = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_SECRET  = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_FOLDER  = 'sonicvault-bob/audio';
```

### Audio Upload Flow
```
Web UI upload  → Cloudinary (unsigned, via sonicvault_web preset) → audioURL saved to Firestore
Watcher        → Cloudinary (signed, via environment variables)   → audioURL saved to Firestore
```

Keep the signed Cloudinary credentials out of git. Store them in local environment variables or another non-tracked secret store only.

## Firestore Data Structure
Collection: `sonicvault-bob`

Documents:
- `tracks` — `{ value: JSON.stringify(tracksArray), updated: timestamp }`
- `playlists` — `{ value: JSON.stringify(playlistsArray), updated: timestamp }`
- `settings` — `{ value: JSON.stringify(settingsObj), updated: timestamp }`

### Track Object Shape
```javascript
{
  id: "t-1711700000000",
  title: "Neon Highways",
  genre: "Synthwave",       // Synthwave|Lo-fi|Electronic|Ambient|Hip Hop|Rock|Pop|Folk|Jazz|Classical|R&B|Chiptune|Metal|Country|Other
  mood: "Energetic",        // Energetic|Chill|Intense|Dreamy|Warm|Playful|Melancholic|Uplifting|Dark
  source: "Suno",           // Suno|Udio|Original|Other
  prompt: "80s synthwave, driving beat...",
  audioURL: "https://res.cloudinary.com/dtw4em0ob/...",  // Cloudinary URL — primary audio source
  duration: 194,            // seconds (detected on upload)
  waveform: [0.2, 0.8, ...], // array of 48 floats 0.15-1.0 (randomly generated on upload)
  created: "2026-03-15",
  plays: 142,
  shared: false,
  fileSize: 4200000,        // bytes
  fileName: "neon-highways.mp3",
  autoImported: true        // only present on watcher-imported tracks
}
```

Note: `audioData` (base64) is a legacy field from before Cloudinary migration. It is no longer written to new tracks. `save()` strips it before writing to Firestore. Playback checks `audioURL` first, falls back to `audioData` for old tracks.

### Playlist Object Shape
```javascript
{
  id: "pl-1711700000000",
  name: "Late Night Drives",
  color: "#E8875C",         // hex accent color
  desc: "Chill vibes for midnight coding",
  trackIds: ["t-123", "t-456"]
}
```

## Key Architecture Patterns

### Save Pattern (matching PokerHQ)
```javascript
function save(key, val) {
  localStorage.setItem('sv_'+key, JSON.stringify(val));
  var cleanVal = val;
  if (key === 'tracks' && Array.isArray(val)) {
    cleanVal = val.map(function(t) {
      var copy = Object.assign({}, t);
      delete copy.audioData; // strip legacy base64 — never send to Firestore
      return copy;
    });
  }
  if (_isOnline && window.fbSave) {
    window.fbSave(key, cleanVal);
  } else {
    _offlineQueue[key] = cleanVal;
    localStorage.setItem('sv_offline_queue', JSON.stringify(_offlineQueue));
  }
}
```

### Load Pattern
```javascript
function load(key, def) {
  try { return JSON.parse(localStorage.getItem('sv_'+key)) || def; } catch(e) { return def; }
}
```

### localStorage Key Prefix: `sv_`
- `sv_tracks`, `sv_playlists`, `sv_settings`
- `sv_offline_queue` — pending Firebase writes
- `sv_theme` — "light" or "dark"

### Audio Playback
- Uses HTML5 `Audio()` object
- Plays from `track.audioURL` (Cloudinary) — checked first
- Falls back to legacy `track.audioData` (base64) for old tracks
- Waveform visualization via div bars with CSS classes `wbar-active` / `wbar-inactive`
- Now-playing bar fixed to bottom with seek, progress, play/pause

### Cloudinary Upload (Web UI)
- Unsigned upload via `sonicvault_web` preset
- `uploadToCloudinary(file, onProgressCallback)` — returns `secure_url`
- Resource type: `auto`
- Progress bar shown during upload (`#upload-progress`, `#upload-progress-bar`, `#upload-progress-pct`)
- File size limit: 100MB
- `saveAllUploads()` is async — uploads each queued file first, then saves its metadata to Firestore

## Design System

### CSS Variables (Dark Theme — default)
```css
--bg:#06080C; --bg2:#0D1017; --bg3:#141820; --bg4:#1C222E;
--rim:rgba(255,255,255,0.06); --rim2:rgba(255,255,255,0.12);
--coral:#E8875C; --coral2:#F4A57A; --coral-dim:rgba(232,135,92,0.12);
--green:#5CB88A; --red:#E85C5C; --blue:#5C8CE8; --violet:#9B7CE8; --amber:#E8C85C;
--serif:'Bebas Neue'; --mono:'DM Mono'; --sans:'DM Sans';
```

### Light Theme
Applied via `body.light` class toggle. All component overrides use `body.light .component` selectors.

### Aurora Glass Design Language (2026-06 redesign)
- Deep near-black base (`--bg:#05060c`) with large soft radial "aurora" blooms: static violet/coral washes on `body`, plus dynamic blooms on `body::before` driven by `--accent-dynamic` (set per playing track) — the background literally re-tints to the current track's palette.
- Body font is Space Grotesk (`--sans`); Syne stays for display, DM Mono for labels.
- Logo (2026-10-04): a keyhole with a three-bar waveform inside it -- private, and music -- in the "Midnight" colourway: a deep ink tile (`#26304a` > `#0b0f1a`, a faint white rim), an off-white keyhole (`#f7f2eb`) and a coral waveform (`#ffb46b` > `#ef6a3a`). Chosen over a vault dial, an S-wave and a waveform orb, and then over black-and-gold, ember and ocean colourways; the first violet-pink-peach version read too soft. It replaced a sky-blue dial icon that matched nothing in the app. `assets/icons/sonicvault-mark.svg` is the master in the fixed colours. In the app it is `#i-logo` in the sprite (`<svg class="brand-mark"><use href="#i-logo"/></svg>`, sidebar and sign-in page), whose waveform runs from a lighter `--accent-dynamic` to `--accent-dynamic`, so it takes on the playing track's colour as the old sidebar orb did. The PNGs are rendered from the SVG with headless Chrome: `favicon-32`, `icon-192` and `icon-512` keep the rounded tile with transparent corners (manifest purpose `any`); `icon-maskable-192/512` and `apple-touch-icon` are full-bleed squares without the rim, because Android and iOS cut their own shape (the keyhole sits inside the maskable safe zone). Icon and manifest links carry the `?v=` deploy token: sw.js serves same-origin files cache-first by exact URL, so a redrawn icon under an old URL would never reach a device. The share previews' fallback picture is `icon-512.png`, so it changed with it.
- Primary buttons are solid white pills with dark text (inverted to dark pills in light theme). Coral/accent lives in highlights, blooms, and waveforms — not CTAs.
- Waveforms and progress fills use a violet-to-accent gradient.
- Interior card elements are borderless (typographic pills/tags, ghost secondary buttons); only outer structural cards keep 1px rims.
- `.section-card` is a grouping, not a box (no rim, fill or padding). The cards inside a section are the only chrome; hover rows and inputs use the `--surface` / `--surface-hover` fills instead of borders.
- Icons come from the SVG sprite at the top of `index.html` (`<svg class="ic"><use href="#i-NAME"/></svg>`), or `icon(name)` / `setPlayButton(btn, playing)` in `js/features/shell.js` for JS-built markup. Never label an icon button with a text abbreviation ("Shuf", "Rep", "FND"); give it an `aria-label` instead.
- Covers: `getTrackPalette` snaps each track's hue to one of `COVER_HUE_PAIRS` (neighbouring hues, nothing in the olive 60-130 band), painted as two blooms over a deep ground (`--cover-mesh`). Warm pairs fade into plum, because dark orange reads as brown. Only `lg` covers carry text labels; `md` keeps the monogram; `xs`/`sm` are artwork only.
- Phones: the docked player collapses to one row (cover, title, play, next, open) sitting on top of the bottom tab bar (`--mobile-nav-h`).
- Real cover art: Suno embeds each song's artwork (a 360x360 JPEG, ID3 APIC frame) in the MP3. `js/features/artwork.js` reads it from the first 64KB of each track's `audioURL` (a ranged request tagged `?sv-art=1`, which `sw.js` passes straight through so it never downloads or caches the whole song), parses it with `findEmbeddedArt` in `js/data/artwork.js`, and stores the image in Cache Storage (`sv-art-v1`) and the palette in `localStorage.sv_art`. Device-local derived data, like waveforms: nothing syncs, nothing is written to the vault. Covers with art get `.has-art` and an `<img class="cover-img">`; `getCoverPalette(track)` returns the art's palette when there is one, so the tint, home hero and lock-screen artwork follow the real cover. Tracks without art keep the generated cover. The sweep reruns after each sync, so watcher imports pick up their art without a reload.
- Lyrics from the file: Suno also embeds the full lyric sheet (ID3 USLT, UTF-8 in current exports, UTF-16 in older ones; sections labelled `[Verse 1]` or `(Verse 1)`, both rendered as headings). `findEmbeddedLyrics` reads it in three places, and each only fills a track whose lyrics are empty: the upload studio (prefills the lyrics box from the picked file), `watcher.js` (music-metadata 7 native USLT frames, so watcher imports arrive with lyrics), and the artwork sweep (back-fills existing tracks from the same 64KB read, saving each filled track to the vault at once). The art index records whether the file had lyrics, so a sheet someone deliberately clears is not refilled.
- Timed lyrics: Suno files carry no lyric timings (the extra GEOB frame in newer exports is a C2PA content-credentials manifest, not timings). The first time a track with lyrics plays for ~4s, `js/features/lyric-sync.js` POSTs `{ audioURL }` to the AI worker's `/transcribe` (Whisper large-v3-turbo on Workers AI; ~20-30s per song, about $0.0005 per audio minute after the free daily allowance). `alignLyricsToWords` (`js/data/lyric-sync.js`, unit-tested) lines the heard words up against the sheet with a global alignment that tolerates misheard and missing words, and the result is saved on the track as `lyricSync = { key, starts: [s|null...], ends: [e|null...], source, at }` (two flat arrays: Firestore rejects a document containing an array directly inside an array, which the first build's `lines: [[start,end]...]` did -- every save of a timed track failed until `cloudSafeLyricSync` converted them), so it syncs to every device and is paid for once. `key` is `lyricSyncKey(lyrics)`: editing the lyrics retires the timings. Below 30% of words matched the result is stored as `source:'unmatched'` so the song is not re-sent on every play. Measured on three real Suno songs: 94-95% of words matched in English, 83% in Bikol; 38/39, 20/20 and 40/40 lines timed. In the player, tapping a sung line while playing re-times it (`fixLyricLine`, source becomes `audio+fixed`, or `manual` with no worker) with a 10s Undo in the status line; tapping while paused jumps to the line. Nothing is lit before the first line or in a long instrumental break. Needs the AI endpoint + bearer token set under Import on each device.
- What was sung vs what was written (2026-10-04): the transcription behind timed lyrics also says what the singer sang. `alignLyricsToWords` now returns `heard` -- per sung line, every heard word from the first to the last lined up with it -- and `packLyricSync` stores it as `lyricSync.heard` (flat strings). "Check what was sung" in the lyrics card (`renderSungCheck`, js/features/lyric-sync.js) runs `checkSungLyrics` (js/data/lyric-sync.js): per line, `compareSungLine` lines the written words up against the heard ones with `sungWordMatch` -- stricter than the timing's `wordMatchScore`, so "chips" vs "ships" is a change, while plurals, a dropped g, one-letter slips in long words and sung-alike pairs (`SUNG_ALIKE`: to/too, gonna/going...) are not; a line differs only on a changed or missing word of three letters or more. The summary counts lines sung as written / sung differently / not heard; tapping a line plays it. Songs timed before `heard` existed are listened to once more on request; timings corrected by hand (`audio+fixed`, `manual`) are kept. The versions list shows each take's "N of M lines as written" once checked.
- Search by meaning (2026-10-04): the "By meaning" pill inside the library search box (`#search-mode-btn`, shown only when the AI worker is connected and not in a demo) switches search from matching words to matching what songs are about. Each song's `songMeaningText` (title, description, themes, tags, mood/genre, prompt, then lyric lines, capped at 3600 chars; js/data/meaning.js) is sent in batches of 12 to the worker's `/embed` (Workers AI `@cf/baai/bge-m3`, 1024 normalised dims, at most 16 texts per call). Vectors are kept on the device only, as int8 + scale (about 1.4KB a song) in `localStorage.sv_meaning`, keyed by song id with a hash of the text, so a song is re-read only when its words change; deleted songs are pruned. A query is embedded once per page load (450ms debounce) and songs are ranked by cosine similarity: `rankMeaningMatches` keeps those scoring at least max(.3, best − .12), at most 24, best first, because unrelated texts already score about .35-.45 with this model. `getFilteredTracks` takes the rank (`getMeaningRank`) for both the match and the order; while a new query is out the previous results stay. After the first use, `scheduleMeaningIndex` tops the index up 20s after each sync. The mode is remembered in `localStorage.sv_search_mode`.
- Story clips (2026-10-04): "Story clip" in the expanded player and "Make a story clip" in every track menu open `#modal-story` (js/features/story.js), which makes a 15- or 30-second 1080x1920 video to post as a story: blurred art backdrop (the art shrunk to 14x24 and stretched back, since Safari has no canvas `filter`), the cover (or the generated palette + monogram), title, genre/mood, the line being sung with the next one under it, analyser bars, and the SonicVault mark, kept clear of the top 250px a story app covers. It records in real time: the song is fetched (tagged `?sv-wave=1`, so sw.js serves a cached copy or fetches without caching), decoded once, and played silently through gain -> analyser -> `MediaStreamDestination` while `canvas.captureStream(30)` + `MediaRecorder` capture it; the audio fades in .3s and out .8s, the picture fades from and to black. `pickStoryFormat` prefers MP4 (Chrome 126+, Safari) over WebM, since Instagram and iPhone Photos refuse WebM; 5 Mbps, about 6-8MB for 15s. `pickStoryStart` (js/data/story.js) starts .8s before the first [Chorus] line (not pre/post-chorus), else the most repeated line, else the first line, else a third of the way in; the slider moves it. Words only follow the singer when the lyrics have real timings (`storyTimes`); untimed lyrics are timed first through `requestLyricSync` when the worker is connected, otherwise the clip shows the AI description. The finished clip previews with the still as its poster and goes out through `navigator.share({ files })` where the browser can share files, else a download. Closing the dialog any way cancels a recording (`onStoryClipClosed`, called from `closeModal`). Every finished clip is kept on the device that made it, never in the cloud: the video and a half-size JPEG still go into Cache Storage `sv-clips-v1` (keys `./__clips/video/<id>` and `./__clips/still/<id>`; sw.js lists the cache so activate keeps it) and the list into `localStorage.sv_clips`, newest first, at most `STORY_KEEP` (5) -- `keepRecentClip` names the ones to delete. The dialog lists them under "Recent clips on this device" for every song; opening one shows it with Share and Save, and the x deletes it. `syncKeptStoryClips` drops entries whose video the browser has since cleared, and the first kept clip asks for `navigator.storage.persist()`.
- Expanded player: `#xp-backdrop` holds the current cover blown up and blurred behind the whole screen (or the generated palette's blooms when there is no art); panels on top use a glass fill that reads on bright and dark art.

### Design Conventions (matching PokerHQ)
- Monospace uppercase labels for metadata (font-family:var(--mono); font-size:9-11px; letter-spacing:.08-.14em)
- Card-based UI with 12-14px border-radius, 1px solid var(--rim) borders
- Modals: overlay with `.modal-overlay.open` display toggle
- Buttons: `.sec-action` base class, `.sec-action.primary` for CTA
- Delete buttons: `.del-btn` — transparent bg, red on hover
- Toast notifications via `#sv-toast` element
- Genre colors mapped in `getGenreColor()` function

## Current Features
- [x] Audio upload with drag-and-drop (MP3/WAV/M4A, up to 100MB)
- [x] Cloudinary storage for audio files with upload progress bar
- [x] Firestore metadata sync with real-time cross-device updates
- [x] Audio playback with waveform visualization
- [x] REAL waveforms: 72 loudness levels measured from the actual audio (Web Audio API, `extractWaveformLevels`): each bar is a block's RMS energy relative to the track's loudest block, stretched over the track's own range. Measured at upload time from the in-memory file, on first play, and by a background sweep (`sweepWaveformBackfill`) for tracks without levels. Kept per device in `localStorage.sv_loudness` and stamped on `track.loudness`, so other devices and share payloads skip the download. (Until 2026-10-04 this was each block's peak sample, stored as `track.peaks` / `sv_waveforms`; every loud master drew as a flat wall. Those fields are now ignored, and `peaks` is deleted when `loudness` is written. Legacy random `track.waveform` is ignored too.) Sweep downloads are tagged `?sv-wave=1`: `sw.js` serves a cached copy when it has one and otherwise fetches without caching, so a full re-measure does not evict recently played audio. Skipped under Data Saver.
- [x] Now-playing bar with seek/progress
- [x] Expanded full-screen player polish (`#modal-now-playing`): animated waveform (`.player-wave.playing` pulses the playhead bar), a "now playing" cover treatment (`.cover-live` — breathing scale + accent glow + drifting ring), proportional lyric scroll-along (`updateLyricHighlight` dims non-current lines and highlights/scrolls the line nearest the playhead; lyrics are untimed so sync is approximate), and queue reordering (`moveQueueTrack` ▲▼ controls — mutates the live shuffle or canonical order; hidden on mobile). All animations respect `prefers-reduced-motion`.
- [x] Sleep timer and fades (2026-10-04, `js/features/playback-extras.js`, pills under the expanded player's volume row): the timer cycles off / 15 / 30 / 45 / 60 min / end of song; when time is up it fades out over 8s, pauses, and puts the volume back; "end of song" is checked first in the 'ended' handler, so it stops rather than advancing. "Fade between songs" (`_playerPrefs.smooth`, device-local) fades the last 4s of a song down when another follows, fades the next one in over 1.5s, and preloads the next song from 25s out so it plays from the service worker's cache. Not a true crossfade: that needs a second audio element wired through everything that follows `_audio`. Fades move `_audio.volume` and return to `_userVolume` (player.js), which is what is saved and shown. iOS ignores page-set volume, so on iPhone the timer pauses without fading and transitions only preload.
- [x] Auto-advance to next track
- [x] Shuffle mode (Fisher-Yates over the active queue, current track pinned first)
- [x] Repeat modes: off / queue / one
- [x] Volume slider + playback speed cycle (0.75x-2x) in the expanded player
- [x] Player prefs persisted device-locally in `sv_player_prefs` (not synced to Firestore)
- [x] Insights dashboard (`#page-insights` / `renderInsights`) — a fourth nav view with stat tiles (tracks, total plays, estimated listening time = Σ plays×duration, avg plays/track), clickable genre/mood/source distribution bars (jump to the filtered library), most-played + hidden-gems (least-played) rails, and a "library health" card (AI-tagged %, lyrics %, watcher imports, catalog runtime). All metrics are derived from existing track data + play counts — no external tracking, no per-play timestamps (so no fabricated "this month" stats).
- [x] Library view with search and genre filtering
- [x] **Progressive shelf rendering** — the browse grid renders `SHELF_PAGE_SIZE` (60) cards, then streams the rest in via `IntersectionObserver` on `#shelf-sentinel` (`appendShelfPage` / `observeShelfSentinel`), with a "Show N more" button as the fallback. First paint and DOM size are now flat regardless of library size (60 cards / ~392KB / ~8k nodes at any count, vs 70k nodes and 13.7MB of HTML at 600 tracks before).
- [x] **Split render paths** — `renderTracks()` = hero + shelf (data changed); `renderTrackList()` = shelf only (filter/search/sort). Search is debounced 140ms via `onSearchInput()`, so a 6-character query triggers one shelf rebuild instead of six full hero+shelf renders. `toggleExpand` flips the `.expanded` class on the two affected cards rather than rebuilding the list. `buildTrackCard` no longer calls `getFilteredTracks()` per card (was 301 calls and 90k id-string copies per render at 300 tracks) — the play button calls `playTrack(id)` and the queue resolves lazily at click time.
- [x] **Keyboard + screen-reader parity** — every card, rail, and row used as a control carries `role="button" tabindex="0"` plus an `aria-label`, activated by a delegated Enter/Space handler registered ahead of the shortcut handler. Redundant pointer affordances (card waveforms, both seek bars) are `aria-hidden` because a labelled equivalent already exists (Play button, J/L and arrow-key seek). Playlist cards and upload queue rows expose explicit **Open** / **Edit** buttons instead of making the card a tab stop that wraps its own buttons. All 6 dialogs have `role="dialog"`, `aria-modal`, an accessible name, Tab containment, and focus restore to the invoking element (falling back to the current nav tab when the opener was re-rendered away). The toast and sync pill are `aria-live` regions — previously the app had none, so no save, upload, or playback message was ever announced.
- [x] **Unshare / share revocation** (`unshareTrack`, `unsharePlaylist`, `revokeShare`) — deletes the world-readable public doc via `fbUnpublishShare` (`deleteDoc`), not just the private `shared` flag. `deleteTrack` and `deletePlaylist` cascade the revoke, so a deleted track can no longer leave a live public page serving its prompt, lyrics excerpt, and Cloudinary URL. Shared items show a "Public link live" pill and an Unshare button.
- [x] **Loading skeletons** — `window.svBootPending` (set in the module script, cleared by `settleBoot()` on first sync resolution) drives `buildLibrarySkeleton()`. A fresh device with an empty localStorage cache used to paint the "Start your private label" empty state while the vault was still on the wire.
- [x] **Drag-to-reorder playlist sequence** — `.playlist-edit-item` rows are draggable with an insertion-line drop indicator (`onSeqDragStart`/`onSeqDragOver`/`onSeqDrop`/`onSeqDragEnd` → `reorderPlaylistTrack`). The Up/Down buttons remain the keyboard path; both share one reorder+persist.
- [x] **Mobile fixes** — track tag rows wrap to two lines instead of clipping (at 375px a 431px row was showing 202px, hiding over half the discovery tags). All touch targets meet 44px under `max-width:640px`; 88 controls were below it, including the bottom nav tabs at 36px.
- [x] Track detail expansion (click to reveal Suno prompt)
- [x] Edit-track modal (`openEditTrack` → `#modal-edit-track`) — edit title/genre/mood/source/prompt/lyrics on tracks already in the vault (including watcher imports that arrived without lyrics), with an inline "Generate AI metadata" button that reuses the same remote-or-local engine as the upload editor. Explicit form values always win over AI suggestions on save.
- [x] Keyboard shortcuts — global `keydown` handler (skipped while typing in a field; dialogs swallow shortcuts but Escape still closes them). Space/K play-pause, J/L ±10s, ←/→ ±5s, ↑/↓ volume, N/P next/prev, S shuffle, R repeat, M mute, `/` jump-to-search, 1–5 switch views (Home, Playlists, Create, Import, Insights), `?` opens the shortcuts overlay (`#modal-shortcuts`), Esc closes dialogs/expanded tracks. Also reachable via the "Keys" button in the nav.
- [x] Playlists — create, view, delete, with track selection
- [x] Playlist page polish (2026-10-04, `js/features/playlists.js`, `.pl-*` in styles/app.css): cards are album sleeves -- `buildPlaylistArt` (four tracks' covers in a seamless square from four tracks up, the first track's cover below that, an empty frame for none), the name, "6 tracks · 21m", Offline / Public link badges -- with a play button rising over the cover on hover (always shown on touch). Sharing, offline, duplicating and deleting moved off the cards into the playlist dialog. The featured mixtape glows in its playlist colour with Play / Shuffle / Open and the running order beside it. Your playlists come before the smart mixes, which use the same cards with an "Auto" label and "Save as playlist". The dialog: cover, facts, Play / Shuffle / Share and a menu (Edit details and order, Shuffle the order, Duplicate, Keep offline / Remove offline copy, Delete playlist), then plain rows; editing puts name, description and colour swatches (radio inputs; fixed a select that showed Coral for any lowercase colour) above rows with a grip, arrows and remove. On a phone the grid is two columns (the page went from ~9,500px to ~3,700px for five playlists), the dialog stacks, and the editor drops the grip because phones don't drag. `playPlaylistShuffled` plays from a random track with shuffle on.
- [x] Smart mixes (`getSmartMixes` / `renderSmartMixes`, top of the Playlists page) — rule-based playlists computed live from the vault (NOT persisted), so they auto-update as tracks import and get tagged. Rules: per-genre, per-mood, Instrumentals (no lyrics / aiVocalStyle ~ Instrumental), High energy / Wind down (aiEnergy), and top recurring AI tags (excluding genre/mood/source names). Sorted by size, capped at 12, min 2–3 tracks each. `playSmartMix(id)` queues the matches; `saveSmartMixAsPlaylist(id)` snapshots one into a regular persisted playlist. Hidden when the vault is empty.
- [x] Share modal with copy link, Twitter, WhatsApp, Email
- [x] Dark/light theme toggle (persisted)
- [x] Mobile responsive with bottom nav
- [x] PWA manifest
- [x] Offline support with queue-based sync
- [x] Service worker (`sw.js`) — offline app shell, cached fonts/Firebase SDK, last 30 played Cloudinary audio files cached with Range support. Shell is network-first so a normal deploy still propagates on the next online load; bump `VERSION` in `sw.js` only when cache logic changes.
- [x] Playlists kept offline (2026-10-04, `js/features/offline.js`, "Keep offline" in the playlist dialog): the page downloads each song (tagged `?sv-offline=1`, which sw.js passes straight through) into its own cache `sv-offline-v1`, keyed by the plain audio URL, and asks for persistent storage. sw.js checks that cache before anything else for audio (and for waveform reads) and never trims it; the 30-song audio cache is unchanged. Which playlists are kept, and the bytes saved per file, are device-local (`localStorage.sv_offline`). Songs added later come down on their own 20s after a sync while online; "Remove offline copy" deletes only files no other kept playlist needs. Cards of kept playlists show an "Offline" pill.
- [x] Versions of a song (2026-10-04, `js/data/versions.js` pure + `js/features/versions.js`): Suno makes two takes per prompt ("Still In (1)" / "(2)"). Takes are grouped by their lyric sheet word for word (`versionKey`: section tags, case and punctuation ignored, at least 60 characters of words), or without lyrics by title less its "(2)"/"v2" plus the prompt. Nothing is stored for a group; the main take carries `versionPick: true`, else the most played stands for the song, else the first made. The shelf shows each song once (`collapseVersions`) with a "2 versions" chip that lists every take with Play / Make main; the summary counts songs and tracks; rails dedupe (`dedupeVersions`); playing from the shelf queues the songs as shown, with a non-main take put in its song's place (`queueWithVersion`); the expanded player shows "Version 1 of 2" and switches takes at the same second (`switchToVersion`). "Group versions" turns it off per device (`sv_group_versions`). Demo songs got distinct lyric lines, since identical sheets would group all eight.
- [x] Suno folder watcher (`watcher.js`) — auto-imports downloads to Cloudinary + Firestore
- [x] **Sign-in page** (2026-10-04, `#login-overlay`, `js/features/sign-in.js`, `js/first-paint.js`) — laid out like PokerHQ's and Enclave's (story column with three numbered benefits and trust ticks; access card with "Continue with Google", "Look around with demo tracks" and, when the browser offers it, "Install as an app"; the card comes first on a phone), in the aurora glass style. The private views stay behind it until the vault's owner signs in; everything else in `<body>` is `inert` and keyboard shortcuts are off while it shows. **Share links never see it.** `js/first-paint.js` runs straight after its markup, before the rest of the page is parsed, and decides the first paint: hidden on `/track/:id`, `/playlist/:id` and `?sv-route=` links, and for whoever was signed in last time on this device (`localStorage.sv_owner_hint`), so the owner's vault opens from cache, offline too; it also applies the saved theme early. js/app.js reports Firebase's answer through `svSignInGate('owner'|'signed-out')`. A signed-in Google account the rules refuse (permission-denied on the private sync) is signed out and told "<email> doesn't have access to this vault" (`svAccessDenied`) — except an address on `VAULT_OWNER_EMAILS`, a mirror of `isBobGoogleAccount()` in firestore.rules, which is never locked out over a refused read. Sign-in is a popup, falling back to a full-page redirect only where popups are blocked or unsupported (`getRedirectResult` reports a failed redirect); a closed popup is not an error. If Firebase never answers, the page stops "Checking" after 10s and says it can't reach Google. The demo is the memory-only cover demo; leaving it returns to the sign-in page. No inline script: tests/shell.test.js forbids them, so the first-paint logic is a file, unit-tested in tests/first-paint.test.js.
- [x] **Create page** (2026-10-04, `#page-create`, `js/features/create.js` + `js/data/create.js`) — songs made by Google's **Lyria 3.5** through the AI worker. A title (optional), a description of the sound (six "Start from" ideas show while it is empty), and lyrics (optional; "Write with Claude" drafts or finishes them via `/lyrics`, with Undo; "Instrumental" sets them aside). "Make the song" POSTs to `/generate` and, in parallel, `/cover` for a FLUX.1 [schnell] picture (shrunk to 640px JPEG in the browser). Each result is a **take** in memory only (unsaved takes are lost on reload; `beforeunload` warns): play it, rename it, then **Save to vault** or Discard. Saving writes the title, lyric sheet and cover into the MP3's ID3 tag (`writeSongTag`, v2.3 like Suno, keeping any frames Lyria wrote) and then runs the import path — `makeUploadDraft` → `decodeUploadPeaks` (waveform) → AI metadata (`requestRemoteAIMetadata`, Claude) → `uploadToCloudinary` → `trackFromUploadDraft` → `addTracksToVault` — with `source: 'Lyria'`. The cover is put straight into the art cache (`rememberTrackArt`) so it shows at once; other devices and share previews read it from the tag like a Suno cover. Untitled songs are named from their first sung phrase (`deriveSongTitle`). The page probes the worker with an empty `/generate` and explains what is missing: no worker, no Gemini key (501), an outdated worker, a refused token or origin. Form contents persist per device in `localStorage.sv_create_draft`. Lyria refuses prompts naming real artists or asking for existing lyrics (`describeLyriaRefusal`); its audio carries Google's inaudible SynthID watermark. Keyboard: 3 opens Create (Import is 4, Insights 5).

## Suno Folder Watcher (`watcher.js`)
A separate Node.js script that runs locally on Bob's Windows machine.

### How it works
1. Monitors `C:\Users\BobbyNacario\Downloads\Suno` for new MP3/WAV/M4A files
2. Waits for file size to stabilize (confirms download is complete)
3. Uploads audio to Cloudinary (signed upload, credentials loaded from local environment variables)
4. Builds track metadata object (title cleaned from filename, waveform generated)
5. Prepends track to Firestore `tracks` doc
6. Moves file to `imported/` subfolder to prevent re-processing
7. SonicVault's `onSnapshot` listener picks up the change automatically

### Running the watcher
```bash
cd C:\Users\BobbyNacario\Claude\sonicvault
npm install
npm run watch
```

### Service account
The Firebase Admin service account JSON (`pokerhq-a67e4-firebase-adminsdk-fbsvc-c85a762ac5.json`) must be present in the sonicvault folder. It is gitignored. The watcher auto-detects it by filename pattern.

### File size limit: 200MB (watcher) / 100MB (web UI)

## AI Metadata (remote worker)
- Share-link previews (2026-10-04): the worker serves public `GET /s/track/:id`, `/s/playlist/:id` and `/s/art/:kind/:id` (`cloudflare-worker/share.js`). Link-preview bots (Facebook, WhatsApp, X) do not run script, and the app's own `/track/:id` URLs are a GitHub Pages 404 that redirects in script, so they previewed as "SonicVault Redirect" with no picture. The `/s/` pages carry Open Graph tags (title, description, cover) and send people on to `SHARE_APP_URL/?sv-route=/track/:id` by script. They read only the world-readable `sonicvault-public-*` records via Firestore REST with no credentials; the cover is read from the MP3's ID3 tag with a ranged request, only from the vault's Cloudinary folder, and falls back to the app icon. These routes take no token or origin check by design. `buildShareURL` (js/features/routes.js) points new share links at `SHARE_PREVIEW_ORIGIN`; localhost keeps local links, and links sent earlier still work without a preview. `cloudflare-worker/id3.js` is a marked copy of the parser in `js/data/artwork.js`; `tests/worker-share.test.js` fails if they drift, and runs the routes against a stubbed fetch. `cloudflare-worker/package.json` only sets `type: module` so the tests can import the worker modules. The share dialog offers the device share sheet (`navigator.share`, where available), Facebook, WhatsApp, X and Email.
- The worker also serves `POST /transcribe` (2026-10-04): JSON `{ audioURL }` for a file under `res.cloudinary.com/dtw4em0ob/` (anything else is refused, so it cannot be used to transcribe arbitrary URLs), or the audio itself as the body. It streams the audio to `@cf/openai/whisper-large-v3-turbo` through the `AI` binding in `wrangler.toml` and returns `{ words: [[text, start, end], ...], language, duration }`. Same origin allowlist and bearer token as the metadata route. Testing it with `wrangler dev --remote` picks up the deployed `SONICVAULT_CLIENT_TOKEN`; wrap the worker in a scratch script that blanks the token instead of touching the secret.
- Create routes (2026-10-04), same origin allowlist and bearer token: `POST /generate { title, style, lyrics, instrumental }` calls Gemini `models/lyria-3.5:generateContent` (override with the `LYRIA_MODEL` var; `lyria-3-clip-preview` makes 30s clips) with `responseModalities: ["AUDIO","TEXT"]`, and streams Google's JSON answer (base64 MP3 plus text parts holding the lyrics or a JSON song structure) straight back unparsed, so a few MB of base64 never costs worker CPU. The app reads it with `readLyriaResponse` / `lyricsFromLyriaText`. Needs the secret `GEMINI_API_KEY` (Google AI Studio, a project with billing on; about $0.08 a song at the time of writing); without it the route answers 501, which the Create page uses as its setup check. Google's errors come back as "Lyria request failed (status STATUS): reason", except the common ones, which are put in words: a key whose project has no billing (429 with a free-tier quota of `limit: 0` — the free tier cannot make Lyria songs at all; Google serves `lyria-3.5` as `lyria-3-pro` in its quota names), a rate limit (other 429s), and "busy" (503, which is retried once after 1.5s since it is immediate and unbilled). The raw reason stays in `details`. Never test `/generate` with `curl --retry`: curl retries 429/503 by itself and re-sends the (billable) request. `POST /lyrics { title, style, draft }` has Claude write or finish a sheet and returns `{ title, lyrics }`. `POST /cover { title, style }` runs `@cf/black-forest-labs/flux-1-schnell` (6 steps) on the `AI` binding and returns `{ mime, image }` in base64; the prompt asks for a painting of the title as a scene ("a scene of harbour lights") coloured by the description; asked for an "album cover" naming the title, FLUX lettered it on the picture, misspelt, despite "no text". `tests/worker-create.test.js` covers all three against stand-ins.
- The web UI's "AI endpoint" field (Import view) points at a Cloudflare Worker. When set, `requestRemoteAIMetadata` POSTs `{title, prompt, lyrics, model, fallback}` and expects the raw `ai*` metadata object back; when blank, SonicVault falls back to the local heuristic tagger (`buildLocalMetadataSuggestion`). Endpoint/token/model follow the owner's sign-in (2026-10-04): they are stored as `aiWorker: { endpoint, token, model, updatedAt }` in the private `settings` document (owner-only by firestore.rules, like the rest of the vault), with each browser's copy in `localStorage.sv_ai_config` for offline and signed-out use. `syncAIConfigWithVault` (js/features/ai-metadata.js, run from `refreshAll` and after an edit, debounced 800ms) compares the two with `resolveAIWorkerSync` (js/data/ai-config.js): only usable settings (an address set, `isUsableAIWorker`) ever move -- the first build also spread half-typed ones, so pasting a token before its address blanked the address in every other browser -- and between two usable copies the newer `updatedAt` wins; nothing is adopted while one of the fields has focus; a browser whose copy predates syncing (no `updatedAt`) seeds an empty vault and otherwise gives way; it waits for `window.svVaultSettingsLoaded`, set by `fbLoadAll`, so a cached copy can never push an old token over a newer one. Backups leave `aiWorker` out (`stripVaultSecrets`), and a restore keeps the vault's. Until then they lived in each browser only, so every new browser or device showed "not connected".
- Without the worker (2026-10-04): `buildLocalMetadataSuggestion` gives only what the words show -- genre, mood and energy from whole-word keyword hits (`hasKeyword`; it used to match inside words, so "turn" counted as "run"), a theme only with two keywords of it, tags only for content words used three or more times (number words excluded), and **no description**. It used to write a two-sentence review from templates, which called a reflective song about turning 47 "energetic synthwave" with "low energy" and a "coastal reset and night-drive escape" theme. Stored reviews of that kind (aiSource `local`, opening `"Title" lands as / leans into / plays like / reads like`) and the old filler sentence are dropped by `getTrackSummary` when read, so nothing in the vault needs rewriting. Basic suggestions never overwrite a description an AI wrote (`applyAIMetadataToDraft`, `hasAIDescription`). The edit dialog says when a browser has no worker, links to its settings, and labels its button for what it will do ("Describe with Claude" / "Suggest from the lyrics").
- Describing the vault (2026-10-04, `js/features/describe.js`, panel `#describe-panel` in the AI worker card): "Describe them" runs Claude over every song without an AI description (`needsDescription`: fallback-tagged songs and imports), one at a time in this tab with a 600ms gap, with progress and Stop; two failures with nothing described stop the run and show the worker's reason. New watcher imports (`isNewUndescribed`: never described, arrived in the last 14 days) are described without asking, 15s after a sync in a visible tab, unless `appSettings.autoDescribe === false` (the checkbox, synced). `describeTrackWithClaude` keeps what a person chose: a genre other than "Other", the mood, the cover style -- except on a raw watcher import (genre "Other", never described), whose "Energetic" is the watcher's placeholder.
- `cloudflare-worker/worker.js` calls the **Anthropic Messages API** (default model `claude-haiku-4-5`). Lyrics are optional so instrumentals and watcher imports can be tagged. Deploy with Wrangler and set secrets `ANTHROPIC_API_KEY` (required), optional `SONICVAULT_CLIENT_TOKEN` (bearer the UI must send) and `ALLOWED_ORIGIN` (comma-separated origin allowlist). The worker forces JSON via an assistant `"{"` prefill and validates the schema before returning.
- **DEPLOYED (2026-06-22):** live at **`https://sonicvault-ai.bobbynacario.workers.dev`** (Cloudflare account `bobbynacario@gmail.com`). Both secrets are set; `ALLOWED_ORIGIN` is locked to the Pages origin + localhost. To use it, paste that URL into the app's Import → "AI endpoint" field and the client token into "AI bearer token" (stored with the vault's private settings and in `localStorage.sv_ai_config`; see above).
  - Worker name is `sonicvault-ai`, NOT `sonicvault-metadata`. The original `sonicvault-metadata` hostname got stuck behind a hostname-specific Cloudflare **Zero Trust Access** policy (302 → `bobbynacario.cloudflareaccess.com`) that couldn't be removed without activating a Zero Trust plan. Renaming the worker sidestepped it. The orphaned `sonicvault-metadata` worker + its Access app are unused/harmless; delete them later if desired. If you ever re-add a custom name, verify it isn't Access-gated with a quick `curl`.

## Known Issues (measured, not yet fixed)
These are data-layer problems the UI work did not touch:
1. **Firestore 1 MiB doc ceiling.** Tracks are one JSON string in one doc at ~1,419 bytes/track → a hard cliff at ~738 tracks (realistically 400–600 with longer lyric sheets). Past it `setDoc` throws, `fbSave` catches it, and the only signal is the status pill reading "Save failed" while localStorage keeps diverging. Also: every play increments `plays` and rewrites the entire library.
2. **Non-transactional read-modify-write.** `watcher.js` does `get()` → concat → `set()` with no transaction while the web app writes the whole array. A watcher import landing during a play-count write silently clobbers one or the other. Fix with `runTransaction`, or move to per-track docs (which also fixes #1).
3. **Public collections allow `list`, not just `get`.** `allow read: if true` on `sonicvault-public-*` covers both, so the entire shared catalog is enumerable — every prompt, lyrics excerpt, and audio URL — not just links that were sent out. Should be `allow get: if true; allow list: if isSonicVaultOwner();`
4. **Cloudinary orphans.** Deleting a track never deletes the audio (the unsigned preset cannot). Every delete leaks ~4MB of the 25GB plan. Upload dedupe only checks the pending queue, not the existing vault, so re-dropping an imported file uploads a second copy.
5. **AI worker has no rate limit or spend cap.** `isAuthorized` passes when no token is set and the origin check is trivially forged by a non-browser client, so a leaked bearer token means unmetered Anthropic spend.

## Planned Features (Priority Order)
1. Suno API auto-sync (when API becomes publicly available)
2. Export playlist as downloadable ZIP of MP3s
3. ~~Claude-powered auto-tagging~~ — DONE (2026-06-22): `cloudflare-worker/worker.js` now runs the Anthropic API; the upload editor and the new edit-track modal both call it.

## Developer Context
- Developer works in a Windows environment
- App is personal use (single user: "Bob")
- No authentication — Firestore rules are open for the `sonicvault-bob` path
- Three apps share one Firebase project: PokerHQ (`pokerhq-bob/`), Daily Briefer (`briefings-bob/`), SonicVault (`sonicvault-bob/`)
- Developer's timezone: PHT (Philippine Time)

## How to Work on This
1. The web app is `index.html` + `styles/app.css` + `js/` (see **Code Layout**). Put new logic in the feature file it belongs to; pure, DOM-free helpers go in `js/data/` with a test.
2. Edit, run `npm test`, bump the `?v=` token in `index.html`, commit, push to GitHub Pages — that's the deploy
3. Firebase Firestore and Cloudinary are already configured — no setup needed
4. Test locally through a server, not `file://` — browsers refuse to load `js/app.js` as a module from `file://`, so sync would silently stay off. `npx http-server -c-1 .` (the `.claude/launch.json` config) serves it on localhost.
5. Keep the vanilla, buildless approach — DO NOT introduce bundlers, transpilers, React, or any framework
6. Follow the existing code style: `var` declarations, function expressions, DOM manipulation via `getElementById` and `innerHTML`
7. All new features should use the existing `save(key, val)` / `load(key, def)` pattern for persistence
8. New tracks must use `audioURL` (Cloudinary link) — never write `audioData` (base64) to Firestore
## Share + Security Notes
- Public share routes now use dedicated Firestore collections:
  - `sonicvault-public-tracks`
  - `sonicvault-public-playlists`
- The private owner data remains in:
  - `sonicvault-bob/tracks`
  - `sonicvault-bob/playlists`
  - `sonicvault-bob/settings`
- `firestore.rules` carries the FULL project ruleset (Daily Briefer + PokerHQ + SonicVault) with the owner email set to `bobbynacario@gmail.com`. Unauthenticated reads of `sonicvault-bob` return 403; public share collections remain world-readable.
- The repo has `firebase.json` + `.firebaserc` so rule deploys are just `firebase deploy --only firestore:rules` (or `./deploy-rules.ps1`).
- IMPORTANT: because Firestore deploys ALL rules at once, `firestore.rules` here includes the PokerHQ and Daily Briefer blocks. Never trim it back to SonicVault-only rules.

### Rule ownership is CENTRALIZED here (2026-06-22)
Because the three apps share one Firestore database, they share one ruleset — any deploy replaces it for all of them. On 2026-06-11 a PokerHQ-only deploy from the pokerhq repo clobbered the project ruleset and locked SonicVault + Daily Briefer out ("ERR Blocked: bobbynacario@gmail.com"). To stop this for good, rule ownership now lives in ONE place instead of three identical copies:
- **`sonicvault/firestore.rules` is the single source of truth.** It is the only file where any app's rules are edited and the only repo that deploys them. Deploy via `./deploy-rules.ps1`.
- **The `pokerhq` and `bobdailybriefing` repos must NOT deploy Firestore rules.** Remove the `"firestore"` block from each of their `firebase.json` files so a stray `firebase deploy` there can't touch rules, and treat any leftover rules file in those repos as stale/reference-only.
- When ANY app's rules change — PokerHQ or Daily Briefer included — edit them HERE and deploy from HERE.
- (Enclave is a *separate* Firebase project and is unaffected by this ruleset.)
- After this change, the web app must be signed in (Owner button, Google account `bobbynacario@gmail.com`) on each device to read/write the private vault. The watcher is unaffected (Admin SDK bypasses rules).

## Cloudinary Hardening
- The web UI still uses an unsigned preset because GitHub Pages cannot safely mint signed uploads client-side.
- Tighten the `sonicvault_web` preset in Cloudinary:
  - lock it to the `sonicvault-bob/audio` folder
  - allow only `mp3`, `wav`, and `m4a`
  - cap file size at 100MB
  - disable overwrite
  - disable any transformations that are not required
  - restrict allowed origins if your Cloudinary plan supports it
- If you later add a tiny signed upload endpoint, move the web UI off the unsigned preset entirely.
