'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────
const WATCH_FOLDER    = process.env.SUNO_WATCH_FOLDER || 'C:\\Users\\BobbyNacario\\Downloads\\Suno';
const FILE_EXTENSIONS = ['.mp3', '.wav', '.m4a'];
const COLLECTION      = 'sonicvault-bob';
const STORAGE_PATH    = 'sonicvault-bob/audio';
const DEBOUNCE_MS     = 2000;  // wait for file to finish writing
const SIZE_STABLE_MS  = 1500;  // re-check after this delay to confirm size is stable

// ─── Service account ─────────────────────────────────────────────────────────
// Place your Firebase Admin service account JSON in this folder and name it:
//   serviceAccount.json
// (or the raw downloaded filename — both are .gitignored)
var serviceAccount;
try {
  serviceAccount = require('./serviceAccount.json');
} catch (e) {
  // Try the raw downloaded filename if present
  var fs = require('fs');
  var path = require('path');
  var files = fs.readdirSync(__dirname).filter(function(f) {
    return f.includes('firebase-adminsdk') && f.endsWith('.json');
  });
  if (files.length === 0) {
    console.error('[SonicVault Watcher] ERROR: No service account JSON found.');
    console.error('  Place serviceAccount.json in this folder and run again.');
    process.exit(1);
  }
  serviceAccount = require(path.join(__dirname, files[0]));
  console.log('[SonicVault Watcher] Using service account: ' + files[0]);
}

// ─── Firebase Admin init ─────────────────────────────────────────────────────
var admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'pokerhq-a67e4.firebasestorage.app'
});
var db     = admin.firestore();
var bucket = admin.storage().bucket();

// ─── Helpers ─────────────────────────────────────────────────────────────────
var fs   = require('fs');
var path = require('path');

function timestamp() {
  return '[' + new Date().toLocaleTimeString('en-US', { hour12: false }) + ']';
}

function log(msg) {
  console.log(timestamp() + ' ' + msg);
}

function formatBytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function cleanTitle(filename) {
  var name = path.basename(filename, path.extname(filename));

  // Remove leading 10+ digit numeric IDs (Suno download format)
  name = name.replace(/^\d{10,}[-_]?/, '');

  // Remove common Suno suffixes
  name = name.replace(/\s*[-–]\s*suno\s*ai\s*$/i, '');
  name = name.replace(/\s*[-–]\s*suno\s*$/i, '');
  name = name.replace(/\s*\(suno.*?\)\s*$/i, '');

  // Replace hyphens and underscores with spaces
  name = name.replace(/[-_]+/g, ' ').trim();

  // Title case
  name = name.replace(/\w\S*/g, function(word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  return name || 'Untitled';
}

function generateWaveform() {
  var waveform = [];
  for (var i = 0; i < 48; i++) {
    waveform.push(Math.round((0.15 + Math.random() * 0.85) * 100) / 100);
  }
  return waveform;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Wait until a file's size stops changing (confirms download finished)
function waitForStableSize(filePath, cb) {
  var size1 = -1;
  try { size1 = fs.statSync(filePath).size; } catch (e) { return cb(new Error('Cannot stat file')); }

  setTimeout(function() {
    var size2 = -1;
    try { size2 = fs.statSync(filePath).size; } catch (e) { return cb(new Error('Cannot stat file')); }

    if (size1 === size2 && size2 > 0) {
      cb(null, size2);
    } else {
      log('File still writing, waiting...');
      waitForStableSize(filePath, cb);
    }
  }, SIZE_STABLE_MS);
}

async function extractDuration(filePath) {
  try {
    var mm = require('music-metadata');
    var metadata = await mm.parseFile(filePath, { duration: true });
    return Math.round(metadata.format.duration || 0);
  } catch (e) {
    return 0;
  }
}

// ─── Core: process a new file ─────────────────────────────────────────────────
var processing = {};  // debounce guard

async function processFile(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (!FILE_EXTENSIONS.includes(ext)) return;

  // Debounce — skip if already processing this path
  if (processing[filePath]) return;
  processing[filePath] = true;

  var filename = path.basename(filePath);
  log('New file detected: ' + filename);

  // Wait for stable file size
  waitForStableSize(filePath, async function(err, fileSize) {
    if (err) {
      log('WARNING: Could not read file, skipping: ' + filename);
      delete processing[filePath];
      return;
    }

    log(filename + ' (' + formatBytes(fileSize) + ') — uploading to Firebase Storage...');

    try {
      // Generate track ID
      var trackId   = 't-' + Date.now();
      var storageName = trackId + '_' + filename.replace(/\s+/g, '-');
      var destPath  = STORAGE_PATH + '/' + storageName;

      // Extract audio duration
      var duration = await extractDuration(filePath);

      // Upload to Firebase Storage
      var fileBuffer = fs.readFileSync(filePath);
      var fileRef    = bucket.file(destPath);

      await fileRef.save(fileBuffer, {
        metadata: {
          contentType: ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'audio/mp4'
        }
      });

      // Make the file publicly accessible and get download URL
      await fileRef.makePublic();
      var downloadURL = 'https://storage.googleapis.com/' + bucket.name + '/' + destPath;

      log('Upload complete → ' + downloadURL);

      // Build track object
      var title = cleanTitle(filename);
      var track = {
        id:           trackId,
        title:        title,
        genre:        'Other',
        mood:         'Energetic',
        source:       'Suno',
        prompt:       '',
        audioURL:     downloadURL,
        duration:     duration,
        waveform:     generateWaveform(),
        created:      todayISO(),
        plays:        0,
        shared:       false,
        fileSize:     fileSize,
        fileName:     filename,
        autoImported: true
      };

      // Load existing tracks from Firestore, prepend new track, save back
      var docRef   = db.collection(COLLECTION).doc('tracks');
      var docSnap  = await docRef.get();
      var existing = [];

      if (docSnap.exists) {
        try { existing = JSON.parse(docSnap.data().value) || []; } catch (e) { existing = []; }
      }

      var updated = [track].concat(existing);

      await docRef.set({
        value:   JSON.stringify(updated),
        updated: admin.firestore.FieldValue.serverTimestamp()
      });

      log('Track "' + title + '" added to SonicVault ✓');

      // Move to imported/ subfolder
      var importedDir = path.join(path.dirname(filePath), 'imported');
      if (!fs.existsSync(importedDir)) fs.mkdirSync(importedDir);
      var dest = path.join(importedDir, filename);
      // Avoid collisions if same filename exists
      if (fs.existsSync(dest)) {
        dest = path.join(importedDir, trackId + '_' + filename);
      }
      fs.renameSync(filePath, dest);
      log('Moved to imported/');

    } catch (e) {
      log('ERROR processing ' + filename + ': ' + e.message);
      console.error(e);
    }

    delete processing[filePath];
  });
}

// ─── Watcher setup ───────────────────────────────────────────────────────────
var chokidar = require('chokidar');

// Ensure watch folder exists
if (!fs.existsSync(WATCH_FOLDER)) {
  fs.mkdirSync(WATCH_FOLDER, { recursive: true });
  console.log('[SonicVault Watcher] Created watch folder: ' + WATCH_FOLDER);
}

console.log('[SonicVault Watcher] Monitoring: ' + WATCH_FOLDER);
console.log('[SonicVault Watcher] Ready — drop Suno downloads here');
console.log('');

var watcher = chokidar.watch(WATCH_FOLDER, {
  ignored:        [/(^|[/\\])\../, /[/\\]imported[/\\]/],  // ignore dotfiles and imported/ subfolder
  ignoreInitial:  true,   // don't process files already there at startup
  persistent:     true,
  awaitWriteFinish: {
    stabilityThreshold: DEBOUNCE_MS,
    pollInterval:       500
  }
});

watcher.on('add', function(filePath) {
  processFile(filePath);
});

watcher.on('error', function(err) {
  console.error('[SonicVault Watcher] Watcher error:', err);
});

process.on('SIGINT', function() {
  console.log('\n[SonicVault Watcher] Stopped.');
  watcher.close();
  process.exit(0);
});
