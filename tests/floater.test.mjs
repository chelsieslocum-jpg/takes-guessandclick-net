// Tests for src/js/floater.js: the floating control bar, driven against a fake Picture-in-Picture
// window, a fake document and a fake bubble map. No browser, no dependencies.
// Run from the repository root: node --test

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const floater = require('../src/js/floater.js');

// ------------------------------------------------------------------ a small fake DOM

class FakeClassList {
  constructor(el) { this.el = el; }
  list() { return this.el.className.split(/\s+/).filter(Boolean); }
  add(c) { const l = this.list(); if (!l.includes(c)) { l.push(c); this.el.className = l.join(' '); } }
  remove(c) { this.el.className = this.list().filter((x) => x !== c).join(' '); }
  contains(c) { return this.list().includes(c); }
}

class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = {};
    this.id = '';
    this.type = '';
    this.ownText = '';
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this.ownText = String(v); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const l = this.listeners[t] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (this.disabled) return; (this.listeners.click || []).slice().forEach((fn) => fn({ type: 'click' })); }
  getElementsByTagName(tag) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); });
    walk(this);
    return out;
  }
}

class FakeDoc {
  constructor(name) {
    this.name = name;
    this.created = 0;
    this.title = '';
    this.activeElement = null;
    this.documentElement = new FakeEl(this, 'html');
    this.head = new FakeEl(this, 'head');
    this.body = new FakeEl(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.styleSheets = [];
  }
  createElement(tag) { this.created++; return new FakeEl(this, tag); }
}

function all(root) {
  const out = [];
  const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
  walk(root);
  return out;
}

function visible(el) {
  for (let n = el; n; n = n.parentNode) {
    if (n.hidden) return false;
    if (n.classList && n.classList.contains('tk-sr-only')) return false;
  }
  return true;
}

function byClass(doc, cls) {
  return all(doc.body).filter((e) => e.classList.contains(cls));
}

function one(doc, cls) {
  const list = byClass(doc, cls);
  assert.equal(list.length, 1, 'exactly one .' + cls);
  return list[0];
}

function visibleButtons(doc) {
  return all(doc.body).filter((e) => e.tagName === 'BUTTON' && visible(e)).map((b) => b.textContent);
}

/** Visible elements that carry their own text and are not buttons. */
function visibleTexts(doc) {
  return all(doc.body)
    .filter((e) => e.tagName !== 'BUTTON' && e.ownText && visible(e) && !hasButtonAncestor(e))
    .map((e) => e.ownText);
}

function hasButtonAncestor(e) {
  for (let n = e.parentNode; n; n = n.parentNode) if (n.tagName === 'BUTTON') return true;
  return false;
}

function currentView(doc) {
  const shown = byClass(doc, 'tk-floater-view').filter((s) => !s.hidden);
  assert.equal(shown.length, 1, 'exactly one view shows');
  const names = ['live', 'processing', 'done', 'short', 'failed'];
  return names.find((n) => shown[0].classList.contains('tk-floater-' + n));
}

// ------------------------------------------------------------------ the fake window, the fake API, the fake map

let opener;
let dpip;
let windows;
let warns;
let padMounts;
let observers;
let closedEvents;

function makeWindow() {
  const w = {
    document: new FakeDoc('pip'),
    closed: false,
    outerWidth: 316,
    outerHeight: 100,
    innerWidth: 300,
    innerHeight: 64,
    listeners: {},
    timers: new Map(),
    nextTimer: 1,
    resizes: [],
    closeCalls: 0,
    // Like a browser: resizeTo sets the outer size and the frame around the page stays the same.
    resizeTo(width, height) {
      this.resizes.push([width, height]);
      this.innerWidth += width - this.outerWidth;
      this.innerHeight += height - this.outerHeight;
      this.outerWidth = width;
      this.outerHeight = height;
    },
    setInterval(fn, ms) { const id = this.nextTimer++; this.timers.set(id, { fn, ms }); return id; },
    clearInterval(id) { this.timers.delete(id); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const l = this.listeners[t] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); },
    fire(t) { (this.listeners[t] || []).slice().forEach((fn) => fn({ type: t })); },
    close() {
      this.closeCalls++;
      if (this.closed) return;
      this.closed = true;
      if (dpip.window === this) dpip.window = null;
      this.fire('pagehide');
    },
    runTimers() { this.timers.forEach((t) => t.fn()); }
  };
  windows.push(w);
  return w;
}

function makeDpip(mode) {
  return {
    window: null,
    mode: mode || 'ok',
    calls: [],
    requestWindow(opts) {
      this.calls.push(opts);
      if (this.mode === 'reject') return Promise.reject(new Error('Refused: no user activation'));
      if (this.mode === 'throw') throw new RangeError('bad size');
      const w = makeWindow();
      if (this.onWindow) this.onWindow(w);
      this.window = w;
      return Promise.resolve(w);
    }
  };
}

