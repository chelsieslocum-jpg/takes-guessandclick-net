// Tests for src/js/pad.js: clientToPos and nudge (pure), and mount driven by hand-written fake DOM objects.
// Run from the repository root: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const compositor = require('../src/js/compositor.js');
const pad = require('../src/js/pad.js');
const { clientToPos, nudge, mount } = pad;

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------ fake DOM

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = '';
    this.attrs = {};
    this.listeners = {};
    this.textContent = '';
    this.id = '';
    this.captured = [];
    this.released = [];
    this.focused = 0;
    this.played = 0;
    this.paused = 0;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.children.indexOf(ref);
    child.parentNode = this;
    if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }
  listenerCount() { return Object.values(this.listeners).reduce((n, l) => n + l.length, 0); }
  fire(type, props = {}) {
    let prevented = false;
    const e = Object.assign({ type, target: this, preventDefault() { prevented = true; } }, props);
    for (const fn of [...(this.listeners[type] || [])]) fn(e);
    return { prevented };
  }
  getBoundingClientRect() {
    if (this.className.split(' ').includes('tk-pad-frame')) return { ...this.ownerDocument.frameRect };
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  setPointerCapture(id) {
    if (this.ownerDocument.captureThrows) throw new Error('NotFoundError');
    this.captured.push(id);
  }
  releasePointerCapture(id) {
    if (this.ownerDocument.captureThrows) throw new Error('NotFoundError');
    this.released.push(id);
  }
  focus() { this.focused += 1; }
  play() { this.played += 1; return Promise.reject(new Error('autoplay blocked')); }
  pause() { this.paused += 1; }
  hasClass(name) { return this.className.split(/\s+/).includes(name); }
}

function makeWindow(opts = {}) {
  const win = { listeners: {}, rafQueue: [], observers: [] };
  win.addEventListener = (t, fn) => { (win.listeners[t] = win.listeners[t] || []).push(fn); };
  win.removeEventListener = (t, fn) => {
    const l = win.listeners[t] || [];
    const i = l.indexOf(fn);
    if (i !== -1) l.splice(i, 1);
  };
  win.fire = (t) => { for (const fn of [...(win.listeners[t] || [])]) fn({ type: t }); };
  if (opts.raf) {
    let id = 0;
    win.requestAnimationFrame = (fn) => { id += 1; win.rafQueue.push({ id, fn }); return id; };
    win.cancelAnimationFrame = (cid) => { win.rafQueue = win.rafQueue.filter((r) => r.id !== cid); };
    win.runFrame = () => { const q = win.rafQueue; win.rafQueue = []; for (const r of q) r.fn(); };
  }
  if (opts.resizeObserver) {
    win.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; win.observers.push(this); }
      observe(t) { this.targets.push(t); }
      disconnect() { this.disconnected = true; }
    };
  }
  return win;
}

function makeDoc(opts = {}) {
  const doc = {
    created: [],
    frameRect: opts.frameRect || { left: 100, top: 50, width: 320, height: 180 },
    captureThrows: !!opts.captureThrows,
    defaultView: opts.win || makeWindow(opts)
  };
  doc.createElement = (tag) => {
    const el = new FakeElement(doc, tag);
    doc.created.push(el);
    return el;
  };
  return doc;
}

