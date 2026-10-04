/* takes:recorder */
/*
 * recorder.js: the MediaRecorder lifecycle.
 * A 3 second countdown, then recording in one second chunks, pause and resume, and stop.
 * It emits record:state and record:done and stores nothing; ui.js builds the recording object.
 * It never stops the capture or the compositor; ui.js does that.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var COUNTDOWN_SECONDS = 3;
  var TIMESLICE_MS = 1000;
  var VIDEO_BITS_PER_SECOND = 5000000;
  var AUDIO_BITS_PER_SECOND = 128000;
  // If the browser never reports that the recorder stopped, finish with what has arrived.
  var STOP_WATCHDOG_MS = 15000;
  // A recorder that is already stopping gets this long to hand over its last chunk.
  var LAST_CHUNK_WATCHDOG_MS = 1000;
  // After the countdown the screen needs a moment to repaint without the overlay, or the first
  // recorded frame shows it: two animation frames, then this pause, and never longer than the cap.
  var REPAINT_PAUSE_MS = 250;
  var REPAINT_NO_FRAMES_MS = 284;
  var REPAINT_CAP_MS = 600;

  var MSG_NO_PICTURE = 'There is no picture to record. Pick the screen or the camera, then try again.';
  var MSG_NO_START = 'The recording could not start. Check that your screen or camera is still shared, then try again.';
  var MSG_BROKE = 'The recording stopped because of a problem in the browser, so it could not be saved. Please try recording again.';
  var MSG_EMPTY = 'The recording came out empty, so nothing was saved. Please try recording again.';
  var MSG_ENDED_EARLY = 'The recording ended early because of a problem in the browser. Everything recorded up to that point was kept.';

  // ---------------------------------------------------------------- the grid

  // state -> action -> next state. Anything not listed is ignored (the state stays as it is).
  var TRANSITIONS = {
    idle: { start: 'countdown' },
    countdown: { stop: 'idle', 'countdown-done': 'recording' },
    recording: { pause: 'paused', stop: 'processing' },
    paused: { resume: 'recording', stop: 'processing' },
    processing: { done: 'idle' }
  };

  function own(obj, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Pure. The single source of truth for transitions. An ignored or unknown action returns the same state. */
  function nextState(state, action) {
    if (!own(TRANSITIONS, state)) return state;
    var row = TRANSITIONS[state];
    return own(row, action) ? row[action] : state;
  }

  // ---------------------------------------------------------------- live state

  var state = 'idle';
  var countdownTimer = null;
  var pending = null;   // { videoStream, audioTrack } while the countdown runs
  var gap = null;       // the short wait between the countdown and the recorder starting
  var session = null;   // the recording in progress, from MediaRecorder start until idle

  function now() {
    var p = root.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }

  /** Apply an action through nextState. Returns true when the state changed. */
  function go(action) {
    var next = nextState(state, action);
    if (next === state) return false;
    state = next;
    return true;
  }

  function emitState(secondsLeft) {
    var payload = { state: state };
    if (typeof secondsLeft === 'number') payload.secondsLeft = secondsLeft;
    Takes.bus.emit('record:state', payload);
  }

  function toastError(text) {
    Takes.bus.emit('toast', { kind: 'error', text: text });
  }

  function makeId() {
    var c = root.crypto;
    try {
      if (c && typeof c.randomUUID === 'function') return String(c.randomUUID());
    } catch (err) { /* fall through to the plain id */ }
    return 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Recorded milliseconds for a session: timestamps minus paused time, never the blob. */
  function measureMs(s) {
    var end = s.endedAt !== null ? s.endedAt : now();
    if (s.pausedAt !== null) end = s.pausedAt;
    var ms = end - s.startedAt - s.pausedTotal;
    return ms > 0 ? ms : 0;
  }

  /** Finish after ms unless the recorder's own stop event gets there first. */
  function armWatchdog(s, ms) {
    clearWatchdog(s);
    s.watchdog = setTimeout(function () {
      s.watchdog = null;
      finish(s);
    }, ms);
  }

  function clearWatchdog(s) {
    if (s.watchdog !== null) {
      clearTimeout(s.watchdog);
      s.watchdog = null;
    }
  }

  function detach(s) {
    try {
      s.mr.ondataavailable = null;
      s.mr.onerror = null;
      s.mr.onstop = null;
    } catch (err) { /* nothing to do */ }
  }

  function settle(s, value) {
    var list = s.resolvers;
    s.resolvers = [];
    for (var i = 0; i < list.length; i++) list[i](value);
  }

  // ---------------------------------------------------------------- countdown

  function clearGap() {
    var g = gap;
    if (!g) return;
    gap = null;
    g.cancelled = true;
    if (g.cap !== null) clearTimeout(g.cap);
    if (g.wait !== null) clearTimeout(g.wait);
  }

  function clearCountdown() {
    if (countdownTimer !== null) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
    clearGap();
  }

  /**
   * The countdown has reached zero. Tell the UI first (secondsLeft 0 is its signal to take the
   * overlay away), let the screen repaint, and only then start recording. The state is still
   * 'countdown' during this wait, so stop cancels it exactly like a stop during the countdown.
   * The cap is a plain timer, so a hidden tab, where animation frames do not run, cannot stall it.
   */
  function settleThenBegin() {
    emitState(0);
    if (state !== 'countdown') return;
    var g = { cancelled: false, cap: null, wait: null };
    gap = g;
    function fire() {
      if (g.cancelled) return;
      clearGap();
      if (state === 'countdown') begin();
    }
    function afterFrames(ms) {
      if (g.cancelled || g.wait !== null) return;
      g.wait = setTimeout(fire, ms);
    }
    g.cap = setTimeout(fire, REPAINT_CAP_MS);
    var raf = root.requestAnimationFrame;
    if (typeof raf !== 'function') { afterFrames(REPAINT_NO_FRAMES_MS); return; }
    try {
      raf.call(root, function () {
        if (g.cancelled) return;
        try {
          raf.call(root, function () { afterFrames(REPAINT_PAUSE_MS); });
        } catch (err) { afterFrames(REPAINT_NO_FRAMES_MS); }
      });
    } catch (err) { afterFrames(REPAINT_NO_FRAMES_MS); }
  }

  function tick(secondsLeft) {
    emitState(secondsLeft);
    countdownTimer = setTimeout(function () {
      countdownTimer = null;
      if (state !== 'countdown') return;
      if (secondsLeft > 1) tick(secondsLeft - 1);
      else settleThenBegin();
    }, 1000);
  }

  /** The countdown ended with nothing to show for it: say why and go back to idle. */
  function abandonCountdown(text) {
    pending = null;
    toastError(text);
    if (go('stop')) emitState();
  }

  function start(videoStream, audioTrack) {
    if (!go('start')) return;
    pending = { videoStream: videoStream, audioTrack: audioTrack || null };
    tick(COUNTDOWN_SECONDS);
  }

  // ---------------------------------------------------------------- recording

  function begin() {
    var input = pending;
    pending = null;
    if (!input) { abandonCountdown(MSG_NO_START); return; }

    var MR = root.MediaRecorder;
    var MS = root.MediaStream;
    var picked;
    try {
      // pickMimeType probes MediaRecorder.isTypeSupported itself and throws a plain-words Error.
      picked = Takes.util.pickMimeType(
        MR && typeof MR.isTypeSupported === 'function'
          ? function (type) { return MR.isTypeSupported(type); }
          : undefined
      );
    } catch (err) {
      abandonCountdown(err && err.message ? err.message : MSG_NO_START);
      return;
    }

    var tracks = [];
    try {
      var vs = input.videoStream;
      if (vs && typeof vs.getVideoTracks === 'function') tracks = vs.getVideoTracks().slice();
    } catch (err) { tracks = []; }
    if (tracks.length === 0) { abandonCountdown(MSG_NO_PICTURE); return; }
    if (input.audioTrack) tracks.push(input.audioTrack);

    var s = {
      mr: null,
      chunks: [],
      mimeType: picked.mimeType,
      createdAt: 0,
      startedAt: 0,
      pausedAt: null,
      pausedTotal: 0,
      endedAt: null,
      resolvers: [],
      watchdog: null,
      broken: false,
      finished: false
    };

    try {
      var options = { mimeType: picked.mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND };
      if (input.audioTrack) options.audioBitsPerSecond = AUDIO_BITS_PER_SECOND;
      s.mr = new MR(new MS(tracks), options);
      s.mr.ondataavailable = function (event) {
        if (s.finished) return;
        if (event && event.data && event.data.size > 0) s.chunks.push(event.data);
      };
      s.mr.onerror = function () { fail(s); };
      s.mr.onstop = function () { finish(s); };
      s.mr.start(TIMESLICE_MS);
    } catch (err) {
      if (s.mr) detach(s);
      abandonCountdown(MSG_NO_START);
      return;
    }

    s.createdAt = Date.now();
    s.startedAt = now();
    session = s;
    go('countdown-done');
    emitState();
  }

  function pause() {
    var s = session;
    if (!s || nextState(state, 'pause') === state) return;
    try { s.mr.pause(); } catch (err) { fail(s); return; }
    s.pausedAt = now();
    go('pause');
    emitState();
  }

  function resume() {
    var s = session;
    if (!s || nextState(state, 'resume') === state) return;
    try { s.mr.resume(); } catch (err) { fail(s); return; }
    if (s.pausedAt !== null) {
      s.pausedTotal += now() - s.pausedAt;
      s.pausedAt = null;
    }
    go('resume');
    emitState();
  }

  /** Freeze the clock and move to processing. Used by stop() and by a recorder that stopped by itself. */
  function enterProcessing(s) {
    s.endedAt = now();
    go('stop');
    emitState();
  }

  function stop() {
    if (state === 'countdown') {
      clearCountdown();
      pending = null;
      go('stop');
      emitState();
      return Promise.resolve(null);
    }

    var s = session;
    if (!s || nextState(state, 'stop') === state) return Promise.resolve(null);

    return new Promise(function (resolve) {
      s.resolvers.push(resolve);
      enterProcessing(s);

      // Already inactive means the browser stopped it by itself (the share ended) and its last
      // chunk and stop event are still on their way: wait for them, never assemble before them.
      var inactive = false;
      try { inactive = s.mr.state === 'inactive'; } catch (err) { inactive = false; }
      if (inactive) { armWatchdog(s, LAST_CHUNK_WATCHDOG_MS); return; }

      try {
        s.mr.stop();
      } catch (err) {
        armWatchdog(s, LAST_CHUNK_WATCHDOG_MS);
        return;
      }
      if (!s.finished) armWatchdog(s, STOP_WATCHDOG_MS);
    });
  }

  /** The recorder has stopped: build the file, announce it, return to idle. */
  function finish(s) {
    if (s !== session || s.finished) return;
    s.finished = true;
    clearWatchdog(s);
    detach(s);

    // The browser stopped the recorder by itself (every track ended). Keep what was recorded.
    if (state === 'recording' || state === 'paused') enterProcessing(s);

    var payload = null;
    try {
      if (s.chunks.length > 0) {
        var type = s.mimeType;
        try { if (s.mr.mimeType) type = String(s.mr.mimeType); } catch (err) { /* keep the picked type */ }
        var blob = new Blob(s.chunks, { type: type });
        if (blob.size > 0) {
          payload = {
            id: makeId(),
            blob: blob,
            mimeType: type,
            durationMs: Math.round(measureMs(s)),
            createdAt: s.createdAt
          };
        }
      }
    } catch (err) {
      payload = null;
    }
    s.chunks = [];

    if (payload) {
      Takes.bus.emit('record:done', payload);
      if (s.broken) toastError(MSG_ENDED_EARLY);
    } else {
      toastError(s.broken ? MSG_BROKE : MSG_EMPTY);
    }

    session = null;
    go('done');
    emitState();
    settle(s, payload);
  }

  /**
   * The recorder broke. Whatever has already been recorded is kept: stop the clock, ask the recorder
   * to stop, and let finish() build the file from the chunks received (the last one included).
   * Only a take with no data at all ends with no record:done.
   */
  function fail(s) {
    if (s !== session || s.finished || s.broken) return;
    s.broken = true;
    if (state === 'recording' || state === 'paused') enterProcessing(s);
    try { if (s.mr.state !== 'inactive') s.mr.stop(); } catch (err) { /* already stopped */ }
    if (!s.finished) armWatchdog(s, LAST_CHUNK_WATCHDOG_MS);
  }

  /** Recorded seconds so far, paused time excluded. 0 when idle or counting down. */
  function elapsed() {
    var s = session;
    if (!s) return 0;
    return measureMs(s) / 1000;
  }

  function getState() {
    return state;
  }

  var api = {
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    nextState: nextState,
    elapsed: elapsed,
    getState: getState
  };
  Takes.recorder = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
