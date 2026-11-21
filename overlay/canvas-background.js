/*
 * SpotyDesk Canvas background extension for Peekabu411 Turntable.
 * Reads existing Spotify playback state; never requests or stores Spotify OAuth/session secrets.
 * Requires an independently hosted, CORS-enabled Canvas API. Canvas is not in Spotify Web API.
 */
(() => {
  'use strict';
  if (window.turntableCanvasBackground) return;

  const LOCAL_PREFERENCE = 'spotydesk.canvas.enabled.v1';
  let root = null;
  let video = null;
  // Public API URL is embedded in the deployed script as a fallback when
  // Android serves an outdated or unavailable canvas-config.json.
  const DEFAULT_CANVAS_ENDPOINT = 'https://spot-omega-sandy.vercel.app/api/canvas';
  let config = { endpoint: DEFAULT_CANVAS_ENDPOINT, enabled: true, timeoutMs: 8000 };
  let activeUri = '';
  let currentTrack = null;
  let currentPlaying = false;
  let requestSerial = 0;
  let abort = null;
  let activeSource = '';
  let sourceBroken = '';
  let disposed = false;
  const cached = new Map();
  let settingEl = null;
  let diagnostic = 'Waiting for playback information.';

  function setDiagnostic(message) {
    diagnostic = message;
    const status = settingEl?.querySelector('[data-canvas-status]');
    if (status) status.textContent = message;
  }

  const prefEnabled = () => localStorage.getItem(LOCAL_PREFERENCE) !== 'false';
  const isPlayerVisible = () => !document.hidden && (!root || !root.dataset.currentView || root.dataset.currentView === 'player');
  const canPlay = () => !disposed && currentPlaying && isPlayerVisible() && prefEnabled();

  function clear() {
    if (!video) return;
    video.pause();
    if (root) root.dataset.spotydeskCanvas = 'off';
    video.removeAttribute('src');
    video.load();
    activeSource = '';
    sourceBroken = '';
  }

  function isSafeVideo(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim(), location.href);
      const validExtension = /\.(mp4|m4v|webm|ogv)$/i.test(url.pathname);
      const local = url.origin === location.origin;
      const spotifyCanvas = url.protocol === 'https:' && url.hostname === 'canvaz.scdn.co';
      return validExtension && (local || spotifyCanvas) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  function safeEndpoint(value) {
    if (!value || typeof value !== 'string') return '';
    try {
      const u = new URL(value.trim());
      if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) return '';
      if (!u.pathname || u.pathname === '/') u.pathname = '/api/canvas';
      // Must be a Canvas API URL, not an arbitrary URL or an embedded credential.
      if (!u.pathname.endsWith('/api/canvas')) return '';
      return u.href;
    } catch { return ''; }
  }

  const settingsReady = fetch('./canvas-config.json?v=4', { credentials: 'same-origin', cache: 'no-store' })
    .then(r => r.ok ? r.json() : {})
    .then(data => {
      config = {
        endpoint: safeEndpoint(data?.endpoint) || safeEndpoint(DEFAULT_CANVAS_ENDPOINT),
        enabled: data?.enabled !== false,
        timeoutMs: Math.max(2000, Math.min(12000, Number(data?.timeoutMs) || 8000))
      };
      updateSettings();
      return config;
    })
    .catch(() => {
      config.endpoint = safeEndpoint(DEFAULT_CANVAS_ENDPOINT);
      updateSettings();
      return config;
    });

  const mappingReady = fetch('./video-loops.json', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : {})
    .then(data => data && typeof data === 'object' && !Array.isArray(data) ? data : {})
    .catch(() => ({}));

  function init() {
    if (disposed || video) return;
    root = document.getElementById('remote') || document.querySelector('.device');
    const background = document.querySelector('[data-panel="player"] .player-background') || document.querySelector('.player-background');
    if (!root || !background) return;
    video = document.createElement('video');
    video.id = 'spotydesk-canvas-background';
    video.className = 'spotydesk-canvas-video';
    video.loop = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'metadata';
    video.disablePictureInPicture = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.tabIndex = -1;
    background.querySelector('.player-background-shade')?.before(video);
    if (!video.parentNode) background.prepend(video);
    video.addEventListener('playing', () => {
      if (canPlay() && activeSource && activeSource !== sourceBroken && root) {
        root.dataset.spotydeskCanvas = 'active';
        setDiagnostic('Canvas video is playing in the background.');
      }
    });
    video.addEventListener('error', () => {
      if (activeSource) {
        sourceBroken = activeSource;
        if (root) root.dataset.spotydeskCanvas = 'off';
        video.pause();
        setDiagnostic('Video file could not play; the original artwork remains.');
      }
    });
    document.addEventListener('visibilitychange', updatePlayback);
    const observer = new MutationObserver(updatePlayback);
    observer.observe(root, { attributes: true, attributeFilter: ['data-current-view'] });
    window.addEventListener('pagehide', () => video?.pause());
    maybeAddSettings();
    // A playback update could have arrived before the DOM was ready.
    if (currentTrack) void resolveTrack(activeUri, requestSerial);
  }

  function updateSettings() {
    if (!settingEl) return;
    const status = settingEl.querySelector('[data-canvas-status]');
    const check = settingEl.querySelector('input');
    if (check) check.checked = prefEnabled();
    if (status) status.textContent = config.endpoint
      ? diagnostic
      : 'No Canvas API URL configured. Turntable keeps its normal artwork until you configure a server.';
  }

  function maybeAddSettings() {
    if (settingEl || !root) return;
    const panel = document.querySelector('[data-panel="settings"]') || document.getElementById('settingsPanel') || document.querySelector('.settings-panel');
    if (!panel) return; // All original settings remain untouched even if selector changes upstream.
    settingEl = document.createElement('section');
    settingEl.className = 'spotydesk-canvas-settings';
    settingEl.innerHTML = '<label><input type="checkbox" checked> Automatic Spotify Canvas backgrounds</label><p data-canvas-status role="status" aria-live="polite"></p><button type="button" data-canvas-retry>Retry Canvas for this song</button>';
    settingEl.querySelector('[data-canvas-retry]').addEventListener('click', () => {
      // Retry expresses intent to enable Canvas, including a previously saved off switch.
      localStorage.setItem(LOCAL_PREFERENCE, 'true');
      updateSettings();
      if (activeUri) cached.delete(activeUri);
      setDiagnostic('Retrying Canvas lookup with the configured API...');
      void syncTrack(currentTrack, currentPlaying, true);
    });
    settingEl.querySelector('input').addEventListener('change', e => {
      localStorage.setItem(LOCAL_PREFERENCE, e.target.checked ? 'true' : 'false');
      if (!e.target.checked) {
        if (root) root.dataset.spotydeskCanvas = 'off';
        video?.pause();
        setDiagnostic('Canvas turned off. Showing original artwork.');
      } else {
        setDiagnostic('Canvas enabled. Checking the current song...');
        void syncTrack(currentTrack, currentPlaying, true);
      }
    });
    panel.append(settingEl);
    updateSettings();
  }

  function updatePlayback() {
    if (!video || disposed) return;
    if (!canPlay()) {
      video.pause();
      if (!prefEnabled() && root) root.dataset.spotydeskCanvas = 'off';
      return;
    }
    if (!activeSource || activeSource === sourceBroken) return;
    Promise.resolve(video.play()).catch(() => {
      // Browsers can refuse media playback. Never block the original UI.
      sourceBroken = activeSource;
      if (root) root.dataset.spotydeskCanvas = 'off';
      setDiagnostic('Android Chrome blocked autoplay. Tap Play in Turntable, then Retry Canvas.');
    });
  }

  async function getCanvas(uri, token) {
    await settingsReady;
    if (!prefEnabled()) {
      setDiagnostic('Canvas is off in Settings. Turn it on, or tap Retry Canvas to enable it.');
      return '';
    }
    if (!config.enabled) {
      setDiagnostic('Canvas is disabled in the configuration file.');
      return '';
    }
    if (!config.endpoint) {
      setDiagnostic('Canvas API endpoint is missing in this app version.');
      return '';
    }
    if (cached.has(uri)) {
      setDiagnostic(cached.get(uri) ? 'Using cached Canvas video.' : 'No Canvas for this song (cached).');
      return cached.get(uri) || '';
    }
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const url = new URL(config.endpoint);
      url.searchParams.set('trackId', uri.split(':').pop());
      const response = await fetch(url, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' }, cache: 'no-store'
      });
      if (!response.ok) {
        setDiagnostic('Canvas API returned HTTP ' + response.status + '. Check the Vercel server.');
        return '';
      }
      const payload = await response.json();
      // The upstream API sends CanvasResponse.toObject() directly:
      // { canvasesList: [...] }. Some deployments wrap it as { data: { canvasesList: [...] } }.
      // Support both formats without accepting arbitrary untrusted payloads.
      const canvases = Array.isArray(payload?.canvasesList)
        ? payload.canvasesList
        : Array.isArray(payload?.data?.canvasesList) ? payload.data.canvasesList : null;
      if (token !== requestSerial) return '';
      if (!canvases) {
        setDiagnostic('Canvas API returned an unexpected response format. Expected canvasesList.');
        return '';
      }
      // Spotify sometimes supplies a linked/alternate track URI. Prefer an exact match,
      // but accept the first permitted Canvas video when the response is for this track ID.
      const candidates = [...canvases.filter(c => c?.trackUri === uri), ...canvases.filter(c => c?.trackUri !== uri)];
      const result = candidates.map(c => isSafeVideo(c?.canvasUrl)).find(Boolean) || '';
      cached.set(uri, result || null);
      setDiagnostic(result ? 'Canvas video found; loading…' : 'No usable Canvas video returned for this song.');
      return result;
    } catch (error) {
      if (token === requestSerial) {
        setDiagnostic(error?.name === 'AbortError'
          ? 'Canvas API timed out; showing original artwork.'
          : 'Cannot read the Canvas API from Chrome (likely CORS or network). The API may work in a separate tab.');
      }
      return ''; // CORS, timeout, token expiry and backend downtime all preserve artwork.
    } finally {
      clearTimeout(timer);
      if (abort === controller) abort = null;
    }
  }

  async function resolveTrack(uri, token) {
    if (!video || !uri || token !== requestSerial || !prefEnabled()) return;
    const map = await mappingReady;
    if (token !== requestSerial || disposed) return;
    const local = isSafeVideo(map[uri] || map[uri.split(':').pop()] || currentTrack?.video_loop_url);
    if (local) setDiagnostic('Local song video found; loading…');
    const candidate = local || await getCanvas(uri, token);
    if (token !== requestSerial || disposed || !video) return;
    if (!candidate) return;
    activeSource = candidate;
    sourceBroken = '';
    video.src = candidate;
    video.load();
    updatePlayback();
  }

  function syncTrack(track, playing, force = false) {
    if (disposed) return;
    currentTrack = track;
    currentPlaying = Boolean(playing);
    const uri = /^spotify:track:[A-Za-z0-9]+$/.test(track?.uri || '')
      ? track.uri
      : /^[A-Za-z0-9]{22}$/.test(track?.id || '') ? `spotify:track:${track.id}` : '';
    if (!video) init();
    if (force || uri !== activeUri) {
      requestSerial++;
      abort?.abort();
      activeUri = uri;
      if (video) clear();
      if (uri && video) {
        setDiagnostic('Looking up Canvas for the current song…');
        void resolveTrack(uri, requestSerial);
      } else if (!uri) {
        setDiagnostic('Waiting for a Spotify track to start playing.');
      }
    } else {
      updatePlayback();
    }
    if (!settingEl) maybeAddSettings();
  }

  window.turntableCanvasBackground = { syncTrack, get configured() { return !!config.endpoint; }, dispose() {
    disposed = true;
    requestSerial++;
    abort?.abort();
    clear();
    video?.remove();
    video = null;
    delete window.turntableCanvasBackground;
  }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