function find(node, cls) {
  if (node.hasClass && node.hasClass(cls)) return node;
  for (const c of node.children || []) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function fakeStream() {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function setup(extra = {}, docOpts = {}) {
  const doc = makeDoc(docOpts);
  const container = doc.createElement('div');
  const handle = mount(container, Object.assign({ doc }, extra));
  const root = container.children[0];
  return {
    doc, container, handle, root,
    frame: find(root, 'tk-pad-frame'),
    bubble: find(root, 'tk-pad-bubble'),
    hint: find(root, 'tk-pad-hint')
  };
}

function bubbleGeom(bubble) {
  return {
    left: parseFloat(bubble.style.left),
    top: parseFloat(bubble.style.top),
    width: parseFloat(bubble.style.width),
    height: parseFloat(bubble.style.height)
  };
}

function expectedGeom(w, h, size, shape, pos) {
  const b = compositor.bubbleAt(w, h, size, shape, pos);
  return shape === 'rectangle'
    ? { left: b.x, top: b.y, width: b.w, height: b.h }
    : { left: b.x, top: b.y, width: b.d, height: b.d };
}

// ------------------------------------------------------------------ module shape

test('pad loads under Node, attaches itself to Takes, and exposes exactly its public methods', () => {
  assert.equal(Takes.pad, pad);
  assert.deepEqual(Object.keys(pad).sort(), ['clientToPos', 'mount', 'nudge']);
  for (const key of Object.keys(pad)) assert.equal(typeof pad[key], 'function', key);
  assert.equal(typeof compositor.bubbleAt, 'function', 'compositor.bubbleAt must exist for the pad to place the bubble');
});

// ------------------------------------------------------------------ clientToPos

test('clientToPos: the corners and center of the frame map to 0, 1 and 0.5', () => {
  const rects = [
    { left: 0, top: 0, width: 320, height: 180 },
    { left: 100, top: 50, width: 640, height: 360 },
    { left: -20, top: 7.5, width: 199, height: 99 }
  ];
  for (const r of rects) {
    const cases = [
      [r.left, r.top, 0, 0],
      [r.left + r.width, r.top, 1, 0],
      [r.left, r.top + r.height, 0, 1],
      [r.left + r.width, r.top + r.height, 1, 1],
      [r.left + r.width / 2, r.top + r.height / 2, 0.5, 0.5]
    ];
    for (const [cx, cy, ex, ey] of cases) {
      const p = clientToPos(r, cx, cy);
      assert.ok(close(p.x, ex) && close(p.y, ey), `${JSON.stringify(r)} ${cx},${cy} -> ${JSON.stringify(p)}`);
    }
  }
});

test('clientToPos: the grab offset is subtracted, and the result is not clamped', () => {
  const r = { left: 10, top: 20, width: 200, height: 100 };
  const p = clientToPos(r, 110, 70, { dx: 0.1, dy: -0.2 });
  assert.ok(close(p.x, 0.4) && close(p.y, 0.7), JSON.stringify(p));
  const out = clientToPos(r, -90, 220);
  assert.ok(close(out.x, -0.5) && close(out.y, 2), 'outside the frame stays outside');
  const partial = clientToPos(r, 110, 70, { dx: 0.25 });
  assert.ok(close(partial.x, 0.25) && close(partial.y, 0.5), 'a missing grab part is 0');
  const bad = clientToPos(r, 110, 70, { dx: NaN, dy: 'x' });
  assert.ok(close(bad.x, 0.5) && close(bad.y, 0.5), 'a non-number grab part is 0');
});

test('clientToPos: a zero-size, missing or broken frame gives the center', () => {
  for (const r of [{ left: 0, top: 0, width: 0, height: 0 }, null, undefined, {}, { width: -5, height: NaN }]) {
    assert.deepEqual(clientToPos(r, 50, 50), { x: 0.5, y: 0.5 }, JSON.stringify(r));
  }
  assert.deepEqual(clientToPos({ left: 0, top: 0, width: 100, height: 100 }, NaN, undefined), { x: 0.5, y: 0.5 });
});

// ------------------------------------------------------------------ nudge

test('nudge: every key, coarse and fine', () => {
  const start = { x: 0.5, y: 0.4 };
  const table = [
    ['ArrowLeft', false, 0.48, 0.4],
    ['ArrowRight', false, 0.52, 0.4],
    ['ArrowUp', false, 0.5, 0.38],
    ['ArrowDown', false, 0.5, 0.42],
    ['ArrowLeft', true, 0.495, 0.4],
    ['ArrowRight', true, 0.505, 0.4],
    ['ArrowUp', true, 0.5, 0.395],
    ['ArrowDown', true, 0.5, 0.405],
    ['Home', false, 0, 0],
    ['End', false, 1, 1],
    ['Home', true, 0, 0],
    ['End', true, 1, 1]
  ];
  for (const [key, fine, ex, ey] of table) {
    const p = nudge(start, key, fine);
    assert.ok(close(p.x, ex) && close(p.y, ey), `${key} fine=${fine} -> ${JSON.stringify(p)}`);
  }
  assert.deepEqual(start, { x: 0.5, y: 0.4 }, 'the input is never changed');
});

test('nudge: any other key gives null, and a missing position starts from the center', () => {
  for (const key of ['a', 'Enter', ' ', 'Tab', 'Escape', 'PageUp', 'Left', '', undefined, null]) {
    assert.equal(nudge({ x: 0.5, y: 0.5 }, key, false), null, String(key));
  }
  const p = nudge(null, 'ArrowRight', false);
  assert.ok(close(p.x, 0.52) && close(p.y, 0.5));
  const q = nudge({ x: NaN }, 'ArrowDown', 'yes');
  assert.ok(close(q.x, 0.5) && close(q.y, 0.52), 'only fine === true is the fine step');
});

// ------------------------------------------------------------------ mount: tree

test('mount builds the class contract tree, every node in the given doc and none in the opener', () => {
  const opener = { createElement() { throw new Error('the opener document was used'); } };
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const saved = globalThis.document;
  globalThis.document = opener;
  try {
    const { doc, container, root, frame, bubble, hint, handle } = setup({ label: 'Camera bubble position', stream: fakeStream(), screenStream: fakeStream() });
    assert.equal(container.children.length, 1);
    assert.equal(root.tagName, 'DIV');
    assert.equal(root.className, 'tk-pad');
    assert.equal(root.children[0], frame);
    assert.equal(root.children[1], hint);
    assert.equal(frame.tagName, 'DIV');
    assert.equal(bubble.tagName, 'BUTTON');
    assert.equal(bubble.getAttribute('type'), 'button');
    assert.equal(bubble.getAttribute('aria-label'), 'Camera bubble position');
    assert.ok(hint.id, 'the hint has an id');
    assert.equal(bubble.getAttribute('aria-describedby'), hint.id);
    assert.equal(hint.tagName, 'P');
    assert.equal(hint.textContent, 'Drag the bubble, or use the arrow keys.');
    assert.ok(close(Number(frame.style.aspectRatio), 16 / 9), 'aspect-ratio set inline, 16:9 by default');
    walk(root, (n) => assert.equal(n.ownerDocument, doc, `${n.tagName}.${n.className} built in the given doc`));
    handle.destroy();
  } finally {
    if (hadDocument) globalThis.document = saved; else delete globalThis.document;
  }
});

test('mount: two pads get different hint ids', () => {
  const a = setup();
  const b = setup();
  assert.notEqual(a.hint.id, b.hint.id);
});

test('mount: cold start with no pos and no stream is a centered placeholder with no video', () => {
  const { bubble, frame, doc } = setup();
  assert.equal(bubble.children.length, 0, 'no video element');
  assert.equal(find(frame, 'tk-pad-screen'), null, 'no screen video');
  assert.equal(doc.created.filter((n) => n.tagName === 'VIDEO').length, 0);
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 180, 'medium', 'circle', { x: 0.5, y: 0.5 }));
  const g = bubbleGeom(bubble);
  assert.ok(Math.abs(g.left + g.width / 2 - 160) <= 1 && Math.abs(g.top + g.height / 2 - 90) <= 1, 'centered');
  assert.equal(bubble.hasClass('tk-is-rect'), false);
});