function makePad() {
  return {
    mount(container, opts) {
      const node = opts.doc.createElement('div');
      node.className = 'tk-pad';
      container.appendChild(node);
      const h = {
        container, opts, node, destroyed: 0, calls: [],
        setPos(p) { h.calls.push(['setPos', p]); },
        setStream(s, m) { h.calls.push(['setStream', s, m]); },
        setScreen(s) { h.calls.push(['setScreen', s]); },
        setAspect(a) { h.calls.push(['setAspect', a]); },
        setShape(s) { h.calls.push(['setShape', s]); },
        destroy() { h.destroyed++; if (node.parentNode) node.parentNode.removeChild(node); }
      };
      padMounts.push(h);
      return h;
    }
  };
}

const LAYOUT = { width: 1920, height: 1080, shape: 'circle', size: 'medium', pos: { x: 0.8, y: 0.8 }, mirror: true };
const CAMERA = { id: 'camera-stream' };
const SCREEN = { id: 'screen-stream' };

function makeHooks(over) {
  const h = {
    state: 'idle',
    seconds: 0,
    layout: null,
    calls: [],
    downloadResult: { name: 'takes-2026-10-17-0931.mp4' },
    getState() { return h.state; },
    elapsed() { return h.seconds; },
    pause() { h.calls.push('pause'); },
    resume() { h.calls.push('resume'); },
    stop() { h.calls.push('stop'); },
    download() { h.calls.push('download'); return Promise.resolve(h.downloadResult); },
    openTakes() { h.calls.push('openTakes'); },
    getLayout() { return h.layout; },
    moveBubble(pos) { h.calls.push(['moveBubble', pos]); return { x: Math.min(pos.x, 0.9), y: pos.y }; },
    cameraStream: null,
    screenStream: null,
    mirror: false,
    wholeScreen: false
  };
  return Object.assign(h, over || {});
}

function emit(state, secondsLeft) {
  const payload = { state };
  if (typeof secondsLeft === 'number') payload.secondsLeft = secondsLeft;
  Takes.bus.emit('record:state', payload);
}

function done(ms) {
  Takes.bus.emit('record:done', { id: 'x', blob: {}, durationMs: ms, createdAt: 0 });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function openWith(hooks) {
  const ok = await floater.open(hooks);
  assert.equal(ok, true);
  return dpip.window;
}

beforeEach(() => {
  opener = new FakeDoc('opener');
  const style = opener.createElement('style');
  style.textContent = '.tk-btn{color:red}';
  opener.head.appendChild(style);
  opener.documentElement.setAttribute('data-theme', 'dark');
  opener.created = 0;
  globalThis.document = opener;
  windows = [];
  dpip = makeDpip();
  globalThis.documentPictureInPicture = dpip;
  Takes.state.caps.docPip = true;
  padMounts = [];
  Takes.pad = makePad();
  observers = [];
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
    observe(target, opts) { this.target = target; this.opts = opts; }
    disconnect() { this.disconnected = true; }
  };
  warns = [];
  console.warn = (...args) => { warns.push(args); };
  closedEvents = 0;
  Takes.bus.on('floater:closed', onClosed);
});

function onClosed() { closedEvents++; }

afterEach(() => {
  floater.close();
  Takes.bus.off('floater:closed', onClosed);
  delete globalThis.documentPictureInPicture;
  delete globalThis.document;
  delete globalThis.MutationObserver;
  Takes.state.caps.docPip = false;
});

// ------------------------------------------------------------------ module shape

test('floater loads under Node and attaches itself to Takes', () => {
  assert.equal(Takes.floater, floater);
  assert.deepEqual(Object.keys(floater).sort(), ['attachRun', 'close', 'isOpen', 'open', 'supported']);
  assert.equal(floater.isOpen(), false);
});

// ------------------------------------------------------------------ opening

test('unsupported: open resolves false and never throws or asks the browser', async () => {
  Takes.state.caps.docPip = false;
  assert.equal(floater.supported(), false);
  assert.equal(await floater.open(makeHooks()), false);
  assert.equal(dpip.calls.length, 0);
  Takes.state.caps.docPip = true;
  delete globalThis.documentPictureInPicture;
  assert.equal(floater.supported(), false);
  assert.equal(await floater.open(makeHooks()), false);
  assert.equal(floater.isOpen(), false);
});

test('a refused request resolves false with one console.warn and no toast', async () => {
  dpip.mode = 'reject';
  const toasts = [];
  const off = Takes.bus.on('toast', (t) => toasts.push(t));
  assert.equal(await floater.open(makeHooks()), false);
  off();
  assert.equal(warns.length, 1);
  assert.equal(toasts.length, 0);
  assert.equal(floater.isOpen(), false);
});

test('a request that throws synchronously resolves false with one console.warn', async () => {
  dpip.mode = 'throw';
  assert.equal(await floater.open(makeHooks()), false);
  assert.equal(warns.length, 1);
});

