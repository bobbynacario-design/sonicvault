# SonicVault — Claude Code Handover

## What This Is
SonicVault is a personal music curation web app for managing AI-generated songs (primarily from Suno). It's a single-file vanilla HTML/CSS/JS app deployed on GitHub Pages with Firebase (Firestore) + Cloudinary backend. Built to match the architecture of an existing app (PokerHQ) by the same developer.

## Repository Setup
- **Hosting:** GitHub Pages (static single-file deployment)
- **Structure:** Single `index.html` file — all HTML, CSS, and JS in one file
- **No build tools** — no npm, no bundler, no React. Pure vanilla.
- **Watcher:** `watcher.js` — separate Node.js script, runs locally, NOT deployed to GitHub Pages

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
// In index.html (web UI — unsigned upload via preset)
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
- `saveTrack()` is async — uploads first, then saves metadata to Firestore

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
- Primary buttons are solid white pills with dark text (inverted to dark pills in light theme). Coral/accent lives in highlights, blooms, and waveforms — not CTAs.
- Waveforms and progress fills use a violet-to-accent gradient.
- Interior card elements are borderless (typographic pills/tags, ghost secondary buttons); only outer structural cards keep 1px rims.

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
- [x] REAL waveforms: peaks decoded from the actual audio (Web Audio API). Decoded at upload time from the in-memory file, on first play, and via a one-time background sweep (`sweepWaveformBackfill`) for older tracks. Stored in `appSettings.waveformCache[trackId]` (72 floats) and stamped on `track.peaks` so share payloads carry them. Legacy random `track.waveform` is ignored by the UI; the watcher's random waveform gets replaced on first play/sweep.
- [x] Now-playing bar with seek/progress
- [x] Auto-advance to next track
- [x] Shuffle mode (Fisher-Yates over the active queue, current track pinned first)
- [x] Repeat modes: off / queue / one
- [x] Volume slider + playback speed cycle (0.75x-2x) in the expanded player
- [x] Player prefs persisted device-locally in `sv_player_prefs` (not synced to Firestore)
- [x] Library view with search and genre filtering
- [x] Track detail expansion (click to reveal Suno prompt)
- [x] Edit-track modal (`openEditTrack` → `#modal-edit-track`) — edit title/genre/mood/source/prompt/lyrics on tracks already in the vault (including watcher imports that arrived without lyrics), with an inline "Generate AI metadata" button that reuses the same remote-or-local engine as the upload editor. Explicit form values always win over AI suggestions on save.
- [x] Keyboard shortcuts — global `keydown` handler (skipped while typing in a field; dialogs swallow shortcuts but Escape still closes them). Space/K play-pause, J/L ±10s, ←/→ ±5s, ↑/↓ volume, N/P next/prev, S shuffle, R repeat, M mute, `/` jump-to-search, 1/2/3 switch views, `?` opens the shortcuts overlay (`#modal-shortcuts`), Esc closes dialogs/expanded tracks. Also reachable via the "Keys" button in the nav.
- [x] Playlists — create, view, delete, with track selection
- [x] Share modal with copy link, Twitter, WhatsApp, Email
- [x] Dark/light theme toggle (persisted)
- [x] Mobile responsive with bottom nav
- [x] PWA manifest
- [x] Offline support with queue-based sync
- [x] Service worker (`sw.js`) — offline app shell, cached fonts/Firebase SDK, last 30 played Cloudinary audio files cached with Range support. Shell is network-first so a normal deploy still propagates on the next online load; bump `VERSION` in `sw.js` only when cache logic changes.
- [x] Suno folder watcher (`watcher.js`) — auto-imports downloads to Cloudinary + Firestore

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
- The web UI's "AI endpoint" field (Import view) points at a Cloudflare Worker. When set, `requestRemoteAIMetadata` POSTs `{title, prompt, lyrics, model, fallback}` and expects the raw `ai*` metadata object back; when blank, SonicVault falls back to the local heuristic tagger (`buildLocalMetadataSuggestion`). Endpoint/token/model live in `localStorage` (`sv_ai_config`) only — never written to Firestore.
- `cloudflare-worker/worker.js` calls the **Anthropic Messages API** (default model `claude-haiku-4-5`). Lyrics are optional so instrumentals and watcher imports can be tagged. Deploy with Wrangler and set secrets `ANTHROPIC_API_KEY` (required), optional `SONICVAULT_CLIENT_TOKEN` (bearer the UI must send) and `ALLOWED_ORIGIN` (comma-separated origin allowlist). The worker forces JSON via an assistant `"{"` prefill and validates the schema before returning.

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
1. The entire web app is ONE file: `index.html`
2. Edit the file, commit, push to GitHub Pages — that's the deploy
3. Firebase Firestore and Cloudinary are already configured — no setup needed
4. Test locally by opening `index.html` in a browser (Firestore will connect, Cloudinary uploads will work)
5. Keep the single-file vanilla approach — DO NOT introduce build tools, npm, React, or any framework
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
- DONE (2026-06-11): `firestore.rules` now carries the FULL project ruleset (Daily Briefer + PokerHQ + SonicVault) with the owner email set to `bobbynacario@gmail.com`, and was deployed via `firebase deploy --only firestore:rules`. Unauthenticated reads of `sonicvault-bob` return 403; public share collections remain world-readable.
- The repo also has `firebase.json` + `.firebaserc` so future rule deploys are just `firebase deploy --only firestore:rules`.
- IMPORTANT: because Firestore deploys ALL rules at once, `firestore.rules` here includes the PokerHQ and Daily Briefer blocks. Never trim it back to SonicVault-only rules.
- THIS HAS ALREADY GONE WRONG ONCE (2026-06-11): a PokerHQ-only rules deploy from the pokerhq repo replaced the project ruleset and locked SonicVault (and Daily Briefer) out — the app showed "ERR Blocked: bobbynacario@gmail.com" even for the owner. The canonical merged ruleset now lives identically in `sonicvault/firestore.rules`, `pokerhq/deploy/firestore.rules`, and `bobdailybriefing/firestore.rules`. If you change rules for ANY app, update all three copies and deploy the full merged file.
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