// ------------------------------------------------------------------ mount: CONTRACT drift

test('CONTRACT: the bubble on the pad has exactly compositor.bubbleAt geometry for the same inputs', () => {
  const frames = [[320, 180], [300, 169], [640, 360], [198, 98], [180, 320], [427, 240]];
  const positions = [{ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.7 }, { x: 0.9, y: 0.1 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: -0.5, y: 1.5 }];
  for (const [w, h] of frames) {
    for (const shape of ['circle', 'rectangle']) {
      for (const size of ['small', 'medium', 'large']) {
        for (const pos of positions) {
          const { bubble, handle } = setup({ shape, size, pos }, { frameRect: { left: 3, top: 4, width: w, height: h } });
          const label = `${w}x${h} ${shape} ${size} ${JSON.stringify(pos)}`;
          assert.deepEqual(bubbleGeom(bubble), expectedGeom(w, h, size, shape, pos), label);
          if (shape === 'rectangle') {
            const b = compositor.bubbleAt(w, h, size, shape, pos);
            assert.equal(bubble.style.borderRadius, b.radius + 'px', label);
            assert.equal(bubble.hasClass('tk-is-rect'), true, label);
          } else {
            assert.equal(bubble.style.borderRadius, '', label);
          }
          handle.destroy();
        }
      }
    }
  }
});