test('requestWindow is called synchronously, with width AND height, for the slim bar', () => {
  const p = floater.open(makeHooks());
  assert.equal(dpip.calls.length, 1, 'called before open returns');
  assert.deepEqual(dpip.calls[0], { width: 300, height: 64 });
  assert.equal('preferInitialWindowPlacement' in dpip.calls[0], false);
  assert.ok(p && typeof p.then === 'function');
  return p;
});

test('two opens in the same turn share one request', async () => {
  const hooks = makeHooks();
  const a = floater.open(hooks);
  const b = floater.open(hooks);
  assert.equal(dpip.calls.length, 1);
  assert.equal(await a, true);
  assert.equal(await b, true);
});

test('close while the browser is still opening: the late window is closed again', async () => {
  const p = floater.open(makeHooks());
  floater.close();
  assert.equal(await p, false);
  assert.equal(windows[0].closed, true);
  assert.equal(floater.isOpen(), false);
});

test('cold start: the first open builds everything in the PiP document, nothing in the opener', async () => {
  const w = await openWith(makeHooks());
  const d = w.document;
  assert.equal(floater.isOpen(), true);
  assert.equal(opener.created, 0, 'the opener document is never used to build');
  assert.ok(d.created > 0);
  assert.ok(d.body.classList.contains('tk-floater'));
  const styles = d.head.getElementsByTagName('style');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, '.tk-btn{color:red}');
  assert.equal(d.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(d.title, 'Takes · Recording');
  assert.equal(currentView(d), 'live');
  assert.equal(w.timers.size, 1);
  assert.equal([...w.timers.values()][0].ms, 250);
});

test('styles fall back to every readable rule when there is not exactly one style block', async () => {
  opener.head.appendChild(opener.createElement('style'));
  opener.styleSheets = [
    { cssRules: [{ cssText: 'a{b:c}' }, { cssText: 'd{e:f}' }] },
    { get cssRules() { throw new Error('SecurityError'); } },
    { cssRules: [{ cssText: 'g{h:i}' }] }
  ];
  const w = await openWith(makeHooks());
  const styles = w.document.head.getElementsByTagName('style');
  assert.equal(styles[0].textContent, 'a{b:c}\nd{e:f}\ng{h:i}');
});

test('theme: the opener theme is mirrored mid-take and the watcher stops on pagehide', async () => {
  const w = await openWith(makeHooks());
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, opener.documentElement);
  assert.deepEqual(observers[0].opts.attributeFilter, ['data-theme']);
  opener.documentElement.setAttribute('data-theme', 'light');
  observers[0].cb([]);
  assert.equal(w.document.documentElement.getAttribute('data-theme'), 'light');
  w.close();
  assert.equal(observers[0].disconnected, true);
});

test('reuse: an open window is reused, never requested twice', async () => {
  const hooks = makeHooks();
  const w = await openWith(hooks);
  assert.equal(await floater.open(hooks), true);
  assert.equal(dpip.calls.length, 1);
  assert.equal(dpip.window, w);
});

test('reuse: a window already open on the page is adopted without a second request', async () => {
  const foreign = makeWindow();
  foreign.document.body.appendChild(foreign.document.createElement('p'));
  dpip.window = foreign;
  assert.equal(await floater.open(makeHooks()), true);
  assert.equal(dpip.calls.length, 0);
  assert.equal(currentView(foreign.document), 'live');
  assert.equal(foreign.document.body.children.filter((c) => c.tagName === 'P').length, 0, 'old content cleared');
});

// ------------------------------------------------------------------ the remembered window size (SCOPE ADDITION)

/** Give a fake window the size Chrome remembers from a take with the map open: 287 x 260 inside a 16 x 36 frame. */
function rememberedBig(w) {
  w.innerWidth = 287;
  w.innerHeight = 260;
  w.outerWidth = 303;
  w.outerHeight = 296;
}

test('fit: a new window opened at a remembered big size is resized to the slim bar (outer = frame + bar)', async () => {
  dpip.onWindow = rememberedBig;
  const w = await openWith(makeHooks());
  assert.deepEqual(w.resizes, [[16 + 300, 36 + 64]], 'one resizeTo, outer size = frame + the bar');
  assert.equal(w.innerWidth, 300);
  assert.equal(w.innerHeight, 64);
  assert.equal(currentView(w.document), 'live');
  assert.equal(warns.length, 0);
});

test('fit: a whole-screen share fits the bar plus the note line in one resize', async () => {
  dpip.onWindow = rememberedBig;
  const w = await openWith(makeHooks({ wholeScreen: true }));
  assert.deepEqual(w.resizes, [[316, 36 + 64 + 24]]);
  assert.equal(w.innerHeight, 88);
});

test('fit: a window already at the bar size is left alone', async () => {
  const w = await openWith(makeHooks());
  assert.deepEqual(w.resizes, []);
});

