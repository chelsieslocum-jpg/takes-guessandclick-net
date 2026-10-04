/* takes:compositor */
/*
 * compositor.js: turns the screen stream and the camera stream into ONE video stream.
 * Screen and camera together are drawn onto a canvas (the screen full-frame, the camera
 * as a round bubble with an accent ring) and the canvas is captured as a stream.
 * Screen only, or camera only, is passed straight through with no canvas.
 *
 * Why a worker: a hidden tab slows its own timers and stops animation frames, which would
 * freeze the picture the moment the person switches to the window they are recording.
 * A worker keeps its pace, so it keeps time and the main thread does the drawing.
 * A worker cannot draw on a main-thread canvas; it only posts ticks.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var FPS = 30;
  var MAX_WIDTH = 1920;
  var FALLBACK_ACCENT = '#FF3DA6'; // must stay equal to --tk-accent
  var CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  var SIZES = { small: 0.16, medium: 0.22, large: 0.30 };
  var MARGIN_SHARE = 0.03;
  var VIDEO_READY_MS = 4000;
  var CONSUMER_READY_MS = 1500;
  var RECT_MAX_WIDTH_SHARE = 0.4;
  var RECT_RADIUS_SHARE = 0.08;

  // The worker's whole program. It paces itself against the clock so a late tick never piles up.
  var WORKER_SOURCE =
    'var timer=null,next=0,iv=1000/' + FPS + ';' +
    'function loop(){postMessage(1);next+=iv;var d=next-performance.now();' +
    'if(d<0){next=performance.now();d=0;}timer=setTimeout(loop,d);}' +
    'onmessage=function(e){if(e.data==="start"){next=performance.now();loop();}' +
    'else{clearTimeout(timer);close();}};';

  // Everything one running session owns. null when nothing is running.
  var session = null;
  // Goes up on every start and every stop, so a start that is still waiting can tell it was overtaken.
  var generation = 0;

  // ---------------------------------------------------------------- pure

  function wholeNumber(value, fallback) {
    var n = Math.round(Number(value));
    return isFinite(n) && n > 0 ? n : fallback;
  }

  /**
   * Where the camera bubble sits on a canvas. Pure.
   * corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; anything else is 'bottom-right'.
   * size: 'small' | 'medium' | 'large' (16%, 22%, 30% of the canvas height), or a number of pixels;
   *       anything else is 'medium'.
   * Returns { x, y, d, cx, cy, r } in whole pixels: x and y are the top-left corner of the bubble's
   * bounding square, d the diameter, cx and cy the center, r the radius.
   * The diameter is always even, so the radius and the center are whole pixels too, and it is held
   * small enough that the bubble and its margin always fit inside the canvas.
   */
  function bubbleRect(canvasW, canvasH, corner, size) {
    var w = wholeNumber(canvasW, 2);
    var h = wholeNumber(canvasH, 2);
    var where = CORNERS.indexOf(corner) === -1 ? 'bottom-right' : corner;
    var margin = Math.round(h * MARGIN_SHARE);

    var d;
    if (typeof size === 'number' && isFinite(size) && size > 0) {
      d = Math.round(size);
    } else {
      var share = typeof size === 'string' && Object.prototype.hasOwnProperty.call(SIZES, size) ? SIZES[size] : SIZES.medium;
      d = Math.round(h * share);
    }

    // Never larger than the room left between the margins.
    var room = Math.min(w, h) - 2 * margin;
    if (room < 2) { margin = 0; room = Math.min(w, h); }
    if (d > room) d = room;
    d -= d % 2;
    if (d < 2) d = 2;

    var r = d / 2;
    var x = where === 'top-left' || where === 'bottom-left' ? margin : w - margin - d;
    var y = where === 'top-left' || where === 'top-right' ? margin : h - margin - d;
    return { x: x, y: y, d: d, cx: x + r, cy: y + r, r: r };
  }

  /**
   * Where the camera frame sits on a canvas, for either shape. Pure.
   * shape: 'rectangle' gives a 16:9 rounded rectangle; anything else is the circle, and the result
   * is exactly bubbleRect(canvasW, canvasH, corner, size).
   * For the rectangle it returns { x, y, w, h, radius } in whole pixels: x and y are the top-left
   * corner, w and h the width and height (both even), radius the corner radius (8% of the height).
   * The height is the circle's diameter for the same size and the width is 16/9 of it. The width is
   * held to 40% of the canvas width at most; when that bites, the height shrinks with it so the
   * frame stays 16:9. The gap to the canvas edges is the same as the circle's.
   */
  function bubbleBox(canvasW, canvasH, corner, size, shape) {
    if (shape !== 'rectangle') return bubbleRect(canvasW, canvasH, corner, size);

    var cw = wholeNumber(canvasW, 2);
    var ch = wholeNumber(canvasH, 2);
    var where = CORNERS.indexOf(corner) === -1 ? 'bottom-right' : corner;
    // The circle in the top-left corner gives both the margin (its x) and the height (its diameter).
    var circle = bubbleRect(cw, ch, 'top-left', size);
    var margin = circle.x;

    var h = circle.d;
    var w = Math.round(h * 16 / 9);
    var maxW = Math.min(Math.floor(cw * RECT_MAX_WIDTH_SHARE), cw - 2 * margin);
    if (maxW < 2) maxW = 2;
    if (w > maxW) {
      w = maxW;
      w -= w % 2;
      h = Math.round(w * 9 / 16);
    }
    w -= w % 2;
    h -= h % 2;
    if (w < 2) w = 2;
    if (h < 2) h = 2;

    var x = where === 'top-left' || where === 'bottom-left' ? margin : cw - margin - w;
    var y = where === 'top-left' || where === 'top-right' ? margin : ch - margin - h;
    return { x: x, y: y, w: w, h: h, radius: Math.max(1, Math.round(h * RECT_RADIUS_SHARE)) };
  }

  /** The canvas size for a screen of this size: at most 1920 wide, same shape, both sides even. */
  function canvasSize(srcW, srcH) {
    var w = wholeNumber(srcW, 1280);
    var h = wholeNumber(srcH, 720);
    if (w > MAX_WIDTH) { h = Math.round(h * MAX_WIDTH / w); w = MAX_WIDTH; }
    w -= w % 2;
    h -= h % 2;
    return { width: Math.max(2, w), height: Math.max(2, h) };
  }

  // ---------------------------------------------------------------- helpers

  function emitToast(kind, text) {
    if (Takes && Takes.bus) Takes.bus.emit('toast', { kind: kind, text: text });
  }

  function fail(code, text) {
    var err = new Error(text);
    err.code = code;
    if (text) {
      emitToast('error', text);
      err.toasted = true;
    }
    return err;
  }

  function videoTrackOf(stream) {
    if (!stream || typeof stream.getVideoTracks !== 'function') return null;
    var tracks = stream.getVideoTracks();
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].readyState !== 'ended') return tracks[i];
    }
    return null;
  }

  /** The accent color as the page defines it, so the ring matches the Record button. */
  function readAccent() {
    try {
      var doc = root.document;
      if (doc && doc.documentElement && typeof root.getComputedStyle === 'function') {
        var value = root.getComputedStyle(doc.documentElement).getPropertyValue('--tk-accent');
        value = value ? String(value).trim() : '';
        if (value) return value;
      }
    } catch (err) { /* fall through to the literal */ }
    return FALLBACK_ACCENT;
  }

  /** A muted video element that plays a stream off-screen. It is never added to the page. */
  function makeHiddenVideo(stream) {
    var v = root.document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = stream;
    return v;
  }

  /** Start playback and wait until the first frame is there. Resolves either way; never rejects. */
  function startVideo(v) {
    var ready = new Promise(function (resolve) {
      if (v.readyState >= 2) { resolve(); return; }
      var timer = null;
      function done() {
        clearTimeout(timer);
        v.removeEventListener('loadeddata', done);
        v.removeEventListener('error', done);
        resolve();
      }
      timer = setTimeout(done, VIDEO_READY_MS);
      v.addEventListener('loadeddata', done);
      v.addEventListener('error', done);
    });
    var playing;
    try { playing = v.play(); } catch (err) { playing = null; }
    return Promise.resolve(playing).catch(function () {}).then(function () { return ready; });
  }

  /**
   * Play a video and wait until it has really received a frame: its 'playing' event or its first
   * video-frame callback, whichever comes first. Gives up waiting after CONSUMER_READY_MS and
   * resolves anyway. Never rejects.
   */
  function waitForFrames(v) {
    var ready = new Promise(function (resolve) {
      var finished = false;
      var timer = null;
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { v.removeEventListener('playing', done); } catch (err) { /* already gone */ }
        resolve();
      }
      timer = setTimeout(done, CONSUMER_READY_MS);
      v.addEventListener('playing', done);
      if (typeof v.requestVideoFrameCallback === 'function') {
        try { v.requestVideoFrameCallback(done); } catch (err) { /* the event or the timeout still ends the wait */ }
      }
    });
    var playing;
    try { playing = v.play(); } catch (err) { playing = null; }
    Promise.resolve(playing).catch(function () {});
    return ready;
  }

  function dropVideo(v) {
    if (!v) return;
    try { v.pause(); } catch (err) { /* already gone */ }
    try { v.srcObject = null; } catch (err) { /* already gone */ }
    try { if (v.parentNode) v.parentNode.removeChild(v); } catch (err) { /* never attached */ }
  }

  // ---------------------------------------------------------------- canvas mode

  /** Trace a rounded rectangle as the current path. */
  function roundedPath(ctx, x, y, w, h, radius) {
    var r = Math.max(0, Math.min(radius, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
    }
    ctx.closePath();
  }

  /** The camera as a 16:9 rounded rectangle with the ring. Runs inside drawFrame's try. */
  function drawRectangle(s, vw, vh) {
    var ctx = s.ctx;
    var b = s.box;
    // The largest centered part of the camera frame with the box's own shape, so nothing is stretched.
    var sw = vw;
    var sh = vh;
    if (vw * b.h > vh * b.w) sw = vh * b.w / b.h; else sh = vw * b.h / b.w;
    ctx.save();
    roundedPath(ctx, b.x, b.y, b.w, b.h, b.radius);
    ctx.clip();
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    if (s.mirror) ctx.scale(-1, 1);
    ctx.drawImage(s.cameraVideo, (vw - sw) / 2, (vh - sh) / 2, sw, sh, -b.w / 2, -b.h / 2, b.w, b.h);
    ctx.restore();

    // The ring follows the outline, just inside the edge.
    var half = s.ringWidth / 2;
    roundedPath(ctx, b.x + half, b.y + half, b.w - s.ringWidth, b.h - s.ringWidth, b.radius - half);
    ctx.lineWidth = s.ringWidth;
    ctx.strokeStyle = s.accent;
    ctx.stroke();
  }

  function drawFrame(s) {
    var ctx = s.ctx;
    var w = s.canvas.width;
    var h = s.canvas.height;
    try {
      // The canvas is never cleared, so when the screen video has no frame to give for a moment
      // the last good picture stays up instead of a black one.
      if (s.screenVideo.readyState >= 2) ctx.drawImage(s.screenVideo, 0, 0, w, h);

      // A camera that has ended leaves its last frame in the video element. Never draw that:
      // once the camera is gone the recording carries the screen alone, with no bubble and no ring.
      var vw = s.cameraVideo.videoWidth;
      var vh = s.cameraVideo.videoHeight;
      var cameraLive = !!s.cameraTrack && s.cameraTrack.readyState === 'live' &&
        s.cameraVideo.readyState >= 2 && vw > 0 && vh > 0;
      if (!cameraLive) return;

      if (s.shape === 'rectangle') { drawRectangle(s, vw, vh); return; }

      var b = s.rect;
      {
        // The largest centered square of the camera frame, so a face is never stretched.
        var side = Math.min(vw, vh);
        ctx.save();
        ctx.beginPath();
        ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        // A live camera is flipped left to right, the way a person sees themselves in a mirror.
        // A video file is not, or any words in it would read backwards.
        ctx.translate(b.cx, b.cy);
        if (s.mirror) ctx.scale(-1, 1);
        ctx.drawImage(s.cameraVideo, (vw - side) / 2, (vh - side) / 2, side, side, -b.r, -b.r, b.d, b.d);
        ctx.restore();
      }

      // The ring sits just inside the bubble's edge, so it never crosses into the margin.
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, b.r - s.ringWidth / 2, 0, Math.PI * 2);
      ctx.lineWidth = s.ringWidth;
      ctx.strokeStyle = s.accent;
      ctx.stroke();
    } catch (err) {
      s.drawErrors++;
      if (s.drawErrors === 1 && typeof console !== 'undefined' && console.error) {
        console.error('[Takes] the compositor could not draw a frame:', err);
      }
    }
  }

  function startCanvasMode(screenStream, cameraStream, bubble, myGeneration) {
    var doc = root.document;
    if (!doc || typeof root.Worker !== 'function' || !root.URL || typeof root.Blob !== 'function') {
      return Promise.reject(fail('compositor-failed',
        'This browser cannot put the camera bubble on the screen recording. Turn the camera off, or use Chrome or Edge.'));
    }

    var s = {
      mode: 'canvas',
      screenVideo: null, cameraVideo: null, outputVideo: null,
      cameraTrack: videoTrackOf(cameraStream),
      canvas: null, ctx: null, rect: null, ringWidth: 3,
      accent: readAccent(),
      worker: null, workerUrl: null,
      stream: null,
      drawErrors: 0
    };
    session = s;

    try {
      s.screenVideo = makeHiddenVideo(screenStream);
      s.cameraVideo = makeHiddenVideo(cameraStream);
    } catch (err) {
      teardown(s);
      return Promise.reject(fail('compositor-failed',
        'The recording picture could not be set up. Reload the page and try again.'));
    }

    return Promise.all([startVideo(s.screenVideo), startVideo(s.cameraVideo)]).then(function () {
      if (myGeneration !== generation || session !== s) {
        // stop() or a newer start() arrived while the videos were warming up.
        teardown(s);
        var gone = new Error('The compositor was stopped before it started.');
        gone.code = 'cancelled';
        throw gone;
      }
      try {
        var settings = {};
        var track = videoTrackOf(screenStream);
        try { settings = track && typeof track.getSettings === 'function' ? track.getSettings() || {} : {}; } catch (err) { settings = {}; }
        var size = canvasSize(settings.width || s.screenVideo.videoWidth, settings.height || s.screenVideo.videoHeight);

        s.canvas = doc.createElement('canvas');
        s.canvas.width = size.width;
        s.canvas.height = size.height;
        s.ctx = s.canvas.getContext('2d');
        if (!s.ctx || typeof s.canvas.captureStream !== 'function') throw new Error('no canvas capture');

        s.rect = bubbleRect(size.width, size.height, bubble.corner, bubble.size);
        s.mirror = bubble.mirror !== false;
        s.ringWidth = Math.max(3, Math.round(s.rect.d * 0.035));
        s.shape = bubble.shape === 'rectangle' ? 'rectangle' : 'circle';
        if (s.shape === 'rectangle') {
          s.box = bubbleBox(size.width, size.height, bubble.corner, bubble.size, 'rectangle');
          s.ringWidth = Math.max(3, Math.round(s.box.h * 0.035));
        }

        s.workerUrl = root.URL.createObjectURL(new root.Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        s.worker = new root.Worker(s.workerUrl);
        s.worker.onmessage = function () { if (session === s) drawFrame(s); };
        s.worker.onerror = function (e) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[Takes] the compositor timer failed:', e && e.message ? e.message : e);
          }
        };

        drawFrame(s); // one frame before the stream exists, so it never opens on a blank picture
        s.worker.postMessage('start');
        s.stream = s.canvas.captureStream(FPS);

        // Give the canvas stream a consumer NOW, before any recorder exists. With nothing reading
        // it through the countdown, the recorder re-bases the video clock once its encoder is up,
        // and the picture lands a fraction of a second off the sound for the whole take.
        var consumerReady = Promise.resolve();
        try {
          s.outputVideo = makeHiddenVideo(s.stream);
          consumerReady = waitForFrames(s.outputVideo);
        } catch (err) {
          s.outputVideo = null;
        }
        return consumerReady.then(function () {
          if (myGeneration !== generation || session !== s) {
            teardown(s);
            var stopped = new Error('The compositor was stopped before it started.');
            stopped.code = 'cancelled';
            throw stopped;
          }
          return s.stream;
        });
      } catch (err) {
        teardown(s);
        if (session === s) session = null;
        throw fail('compositor-failed',
          'The camera bubble could not be added to the recording. Turn the camera off and try again, or reload the page.');
      }
    });
  }

  function teardown(s) {
    if (!s) return;
    if (s.worker) {
      try { s.worker.postMessage('stop'); } catch (err) { /* already ended */ }
      try { s.worker.terminate(); } catch (err) { /* already ended */ }
      s.worker.onmessage = null;
      s.worker.onerror = null;
      s.worker = null;
    }
    if (s.workerUrl) {
      try { root.URL.revokeObjectURL(s.workerUrl); } catch (err) { /* already revoked */ }
      s.workerUrl = null;
    }
    // Only the canvas stream is ours to stop. A passed-through track belongs to capture.
    if (s.mode === 'canvas' && s.stream) {
      try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (err) { /* already stopped */ }
    }
    s.stream = null;
    dropVideo(s.outputVideo);
    s.outputVideo = null;
    dropVideo(s.screenVideo);
    dropVideo(s.cameraVideo);
    s.screenVideo = null;
    s.cameraVideo = null;
    if (s.canvas) {
      try { if (s.canvas.parentNode) s.canvas.parentNode.removeChild(s.canvas); } catch (err) { /* never attached */ }
      try { s.canvas.width = 0; s.canvas.height = 0; } catch (err) { /* nothing to free */ }
    }
    s.canvas = null;
    s.ctx = null;
  }

  // ---------------------------------------------------------------- api

  /**
   * ({ screenStream, cameraStream, bubble: { corner, size, mirror } }) -> Promise of a video-only MediaStream.
   * Both streams: the canvas picture. One stream: its own video track, untouched. Neither: rejects
   * with err.code 'nothing-to-record'.
   * bubble.mirror: the bubble is flipped left to right (a selfie view) unless this is exactly false.
   * Pass false when the bubble shows a prerecorded video file, so its on-screen text reads normally.
   * It has no effect on a passed-through stream.
   * bubble.shape: 'circle' (the default, and what anything unknown means) or 'rectangle', a 16:9
   * rounded rectangle as tall as the circle would be wide, in the same corner with the same margin
   * and the same ring. bubbleBox gives its exact place. It has no effect on a passed-through stream.
   */
  function start(options) {
    var opts = options || {};
    var bubble = opts.bubble || {};
    var screenTrack = videoTrackOf(opts.screenStream);
    var cameraTrack = videoTrackOf(opts.cameraStream);

    // One compositor at a time: a second start replaces the first.
    stop();
    var myGeneration = ++generation;

    if (!screenTrack && !cameraTrack) {
      return Promise.reject(fail('nothing-to-record',
        'There is nothing to record. Turn on the screen or the camera, then press Record again.'));
    }

    if (screenTrack && cameraTrack) {
      return startCanvasMode(opts.screenStream, opts.cameraStream, bubble, myGeneration);
    }

    try {
      var passed = new root.MediaStream([screenTrack || cameraTrack]);
      session = { mode: 'passthrough', stream: passed };
      return Promise.resolve(passed);
    } catch (err) {
      return Promise.reject(fail('compositor-failed',
        'The recording picture could not be set up. Reload the page and try again.'));
    }
  }

  /** Ends the worker, the canvas stream and the hidden videos. Never touches the capture tracks. Safe to call twice. */
  function stop() {
    generation++;
    var s = session;
    session = null;
    teardown(s);
  }

  var api = { start: start, stop: stop, bubbleRect: bubbleRect, bubbleBox: bubbleBox };
  if (Takes) Takes.compositor = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