test('setShape, setAspect and setPos re-lay the bubble out with bubbleAt', () => {
  const { doc, bubble, frame, handle } = setup({ pos: { x: 0.3, y: 0.6 } });
  handle.setShape('rectangle');
  assert.equal(bubble.hasClass('tk-is-rect'), true);
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 180, 'medium', 'rectangle', { x: 0.3, y: 0.6 }));
  handle.setShape('circle');
  assert.equal(bubble.hasClass('tk-is-rect'), false);
  doc.frameRect = { left: 0, top: 0, width: 320, height: 240 };
  handle.setAspect(4 / 3);
  assert.ok(close(Number(frame.style.aspectRatio), 4 / 3));
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 240, 'medium', 'circle', { x: 0.3, y: 0.6 }));
  handle.setAspect(NaN);
  assert.ok(close(Number(frame.style.aspectRatio), 16 / 9), 'a bad aspect falls back to 16:9');
  handle.setPos({ x: 0.8, y: 0.25 });
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 240, 'medium', 'circle', { x: 0.8, y: 0.25 }));
  handle.setPos(null);
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 240, 'medium', 'circle', { x: 0.5, y: 0.5 }));
});

test('a frame that is not laid out yet is laid out by the ResizeObserver', () => {
  const win = makeWindow({ resizeObserver: true });
  const { doc, bubble, frame, handle } = setup({ pos: { x: 0.25, y: 0.25 } }, { win, frameRect: { left: 0, top: 0, width: 0, height: 0 } });
  assert.equal(bubble.style.left, undefined, 'nothing placed at zero size');
  assert.equal(win.observers.length, 1);
  assert.deepEqual(win.observers[0].targets, [frame]);
  doc.frameRect = { left: 0, top: 0, width: 640, height: 360 };
  win.observers[0].cb([]);
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(640, 360, 'medium', 'circle', { x: 0.25, y: 0.25 }));
  assert.equal((win.listeners.resize || []).length, 0, 'no resize listener when an observer exists');
  handle.destroy();
  assert.equal(win.observers[0].disconnected, true);
});

test('without a ResizeObserver the window resize event re-lays it out', () => {
  const win = makeWindow();
  const { doc, bubble, handle } = setup({}, { win });
  assert.equal(win.listeners.resize.length, 1);
  doc.frameRect = { left: 0, top: 0, width: 640, height: 360 };
  win.fire('resize');
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(640, 360, 'medium', 'circle', { x: 0.5, y: 0.5 }));
  handle.destroy();
  assert.equal(win.listeners.resize.length, 0);
});

// ------------------------------------------------------------------ mount: pointer

test('pointer drag: the grab keeps the bubble under the pointer, onMove gets each move, onSettle once at the end', () => {
  const moves = [];
  const settles = [];
  const { bubble, frame } = setup({ pos: { x: 0.5, y: 0.5 }, onMove: (p) => { moves.push(p); }, onSettle: (p) => settles.push(p) });
  // frame at left 100, top 50, 320x180; the bubble's center is at client (260, 140). Grab 10 px right of it.
  frame.fire('pointerdown', { target: bubble, pointerId: 7, button: 0, clientX: 270, clientY: 140 });
  assert.deepEqual(frame.captured, [7]);
  assert.equal(bubble.hasClass('tk-is-dragging'), true);
  assert.equal(moves.length, 0, 'a press on the bubble does not move it');
  frame.fire('pointermove', { target: frame, pointerId: 7, clientX: 238, clientY: 104 });
  assert.equal(moves.length, 1);
  // 32 px left of the grab point and 36 px up: center moves to (228, 104) -> (0.4, 0.3).
  assert.ok(close(moves[0].x, 0.4, 1e-6) && close(moves[0].y, 0.3, 1e-6), JSON.stringify(moves[0]));
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 180, 'medium', 'circle', moves[0]));
  frame.fire('pointermove', { target: frame, pointerId: 99, clientX: 0, clientY: 0 });
  assert.equal(moves.length, 1, 'another pointer is ignored');
  assert.equal(settles.length, 0, 'nothing settles mid-drag');
  frame.fire('pointerup', { target: frame, pointerId: 7 });
  assert.deepEqual(frame.released, [7]);
  assert.equal(bubble.hasClass('tk-is-dragging'), false);
  assert.equal(settles.length, 1);
  assert.ok(close(settles[0].x, 0.4, 1e-6) && close(settles[0].y, 0.3, 1e-6));
  frame.fire('pointermove', { target: frame, pointerId: 7, clientX: 120, clientY: 60 });
  assert.equal(moves.length, 1, 'no moves after the drag ends');
});

