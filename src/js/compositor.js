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
  var STALL_FRAMES = FPS * 2; // about two seconds of frames in a row not sent counts as a stopped picture
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

  /** A fraction from a position part: a finite number is kept, anything else is 0.5. Pure. */
  function posPart(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0.5;
  }

  /** True when pos is an object whose x and y are both finite numbers. Pure. */
  function isPos(pos) {
    return !!pos && typeof pos === 'object' &&
      typeof pos.x === 'number' && isFinite(pos.x) &&
      typeof pos.y === 'number' && isFinite(pos.y);
  }

  /** The center of a box (either shape) as fractions of the canvas width and height. Pure. */
  function centerOf(box, canvasW, canvasH) {
    var w = box.d !== undefined ? box.d : box.w;
    var h = box.d !== undefined ? box.d : box.h;
    return { x: (box.x + w / 2) / canvasW, y: (box.y + h / 2) / canvasH };
  }

  /** value held between lo and hi; lo wins when the range is empty. Pure. */
  function clampTo(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  /**
   * Where the camera frame sits when its center is placed anywhere on the canvas. Pure.
   * size and shape mean exactly what they mean to bubbleBox, and the frame is the same size a
   * corner frame would be.
   * pos: { x, y }, the frame's CENTER as fractions of the canvas width and height. A missing or
   * non-finite part is 0.5; values outside 0..1 are allowed and clamped.
   * The frame is placed with its center at (pos.x * width, pos.y * height), rounded to whole pixels,
   * then the whole frame is held inside the canvas with the same margin a corner frame keeps.
   * Returns what bubbleBox returns for that shape: circle { x, y, d, cx, cy, r }, rectangle
   * { x, y, w, h, radius }.
   */
  function bubbleAt(canvasW, canvasH, size, shape, pos) {
    var cw = wholeNumber(canvasW, 2);
    var ch = wholeNumber(canvasH, 2);
    var p = pos && typeof pos === 'object' ? pos : {};
    var fx = posPart(p.x);
    var fy = posPart(p.y);
    // The top-left circle gives the margin, with bubbleRect's zero-margin fallback for tiny canvases.
    var margin = bubbleRect(cw, ch, 'top-left', size).x;
    var base = bubbleBox(cw, ch, 'top-left', size, shape);
    var w = base.d !== undefined ? base.d : base.w;
    var h = base.d !== undefined ? base.d : base.h;

    var x = clampTo(Math.round(fx * cw - w / 2), margin, cw - margin - w);
    var y = clampTo(Math.round(fy * ch - h / 2), margin, ch - margin - h);

    if (base.d !== undefined) {
      var r = base.d / 2;
      return { x: x, y: y, d: base.d, cx: x + r, cy: y + r, r: r };
    }
    return { x: x, y: y, w: base.w, h: base.h, radius: base.radius };
  }

  /**
   * The center of a corner frame as fractions of the canvas width and height. Pure.
   * Arguments mean what they mean to bubbleBox. Placing a frame at this position with bubbleAt
   * gives exactly bubbleBox(canvasW, canvasH, corner, size, shape).
   * Returns { x, y }.
   */
  function cornerPos(canvasW, canvasH, corner, size, shape) {
    var cw = wholeNumber(canvasW, 2);
    var ch = wholeNumber(canvasH, 2);
    return centerOf(bubbleBox(cw, ch, corner, size, shape), cw, ch);
  }

  /**
   * The position a frame really ends up at once bubbleAt has held it inside the canvas. Pure.
   * Arguments mean what they mean to bubbleAt. Returns { x, y }, the center of
   * bubbleAt(canvasW, canvasH, size, shape, pos) as fractions of the canvas width and height.
   * Feeding the result back into bubbleAt gives the same frame.
   */
  function clampPos(canvasW, canvasH, size, shape, pos) {
    var cw = wholeNumber(canvasW, 2);
    var ch = wholeNumber(canvasH, 2);
    return centerOf(bubbleAt(cw, ch, size, shape, pos), cw, ch);
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

  // ---------------------------------------------------------------- frame output
  //
  // Why the picture is not sent with canvas.captureStream() where it can be avoided: in Chrome and Edge, a canvas
  // capture track stops delivering frames for good while the page also has a Document Picture-in-Picture window
  // open and the tab is in front. The canvas keeps being drawn 30 times a second, but the track goes silent,
  // usually as the recorder starts or as the floating window is resized, so the recording keeps its sound and its
  // picture freezes (or holds no video at all). The stall is in the browser's capture of a GPU-drawn canvas:
  // the same canvas drawn without the GPU never stalls, but then each frame costs far too much main-thread time
  // at full size.
  // A track generator does not wait on anything: each tick hands it one VideoFrame made from the canvas, so a
  // frame is sent exactly when one is drawn, whatever the page's rendering is doing. A browser without a
  // generator has no Document Picture-in-Picture either, so captureStream() is safe there.

  /**
   * Opens the track the canvas picture is sent on, sets s.writer when frames are pushed by hand, and returns
   * the MediaStream. Falls back to canvas.captureStream(FPS) when the generator, VideoFrame or MediaStream is
   * missing, or when a frame cannot be made from this canvas.
   */
  function openFrameOutput(s) {
    s.writer = null;
    s.generator = null;
    s.pendingWrites = 0;
    s.frameErrors = 0;
    s.missedFrames = 0;
    s.stallWarned = false;
    s.lastTimestamp = 0;
    var Generator = root.MediaStreamTrackGenerator;
    if (typeof Generator === 'function' && typeof root.VideoFrame === 'function' && typeof root.MediaStream === 'function') {
      var generator = null;
      try {
        // One frame first, so a canvas the browser cannot make frames from takes the captureStream road instead.
        var probe = new root.VideoFrame(s.canvas, { timestamp: 0 });
        try { probe.close(); } catch (err) { /* already released */ }
        generator = new Generator({ kind: 'video' });
        var writer = generator.writable.getWriter();
        var stream = new root.MediaStream([generator]);
        s.generator = generator;
        s.writer = writer;
        return stream;
      } catch (err) {
        if (generator) { try { generator.stop(); } catch (stopErr) { /* never started */ } }
        s.generator = null;
        s.writer = null;
      }
    }
    return s.canvas.captureStream(FPS);
  }

  /** The time in microseconds, for a VideoFrame's timestamp. */
  function nowMicros() {
    var perf = root.performance;
    var ms = perf && typeof perf.now === 'function' ? perf.now() : Date.now();
    return Math.round(ms * 1000);
  }

  /** Logs the first frame error of a session, with what went wrong. Later ones are only counted. */
  function noteFrameError(s, err) {
    s.frameErrors++;
    if (s.frameErrors === 1 && typeof console !== 'undefined' && console.error) {
      console.error('[Takes] the compositor could not send a frame:', err);
    }
  }

  /**
   * Counts one frame that did not go out. Once STALL_FRAMES in a row have not gone out, the picture in the
   * recording has stopped moving, so the person is told once for that stall. The take is not ended: the sound
   * and what was recorded so far are still theirs to keep. A write that lands clears the count (see pushFrame).
   */
  function missFrame(s, reason) {
    if (session !== s || !s.writer) return; // stopped: nothing is being recorded any more
    s.missedFrames++;
    if (s.missedFrames < STALL_FRAMES || s.stallWarned) return;
    s.stallWarned = true;
    if (typeof console !== 'undefined' && console.error) {
      console.error('[Takes] the recording picture stopped updating: ' + s.missedFrames +
        ' frames in a row were not sent (' + reason + ').');
    }
    emitToast('error', 'The video picture stopped updating. Stop now to keep what you have, then record again.');
  }

  /**
   * Sends what the canvas shows now as one frame, when frames are pushed by hand (a no-op on the captureStream
   * road). A frame is dropped rather than queued while two writes are still in flight, so a slow consumer can
   * never pile up frames (each one holds a copy of the picture). Every frame that does not go out is counted,
   * so a picture that has stopped is reported rather than recorded silently.
   */
  function pushFrame(s) {
    if (!s.writer) return;
    if (s.pendingWrites >= 2) {
      missFrame(s, 'earlier frames are still waiting to be taken');
      return;
    }
    // Each frame's timestamp is later than the one before, even if the clock has not moved on.
    var timestamp = Math.max(nowMicros(), s.lastTimestamp + 1);
    var frame;
    try {
      frame = new root.VideoFrame(s.canvas, { timestamp: timestamp });
    } catch (err) {
      noteFrameError(s, err);
      missFrame(s, 'a frame could not be made from the canvas');
      return;
    }
    s.lastTimestamp = timestamp;
    var writer = s.writer;
    s.pendingWrites++;
    // The generator takes the frame and releases it once sent; a refused write leaves it with us to release.
    Promise.resolve().then(function () { return writer.write(frame); }).then(function () {
      s.pendingWrites--;
      s.missedFrames = 0;
      s.stallWarned = false; // the picture is moving again, so a later stall is reported again
    }, function (err) {
      s.pendingWrites--;
      try { frame.close(); } catch (closeErr) { /* already released */ }
      // A write refused because stop() closed the writer is the normal end of a take, not a fault.
      if (s.writer !== writer) return;
      noteFrameError(s, err);
      missFrame(s, 'the browser refused a frame');
    });
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

        s.corner = bubble.corner;
        s.size = bubble.size;
        s.pos = null;
        if (isPos(bubble.pos)) {
          // A free position: the same frame size as a corner, placed where the person put it.
          s.rect = bubbleAt(size.width, size.height, bubble.size, 'circle', bubble.pos);
          s.mirror = bubble.mirror !== false;
          s.ringWidth = Math.max(3, Math.round(s.rect.d * 0.035));
          s.shape = bubble.shape === 'rectangle' ? 'rectangle' : 'circle';
          if (s.shape === 'rectangle') {
            s.box = bubbleAt(size.width, size.height, bubble.size, 'rectangle', bubble.pos);
            s.ringWidth = Math.max(3, Math.round(s.box.h * 0.035));
          }
          s.pos = clampPos(size.width, size.height, bubble.size, s.shape, bubble.pos);
        } else {
          s.rect = bubbleRect(size.width, size.height, bubble.corner, bubble.size);
          s.mirror = bubble.mirror !== false;
          s.ringWidth = Math.max(3, Math.round(s.rect.d * 0.035));
          s.shape = bubble.shape === 'rectangle' ? 'rectangle' : 'circle';
          if (s.shape === 'rectangle') {
            s.box = bubbleBox(size.width, size.height, bubble.corner, bubble.size, 'rectangle');
            s.ringWidth = Math.max(3, Math.round(s.box.h * 0.035));
          }
        }

        s.workerUrl = root.URL.createObjectURL(new root.Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        s.worker = new root.Worker(s.workerUrl);
        s.worker.onmessage = function () {
          if (session !== s) return;
          drawFrame(s);
          pushFrame(s);
        };
        s.worker.onerror = function (e) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[Takes] the compositor timer failed:', e && e.message ? e.message : e);
          }
        };

        drawFrame(s); // one frame before the stream exists, so it never opens on a blank picture
        s.worker.postMessage('start');
        s.stream = openFrameOutput(s);
        pushFrame(s); // the first frame goes out now, not a tick later

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
    if (s.writer) {
      var writer = s.writer;
      s.writer = null;
      try { Promise.resolve(writer.close()).catch(function () {}); } catch (err) { /* already closed */ }
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
   * bubble.pos: optional { x, y }, the frame's center as fractions of the picture's width and height.
   * When both parts are finite numbers it wins over corner and bubbleAt gives the exact place;
   * otherwise the corner is used. moveBubble moves it while the take runs.
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

  /** The running canvas picture's session, or null (nothing running, passed through, or still warming up). */
  function canvasSession() {
    var s = session;
    return s && s.mode === 'canvas' && s.canvas ? s : null;
  }

  /**
   * Moves the camera frame of the running canvas picture to pos ({ x, y }, its center as fractions,
   * read the way bubbleAt reads it). The size and the ring stay as they are.
   * Returns the position actually used once the frame is held inside the canvas, and emits it as
   * 'bubble:moved'. Returns null, and changes nothing, when no canvas picture is running.
   * The next frame drawn shows the move; the new place is swapped in with one assignment.
   */
  function moveBubble(pos) {
    var s = canvasSession();
    if (!s) return null;
    var w = s.canvas.width;
    var h = s.canvas.height;
    var box = bubbleAt(w, h, s.size, s.shape, pos);
    if (s.shape === 'rectangle') s.box = box; else s.rect = box;
    var used = centerOf(box, w, h);
    s.pos = used;
    if (Takes && Takes.bus) Takes.bus.emit('bubble:moved', { x: used.x, y: used.y });
    return { x: used.x, y: used.y };
  }

  /**
   * The running canvas picture: { width, height, shape, size, pos, mirror }, where pos is the
   * frame's center as fractions (the corner's center when the take started on a corner).
   * null when no canvas picture is running.
   */
  function layout() {
    var s = canvasSession();
    if (!s) return null;
    var w = s.canvas.width;
    var h = s.canvas.height;
    var pos = s.pos ? { x: s.pos.x, y: s.pos.y } : cornerPos(w, h, s.corner, s.size, s.shape);
    return { width: w, height: h, shape: s.shape, size: s.size, pos: pos, mirror: s.mirror };
  }

  var api = {
    start: start, stop: stop,
    bubbleRect: bubbleRect, bubbleBox: bubbleBox,
    bubbleAt: bubbleAt, cornerPos: cornerPos, clampPos: clampPos,
    moveBubble: moveBubble, layout: layout
  };
  if (Takes) Takes.compositor = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
