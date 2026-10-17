/* takes:floater */
/*
 * floater.js: the small control bar that floats on top of every other window while a take records.
 * It lives in the browser's Document Picture-in-Picture window (Chrome and Edge, no extension).
 * By default it is one slim row: the recording dot, the timer, Pause or Resume, Stop, and a
 * "Move bubble" button when the take has a camera bubble. Pressing "Move bubble" opens a map of the
 * frame (Takes.pad) under the bar and grows the window; pressing it again shrinks it back.
 * When the take ends the bar turns into "Your take is ready" with Download and Open in Takes.
 * Everything it does to the take goes through the hooks ui.js hands it; it never reaches into ui.
 * Closing the window never stops a recording.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  // The smallest bar the browser is asked for. Width and height must be passed together.
  var BAR_SIZE = { width: 300, height: 64 };
  // Extra height, in CSS pixels, for the one-line whole-screen note under the bar.
  var NOTE_EXTRA = 24;
  // Extra height for the finished views (a title line above one row of buttons).
  var DONE_EXTRA = 44;
  // Space beside the bubble map, and room for its hint line and gaps.
  var PAD_SIDE = 24;
  var PAD_HINT = 40;
  // The window is visible, so its own timers run at full speed.
  var TIMER_MS = 250;
  // A take shorter than this is not kept (the same rule ui.js applies).
  var SHORT_MS = 1000;
  var DEFAULT_ASPECT = 16 / 9;

  var LIVE_STATES = { countdown: true, recording: true, paused: true };
  var STATE_CLASSES = {
    countdown: 'tk-is-countdown',
    recording: 'tk-is-recording',
    paused: 'tk-is-paused',
    processing: 'tk-is-processing'
  };
  var STATUS_TEXT = {
    countdown: 'Get ready',
    recording: 'Recording',
    paused: 'Paused',
    processing: 'Finishing your recording…'
  };
  var NAME = (Takes && Takes.PRODUCT_NAME) || 'Takes';
  var TITLES = {
    live: NAME + ' · Recording',
    processing: NAME + ' · Finishing',
    done: NAME + ' · Your take is ready',
    short: NAME,
    failed: NAME
  };
  var MSG_READY = 'Your take is ready';
  var MSG_SHORT = 'That recording was under a second, so it was not kept.';
  var MSG_FAILED = 'The recording could not be saved. Go back to Takes to try again.';
  var MSG_WHOLE = 'Whole screen shared: this bar shows in the video.';
  var MSG_SAVING = 'Saving your take…';
  var MSG_NO_DOWNLOAD = 'The download did not start. Go back to Takes to try again.';
  var PAD_LABEL = 'Camera bubble position';

  // ---------------------------------------------------------------- live state

  var win = null;          // the Picture-in-Picture window this module built in, or null
  var doc = null;          // its document
  var hooks = {};          // the current take's hooks from ui.js
  var ui = null;           // the elements built in doc
  var pad = null;          // the mounted bubble map, or null
  var padOpen = false;
  var timerId = null;
  var unsubs = [];
  var observer = null;     // mirrors the opener's theme
  var onPageHide = null;
  var view = null;         // 'live' | 'processing' | 'done' | 'short' | 'failed'
  var lastState = 'idle';  // the recorder state last seen, to tell an empty take from a cancelled countdown
  var lastSecondsLeft;
  var gotDone = false;     // record:done arrived for the take on screen
  var extra = 0;           // height added to the window on top of the bar, in CSS pixels
  var fitting = false;     // a fresh or reused window is being sized as a whole, so setExtra only records
  var busy = false;        // a download asked for from this window has not answered yet
  var generation = 0;      // goes up on every close, so a window that arrives late is closed again
  var pending = null;      // the open that is waiting for the browser

  // ---------------------------------------------------------------- small helpers

  function hook(name) {
    var fn = hooks && hooks[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(); } catch (err) { return undefined; /* a hook that fails leaves the bar as it is */ }
  }

  function readState() {
    var s = hook('getState');
    return typeof s === 'string' ? s : 'idle';
  }

  function readLayout() {
    var l = hook('getLayout');
    return l && typeof l === 'object' ? l : null;
  }

  function aspectOf(layout) {
    var a = layout ? Number(layout.width) / Number(layout.height) : NaN;
    return isFinite(a) && a > 0 ? a : DEFAULT_ASPECT;
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = !!hidden;
  }

  function make(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick) {
    var b = make('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function setTitle(text) {
    try { doc.title = text; } catch (err) { /* a title is a nicety */ }
  }

  function warnRefused(err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[' + NAME + '] the floating controls could not open:', err && err.message ? err.message : err);
    }
  }

  // ---------------------------------------------------------------- style and theme

  /** The opener's CSS as one string: its single inline style block, or every readable rule. */
  function styleText() {
    var od = root.document;
    if (!od) return '';
    var blocks = null;
    try { blocks = od.head ? od.head.getElementsByTagName('style') : null; } catch (err) { blocks = null; /* no head to read */ }
    if (blocks && blocks.length === 1) return String(blocks[0].textContent || '');
    var out = [];
    var sheets = null;
    try { sheets = od.styleSheets; } catch (err) { sheets = null; /* no style sheets to read */ }
    var count = sheets && typeof sheets.length === 'number' ? sheets.length : 0;
    for (var i = 0; i < count; i++) {
      try {
        var rules = sheets[i].cssRules;
        for (var j = 0; j < rules.length; j++) out.push(rules[j].cssText);
      } catch (err) { /* a sheet from another origin cannot be read; skip it */ }
    }
    return out.join('\n');
  }

  function openerTheme() {
    try { return root.document.documentElement.getAttribute('data-theme'); } catch (err) { return null; /* no opener document */ }
  }

  function copyTheme() {
    if (!doc || !doc.documentElement) return;
    var theme = openerTheme();
    try {
      if (theme) doc.documentElement.setAttribute('data-theme', theme);
      else doc.documentElement.removeAttribute('data-theme');
    } catch (err) { /* the window keeps its current theme */ }
  }

  function watchTheme() {
    var MO = root.MutationObserver;
    if (typeof MO !== 'function') return;
    try {
      observer = new MO(copyTheme);
      observer.observe(root.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (err) { observer = null; /* the theme is copied once at opening instead */ }
  }

  // ---------------------------------------------------------------- window size

  /**
   * How wide the bubble map's frame is: the window's inner width less the side padding, so a window
   * wider than the bar gets a taller map and the hint line under it still fits. While a window is
   * being fitted it is about to become the bar's width, so that width is used.
   */
  function padFrameWidth() {
    var w = fitting ? NaN : Number(win && win.innerWidth);
    if (!isFinite(w) || !(w > PAD_SIDE)) w = BAR_SIZE.width;
    return w - PAD_SIDE;
  }

  function liveExtra() {
    var px = hooks && hooks.wholeScreen ? NOTE_EXTRA : 0;
    if (padOpen) {
      px += Math.round(padFrameWidth() / aspectOf(readLayout())) + PAD_HINT;
    }
    return px;
  }

  /** Grow or shrink the window so it has px of height on top of the bar. A refused resize changes nothing. */
  function setExtra(px) {
    var delta = px - extra;
    if (fitting) { extra = px; return; }   // fitWindow sets the whole size once the view is known
    if (!win || delta === 0 || typeof win.resizeTo !== 'function') return;
    var w = Number(win.outerWidth);
    var h = Number(win.outerHeight);
    if (!isFinite(w) || !(w > 0)) w = Number(win.innerWidth);
    if (!isFinite(h) || !(h > 0)) h = Number(win.innerHeight);
    if (!isFinite(w) || !(w > 0)) w = BAR_SIZE.width;
    if (!isFinite(h) || !(h > 0)) h = BAR_SIZE.height + extra;
    try {
      win.resizeTo(Math.round(w), Math.round(h + delta));
      extra = px;
    } catch (err) { /* resizing needs a click; without one the window keeps its size */ }
  }

  /**
   * Size the window to exactly what the current view needs. Chrome and Edge reopen the
   * Picture-in-Picture window at the size it last had (a take with the map open leaves it big) and
   * ignore the size requestWindow asked for, so this runs as soon as a window is attached or reused,
   * still inside the click. resizeTo sets the OUTER size, so the browser's own frame is added on.
   * A refused resize (the click's permission has run out) is silent: the CSS fits a bigger window.
   */
  function fitWindow() {
    if (!win || typeof win.resizeTo !== 'function') return;
    var wantW = BAR_SIZE.width;
    var wantH = BAR_SIZE.height + extra;
    var ow = Number(win.outerWidth);
    var oh = Number(win.outerHeight);
    var iw = Number(win.innerWidth);
    var ih = Number(win.innerHeight);
    if (!(isFinite(ow) && isFinite(oh) && isFinite(iw) && isFinite(ih))) return;
    if (!(iw > 0 && ih > 0 && ow >= iw && oh >= ih)) return;
    if (Math.round(iw) === wantW && Math.round(ih) === wantH) return;
    try {
      win.resizeTo(Math.round(ow - iw + wantW), Math.round(oh - ih + wantH));
    } catch (err) { /* no click left to resize with; the bar's CSS handles the bigger window */ }
  }

  /** Show the view that matches the recorder, then size the whole window to it in one step. */
  function syncAndFit() {
    fitting = true;
    try { syncToState(); } finally { fitting = false; }
    fitWindow();
  }

  // ---------------------------------------------------------------- the bubble map

  function destroyPad() {
    if (!pad) return;
    var p = pad;
    pad = null;
    try { p.destroy(); } catch (err) { /* the map is going away anyway */ }
  }

  function screenFor() {
    return hooks && !hooks.wholeScreen ? hooks.screenStream || null : null;
  }

  function expandPad() {
    var layout = readLayout();
    var P = Takes && Takes.pad;
    if (!layout || !P || typeof P.mount !== 'function' || !ui) return;
    destroyPad();
    try {
      pad = P.mount(ui.padBox, {
        doc: doc,
        aspect: aspectOf(layout),
        shape: layout.shape,
        size: layout.size,
        pos: layout.pos,
        stream: hooks.cameraStream || null,
        screenStream: screenFor(),
        mirror: !!hooks.mirror,
        label: PAD_LABEL,
        onMove: function (pos) {
          var fn = hooks && hooks.moveBubble;
          if (typeof fn !== 'function') return undefined;
          try { return fn(pos) || undefined; } catch (err) { return undefined; /* the map shows what it sent */ }
        },
        onSettle: function (pos) {
          var fn = hooks && hooks.onSettle;
          if (typeof fn === 'function') {
            try { fn(pos); } catch (err) { /* saving the spot is a nicety */ }
          }
        }
      });
    } catch (err) {
      pad = null;
    }
    padOpen = !!pad;
    setHidden(ui.padBox, !padOpen);
    ui.moveBtn.setAttribute('aria-expanded', padOpen ? 'true' : 'false');
    setExtra(liveExtra());
  }

  function collapsePad() {
    destroyPad();
    padOpen = false;
    if (!ui) return;
    setHidden(ui.padBox, true);
    ui.moveBtn.setAttribute('aria-expanded', 'false');
  }

  function onMoveClick() {
    if (!padOpen) { expandPad(); return; }
    collapsePad();
    setExtra(liveExtra());
  }

  /** Point an open map at the current take's layout and streams. */
  function refreshPad() {
    if (!pad) return;
    var layout = readLayout();
    if (!layout) { collapsePad(); setExtra(liveExtra()); return; }
    try { if (typeof pad.setAspect === 'function') pad.setAspect(aspectOf(layout)); } catch (err) { /* keeps its shape */ }
    try { if (typeof pad.setShape === 'function') pad.setShape(layout.shape); } catch (err) { /* keeps its shape */ }
    try { if (typeof pad.setStream === 'function') pad.setStream(hooks.cameraStream || null, !!hooks.mirror); } catch (err) { /* keeps its picture */ }
    try { if (typeof pad.setScreen === 'function') pad.setScreen(screenFor()); } catch (err) { /* keeps its picture */ }
    try { if (typeof pad.setPos === 'function' && layout.pos) pad.setPos(layout.pos); } catch (err) { /* keeps its spot */ }
  }

  // ---------------------------------------------------------------- building the views

  function build() {
    var body = doc.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.classList.add('tk-floater');

    var css = styleText();
    if (css && doc.head) {
      var style = doc.createElement('style');
      style.textContent = css;
      doc.head.appendChild(style);
    }

    var u = {};
    // live: one slim row, then the map (closed until asked for), then the whole-screen note.
    u.live = make('section', 'tk-floater-view tk-floater-live');
    u.head = make('div', 'tk-floater-head');
    u.dot = make('span', 'tk-recbar-dot tk-floater-dot');
    u.dot.setAttribute('aria-hidden', 'true');
    u.status = make('span', 'tk-sr-only tk-floater-status');
    u.status.setAttribute('role', 'status');
    u.status.setAttribute('aria-live', 'polite');
    u.timer = make('span', 'tk-floater-timer', '0:00');
    u.timer.setAttribute('role', 'timer');
    u.timer.setAttribute('aria-label', 'Recording time');
    u.actions = make('div', 'tk-floater-actions');
    u.pauseBtn = button('tk-btn tk-floater-pause', 'Pause', function () { hook('pause'); });
    u.resumeBtn = button('tk-btn tk-floater-resume', 'Resume', function () { hook('resume'); });
    u.stopBtn = button('tk-btn tk-btn-primary tk-floater-stop', 'Stop', function () { hook('stop'); });
    u.moveBtn = button('tk-btn tk-floater-move', 'Move bubble', onMoveClick);
    u.moveBtn.setAttribute('aria-expanded', 'false');
    u.moveBtn.setAttribute('aria-controls', 'tk-floater-pad');
    u.actions.appendChild(u.pauseBtn);
    u.actions.appendChild(u.resumeBtn);
    u.actions.appendChild(u.stopBtn);
    u.actions.appendChild(u.moveBtn);
    u.head.appendChild(u.dot);
    u.head.appendChild(u.status);
    u.head.appendChild(u.timer);
    u.head.appendChild(u.actions);
    u.padBox = make('div', 'tk-floater-pad');
    u.padBox.id = 'tk-floater-pad';
    u.padBox.hidden = true;
    u.note = make('p', 'tk-floater-note', MSG_WHOLE);
    u.note.hidden = true;
    u.live.appendChild(u.head);
    u.live.appendChild(u.padBox);
    u.live.appendChild(u.note);

    // processing: status only.
    u.processing = make('section', 'tk-floater-view tk-floater-processing');
    u.processingText = make('p', 'tk-floater-title', STATUS_TEXT.processing);
    u.processingText.setAttribute('role', 'status');
    u.processing.appendChild(u.processingText);

    // done: the title, then Download and Open in Takes on one row, then the download's result.
    u.done = make('section', 'tk-floater-view tk-floater-done');
    u.doneTitle = make('p', 'tk-floater-title', MSG_READY);
    u.doneActions = make('div', 'tk-floater-actions');
    u.downloadBtn = button('tk-btn tk-btn-primary tk-floater-download', 'Download', onDownloadClick);
    u.openBtn = button('tk-btn tk-floater-open', 'Open in ' + NAME, function () { hook('openTakes'); });
    u.doneActions.appendChild(u.downloadBtn);
    u.doneActions.appendChild(u.openBtn);
    u.msg = make('p', 'tk-floater-msg');
    u.msg.setAttribute('role', 'status');
    u.msg.setAttribute('aria-live', 'polite');
    u.done.appendChild(u.doneTitle);
    u.done.appendChild(u.doneActions);
    u.done.appendChild(u.msg);

    // short: the take was too short to keep.
    u.short = make('section', 'tk-floater-view tk-floater-short');
    u.shortText = make('p', 'tk-floater-title', MSG_SHORT);
    u.shortText.setAttribute('role', 'status');
    u.shortActions = make('div', 'tk-floater-actions');
    u.shortClose = button('tk-btn tk-floater-close', 'Close', function () { close(); });
    u.shortActions.appendChild(u.shortClose);
    u.short.appendChild(u.shortText);
    u.short.appendChild(u.shortActions);

    // failed: the recorder finished with nothing to keep.
    u.failed = make('section', 'tk-floater-view tk-floater-failed');
    u.failedText = make('p', 'tk-floater-title', MSG_FAILED);
    u.failedText.setAttribute('role', 'status');
    u.failedActions = make('div', 'tk-floater-actions');
    u.failedOpen = button('tk-btn tk-floater-open', 'Open in ' + NAME, function () { hook('openTakes'); });
    u.failedClose = button('tk-btn tk-floater-close', 'Close', function () { close(); });
    u.failedActions.appendChild(u.failedOpen);
    u.failedActions.appendChild(u.failedClose);
    u.failed.appendChild(u.failedText);
    u.failed.appendChild(u.failedActions);

    u.views = { live: u.live, processing: u.processing, done: u.done, short: u.short, failed: u.failed };
    for (var key in u.views) {
      if (!Object.prototype.hasOwnProperty.call(u.views, key)) continue;
      u.views[key].hidden = true;
      body.appendChild(u.views[key]);
    }
    ui = u;
  }

  function setStateClass(look) {
    var body = doc.body;
    for (var key in STATE_CLASSES) {
      if (!Object.prototype.hasOwnProperty.call(STATE_CLASSES, key)) continue;
      if (key === look) body.classList.add(STATE_CLASSES[key]);
      else body.classList.remove(STATE_CLASSES[key]);
    }
  }

  function showView(name) {
    if (!ui) return;
    if (name !== 'live') collapsePad();
    view = name;
    for (var key in ui.views) {
      if (Object.prototype.hasOwnProperty.call(ui.views, key)) setHidden(ui.views[key], key !== name);
    }
    try { doc.body.setAttribute('data-view', name); } catch (err) { /* styling hint only */ }
    setTitle(TITLES[name] || NAME);
    if (name === 'done' || name === 'short' || name === 'failed') {
      setStateClass(null);
      if (name === 'done') ui.msg.textContent = '';
      setExtra(DONE_EXTRA);
    } else if (name === 'processing') {
      setStateClass('processing');
      setExtra(0);
    } else {
      setExtra(liveExtra());
    }
  }

  /** The live row for one recorder state. Mirrors the in-page bar's rules. */
  function renderLive(state, secondsLeft) {
    if (!ui) return;
    // Before the recorder starts (the share picker is still open) the bar reads as the countdown.
    var base = LIVE_STATES[state] ? state : 'countdown';
    var look = base === 'countdown' && secondsLeft === 0 ? 'recording' : base;
    setStateClass(look);
    var text = STATUS_TEXT[look] || '';
    ui.status.textContent = text;
    var whole = !!(hooks && hooks.wholeScreen);
    try { ui.head.setAttribute('title', whole ? text + '. ' + MSG_WHOLE : text); } catch (err) { /* tooltip only */ }
    setHidden(ui.note, !whole);

    // Pause and Resume trade places; Pause only works while recording.
    var hadFocus = doc.activeElement;
    setHidden(ui.pauseBtn, state === 'paused');
    setHidden(ui.resumeBtn, state !== 'paused');
    ui.pauseBtn.disabled = state !== 'recording';
    ui.resumeBtn.disabled = state !== 'paused';
    ui.stopBtn.disabled = !LIVE_STATES[state];
    if (state === 'paused' && hadFocus === ui.pauseBtn) ui.resumeBtn.focus();
    if (state === 'recording' && hadFocus === ui.resumeBtn) ui.pauseBtn.focus();

    var hasBubble = !!readLayout();
    setHidden(ui.moveBtn, !hasBubble);
    if (!hasBubble && padOpen) collapsePad();
    setExtra(liveExtra());
    tick();
  }

  function tick() {
    if (!ui || view !== 'live') return;
    var formatTime = Takes && Takes.util && Takes.util.formatTime;
    var secs = Number(hook('elapsed'));
    ui.timer.textContent = formatTime ? formatTime(secs) : String(Math.floor(secs) || 0);
  }

  /** Show the view that matches the recorder right now (used when opening and reusing). */
  function syncToState() {
    var state = readState();
    lastState = state;
    lastSecondsLeft = undefined;
    if (state === 'processing') { showView('processing'); return; }
    gotDone = false;
    showView('live');
    renderLive(state, undefined);
  }

  // ---------------------------------------------------------------- events

  function onState(payload) {
    if (!win) return;
    var state = payload && typeof payload.state === 'string' ? payload.state : 'idle';
    var prev = lastState;
    lastState = state;
    lastSecondsLeft = payload ? payload.secondsLeft : undefined;

    if (LIVE_STATES[state]) {
      if (view !== 'live') {
        // A new take in a window that still shows the last one.
        gotDone = false;
        showView('live');
      }
      renderLive(state, lastSecondsLeft);
      return;
    }
    if (state === 'processing') {
      showView('processing');
      return;
    }
    // idle
    if (gotDone) return;                  // the done or short view stays up
    if (prev === 'countdown') { close(); return; }   // Stop during the countdown: nothing was recorded
    if (prev === 'processing' || prev === 'recording' || prev === 'paused') showView('failed');
  }

  function onDone(payload) {
    if (!win) return;
    gotDone = true;
    busy = false;
    var ms = Number(payload && payload.durationMs);
    showView(ms >= SHORT_MS ? 'done' : 'short');
    if (ui) ui.downloadBtn.disabled = false;
  }

  function onMoved(pos) {
    if (!pad || !pos) return;
    try { if (typeof pad.setPos === 'function') pad.setPos(pos); } catch (err) { /* keeps its spot */ }
  }

  function onDownloadClick() {
    if (busy || !ui) return;
    busy = true;
    ui.downloadBtn.disabled = true;
    ui.msg.textContent = MSG_SAVING;
    var result;
    try {
      result = typeof hooks.download === 'function' ? hooks.download() : null;
    } catch (err) {
      result = null;
    }
    Promise.resolve(result).then(showDownload, function () { showDownload(null); });
  }

  function showDownload(result) {
    busy = false;
    if (!ui) return;
    ui.downloadBtn.disabled = false;
    var name = typeof result === 'string' ? result : result && typeof result.name === 'string' ? result.name : '';
    if (name) ui.msg.textContent = 'Downloaded as ' + name + '. Look in your Downloads folder.';
    else if (result && typeof result.error === 'string' && result.error) ui.msg.textContent = result.error;
    else ui.msg.textContent = MSG_NO_DOWNLOAD;
  }

  // ---------------------------------------------------------------- open and close

  function attach(w) {
    win = w;
    doc = w.document;
    extra = 0;
    padOpen = false;
    busy = false;
    view = null;
    build();
    copyTheme();
    watchTheme();
    onPageHide = function () { teardown(); };
    w.addEventListener('pagehide', onPageHide);
    timerId = w.setInterval(tick, TIMER_MS);
    unsubs = [
      Takes.bus.on('record:state', onState),
      Takes.bus.on('record:done', onDone),
      Takes.bus.on('bubble:moved', onMoved)
    ];
    syncAndFit();
  }

  /** Let go of the window: the map, the timer, the listeners. Safe to call twice. */
  function teardown() {
    if (!win) return;
    var w = win;
    destroyPad();
    padOpen = false;
    if (timerId !== null) {
      try { w.clearInterval(timerId); } catch (err) { /* the window is gone */ }
      timerId = null;
    }
    for (var i = 0; i < unsubs.length; i++) {
      try { unsubs[i](); } catch (err) { /* already gone */ }
    }
    unsubs = [];
    if (observer) {
      try { observer.disconnect(); } catch (err) { /* already gone */ }
      observer = null;
    }
    try { w.removeEventListener('pagehide', onPageHide); } catch (err) { /* the window is gone */ }
    onPageHide = null;
    win = null;
    doc = null;
    ui = null;
    view = null;
    busy = false;
    Takes.bus.emit('floater:closed', {});
  }

  function supported() {
    var caps = Takes && Takes.state && Takes.state.caps;
    var dpip = root.documentPictureInPicture;
    return !!(caps && caps.docPip) && !!dpip && typeof dpip.requestWindow === 'function';
  }

  function isOpen() {
    return !!win;
  }

  /**
   * Open the bar (or reuse the one already open) for the take described by h.
   * Call it straight from a click: the browser's request runs before anything is awaited.
   * Resolves true when the window is up, false when it is unsupported or refused. Never rejects.
   */
  function open(h) {
    if (h && typeof h === 'object') hooks = h;
    if (!supported()) return Promise.resolve(false);
    var dpip = root.documentPictureInPicture;
    var existing = null;
    try { existing = dpip.window || null; } catch (err) { existing = null; /* treat as none open */ }
    if (existing) {
      if (existing === win) syncAndFit();
      else { teardown(); attach(existing); }
      return Promise.resolve(true);
    }
    if (pending) return pending;
    var request;
    try {
      request = dpip.requestWindow({ width: BAR_SIZE.width, height: BAR_SIZE.height });
    } catch (err) {
      warnRefused(err);
      return Promise.resolve(false);
    }
    var ticket = generation;
    pending = Promise.resolve(request).then(function (w) {
      pending = null;
      if (!w || !w.document) return false;
      if (ticket !== generation) {
        // close() ran while the browser was opening the window.
        try { w.close(); } catch (err) { /* already gone */ }
        return false;
      }
      attach(w);
      return true;
    }, function (err) {
      pending = null;
      warnRefused(err);
      return false;
    });
    return pending;
  }

  /** Close the window if it is open. Safe to call twice. Never touches the recording. */
  function close() {
    generation++;
    var w = win;
    teardown();
    if (w) {
      try { w.close(); } catch (err) { /* already gone */ }
    }
  }

  /** Point the open bar at a take's hooks (the streams and the layout arrive after opening). */
  function attachRun(h) {
    if (h && typeof h === 'object') hooks = h;
    if (!win || !ui) return;
    if (view === 'live') renderLive(lastState, lastSecondsLeft);
    refreshPad();
  }

  var api = {
    supported: supported,
    isOpen: isOpen,
    open: open,
    close: close,
    attachRun: attachRun
  };
  if (Takes) Takes.floater = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