test('fit: resizeTo refused (the click has expired) -> open still resolves true, no warning, the bar still renders', async () => {
  dpip.onWindow = (w) => {
    rememberedBig(w);
    w.resizeTo = function () { this.resizes.push('refused'); const e = new Error('Not allowed'); e.name = 'NotAllowedError'; throw e; };
  };
  const hooks = makeHooks({ layout: LAYOUT });
  assert.equal(await floater.open(hooks), true);
  const w = dpip.window;
  assert.deepEqual(w.resizes, ['refused'], 'tried once');
  assert.equal(warns.length, 0, 'no console noise');
  assert.equal(w.innerHeight, 260, 'the window keeps its size');
  emit('recording');
  assert.equal(currentView(w.document), 'live');
  assertSlimBar(w.document, { pause: true, move: true });
  // The map still opens and closes in the bigger window without throwing.
  one(w.document, 'tk-floater-move').click();
  assert.equal(padMounts.length, 1);
  one(w.document, 'tk-floater-move').click();
  assert.equal(padMounts[0].destroyed, 1);
  assert.equal(warns.length, 0);
});

test('fit: a reused window that grew is fitted back to the view it shows', async () => {
  const hooks = makeHooks();
  const w = await openWith(hooks);
  emit('recording');
  emit('processing');
  done(4000);
  emit('idle');
  assert.equal(currentView(w.document), 'done');
  // The person drags it bigger, then presses Record again.
  w.resizes = [];
  w.innerWidth = 500; w.innerHeight = 400; w.outerWidth = 516; w.outerHeight = 436;
  assert.equal(await floater.open(makeHooks({ state: 'idle' })), true);
  assert.equal(dpip.calls.length, 1, 'no second request');
  assert.equal(currentView(w.document), 'live');
  assert.deepEqual(w.resizes.at(-1), [316, 100]);
  assert.equal(w.innerWidth, 300);
  assert.equal(w.innerHeight, 64);
});

test('fit: a window already open on the page at a big size is fitted when adopted', async () => {
  const foreign = makeWindow();
  rememberedBig(foreign);
  dpip.window = foreign;
  assert.equal(await floater.open(makeHooks()), true);
  assert.equal(dpip.calls.length, 0);
  assert.deepEqual(foreign.resizes, [[316, 100]]);
});

test('fit: a refused resize on a reused window is silent too', async () => {
  const w = await openWith(makeHooks());
  w.innerWidth = 287; w.innerHeight = 260; w.outerWidth = 303; w.outerHeight = 296;
  w.resizeTo = function () { throw new Error('Not allowed'); };
  assert.equal(await floater.open(makeHooks()), true);
  assert.equal(warns.length, 0);
  assert.equal(currentView(w.document), 'live');
});

test('pad height follows the window width: a wide window gets a taller map so the hint line fits', async () => {
  const hooks = makeHooks({ layout: LAYOUT });
  const w = await openWith(hooks);
  emit('recording');
  // The person widened the window to 400 inside (frame 16 x 36).
  w.innerWidth = 400; w.outerWidth = 416;
  const before = w.outerHeight;
  one(w.document, 'tk-floater-move').click();
  const grow = Math.round((400 - 24) / (1920 / 1080)) + 40;
  assert.equal(w.outerHeight - before, grow);
  assert.ok(grow > Math.round(276 / (1920 / 1080)) + 40, 'taller than the 300-wide map');
  assert.equal(w.outerWidth, 416, 'width kept');
  one(w.document, 'tk-floater-move').click();
  assert.equal(w.outerHeight, before, 'shrinks back by the same amount');
});

test('pad height falls back to the 276-wide frame when the window has no usable width', async () => {
  const hooks = makeHooks({ layout: LAYOUT });
  const w = await openWith(hooks);
  emit('recording');
  w.innerWidth = undefined;
  const before = w.outerHeight;
  one(w.document, 'tk-floater-move').click();
  assert.equal(w.outerHeight - before, Math.round(276 / (1920 / 1080)) + 40);
});

// ------------------------------------------------------------------ the live bar (C6.14)

function assertSlimBar(d, { pause, resume, move, note }) {
  const buttons = visibleButtons(d);
  const expected = [];
  if (pause) expected.push('Pause');
  if (resume) expected.push('Resume');
  expected.push('Stop');
  if (move) expected.push('Move bubble');
  assert.deepEqual(buttons, expected);
  // The only visible text is the timer (and the one-line note for a whole-screen share).
  const texts = visibleTexts(d);
  const wantTexts = [texts.find((t) => /^\d+:\d\d$/.test(t))];
  if (note) wantTexts.push('Whole screen shared: this bar shows in the video.');
  assert.deepEqual(texts, wantTexts);
  assert.ok(visible(one(d, 'tk-recbar-dot')), 'the dot shows');
  assert.ok(visible(one(d, 'tk-floater-timer')), 'the timer shows');
  assert.equal(byClass(d, 'tk-pad').length, 0, 'no map until Move bubble is pressed');
}