test('pointerdown on empty frame space jumps the bubble there (grab 0); pointercancel also settles', () => {
  const moves = [];
  const settles = [];
  const { bubble, frame } = setup({ pos: { x: 0.5, y: 0.5 }, onMove: (p) => { moves.push(p); }, onSettle: (p) => settles.push(p) });
  frame.fire('pointerdown', { target: frame, pointerId: 1, button: 0, clientX: 100 + 64, clientY: 50 + 54 });
  assert.equal(moves.length, 1);
  assert.ok(close(moves[0].x, 0.2) && close(moves[0].y, 0.3), JSON.stringify(moves[0]));
  frame.fire('pointercancel', { target: frame, pointerId: 1 });
  assert.equal(settles.length, 1);
  assert.equal(bubble.hasClass('tk-is-dragging'), false);
});

test('a press on the video inside the bubble counts as a press on the bubble', () => {
  const moves = [];
  const { bubble, frame } = setup({ stream: fakeStream(), onMove: (p) => { moves.push(p); } });
  const video = find(bubble, 'tk-pad-video');
  frame.fire('pointerdown', { target: video, pointerId: 2, button: 0, clientX: 265, clientY: 145 });
  assert.equal(moves.length, 0);
});

test('a right-button press does nothing', () => {
  const moves = [];
  const { bubble, frame } = setup({ onMove: (p) => { moves.push(p); } });
  frame.fire('pointerdown', { target: frame, pointerId: 3, button: 2, clientX: 120, clientY: 60 });
  assert.equal(moves.length, 0);
  assert.equal(bubble.hasClass('tk-is-dragging'), false);
  assert.deepEqual(frame.captured, []);
});

test('pointer capture that throws (a synthetic pointerId) never breaks the drag', () => {
  const moves = [];
  const settles = [];
  const { frame, bubble } = setup({ onMove: (p) => { moves.push(p); }, onSettle: (p) => settles.push(p) }, { captureThrows: true });
  assert.doesNotThrow(() => frame.fire('pointerdown', { target: bubble, pointerId: 1, button: 0, clientX: 260, clientY: 140 }));
  frame.fire('pointermove', { target: frame, pointerId: 1, clientX: 200, clientY: 100 });
  assert.equal(moves.length, 1);
  assert.doesNotThrow(() => frame.fire('pointerup', { target: frame, pointerId: 1 }));
  assert.equal(settles.length, 1);
});

test('onMove returning a clamped position is what the pad shows and settles', () => {
  const settles = [];
  const { bubble, frame } = setup({ onMove: () => ({ x: 0.7, y: 0.2 }), onSettle: (p) => settles.push(p) });
  frame.fire('pointerdown', { target: frame, pointerId: 1, button: 0, clientX: 120, clientY: 60 });
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 180, 'medium', 'circle', { x: 0.7, y: 0.2 }));
  frame.fire('pointerup', { target: frame, pointerId: 1 });
  assert.ok(close(settles[0].x, 0.7, 1e-6) && close(settles[0].y, 0.2, 1e-6), JSON.stringify(settles[0]));
});

