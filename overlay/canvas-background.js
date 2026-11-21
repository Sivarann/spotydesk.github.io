/*
 * SpotyDesk Canvas background extension for Peekabu411 Turntable.
 * Reads existing Spotify playback state; never requests or stores Spotify OAuth/session secrets.
 * Requires an independently hosted, CORS-enabled Canvas API. Canvas is not in Spotify Web API.
 */
(() => {
  'use strict';

  const LOCAL_PREFERENCE = 'spotydesk.canvas.enabled.v1';
  let root = null;
  let video = null;
  let config = { endpoint: '', enabled: true, timeoutMs: 8000 };
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

  const settingsReady = fetch('./canvas-config.json', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : {})
    .then(data => {
      config = {
        endpoint: safeEndpoint(data?.endpoint),
        enabled: data?.enabled !== false,
        timeoutMs: Math.max(2000, Math.min(12000, Number(data?.timeoutMs) || 8000))
      };
      updateSettings();
      return config;
    })
    .catch(() => config);

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
      if (canPlay() && activeSource && activeSource !== sourceBroken && root) root.dataset.spotydeskCanvas = 'active';
    });
    video.addEventListener('error', () => {
      if (activeSource) {
        sourceBroken = activeSource;
        if (root) root.dataset.spotydeskCanvas = 'off';
        video.pause();
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
      ? 'Automatic lookup configured. Missing videos or request failures use the original artwork.'
      : 'No Canvas API URL configured. Turntable keeps its normal artwork until you configure a server.';
  }

  function maybeAddSettings() {
    if (settingEl || !root) return;
    const panel = document.querySelector('[data-panel="settings"]') || document.getElementById('settingsPanel') || document.querySelector('.settings-panel');
    if (!panel) return; // All original settings remain untouched even if selector changes upstream.
    settingEl = document.createElement('section');
    settingEl.className = 'spotydesk-canvas-settings';
    settingEl.innerHTML = '<label><input type="checkbox" checked> Automatic Spotify Canvas backgrounds</label><p data-canvas-status></p>';
    settingEl.querySelector('input').addEventListener('change', e => {
      localStorage.setItem(LOCAL_PREFERENCE, e.target.checked ? 'true' : 'false');
      if (!e.target.checked) {
        if (root) root.dataset.spotydeskCanvas = 'off';
        video?.pause();
      } else {
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
    });
  }

  async function getCanvas(uri, token) {
    await settingsReady;
    if (!config.enabled || !config.endpoint || !prefEnabled()) return '';
    if (cached.has(uri)) return cached.get(uri) || '';
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
      if (!response.ok) return '';
      const payload = await response.json();
      const canvases = payload?.data?.canvasesList;
      if (token !== requestSerial || !Array.isArray(canvases)) return '';
      const matching = canvases.find(c => c?.trackUri === uri) || canvases.find(c => !c?.trackUri);
      const result = isSafeVideo(matching?.canvasUrl);
      cached.set(uri, result || null);
      return result;
    } catch {
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
      if (uri && video) void resolveTrack(uri, requestSerial);
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
