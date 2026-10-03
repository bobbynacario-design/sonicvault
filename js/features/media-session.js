// The OS media controls: lock-screen artwork, metadata, position, and the
// hardware play/pause/seek handlers.

var _mediaSessionActionBound = false;
var _mediaSessionArtworkCache = {};

function getQueueContextLabel() {
  if (_playQueueLabel) return _playQueueLabel;
  if (_currentTrack && _currentTrack.source) return _currentTrack.source;
  return 'SonicVault';
}

function buildMediaSessionArtwork(track, size) {
  var style = getCoverStyle(track || {});
  var key = (track && track.id || 'vault') + ':' + style + ':' + size;
  if (_mediaSessionArtworkCache[key]) return _mediaSessionArtworkCache[key];

  var palette = getTrackPalette(track || {});
  var label = getTrackMonogram(track && track.title);
  var source = track && track.source ? String(track.source).toUpperCase() : 'SONICVAULT';
  var mood = track && (track.mood || track.genre) ? String(track.mood || track.genre).toUpperCase() : 'CURATED';

  try {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (ctx) {
      var grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, palette.a);
      grad.addColorStop(.55, palette.b);
      grad.addColorStop(1, palette.c);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      for (var i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(
          size * (style === 'vinyl' ? 0.5 : (0.18 + i * 0.17)),
          size * (style === 'vinyl' ? 0.5 : (0.22 + (i % 2) * 0.12)),
          size * (style === 'vinyl' ? (0.1 + i * 0.07) : (0.22 + i * 0.015)),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = Math.max(2, size * 0.012);
      if (style === 'prism' || style === 'poster') {
        ctx.beginPath();
        ctx.moveTo(size * 0.12, size * 0.18);
        ctx.lineTo(size * 0.84, size * 0.12);
        ctx.lineTo(size * 0.72, size * 0.84);
        ctx.lineTo(size * 0.18, size * 0.76);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.strokeRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '700 ' + Math.round(size * 0.26) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, size / 2, size * 0.54);

      ctx.font = '600 ' + Math.round(size * 0.06) + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(source, size * 0.1, size * 0.16);
      ctx.textAlign = 'right';
      ctx.fillText(mood.slice(0, 10), size * 0.9, size * 0.88);

      _mediaSessionArtworkCache[key] = canvas.toDataURL('image/png');
      return _mediaSessionArtworkCache[key];
    }
  } catch (e) {}

  var svg = ''
    + '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">'
    + '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="' + palette.a + '"/><stop offset="55%" stop-color="' + palette.b + '"/><stop offset="100%" stop-color="' + palette.c + '"/></linearGradient></defs>'
    + '<rect width="' + size + '" height="' + size + '" fill="url(#g)"/>'
    + '<rect x="' + Math.round(size * 0.08) + '" y="' + Math.round(size * 0.08) + '" width="' + Math.round(size * 0.84) + '" height="' + Math.round(size * 0.84) + '" fill="none" stroke="rgba(255,255,255,0.26)"/>'
    + '<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="' + Math.round(size * 0.26) + '" font-family="Arial" font-weight="700" fill="white">' + esc(label) + '</text>'
    + '</svg>';
  _mediaSessionArtworkCache[key] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return _mediaSessionArtworkCache[key];
}

function getMediaSessionArtworkList(track) {
  // The real cover once its data URL is ready (Suno's are 360px); the
  // generated one until then and for tracks without art.
  var artData = track && track.id ? getArtDataURL(track.id) : '';
  if (artData) {
    return [{ src:artData, sizes:'360x360', type:artData.slice(5, artData.indexOf(';')) || 'image/jpeg' }];
  }
  return [96, 192, 256, 384, 512].map(function(size) {
    return {
      src: buildMediaSessionArtwork(track, size),
      sizes: size + 'x' + size,
      type: 'image/png'
    };
  });
}

function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  } catch (e) {}
}

function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator) || !_currentTrack) return;
  if (typeof navigator.mediaSession.setPositionState !== 'function') return;
  var duration = Number(_audio.duration || _currentTrack.duration || 0);
  if (!duration || !isFinite(duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: duration,
      playbackRate: _audio.playbackRate || 1,
      position: Math.min(duration, Math.max(0, Number(_audio.currentTime || 0)))
    });
  } catch (e) {}
}

function bindMediaSessionActions() {
  if (!('mediaSession' in navigator) || _mediaSessionActionBound) return;
  var actions = {
    play: function() { if (!_currentTrack) togglePlayback(); else if (!_isPlaying) togglePlayback(); },
    pause: function() { if (_isPlaying) togglePlayback(); },
    previoustrack: function() { playPrevious(); },
    nexttrack: function() { playNext(); },
    seekbackward: function(details) {
      if (!_currentTrack) return;
      var offset = details && details.seekOffset ? details.seekOffset : 10;
      _audio.currentTime = Math.max(0, Number(_audio.currentTime || 0) - offset);
      updateMediaSessionPosition();
    },
    seekforward: function(details) {
      if (!_currentTrack) return;
      var offset = details && details.seekOffset ? details.seekOffset : 10;
      var duration = Number(_audio.duration || _currentTrack.duration || 0);
      _audio.currentTime = duration ? Math.min(duration, Number(_audio.currentTime || 0) + offset) : Number(_audio.currentTime || 0) + offset;
      updateMediaSessionPosition();
    },
    seekto: function(details) {
      if (!_currentTrack || !details || typeof details.seekTime !== 'number') return;
      var duration = Number(_audio.duration || _currentTrack.duration || 0);
      var target = duration ? Math.min(duration, Math.max(0, details.seekTime)) : Math.max(0, details.seekTime);
      if (details.fastSeek && typeof _audio.fastSeek === 'function') {
        _audio.fastSeek(target);
      } else {
        _audio.currentTime = target;
      }
      updateMediaSessionPosition();
    }
  };

  Object.keys(actions).forEach(function(name) {
    try {
      navigator.mediaSession.setActionHandler(name, actions[name]);
    } catch (e) {}
  });
  _mediaSessionActionBound = true;
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  bindMediaSessionActions();
  if (!_currentTrack) {
    clearMediaSession();
    return;
  }

  var artist = _currentTrack.artist || _currentTrack.source || 'SonicVault';
  var album = getQueueContextLabel();
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: _currentTrack.title || 'Untitled release',
      artist: artist,
      album: album,
      artwork: getMediaSessionArtworkList(_currentTrack)
    });
  } catch (e) {}

  try {
    navigator.mediaSession.playbackState = _isPlaying ? 'playing' : 'paused';
  } catch (e) {}
  updateMediaSessionPosition();
}
