# SonicVault — Suno Folder Watcher

## What to Build
A Node.js script (`watcher.js`) that monitors a folder on Bob's Windows machine for new audio files (MP3/WAV). When a new file appears, it automatically:
1. Uploads the audio to Firebase Storage (`sonicvault-bob/audio/`)
2. Creates a track metadata entry in Firestore (`sonicvault-bob/tracks`)
3. SonicVault's real-time `onSnapshot` listener picks it up instantly — no manual upload needed

## User Workflow After This
```
Suno website → Click "Download MP3" → File lands in watched folder → Auto-imported into SonicVault
```

## Technical Spec

### File: `watcher.js` (Node.js script, runs locally on Windows)

### Dependencies
- `firebase-admin` — server-side Firebase SDK (uses service account, not browser auth)
- `chokidar` — cross-platform file watcher (better than fs.watch on Windows)
- `music-metadata` — extract duration from audio files (optional but nice)

### Setup: `package.json`
```json
{
  "name": "sonicvault-watcher",
  "version": "1.0.0",
  "scripts": {
    "watch": "node watcher.js"
  },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "chokidar": "^3.6.0",
    "music-metadata": "^7.14.0"
  }
}
```

### Config at top of `watcher.js`
```javascript
const WATCH_FOLDER = process.env.SUNO_WATCH_FOLDER || 'C:\\Users\\Bob\\Downloads\\Suno';
const FILE_EXTENSIONS = ['.mp3', '.wav', '.m4a'];
const FIRESTORE_COLLECTION = 'sonicvault-bob';
const STORAGE_PATH = 'sonicvault-bob/audio';
const DEBOUNCE_MS = 2000; // Wait for file to finish writing
```

### Firebase Admin Init
Use a service account JSON file. Bob will need to:
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate New Private Key"
3. Save as `serviceAccount.json` in the watcher folder
4. Add `serviceAccount.json` to `.gitignore`

```javascript
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'pokerhq-a67e4.firebasestorage.app'
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
```

### Core Logic Flow
```
1. chokidar watches WATCH_FOLDER for new files matching FILE_EXTENSIONS
2. On 'add' event → wait DEBOUNCE_MS (file might still be downloading)
3. Verify file is complete (check file size is stable)
4. Extract duration using music-metadata
5. Generate trackId: 't-' + Date.now()
6. Upload file to Firebase Storage: STORAGE_PATH/{trackId}_{filename}
7. Get download URL
8. Build track metadata object (auto-detect genre/mood from filename if possible)
9. Load current tracks array from Firestore doc
10. Prepend new track to array
11. Save back to Firestore
12. Log success to console
13. Optionally move processed file to a 'processed' subfolder
```

### Track Metadata (auto-generated)
```javascript
{
  id: trackId,
  title: filename without extension (cleaned up — remove Suno's default naming junk),
  genre: "Other",           // Default — user can edit in SonicVault UI later
  mood: "Energetic",        // Default
  source: "Suno",           // Auto-set since it's from the watcher
  prompt: "",               // Empty — user can add in UI
  audioURL: downloadURL,    // From Firebase Storage
  duration: extractedDuration,
  waveform: Array of 48 random floats 0.15-1.0,
  created: today's date (YYYY-MM-DD),
  plays: 0,
  shared: false,
  fileSize: file size in bytes,
  fileName: original filename,
  autoImported: true         // Flag so UI can show these differently if needed
}
```

### Title Cleanup Logic
Suno downloads often have names like `"Neon Highways - Suno AI.mp3"` or `"1234567890-neon-highways.mp3"`. Clean up:
- Remove " - Suno AI", " - Suno", "- suno" suffixes
- Remove leading numeric IDs (if filename starts with 10+ digits)
- Replace hyphens/underscores with spaces
- Title case the result

### Console Output
```
[SonicVault Watcher] Monitoring: C:\Users\Bob\Downloads\Suno
[SonicVault Watcher] Ready — drop Suno downloads here

[14:32:05] New file detected: Neon Highways - Suno AI.mp3 (4.2MB)
[14:32:07] Uploading to Firebase Storage...
[14:32:12] Upload complete → https://firebasestorage.googleapis.com/...
[14:32:12] Track "Neon Highways" added to SonicVault ✓
```

### Error Handling
- If Firebase upload fails → log error, leave file in place, retry on next run
- If file is not a valid audio file → skip, log warning
- If Firestore read/write fails → log error, don't lose the upload URL
- If watched folder doesn't exist → create it and log a message

### Optional: Processed File Handling
After successful import, move the file to `WATCH_FOLDER/imported/` subfolder so the watcher doesn't re-process it. Keep originals as backup.

### How to Run
```bash
cd sonicvault
npm install
npm run watch
```

Or to run in background on Windows:
```bash
# Using pm2 (optional)
npx pm2 start watcher.js --name sonicvault-watcher

# Or just keep a terminal open
node watcher.js
```

### Files to Create
```
sonicvault/
  index.html                  ← existing app (don't touch)
  SONICVAULT-HANDOVER.md      ← existing context doc
  watcher.js                  ← NEW: the watcher script
  package.json                ← NEW: dependencies
  serviceAccount.json         ← NEW: Firebase admin credentials (gitignored)
  .gitignore                  ← NEW or updated: exclude serviceAccount.json and node_modules
```

### .gitignore
```
node_modules/
serviceAccount.json
```

### IMPORTANT NOTES
- This is a LOCAL script, not part of the GitHub Pages deployment
- `index.html` stays untouched — the watcher writes directly to Firebase, and SonicVault's existing onSnapshot listener picks up changes automatically
- The watcher uses Firebase Admin SDK (server-side) while the web app uses the client SDK — both talk to the same Firestore/Storage, no conflicts
- Keep the single-file vanilla approach for the web app — the watcher is a separate Node.js utility