test('moves are coalesced to one onMove per animation frame, and pointerup flushes the last one', () => {
  const win = makeWindow({ raf: true });
  const moves = [];
  const settles = [];
  const { bubble, frame } = setup({ onMove: (p) => { moves.push(p); }, onSettle: (p) => settles.push(p) }, { win });
  frame.fire('pointerdown', { target: bubble, pointerId: 1, button: 0, clientX: 260, clientY: 140 });
  frame.fire('pointermove', { target: frame, pointerId: 1, clientX: 250, clientY: 140 });
  frame.fire('pointermove', { target: frame, pointerId: 1, clientX: 240, clientY: 140 });
  frame.fire('pointermove', { target: frame, pointerId: 1, clientX: 228, clientY: 140 });
  assert.equal(moves.length, 0, 'nothing until the frame');
  assert.equal(win.rafQueue.length, 1, 'one frame requested');
  win.runFrame();
  assert.equal(moves.length, 1);
  assert.ok(close(moves[0].x, 0.4, 1e-6), 'the latest move wins');
  frame.fire('pointermove', { target: frame, pointerId: 1, clientX: 196, clientY: 140 });
  frame.fire('pointerup', { target: frame, pointerId: 1 });
  assert.equal(moves.length, 2, 'pointerup flushes the waiting move');
  assert.ok(close(moves[1].x, 0.3, 1e-6));
  assert.equal(win.rafQueue.length, 0, 'the waiting frame is cancelled');
  assert.equal(settles.length, 1);
  assert.ok(close(settles[0].x, 0.3, 1e-6));
});

// ------------------------------------------------------------------ mount: keyboard

test('keyboard: arrows nudge through onMove, unknown keys are left alone, keyup settles', () => {
  const moves = [];
  const settles = [];
  const { bubble } = setup({ pos: { x: 0.5, y: 0.5 }, onMove: (p) => { moves.push(p); }, onSettle: (p) => settles.push(p) });
  const r = bubble.fire('keydown', { key: 'ArrowRight' });
  assert.equal(r.prevented, true);
  assert.equal(moves.length, 1);
  assert.ok(close(moves[0].x, 0.52) && close(moves[0].y, 0.5));
  assert.equal(settles.length, 0, 'keydown does not settle');
  bubble.fire('keyup', { key: 'ArrowRight' });
  assert.equal(settles.length, 1);
  const fine = bubble.fire('keydown', { key: 'ArrowUp', altKey: true });
  assert.equal(fine.prevented, true);
  assert.ok(close(moves[1].y, 0.495));
  const other = bubble.fire('keydown', { key: 'Tab' });
  assert.equal(other.prevented, false, 'Tab still moves focus');
  assert.equal(moves.length, 2);
  bubble.fire('keyup', { key: 'Tab' });
  assert.equal(settles.length, 1, 'an unhandled key never settles');
});

test('keyboard: Home and End reach the clamped corners, and presses past an edge do not pile up', () => {
  const moves = [];
  const { bubble } = setup({ onMove: (p) => { moves.push(p); } });
  bubble.fire('keydown', { key: 'End' });
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 180, 'medium', 'circle', { x: 1, y: 1 }));
  for (let i = 0; i < 20; i++) bubble.fire('keydown', { key: 'ArrowRight' });
  bubble.fire('keydown', { key: 'ArrowLeft' });
  const atEdge = expectedGeom(320, 180, 'medium', 'circle', { x: 1, y: 1 });
  const g = bubbleGeom(bubble);
  assert.ok(g.left < atEdge.left, 'one press left moves off the edge at once');
  bubble.fire('keydown', { key: 'Home' });
  assert.deepEqual(bubbleGeom(bubble), expectedGeom(320, 180, 'medium', 'circle', { x: 0, y: 0 }));
});

// ------------------------------------------------------------------ mount: videos