test('live view shows only the dot, the timer, Pause/Resume, Stop (and Move bubble when there is a bubble)', async () => {
  const hooks = makeHooks();
  const d = (await openWith(hooks)).document;
  emit('recording');
  assertSlimBar(d, { pause: true, move: false });
  hooks.layout = LAYOUT;
  floater.attachRun(hooks);
  assertSlimBar(d, { pause: true, move: true });
  emit('paused');
  assertSlimBar(d, { resume: true, move: true });
});

test('Move bubble mounts the map in the PiP document, grows the window, and shrinks it again', async () => {
  const hooks = makeHooks({ layout: LAYOUT, cameraStream: CAMERA, screenStream: SCREEN, mirror: true });
  const w = await openWith(hooks);
  const d = w.document;
  emit('recording');
  assert.equal(padMounts.length, 0);
  const move = one(d, 'tk-floater-move');
  assert.equal(move.getAttribute('aria-expanded'), 'false');
  const before = w.outerHeight;

  move.click();
  assert.equal(padMounts.length, 1);
  const m = padMounts[0];
  assert.equal(m.opts.doc, d);
  assert.equal(m.container, one(d, 'tk-floater-pad'));
  assert.ok(visible(m.container));
  assert.equal(m.opts.aspect, 1920 / 1080);
  assert.equal(m.opts.shape, 'circle');
  assert.equal(m.opts.size, 'medium');
  assert.deepEqual(m.opts.pos, LAYOUT.pos);
  assert.equal(m.opts.stream, CAMERA);
  assert.equal(m.opts.screenStream, SCREEN, 'a tab or window share shows behind the bubble');
  assert.equal(m.opts.mirror, true);
  assert.equal(m.opts.label, 'Camera bubble position');
  assert.equal(move.getAttribute('aria-expanded'), 'true');
  assert.equal(w.resizes.length, 1, 'resizeTo on opening the map');
  assert.ok(w.outerHeight > before);
  assert.equal(opener.created, 0);

  // Moving on the map moves the recording's bubble and shows the clamped answer.
  assert.deepEqual(m.opts.onMove({ x: 0.95, y: 0.5 }), { x: 0.9, y: 0.5 });
  assert.deepEqual(hooks.calls.at(-1), ['moveBubble', { x: 0.95, y: 0.5 }]);

  move.click();
  assert.equal(m.destroyed, 1);
  assert.equal(byClass(d, 'tk-pad').length, 0);
  assert.equal(one(d, 'tk-floater-pad').hidden, true);
  assert.equal(w.resizes.length, 2, 'resizeTo on closing the map');
  assert.equal(w.outerHeight, before);
  assert.equal(move.getAttribute('aria-expanded'), 'false');
});

test('a move from the other map keeps this map in step', async () => {
  const hooks = makeHooks({ layout: LAYOUT });
  const d = (await openWith(hooks)).document;
  emit('recording');
  one(d, 'tk-floater-move').click();
  Takes.bus.emit('bubble:moved', { x: 0.3, y: 0.4 });
  assert.deepEqual(padMounts[0].calls.at(-1), ['setPos', { x: 0.3, y: 0.4 }]);
});

test('whole-screen share: the slim bar plus the one-line note, map closed, no screen behind the bubble', async () => {
  const hooks = makeHooks({ layout: LAYOUT, cameraStream: CAMERA, screenStream: SCREEN, wholeScreen: true });
  const w = await openWith(hooks);
  const d = w.document;
  emit('recording');
  assertSlimBar(d, { pause: true, move: true, note: true });
  assert.match(one(d, 'tk-floater-head').getAttribute('title'), /Whole screen shared: this bar shows in the video\./);
  one(d, 'tk-floater-move').click();
  assert.equal(padMounts.length, 1);
  assert.equal(padMounts[0].opts.screenStream, null, 'no hall of mirrors');
});

test('attachRun after opening: the streams and the layout arrive, an open map is re-pointed (aspect from the layout)', async () => {
  const hooks = makeHooks();
  const d = (await openWith(hooks)).document;
  emit('countdown', 3);
  assert.equal(one(d, 'tk-floater-move').hidden, true, 'no bubble yet');
  const next = makeHooks({ layout: LAYOUT, cameraStream: CAMERA, screenStream: SCREEN, mirror: true, state: 'countdown' });
  floater.attachRun(next);
  assert.equal(one(d, 'tk-floater-move').hidden, false);
  one(d, 'tk-floater-move').click();
  const later = makeHooks({ layout: { ...LAYOUT, width: 1280, height: 1024 }, cameraStream: CAMERA, screenStream: SCREEN, state: 'recording' });
  floater.attachRun(later);
  const calls = padMounts[0].calls;
  assert.deepEqual(calls.find((c) => c[0] === 'setAspect'), ['setAspect', 1280 / 1024]);
  assert.ok(calls.some((c) => c[0] === 'setStream' && c[1] === CAMERA));
  assert.ok(calls.some((c) => c[0] === 'setScreen' && c[1] === SCREEN));
});

