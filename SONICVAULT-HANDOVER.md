# SonicVault — Claude Code Handover

## What This Is
SonicVault is a personal music curation web app for managing AI-generated songs (primarily from Suno). It's a single-file vanilla HTML/CSS/JS app deployed on GitHub Pages with Firebase backend. Built to match the architecture of an existing app (PokerHQ) by the same developer.

## Repository Setup
- **Hosting:** GitHub Pages (static single-file deployment)
- **Structure:** Single `index.html` file — all HTML, CSS, and JS in one file
- **No build tools** — no npm, no bundler, no React. Pure vanilla.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS, no frameworks
- **Fonts:** Bebas Neue (display), DM Sans (body), DM Mono (mono/labels) — loaded via Google Fonts CDN
- **Backend:** Firebase (shared project with PokerHQ and Daily Briefer apps)
  - **Firestore** — metadata storage (tracks, playlists, settings) under collection `sonicvault-bob`
  - **Firebase Storage** — audio file storage under path `sonicvault-bob/audio/`
  - **Real-time sync** via `onSnapshot` listeners
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
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
```

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
  audioURL: "https://firebasestorage.googleapis.com/...",  // Firebase Storage download URL
  duration: 194,            // seconds (detected on upload)
  waveform: [0.2, 0.8, ...], // array of 48 floats 0-1 (randomly generated on upload)
  created: "2026-03-15",
  plays: 142,
  shared: false,
  fileSize: 4200000,        // bytes
  fileName: "neon-highways.mp3"
}
```

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

## Firebase Storage Structure
```
sonicvault-bob/
  audio/
    t-1711700000000_neon-highways.mp3
    t-1711700000001_midnight-garden.mp3
```

## Key Architecture Patterns

### Save Pattern (matching PokerHQ)
```javascript
function save(key, val) {
  localStorage.setItem('sv_'+key, JSON.stringify(val));
  // Strip audioData from tracks before Firestore save
  var cleanVal = val;
  if (key === 'tracks' && Array.isArray(val)) {
    cleanVal = val.map(function(t) {
      var copy = Object.assign({}, t);
      delete copy.audioData; // legacy base64 removal
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
- Plays from `track.audioURL` (Firebase Storage) with fallback to legacy `track.audioData` (base64)
- Waveform visualization via div bars with CSS classes `wbar-active` / `wbar-inactive`
- Now-playing bar fixed to bottom with seek, progress, play/pause

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

### Design Conventions (matching PokerHQ)
- Monospace uppercase labels for metadata (font-family:var(--mono); font-size:9-11px; letter-spacing:.08-.14em)
- Card-based UI with 12-14px border-radius, 1px solid var(--rim) borders
- Modals: overlay with `.modal-overlay.open` display toggle
- Buttons: `.sec-action` base class, `.sec-action.primary` for CTA
- Delete buttons: `.del-btn` — transparent bg, red on hover
- Toast notifications via `#sv-toast` element
- Genre colors mapped in `getGenreColor()` function

## Current Features (V1 + V2)
- [x] Audio upload with drag-and-drop (MP3/WAV, up to 50MB)
- [x] Firebase Storage for audio files with upload progress bar
- [x] Firestore metadata sync with real-time cross-device updates
- [x] Audio playback with waveform visualization
- [x] Now-playing bar with seek/progress
- [x] Auto-advance to next track
- [x] Library view with search and genre filtering
- [x] Track detail expansion (click to reveal Suno prompt)
- [x] Playlists — create, view, delete, with track selection
- [x] Share modal with copy link, Twitter, WhatsApp, Email
- [x] Dark/light theme toggle (persisted)
- [x] Mobile responsive with bottom nav
- [x] PWA manifest
- [x] Offline support with queue-based sync

## Planned Features (Priority Order)
1. ~~Firebase Storage for audio~~ ✅ Done
2. Suno API auto-sync (when API becomes publicly available)
3. Export playlist as downloadable ZIP of MP3s
4. Claude-powered auto-tagging (analyze prompt to suggest genre/mood)

## Developer Context
- Developer works in a Windows environment
- App is personal use (single user: "Bob")
- No authentication — Firestore/Storage rules are open for the `sonicvault-bob` path
- Three apps share one Firebase project: PokerHQ (`pokerhq-bob/`), Daily Briefer (`briefings-bob/`), SonicVault (`sonicvault-bob/`)
- Developer's timezone: PHT (Philippine Time)

## How to Work on This
1. The entire app is ONE file: `index.html`
2. Edit the file, commit, push to GitHub Pages — that's the deploy
3. Firebase is already configured and running — no setup needed
4. Test locally by just opening `index.html` in a browser (Firebase will connect)
5. Keep the single-file vanilla approach — DO NOT introduce build tools, npm, React, or any framework
6. Follow the existing code style: `var` declarations, function expressions, DOM manipulation via `getElementById` and `innerHTML`
7. All new features should use the existing `save(key, val)` / `load(key, def)` pattern for persistence