test('setStream shows the stream in the bubble, mirrored on request, and never stops its tracks', () => {
  const s1 = fakeStream();
  const s2 = fakeStream();
  const { bubble, handle } = setup({ stream: s1, mirror: true });
  let v = find(bubble, 'tk-pad-video');
  assert.ok(v, 'a video element');
  assert.equal(v.tagName, 'VIDEO');
  assert.equal(v.srcObject, s1);
  assert.equal(v.muted, true);
  assert.equal(v.playsInline, true);
  assert.equal(v.autoplay, true);
  assert.equal(v.getAttribute('playsinline'), '');
  assert.equal(v.played, 1, 'play() is called (its rejection is swallowed)');
  assert.equal(v.style.transform, 'scaleX(-1)');
  handle.setStream(s1, false);
  assert.equal(find(bubble, 'tk-pad-video'), v, 'same stream keeps the same element');
  assert.equal(v.style.transform, '');
  handle.setStream(s2);
  assert.equal(v.srcObject, null, 'the old video is detached');
  assert.equal(v.parentNode, null);
  v = find(bubble, 'tk-pad-video');
  assert.equal(v.srcObject, s2);
  assert.equal(v.style.transform, '', 'mirror is kept when not passed');
  handle.setStream(null);
  assert.equal(bubble.children.length, 0, 'no stream: back to the placeholder');
  assert.equal(s1.track.stops + s2.track.stops, 0, 'no track was ever stopped');
});

test('setScreen puts the raw screen behind the bubble, never mirrored', () => {
  const screen = fakeStream();
  const { frame, bubble, handle } = setup({ mirror: true, stream: fakeStream() });
  assert.equal(find(frame, 'tk-pad-screen'), null);
  handle.setScreen(screen);
  const v = find(frame, 'tk-pad-screen');
  assert.ok(v);
  assert.equal(v.tagName, 'VIDEO');
  assert.equal(v.srcObject, screen);
  assert.equal(v.muted, true);
  assert.equal(frame.children.indexOf(v) < frame.children.indexOf(bubble), true, 'below the bubble');
  assert.ok(!v.style.transform, 'never mirrored');
  handle.setScreen(null);
  assert.equal(find(frame, 'tk-pad-screen'), null);
  assert.equal(v.srcObject, null);
  assert.equal(screen.track.stops, 0);
});

test('opts.screenStream at mount shows the screen from the start', () => {
  const screen = fakeStream();
  const { frame, bubble } = setup({ screenStream: screen });
  const v = find(frame, 'tk-pad-screen');
  assert.equal(v.srcObject, screen);
  assert.equal(frame.children[0], v);
  assert.equal(frame.children[1], bubble);
});

// ------------------------------------------------------------------ mount: destroy

test('destroy removes the DOM and every listener, detaches videos, stops no track, and is safe twice', () => {
  const cam = fakeStream();
  const screen = fakeStream();
  const win = makeWindow({ raf: true });
  const moves = [];
  const settles = [];
  const { container, frame, bubble, handle } = setup({ stream: cam, screenStream: screen, onMove: (p) => moves.push(p), onSettle: (p) => settles.push(p) }, { win });
  const v = find(bubble, 'tk-pad-video');
  const sv = find(frame, 'tk-pad-screen');
  frame.fire('pointerdown', { target: bubble, pointerId: 1, button: 0, clientX: 260, clientY: 140 });
  frame.fire('pointermove', { target: frame, pointerId: 1, clientX: 200, clientY: 100 });
  assert.equal(win.rafQueue.length, 1);
  assert.ok(frame.listenerCount() > 0 && bubble.listenerCount() > 0);
  handle.destroy();
  assert.equal(container.children.length, 0, 'the pad is gone');
  assert.equal(frame.listenerCount(), 0);
  assert.equal(bubble.listenerCount(), 0);
  assert.equal(win.rafQueue.length, 0, 'the waiting frame is cancelled');
  assert.equal(v.srcObject, null);
  assert.equal(sv.srcObject, null);
  assert.ok(v.paused >= 1 && sv.paused >= 1);
  assert.equal(cam.track.stops, 0);
  assert.equal(screen.track.stops, 0);
  assert.equal(moves.length, 0);
  assert.doesNotThrow(() => handle.destroy());
  assert.doesNotThrow(() => { handle.setPos({ x: 0.1, y: 0.1 }); handle.setStream(fakeStream()); handle.setScreen(fakeStream()); handle.setShape('rectangle'); handle.setAspect(1); });
  assert.equal(bubble.children.length, 0, 'nothing is rebuilt after destroy');
  assert.equal(settles.length, 0);
});

test('mount without a doc throws a plain error', () => {
  assert.throws(() => mount({ appendChild() {} }, {}), /opts\.doc/);
});