test('attachRun with no window open does nothing and never throws', () => {
  floater.attachRun(makeHooks({ layout: LAYOUT }));
  assert.equal(floater.isOpen(), false);
});

test('the timer is driven by the window\'s own interval and reads hooks.elapsed', async () => {
  const hooks = makeHooks();
  const w = await openWith(hooks);
  emit('recording');
  hooks.seconds = 75.4;
  w.runTimers();
  assert.equal(one(w.document, 'tk-floater-timer').textContent, '1:15');
});

test('focus moves to the partner when the focused Pause or Resume hides', async () => {
  const d = (await openWith(makeHooks())).document;
  emit('recording');
  one(d, 'tk-floater-pause').focus();
  emit('paused');
  assert.equal(d.activeElement, one(d, 'tk-floater-resume'));
  emit('recording');
  assert.equal(d.activeElement, one(d, 'tk-floater-pause'));
});

test('Pause, Resume and Stop call the hooks', async () => {
  const hooks = makeHooks();
  const d = (await openWith(hooks)).document;
  emit('recording');
  one(d, 'tk-floater-pause').click();
  emit('paused');
  one(d, 'tk-floater-resume').click();
  emit('recording');
  one(d, 'tk-floater-stop').click();
  assert.deepEqual(hooks.calls, ['pause', 'resume', 'stop']);
});

// ------------------------------------------------------------------ the status x operation grid

function liveRow(d) {
  const b = (cls) => one(d, cls);
  return {
    view: currentView(d),
    pause: visible(b('tk-floater-pause')) ? (b('tk-floater-pause').disabled ? 'disabled' : 'enabled') : 'hidden',
    resume: visible(b('tk-floater-resume')) ? (b('tk-floater-resume').disabled ? 'disabled' : 'enabled') : 'hidden',
    stop: visible(b('tk-floater-stop')) ? (b('tk-floater-stop').disabled ? 'disabled' : 'enabled') : 'hidden',
    move: visible(b('tk-floater-move'))
  };
}

function statusText(d) {
  return one(d, 'tk-floater-status').textContent;
}

test('grid: countdown with seconds left -> live, "Get ready", Pause shown but disabled, Stop enabled', async () => {
  const d = (await openWith(makeHooks({ layout: LAYOUT }))).document;
  emit('countdown', 3);
  assert.deepEqual(liveRow(d), { view: 'live', pause: 'disabled', resume: 'hidden', stop: 'enabled', move: true });
  assert.equal(statusText(d), 'Get ready');
  assert.ok(d.body.classList.contains('tk-is-countdown'));
});

test('grid: countdown at 0 -> live, "Recording", Pause still disabled', async () => {
  const d = (await openWith(makeHooks({ layout: LAYOUT }))).document;
  emit('countdown', 0);
  assert.deepEqual(liveRow(d), { view: 'live', pause: 'disabled', resume: 'hidden', stop: 'enabled', move: true });
  assert.equal(statusText(d), 'Recording');
  assert.ok(d.body.classList.contains('tk-is-recording'));
});

test('grid: recording -> Pause enabled, Resume hidden, Stop enabled', async () => {
  const d = (await openWith(makeHooks({ layout: LAYOUT }))).document;
  emit('recording');
  assert.deepEqual(liveRow(d), { view: 'live', pause: 'enabled', resume: 'hidden', stop: 'enabled', move: true });
  assert.equal(statusText(d), 'Recording');
});

test('grid: paused -> Pause hidden, Resume enabled, Stop enabled, the map still opens', async () => {
  const d = (await openWith(makeHooks({ layout: LAYOUT }))).document;
  emit('paused');
  assert.deepEqual(liveRow(d), { view: 'live', pause: 'hidden', resume: 'enabled', stop: 'enabled', move: true });
  assert.equal(statusText(d), 'Paused');
  assert.ok(d.body.classList.contains('tk-is-paused'));
  one(d, 'tk-floater-move').click();
  assert.equal(padMounts.length, 1, 'moving while paused is allowed');
});

test('grid: no bubble (screen only or camera only) -> no Move bubble anywhere', async () => {
  const d = (await openWith(makeHooks())).document;
  for (const s of ['countdown', 'recording', 'paused']) {
    emit(s);
    assert.equal(liveRow(d).move, false, s);
  }
});

test('grid: processing -> status only, no buttons, the map is closed', async () => {
  const d = (await openWith(makeHooks({ layout: LAYOUT }))).document;
  emit('recording');
  one(d, 'tk-floater-move').click();
  emit('processing');
  assert.equal(currentView(d), 'processing');
  assert.deepEqual(visibleButtons(d), []);
  assert.deepEqual(visibleTexts(d), ['Finishing your recording…']);
  assert.equal(padMounts[0].destroyed, 1);
  assert.equal(byClass(d, 'tk-pad').length, 0);
});

