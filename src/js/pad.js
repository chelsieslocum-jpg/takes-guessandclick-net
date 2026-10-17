/* takes:pad */
/*
 * pad.js: the drag surface for the camera bubble. It is a small map of the recording frame with
 * a bubble on it that can be dragged with a pointer or moved with the arrow keys. The bubble's
 * place on the map comes from the compositor's own bubbleAt, so what is shown here is the same
 * geometry the recording gets. It can be built in any document (the main page or a floating
 * Picture-in-Picture window), and it only reports positions; the caller decides what they move.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var STEP = 0.02;
  var FINE_STEP = 0.005;
  var DEFAULT_ASPECT = 16 / 9;
  var HINT_TEXT = 'Drag the bubble, or use the arrow keys.';
  var SIZES = ['small', 'medium', 'large'];

  // Gives each pad's hint its own id, so aria-describedby never points at another pad's hint.
  var hintCount = 0;

  // ---------------------------------------------------------------- pure

  function finite(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /** A position with every missing or non-finite part set to the center (0.5). Pure. */
  function cleanPos(pos) {
    var p = pos && typeof pos === 'object' ? pos : {};
    return { x: finite(p.x) ? p.x : 0.5, y: finite(p.y) ? p.y : 0.5 };
  }

  function validPos(pos) {
    return !!(pos && typeof pos === 'object' && finite(pos.x) && finite(pos.y));
  }

  /**
   * Turns a pointer position into a bubble position. Pure.
   * padRect: { left, top, width, height } of the pad's frame element, in CSS pixels.
   * clientX, clientY: the pointer, in the same coordinates.
   * grab: { dx, dy }, the offset (as fractions of the frame) between the pointer and the bubble's
   *       center when the drag began, so the bubble does not jump under the pointer. Missing or
   *       non-finite parts are 0.
   * Returns { x, y }: the bubble's center as fractions of the frame. It is NOT clamped; the
   * compositor's bubbleAt keeps the bubble inside the frame. A frame with no width or no height,
   * or a pointer that is not a number, gives the center { 0.5, 0.5 } for that axis.
   */
  function clientToPos(padRect, clientX, clientY, grab) {
    var r = padRect && typeof padRect === 'object' ? padRect : {};
    var g = grab && typeof grab === 'object' ? grab : {};
    var dx = finite(g.dx) ? g.dx : 0;
    var dy = finite(g.dy) ? g.dy : 0;
    var left = finite(r.left) ? r.left : 0;
    var top = finite(r.top) ? r.top : 0;
    var x = finite(r.width) && r.width > 0 && finite(clientX) ? (clientX - left) / r.width - dx : 0.5;
    var y = finite(r.height) && r.height > 0 && finite(clientY) ? (clientY - top) / r.height - dy : 0.5;
    return { x: x, y: y };
  }

  /**
   * Moves a bubble position for one key press. Pure.
   * pos: the current { x, y } (missing parts count as the center).
   * key: a KeyboardEvent key name. ArrowLeft, ArrowRight, ArrowUp and ArrowDown move 0.02 of the
   *      frame (0.005 when fine is true, for Alt held). Home gives { 0, 0 } and End gives { 1, 1 };
   *      the compositor's bubbleAt clamps both into the frame's margins.
   * Returns the new { x, y }, not clamped, or null for any other key.
   */
  function nudge(pos, key, fine) {
    var p = cleanPos(pos);
    var step = fine === true ? FINE_STEP : STEP;
    switch (key) {
      case 'ArrowLeft': return { x: p.x - step, y: p.y };
      case 'ArrowRight': return { x: p.x + step, y: p.y };
      case 'ArrowUp': return { x: p.x, y: p.y - step };
      case 'ArrowDown': return { x: p.x, y: p.y + step };
      case 'Home': return { x: 0, y: 0 };
      case 'End': return { x: 1, y: 1 };
      default: return null;
    }
  }

  // ---------------------------------------------------------------- helpers

  function setClass(node, name, on) {
    var list = String(node.className || '').split(/\s+/).filter(function (c) { return c && c !== name; });
    if (on) list.push(name);
    node.className = list.join(' ');
  }

  function compositor() {
    var T = root.Takes || Takes;
    return T && T.compositor && typeof T.compositor.bubbleAt === 'function' ? T.compositor : null;
  }

  function makeVideo(doc, className, stream) {
    var v = doc.createElement('video');
    v.className = className;
    try {
      v.muted = true;
      v.setAttribute('muted', '');
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.autoplay = true;
      v.setAttribute('autoplay', '');
      v.setAttribute('aria-hidden', 'true');
    } catch (err) { /* a minimal element without attributes still plays */ }
    try { v.srcObject = stream; } catch (err) { /* an unusable stream leaves the placeholder look */ }
    var playing;
    try { playing = v.play(); } catch (err) { playing = null; }
    Promise.resolve(playing).catch(function () {});
    return v;
  }

  // Detaches a video this pad made. It never stops the stream's tracks: the stream is not the pad's.
  function dropVideo(v) {
    if (!v) return;
    try { v.pause(); } catch (err) { /* already gone */ }
    try { v.srcObject = null; } catch (err) { /* already gone */ }
    try { if (v.parentNode) v.parentNode.removeChild(v); } catch (err) { /* never attached */ }
  }

  function isInside(node, ancestor) {
    var n = node;
    while (n) {
      if (n === ancestor) return true;
      n = n.parentNode;
    }
    return false;
  }

  // ---------------------------------------------------------------- mount

  /**
   * Builds a pad inside container, in opts.doc, and returns a handle to drive it.
   *
   * opts:
   *   doc          the document to build in (required; the main page or a Picture-in-Picture window's)
   *   aspect       the frame's width / height (default 16 / 9)
   *   shape        'circle' (default) or 'rectangle'
   *   size         'small', 'medium' (default) or 'large'
   *   pos          { x, y }, the bubble's center as fractions of the frame (missing parts are 0.5)
   *   stream       a MediaStream shown inside the bubble, or null for the plain bubble
   *   screenStream a MediaStream shown behind the bubble as the frame's background, or null for none
   *   mirror       true to flip the bubble's video left to right (the screen is never flipped)
   *   label        the bubble's accessible name (default 'Camera bubble position')
   *   onMove(pos)  called with every new position while dragging or on each key press, at most once
   *                per animation frame. It may return a corrected { x, y }, which the pad then shows.
   *   onSettle(pos) called once when a drag or a key press ends, with the position the pad shows
   *
   * The handle:
   *   setPos(pos)              show the bubble at pos (no onMove call)
   *   setStream(stream, mirror) swap the bubble's video; mirror is applied when it is a boolean
   *   setScreen(stream)        swap the background video, or remove it with null
   *   setAspect(aspect)        change the frame's width / height
   *   setShape(shape)          'circle' or 'rectangle'
   *   destroy()                remove the pad and its listeners. The streams' tracks are never stopped:
   *                            the streams belong to the caller. Safe to call twice.
   */
  function mount(container, opts) {
    var o = opts || {};
    var doc = o.doc;
    if (!doc || typeof doc.createElement !== 'function') throw new Error('pad.mount needs opts.doc');
    var win = doc.defaultView || null;

    var state = {
      aspect: finite(o.aspect) && o.aspect > 0 ? o.aspect : DEFAULT_ASPECT,
      shape: o.shape === 'rectangle' ? 'rectangle' : 'circle',
      size: SIZES.indexOf(o.size) === -1 ? 'medium' : o.size,
      pos: cleanPos(o.pos),
      stream: null,
      mirror: o.mirror === true,
      screen: null,
      box: null,
      frameW: 0,
      frameH: 0,
      drag: null,
      pending: null,
      rafId: null,
      destroyed: false
    };
    var onMove = typeof o.onMove === 'function' ? o.onMove : null;
    var onSettle = typeof o.onSettle === 'function' ? o.onSettle : null;
    var bound = [];
    var observer = null;
    var video = null;
    var screenVideo = null;

    // ---- the tree
    var pad = doc.createElement('div');
    pad.className = 'tk-pad';
    var frame = doc.createElement('div');
    frame.className = 'tk-pad-frame';
    var bubble = doc.createElement('button');
    bubble.className = 'tk-pad-bubble';
    var hint = doc.createElement('p');
    hint.className = 'tk-pad-hint';
    hintCount += 1;
    hint.id = 'tk-pad-hint-' + hintCount;
    hint.textContent = HINT_TEXT;

    bubble.setAttribute('type', 'button');
    try { bubble.type = 'button'; } catch (err) { /* the attribute is enough */ }
    bubble.setAttribute('aria-label', typeof o.label === 'string' && o.label ? o.label : 'Camera bubble position');
    bubble.setAttribute('aria-describedby', hint.id);

    frame.appendChild(bubble);
    pad.appendChild(frame);
    pad.appendChild(hint);

    function listen(target, type, fn) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      bound.push([target, type, fn]);
    }

    // ---- geometry

    function frameRect() {
      var r = null;
      try { r = frame.getBoundingClientRect(); } catch (err) { /* not in a document yet */ }
      if (!r) r = { left: 0, top: 0, width: frame.clientWidth || 0, height: frame.clientHeight || 0 };
      return r;
    }

    function layout() {
      if (state.destroyed) return;
      var comp = compositor();
      var r = frameRect();
      var w = Math.round(Number(r.width) || 0);
      var h = Math.round(Number(r.height) || 0);
      if (!comp || w < 2 || h < 2) return; // hidden or not laid out yet; the next resize lays it out
      state.frameW = w;
      state.frameH = h;

      // Hold the position to what the frame can show, so key presses past an edge do not pile up.
      var lo = comp.bubbleAt(w, h, state.size, state.shape, { x: 0, y: 0 });
      var hi = comp.bubbleAt(w, h, state.size, state.shape, { x: 1, y: 1 });
      var bw = state.shape === 'rectangle' ? lo.w : lo.d;
      var bh = state.shape === 'rectangle' ? lo.h : lo.d;
      var minX = (lo.x + bw / 2) / w;
      var maxX = (hi.x + bw / 2) / w;
      var minY = (lo.y + bh / 2) / h;
      var maxY = (hi.y + bh / 2) / h;
      state.pos = {
        x: Math.min(maxX, Math.max(minX, state.pos.x)),
        y: Math.min(maxY, Math.max(minY, state.pos.y))
      };

      var box = comp.bubbleAt(w, h, state.size, state.shape, state.pos);
      state.box = box;
      var s = bubble.style;
      s.left = box.x + 'px';
      s.top = box.y + 'px';
      if (state.shape === 'rectangle') {
        s.width = box.w + 'px';
        s.height = box.h + 'px';
        s.borderRadius = box.radius + 'px';
      } else {
        s.width = box.d + 'px';
        s.height = box.d + 'px';
        s.borderRadius = '';
      }
    }

    function boxCenter() {
      var b = state.box;
      if (!b || !state.frameW || !state.frameH) return cleanPos(state.pos);
      var bw = state.shape === 'rectangle' ? b.w : b.d;
      var bh = state.shape === 'rectangle' ? b.h : b.d;
      return { x: (b.x + bw / 2) / state.frameW, y: (b.y + bh / 2) / state.frameH };
    }

    // Sends a position out and shows what comes back (or what was sent).
    function apply(pos) {
      var shown = pos;
      if (onMove) {
        var back;
        try { back = onMove({ x: pos.x, y: pos.y }); } catch (err) { back = null; }
        if (validPos(back)) shown = back;
      }
      state.pos = cleanPos(shown);
      layout();
    }

    function flush() {
      state.rafId = null;
      var p = state.pending;
      state.pending = null;
      if (p && !state.destroyed) apply(p);
    }

    // One onMove per animation frame of the pad's own window; straight through without one.
    function queue(pos) {
      state.pending = pos;
      if (win && typeof win.requestAnimationFrame === 'function') {
        if (state.rafId === null) {
          try { state.rafId = win.requestAnimationFrame(flush); } catch (err) { state.rafId = null; flush(); }
        }
      } else {
        flush();
      }
    }

    function cancelQueued() {
      if (state.rafId !== null && win && typeof win.cancelAnimationFrame === 'function') {
        try { win.cancelAnimationFrame(state.rafId); } catch (err) { /* already ran */ }
      }
      state.rafId = null;
    }

    function settle() {
      if (onSettle) {
        try { onSettle({ x: state.pos.x, y: state.pos.y }); } catch (err) { /* the caller's problem, not the drag's */ }
      }
    }

    // ---- videos

    function setStream(stream, mirror) {
      if (state.destroyed) return;
      if (typeof mirror === 'boolean') state.mirror = mirror;
      var next = stream || null;
      if (next !== state.stream) {
        dropVideo(video);
        video = null;
        state.stream = next;
        if (next) {
          video = makeVideo(doc, 'tk-pad-video', next);
          bubble.appendChild(video);
        }
      }
      if (video) video.style.transform = state.mirror ? 'scaleX(-1)' : '';
    }

    function setScreen(stream) {
      if (state.destroyed) return;
      var next = stream || null;
      if (next === state.screen) return;
      dropVideo(screenVideo);
      screenVideo = null;
      state.screen = next;
      if (next) {
        // The shared screen sits behind the bubble, never mirrored.
        screenVideo = makeVideo(doc, 'tk-pad-screen', next);
        frame.insertBefore(screenVideo, bubble);
      }
    }

    // ---- input

    function endDrag(e) {
      var d = state.drag;
      if (!d) return;
      if (e && finite(e.pointerId) && finite(d.pointerId) && e.pointerId !== d.pointerId) return;
      state.drag = null;
      setClass(bubble, 'tk-is-dragging', false);
      try { frame.releasePointerCapture(d.pointerId); } catch (err) { /* a synthetic pointer has no capture */ }
      cancelQueued();
      if (state.pending) flush();
      settle();
    }

    function onPointerDown(e) {
      if (state.destroyed || state.drag) return;
      if (finite(e.button) && e.button !== 0) return;
      var r = frameRect();
      var at = clientToPos(r, e.clientX, e.clientY, null);
      var grab = { dx: 0, dy: 0 };
      var onBubble = isInside(e.target, bubble);
      if (onBubble) {
        var c = boxCenter();
        grab = { dx: at.x - c.x, dy: at.y - c.y };
      }
      state.drag = { pointerId: e.pointerId, grab: grab };
      setClass(bubble, 'tk-is-dragging', true);
      try { frame.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer has no capture */ }
      try { if (typeof e.preventDefault === 'function') e.preventDefault(); } catch (err) { /* nothing to stop */ }
      try { if (typeof bubble.focus === 'function') bubble.focus(); } catch (err) { /* focus is a nicety */ }
      // A press on empty frame space jumps the bubble there.
      if (!onBubble) queue(at);
    }

    function onPointerMove(e) {
      var d = state.drag;
      if (!d) return;
      if (finite(e.pointerId) && finite(d.pointerId) && e.pointerId !== d.pointerId) return;
      queue(clientToPos(frameRect(), e.clientX, e.clientY, d.grab));
    }

    function onKeyDown(e) {
      if (state.destroyed) return;
      var next = nudge(state.pos, e.key, e.altKey === true);
      if (!next) return;
      try { if (typeof e.preventDefault === 'function') e.preventDefault(); } catch (err) { /* nothing to stop */ }
      apply(next);
    }

    function onKeyUp(e) {
      if (state.destroyed) return;
      if (nudge(state.pos, e.key, false)) settle();
    }

    listen(frame, 'pointerdown', onPointerDown);
    listen(frame, 'pointermove', onPointerMove);
    listen(frame, 'pointerup', endDrag);
    listen(frame, 'pointercancel', endDrag);
    listen(bubble, 'keydown', onKeyDown);
    listen(bubble, 'keyup', onKeyUp);

    // ---- size and placement

    try { frame.style.aspectRatio = String(state.aspect); } catch (err) { /* older engines size by width */ }
    if (state.shape === 'rectangle') setClass(bubble, 'tk-is-rect', true);
    if (container && typeof container.appendChild === 'function') container.appendChild(pad);

    if (win && typeof win.ResizeObserver === 'function') {
      try {
        observer = new win.ResizeObserver(function () { layout(); });
        observer.observe(frame);
      } catch (err) { observer = null; }
    }
    if (!observer) listen(win, 'resize', layout);

    if (o.stream) setStream(o.stream, o.mirror === true);
    if (o.screenStream) setScreen(o.screenStream);
    layout();

    return {
      setPos: function (pos) {
        if (state.destroyed) return;
        state.pos = cleanPos(pos);
        layout();
      },
      setStream: setStream,
      setScreen: setScreen,
      setAspect: function (aspect) {
        if (state.destroyed) return;
        state.aspect = finite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
        try { frame.style.aspectRatio = String(state.aspect); } catch (err) { /* older engines size by width */ }
        layout();
      },
      setShape: function (shape) {
        if (state.destroyed) return;
        state.shape = shape === 'rectangle' ? 'rectangle' : 'circle';
        setClass(bubble, 'tk-is-rect', state.shape === 'rectangle');
        layout();
      },
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        cancelQueued();
        state.pending = null;
        state.drag = null;
        for (var i = 0; i < bound.length; i++) {
          try { bound[i][0].removeEventListener(bound[i][1], bound[i][2]); } catch (err) { /* already gone */ }
        }
        bound = [];
        if (observer) {
          try { observer.disconnect(); } catch (err) { /* already gone */ }
          observer = null;
        }
        dropVideo(video);
        dropVideo(screenVideo);
        video = null;
        screenVideo = null;
        state.stream = null;
        state.screen = null;
        try { if (pad.parentNode) pad.parentNode.removeChild(pad); } catch (err) { /* never attached */ }
      }
    };
  }

  var api = { clientToPos: clientToPos, nudge: nudge, mount: mount };
  if (Takes) Takes.pad = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