test('grid: record:done of 1 s or more -> done view with Download and Open in Takes on one row', async () => {
  const w = await openWith(makeHooks({ layout: LAYOUT }));
  const d = w.document;
  emit('recording');
  emit('processing');
  done(1000);
  emit('idle');
  assert.equal(currentView(d), 'done');
  assert.deepEqual(visibleButtons(d), ['Download', 'Open in Takes']);
  const row = one(d, 'tk-floater-download').parentNode;
  assert.equal(row, byClass(d, 'tk-floater-open').find(visible).parentNode, 'one row');
  assert.ok(row.classList.contains('tk-floater-actions'));
  assert.ok(one(d, 'tk-floater-download').classList.contains('tk-btn-primary'));
  assert.deepEqual(visibleTexts(d), ['Your take is ready']);
  assert.equal(d.title, 'Takes · Your take is ready');
  assert.equal(floater.isOpen(), true, 'idle after done keeps the done view');
});

test('grid: record:done under 1 s -> short view with Close', async () => {
  const d = (await openWith(makeHooks())).document;
  emit('recording');
  emit('processing');
  done(999);
  emit('idle');
  assert.equal(currentView(d), 'short');
  assert.deepEqual(visibleButtons(d), ['Close']);
  assert.deepEqual(visibleTexts(d), ['That recording was under a second, so it was not kept.']);
  byClass(d, 'tk-floater-close').find(visible).click();
  assert.equal(floater.isOpen(), false);
});

test('grid: Stop during the countdown -> idle with no record:done closes the window, no done view', async () => {
  const hooks = makeHooks();
  const w = await openWith(hooks);
  emit('countdown', 2);
  one(w.document, 'tk-floater-stop').click();
  emit('idle');
  assert.equal(floater.isOpen(), false);
  assert.equal(w.closeCalls, 1);
  assert.equal(closedEvents, 1);
  assert.deepEqual(hooks.calls, ['stop']);
});

test('grid (C6.6): processing -> idle with no record:done -> "could not be saved" with Open in Takes and Close', async () => {
  const hooks = makeHooks();
  const w = await openWith(hooks);
  const d = w.document;
  emit('recording');
  emit('processing');
  emit('idle');
  assert.equal(floater.isOpen(), true, 'it never closes on its own here');
  assert.equal(currentView(d), 'failed');
  assert.deepEqual(visibleButtons(d), ['Open in Takes', 'Close']);
  assert.deepEqual(visibleTexts(d), ['The recording could not be saved. Go back to Takes to try again.']);
  byClass(d, 'tk-floater-open').find(visible).click();
  assert.deepEqual(hooks.calls, ['openTakes']);
  byClass(d, 'tk-floater-close').find(visible).click();
  assert.equal(floater.isOpen(), false);
  assert.equal(w.closed, true);
});

test('grid: idle when the window is reused before Record keeps the last done view', async () => {
  const d = (await openWith(makeHooks())).document;
  emit('recording');
  emit('processing');
  done(5000);
  emit('idle');
  emit('idle');
  assert.equal(currentView(d), 'done');
});

test('grid: a second Record while the window still shows done reuses it and switches to live', async () => {
  const hooks = makeHooks();
  const w = await openWith(hooks);
  emit('recording');
  emit('processing');
  done(4000);
  emit('idle');
  assert.equal(currentView(w.document), 'done');
  // The next Record click opens again: same window, live view, "Get ready".
  assert.equal(await floater.open(makeHooks({ state: 'idle' })), true);
  assert.equal(dpip.calls.length, 1);
  assert.equal(currentView(w.document), 'live');
  assert.equal(statusText(w.document), 'Get ready');
  emit('countdown', 3);
  emit('recording');
  emit('processing');
  emit('idle');
  assert.equal(currentView(w.document), 'failed', 'the new take is tracked on its own');
});

test('grid: a new take seen only through record:state also switches a done window to live', async () => {
  const w = await openWith(makeHooks());
  emit('recording');
  emit('processing');
  done(4000);
  emit('idle');
  emit('countdown', 3);
  assert.equal(currentView(w.document), 'live');
});

// ------------------------------------------------------------------ download and open

test('Download pressed twice quickly starts one download and shows the file name', async () => {
  const hooks = makeHooks();
  const d = (await openWith(hooks)).document;
  emit('recording');
  emit('processing');
  done(3000);
  const btn = one(d, 'tk-floater-download');
  btn.click();
  btn.click();
  assert.equal(hooks.calls.filter((c) => c === 'download').length, 1);
  await flush();
  assert.equal(one(d, 'tk-floater-msg').textContent, 'Downloaded as takes-2026-10-17-0931.mp4. Look in your Downloads folder.');
  assert.equal(btn.disabled, false);
});

test('Download that answers with an error shows the error in the status line', async () => {
  const hooks = makeHooks({ downloadResult: { error: 'Captions are still being made. Try again in a moment.' } });
  const d = (await openWith(hooks)).document;
  emit('recording');
  emit('processing');
  done(3000);
  one(d, 'tk-floater-download').click();
  await flush();
  assert.equal(one(d, 'tk-floater-msg').textContent, 'Captions are still being made. Try again in a moment.');
});

test('Download that rejects or answers nothing still says something', async () => {
  const hooks = makeHooks();
  hooks.download = () => Promise.reject(new Error('boom'));
  const d = (await openWith(hooks)).document;
  emit('recording');
  emit('processing');
  done(3000);
  one(d, 'tk-floater-download').click();
  await flush();
  assert.equal(one(d, 'tk-floater-msg').textContent, 'The download did not start. Go back to Takes to try again.');
  assert.equal(one(d, 'tk-floater-msg').getAttribute('role'), 'status');
});

test('Open in Takes calls the hook', async () => {
  const hooks = makeHooks();
  const d = (await openWith(hooks)).document;
  emit('recording');
  emit('processing');
  done(3000);
  byClass(d, 'tk-floater-open').find(visible).click();
  assert.deepEqual(hooks.calls, ['openTakes']);
});

// ------------------------------------------------------------------ closing

test('pagehide (the person closes the window): timer cleared, listeners gone, floater:closed, recording untouched', async () => {
  const hooks = makeHooks({ layout: LAYOUT });
  const w = await openWith(hooks);
  const d = w.document;
  emit('recording');
  one(d, 'tk-floater-move').click();
  w.close();
  assert.equal(floater.isOpen(), false);
  assert.equal(w.timers.size, 0);
  assert.equal(closedEvents, 1);
  assert.equal(padMounts[0].destroyed, 1);
  assert.deepEqual(hooks.calls.filter((c) => typeof c === 'string'), [], 'stop is never called');
  const snapshot = JSON.stringify(all(d.body).map((e) => [e.className, e.hidden, e.ownText]));
  emit('paused');
  emit('processing');
  done(5000);
  Takes.bus.emit('bubble:moved', { x: 0.1, y: 0.1 });
  assert.equal(JSON.stringify(all(d.body).map((e) => [e.className, e.hidden, e.ownText])), snapshot, 'nothing changes after pagehide');
  assert.equal(padMounts[0].calls.length, 0);
});

test('close is safe twice and emits floater:closed once', async () => {
  const w = await openWith(makeHooks());
  floater.close();
  floater.close();
  assert.equal(closedEvents, 1);
  assert.equal(w.closed, true);
  assert.equal(floater.isOpen(), false);
});

test('after closing, the next open asks the browser for a fresh window', async () => {
  await openWith(makeHooks());
  floater.close();
  await openWith(makeHooks());
  assert.equal(dpip.calls.length, 2);
  assert.equal(floater.isOpen(), true);
});

// ------------------------------------------------------------------ invariant sweep: no link or share, in any view or state

const CONTROL_BAD = /link|share/i;
const TEXT_BAD = /\blink\b|share link|copy link/i;

function sweep(d, where) {
  assert.doesNotMatch(String(d.title), TEXT_BAD, where + ' title');
  for (const e of all(d.body)) {
    const control = e.tagName === 'BUTTON' || e.tagName === 'A' || e.getAttribute('role') === 'button';
    const bad = control ? CONTROL_BAD : TEXT_BAD;
    const text = control ? e.textContent : e.ownText;
    for (const v of [text, e.getAttribute('aria-label'), e.getAttribute('title')]) {
      if (v) assert.doesNotMatch(v, bad, where + ': ' + e.tagName + ' ' + e.className + ' "' + v + '"');
    }
    assert.notEqual(e.tagName, 'A', where + ': no anchors at all');
  }
}

test('invariant sweep: no link or share control in any view or state, for every share type', async () => {
  for (const whole of [false, true]) {
    for (const withBubble of [false, true]) {
      const hooks = makeHooks({ wholeScreen: whole, layout: withBubble ? LAYOUT : null, cameraStream: CAMERA, screenStream: SCREEN });
      const w = await openWith(hooks);
      const d = w.document;
      const tag = 'whole=' + whole + ' bubble=' + withBubble;
      sweep(d, tag + ' opened');
      const steps = [['countdown', 3], ['countdown', 0], ['recording'], ['paused'], ['recording']];
      for (const [s, left] of steps) { emit(s, left); sweep(d, tag + ' ' + s); }
      if (withBubble) { one(d, 'tk-floater-move').click(); sweep(d, tag + ' map open'); }
      emit('processing'); sweep(d, tag + ' processing');
      done(2000); sweep(d, tag + ' done');
      one(d, 'tk-floater-download').click();
      await flush();
      sweep(d, tag + ' downloaded');
      emit('idle'); sweep(d, tag + ' idle after done');
      emit('countdown', 3); emit('recording'); emit('processing'); done(10); sweep(d, tag + ' short');
      emit('idle');
      emit('countdown', 3); emit('recording'); emit('processing'); emit('idle'); sweep(d, tag + ' failed');
      floater.close();
    }
  }
});
