// Tests for src/js/compositor.js: bubbleRect (pure) and the parts of start/stop that need no browser.
// Run from the repository root: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const compositor = require('../src/js/compositor.js');
const { bubbleRect } = compositor;

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const SHARES = { small: 0.16, medium: 0.22, large: 0.30 };
const CANVASES = [
  [1920, 1080],
  [1280, 720],
  [320, 180],   // a small canvas
  [640, 1136],  // taller than wide
  [198, 98]     // tiny, odd-ish numbers
];

const margin = (h) => Math.round(h * 0.03);

// ------------------------------------------------------------------ module shape

test('compositor loads under Node and exposes exactly its public methods', () => {
  assert.equal(Takes.compositor, compositor, 'the module attaches itself to Takes');
  assert.deepEqual(Object.keys(compositor).sort(),
    ['bubbleAt', 'bubbleBox', 'bubbleRect', 'clampPos', 'cornerPos', 'layout', 'moveBubble', 'start', 'stop']);
  for (const key of Object.keys(compositor)) assert.equal(typeof compositor[key], 'function', key);
});

// ------------------------------------------------------------------ bubbleRect: shape

test('bubbleRect: returns exactly { x, y, d, cx, cy, r }, all whole pixels', () => {
  for (const [w, h] of CANVASES) {
    for (const corner of CORNERS) {
      for (const size of Object.keys(SHARES)) {
        const b = bubbleRect(w, h, corner, size);
        const label = `${w}x${h} ${corner} ${size}`;
        assert.deepEqual(Object.keys(b).sort(), ['cx', 'cy', 'd', 'r', 'x', 'y'], label);
        for (const key of Object.keys(b)) assert.ok(Number.isInteger(b[key]), `${label}: ${key} = ${b[key]}`);
      }
    }
  }
});

test('bubbleRect: cx, cy and r agree with x, y and d', () => {
  for (const [w, h] of CANVASES) {
    for (const corner of CORNERS) {
      for (const size of ['small', 'medium', 'large', 137, 200]) {
        const b = bubbleRect(w, h, corner, size);
        const label = `${w}x${h} ${corner} ${size}`;
        assert.equal(b.r * 2, b.d, label);
        assert.equal(b.cx, b.x + b.r, label);
        assert.equal(b.cy, b.y + b.r, label);
      }
    }
  }
});

// ------------------------------------------------------------------ bubbleRect: position

test('bubbleRect: the circle stays inside the canvas with the margin, in every corner and size', () => {
  for (const [w, h] of CANVASES) {
    const m = margin(h);
    for (const corner of CORNERS) {
      for (const size of ['small', 'medium', 'large']) {
        const b = bubbleRect(w, h, corner, size);
        const label = `${w}x${h} ${corner} ${size}`;
        assert.ok(b.d > 0, label);
        assert.ok(b.cx - b.r >= m, `${label}: left edge`);
        assert.ok(b.cy - b.r >= m, `${label}: top edge`);
        assert.ok(b.cx + b.r <= w - m, `${label}: right edge`);
        assert.ok(b.cy + b.r <= h - m, `${label}: bottom edge`);
      }
    }
  }
});

test('bubbleRect: each corner hugs its own two edges at exactly the margin', () => {
  for (const [w, h] of [[1920, 1080], [320, 180]]) {
    const m = margin(h);
    for (const size of ['small', 'medium', 'large']) {
      const tl = bubbleRect(w, h, 'top-left', size);
      const tr = bubbleRect(w, h, 'top-right', size);
      const bl = bubbleRect(w, h, 'bottom-left', size);
      const br = bubbleRect(w, h, 'bottom-right', size);
      const label = `${w}x${h} ${size}`;

      assert.deepEqual([tl.x, tl.y], [m, m], label);
      assert.deepEqual([tr.x + tr.d, tr.y], [w - m, m], label);
      assert.deepEqual([bl.x, bl.y + bl.d], [m, h - m], label);
      assert.deepEqual([br.x + br.d, br.y + br.d], [w - m, h - m], label);

      // The four corners are four different places, all the same size.
      const spots = new Set([tl, tr, bl, br].map((b) => `${b.x},${b.y}`));
      assert.equal(spots.size, 4, label);
      for (const b of [tr, bl, br]) assert.equal(b.d, tl.d, label);
    }
  }
});

test('bubbleRect: known values on 1920x1080', () => {
  // margin = round(1080 * 0.03) = 32; medium = round(1080 * 0.22) = 238
  assert.deepEqual(bubbleRect(1920, 1080, 'bottom-right', 'medium'),
    { x: 1650, y: 810, d: 238, cx: 1769, cy: 929, r: 119 });
  assert.deepEqual(bubbleRect(1920, 1080, 'top-left', 'medium'),
    { x: 32, y: 32, d: 238, cx: 151, cy: 151, r: 119 });
  // large = round(1080 * 0.30) = 324
  assert.deepEqual(bubbleRect(1920, 1080, 'top-right', 'large'),
    { x: 1564, y: 32, d: 324, cx: 1726, cy: 194, r: 162 });
  // small = round(1080 * 0.16) = 173, held to an even 172
  assert.deepEqual(bubbleRect(1920, 1080, 'bottom-left', 'small'),
    { x: 32, y: 876, d: 172, cx: 118, cy: 962, r: 86 });
});

// ------------------------------------------------------------------ bubbleRect: size

test('bubbleRect: the diameter follows the size, as a share of the canvas height', () => {
  for (const [w, h] of [[1920, 1080], [1280, 720], [320, 180]]) {
    const small = bubbleRect(w, h, 'bottom-right', 'small').d;
    const medium = bubbleRect(w, h, 'bottom-right', 'medium').d;
    const large = bubbleRect(w, h, 'bottom-right', 'large').d;
    assert.ok(small < medium && medium < large, `${w}x${h}: ${small} < ${medium} < ${large}`);
    for (const [name, d] of [['small', small], ['medium', medium], ['large', large]]) {
      // Within one pixel of the share: the diameter is rounded, then held to an even number.
      assert.ok(Math.abs(d - h * SHARES[name]) <= 1.5, `${w}x${h} ${name}: ${d} vs ${h * SHARES[name]}`);
    }
  }
});

test('bubbleRect: the bubble and its margin scale with the canvas', () => {
  const big = bubbleRect(1920, 1080, 'top-left', 'medium');
  const little = bubbleRect(320, 180, 'top-left', 'medium');
  assert.ok(big.d > little.d);
  assert.equal(big.x, 32);
  assert.equal(little.x, 5, 'round(180 * 0.03)');
  assert.equal(little.d, 40, 'round(180 * 0.22)');
});

test('bubbleRect: a number is taken as the diameter in pixels', () => {
  assert.equal(bubbleRect(1920, 1080, 'top-left', 200).d, 200);
  assert.equal(bubbleRect(1920, 1080, 'top-left', 201).d, 200, 'held to an even number so the radius is whole');
  assert.deepEqual(bubbleRect(1920, 1080, 'bottom-right', 100),
    { x: 1788, y: 948, d: 100, cx: 1838, cy: 998, r: 50 });
});

test('bubbleRect: a diameter too large for the canvas is held inside the margins', () => {
  const m = margin(180);
  for (const corner of CORNERS) {
    const b = bubbleRect(320, 180, corner, 5000);
    assert.ok(b.d <= 180 - 2 * m, corner);
    assert.ok(b.x >= m && b.y >= m, corner);
    assert.ok(b.x + b.d <= 320 - m && b.y + b.d <= 180 - m, corner);
  }
});

// ------------------------------------------------------------------ bubbleRect: fallbacks

test('bubbleRect: an unknown corner is treated as bottom-right and never throws', () => {
  const expected = bubbleRect(1920, 1080, 'bottom-right', 'medium');
  for (const bad of ['middle', 'TOP-LEFT', 'topleft', '', null, undefined, 3, {}]) {
    assert.deepEqual(bubbleRect(1920, 1080, bad, 'medium'), expected, String(bad));
  }
});

test('bubbleRect: an unknown size is treated as medium and never throws', () => {
  const expected = bubbleRect(1920, 1080, 'top-left', 'medium');
  for (const bad of ['huge', 'MEDIUM', '', null, undefined, {}, NaN, Infinity, 0, -40, '200', 'toString']) {
    assert.deepEqual(bubbleRect(1920, 1080, 'top-left', bad), expected, String(bad));
  }
});

test('bubbleRect: is pure, the same inputs always give an equal, fresh result', () => {
  const a = bubbleRect(1280, 720, 'top-right', 'large');
  const b = bubbleRect(1280, 720, 'top-right', 'large');
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'a new object each call');
  a.x = -1;
  assert.notEqual(bubbleRect(1280, 720, 'top-right', 'large').x, -1);
});

// ------------------------------------------------------------------ start / stop without a browser

test('stop: safe before start, and safe to call twice', () => {
  assert.doesNotThrow(() => compositor.stop());
  assert.doesNotThrow(() => compositor.stop());
  assert.equal(compositor.stop(), undefined, 'synchronous, returns nothing');
});

test('start: with neither stream it rejects with code nothing-to-record, after one toast', async () => {
  const toasts = [];
  const off = Takes.bus.on('toast', (t) => toasts.push(t));
  try {
    for (const options of [
      { screenStream: null, cameraStream: null, bubble: { corner: 'top-left', size: 'medium' } },
      {},
      undefined
    ]) {
      toasts.length = 0;
      const promise = compositor.start(options);
      assert.ok(promise instanceof Promise, 'start always returns a Promise');
      await assert.rejects(promise, (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.code, 'nothing-to-record');
        assert.equal(err.toasted, true);
        return true;
      });
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].kind, 'error');
      assert.equal(toasts[0].text.length > 0, true);
    }
  } finally {
    off();
  }
});

test('start: one stream only passes its own video track straight through, and stop leaves it running', async (t) => {
  // A stand-in for the browser class, present only for this test.
  class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks.slice(); }
    getTracks() { return this.tracks.slice(); }
    getVideoTracks() { return this.tracks.filter((tr) => tr.kind === 'video'); }
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'MediaStream');
  const before = globalThis.MediaStream;
  globalThis.MediaStream = FakeMediaStream;
  t.after(() => { if (had) globalThis.MediaStream = before; else delete globalThis.MediaStream; });

  const makeTrack = (kind) => ({ kind, readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } });

  for (const which of ['screenStream', 'cameraStream']) {
    const video = makeTrack('video');
    const audio = makeTrack('audio');
    const input = new FakeMediaStream([audio, video]);
    const out = await compositor.start({ [which]: input, bubble: { corner: 'top-left', size: 'medium' } });

    assert.notEqual(out, input, `${which}: a new stream`);
    assert.deepEqual(out.getTracks(), [video], `${which}: video only, the very same track`);

    compositor.stop();
    compositor.stop();
    assert.equal(video.stopped, false, `${which}: stop never stops a capture track`);
    assert.equal(audio.stopped, false);
  }
});

// ------------------------------------------------------------------ bubbleBox: the rectangle shape

const { bubbleBox } = compositor;

test('bubbleBox: a circle, or any unknown shape, is exactly bubbleRect', () => {
  for (const [w, h] of [[1920, 1080], [320, 180]]) {
    for (const corner of CORNERS) {
      for (const size of ['small', 'medium', 'large', 150]) {
        const expected = bubbleRect(w, h, corner, size);
        for (const shape of ['circle', undefined, null, '', 'square', 'RECTANGLE', 7, {}]) {
          assert.deepEqual(bubbleBox(w, h, corner, size, shape), expected, `${w}x${h} ${corner} ${size} ${String(shape)}`);
        }
      }
    }
  }
});

test('bubbleBox: the rectangle is { x, y, w, h, radius } in whole pixels, with an even width and height', () => {
  for (const [w, h] of CANVASES) {
    for (const corner of CORNERS) {
      for (const size of ['small', 'medium', 'large']) {
        const b = bubbleBox(w, h, corner, size, 'rectangle');
        const label = `${w}x${h} ${corner} ${size}`;
        assert.deepEqual(Object.keys(b).sort(), ['h', 'radius', 'w', 'x', 'y'], label);
        for (const key of Object.keys(b)) assert.ok(Number.isInteger(b[key]), `${label}: ${key} = ${b[key]}`);
        assert.equal(b.w % 2, 0, `${label}: w`);
        assert.equal(b.h % 2, 0, `${label}: h`);
        assert.ok(b.w > 0 && b.h > 0 && b.radius > 0, label);
      }
    }
  }
});

test('bubbleBox: the rectangle stays inside the canvas with the margin, in every corner and size', () => {
  for (const [w, h] of CANVASES) {
    const m = margin(h);
    for (const corner of CORNERS) {
      for (const size of ['small', 'medium', 'large']) {
        const b = bubbleBox(w, h, corner, size, 'rectangle');
        const label = `${w}x${h} ${corner} ${size}`;
        assert.ok(b.x >= m, `${label}: left edge`);
        assert.ok(b.y >= m, `${label}: top edge`);
        assert.ok(b.x + b.w <= w - m, `${label}: right edge`);
        assert.ok(b.y + b.h <= h - m, `${label}: bottom edge`);
      }
    }
  }
});

test('bubbleBox: each corner of the rectangle hugs its own two edges at exactly the margin', () => {
  for (const [w, h] of [[1920, 1080], [320, 180]]) {
    const m = margin(h);
    for (const size of ['small', 'medium', 'large']) {
      const tl = bubbleBox(w, h, 'top-left', size, 'rectangle');
      const tr = bubbleBox(w, h, 'top-right', size, 'rectangle');
      const bl = bubbleBox(w, h, 'bottom-left', size, 'rectangle');
      const br = bubbleBox(w, h, 'bottom-right', size, 'rectangle');
      const label = `${w}x${h} ${size}`;
      assert.deepEqual([tl.x, tl.y], [m, m], label);
      assert.deepEqual([tr.x + tr.w, tr.y], [w - m, m], label);
      assert.deepEqual([bl.x, bl.y + bl.h], [m, h - m], label);
      assert.deepEqual([br.x + br.w, br.y + br.h], [w - m, h - m], label);
      for (const b of [tr, bl, br]) assert.deepEqual([b.w, b.h, b.radius], [tl.w, tl.h, tl.radius], label);
      assert.deepEqual(bubbleBox(w, h, 'nowhere', size, 'rectangle'), br, `${label}: unknown corner is bottom-right`);
    }
  }
});

test('bubbleBox: the rectangle is as tall as the circle is wide, 16:9, with a radius of 8% of its height', () => {
  for (const [w, h] of [[1920, 1080], [1280, 720], [320, 180]]) {
    for (const size of ['small', 'medium', 'large']) {
      const b = bubbleBox(w, h, 'top-left', size, 'rectangle');
      const label = `${w}x${h} ${size}`;
      assert.equal(b.h, bubbleRect(w, h, 'top-left', size).d, `${label}: height is the circle's diameter`);
      assert.ok(Math.abs(b.w - b.h * 16 / 9) <= 2, `${label}: ${b.w}x${b.h}`);
      assert.equal(b.radius, Math.max(1, Math.round(b.h * 0.08)), label);
      assert.ok(b.w <= w * 0.4, `${label}: within 40% of the width`);
    }
  }
});

test('bubbleBox: known values on 1920x1080', () => {
  // medium: h = 238, w = round(238 * 16 / 9) = 423 held to an even 422, radius = round(238 * 0.08) = 19
  assert.deepEqual(bubbleBox(1920, 1080, 'bottom-left', 'medium', 'rectangle'), { x: 32, y: 810, w: 422, h: 238, radius: 19 });
  assert.deepEqual(bubbleBox(1920, 1080, 'top-right', 'medium', 'rectangle'), { x: 1466, y: 32, w: 422, h: 238, radius: 19 });
  // large: h = 324, w = 576, radius = 26
  assert.deepEqual(bubbleBox(1920, 1080, 'bottom-right', 'large', 'rectangle'), { x: 1312, y: 724, w: 576, h: 324, radius: 26 });
});

test('bubbleBox: the width is held to 40% of the canvas width, and the height shrinks to keep 16:9', () => {
  // A tall canvas: large would be 341 high and 606 wide, far over 40% of 640.
  for (const corner of CORNERS) {
    const b = bubbleBox(640, 1136, corner, 'large', 'rectangle');
    const m = margin(1136);
    assert.equal(b.w, 256, `${corner}: 40% of 640`);
    assert.equal(b.h, 144, `${corner}: 256 * 9 / 16`);
    assert.ok(b.x >= m && b.y >= m && b.x + b.w <= 640 - m && b.y + b.h <= 1136 - m, corner);
  }
  // A pixel size far too large for the canvas is held the same way.
  const big = bubbleBox(1920, 1080, 'top-left', 5000, 'rectangle');
  assert.equal(big.w, 768, '40% of 1920');
  assert.equal(big.h, 432);
  // Unclamped sizes are left alone.
  assert.ok(bubbleBox(1920, 1080, 'top-left', 'large', 'rectangle').w < 768);
});

// ------------------------------------------------------------------ bubbleAt, cornerPos, clampPos: anywhere on the canvas

const { bubbleAt, cornerPos, clampPos } = compositor;
const SHAPES = ['circle', 'rectangle'];
const SIZE_NAMES = ['small', 'medium', 'large'];
const GRID = [];
for (let v = -0.5; v <= 1.5 + 1e-9; v += 0.25) GRID.push(Math.round(v * 100) / 100);

// The frame's outer width and height, whichever shape it is.
const extent = (b) => (b.d !== undefined ? [b.d, b.d] : [b.w, b.h]);
// The margin a corner frame keeps, including bubbleRect's zero-margin fallback.
const cornerMargin = (w, h, size) => bubbleRect(w, h, 'top-left', size).x;

test('bubbleAt: every canvas, size, shape and position keeps the frame inside the margins, in whole pixels', () => {
  for (const [w, h] of CANVASES) {
    for (const size of SIZE_NAMES) {
      const m = cornerMargin(w, h, size);
      for (const shape of SHAPES) {
        const keys = shape === 'rectangle' ? ['h', 'radius', 'w', 'x', 'y'] : ['cx', 'cy', 'd', 'r', 'x', 'y'];
        for (const x of GRID) {
          for (const y of GRID) {
            const b = bubbleAt(w, h, size, shape, { x, y });
            const label = `${w}x${h} ${size} ${shape} (${x}, ${y})`;
            assert.deepEqual(Object.keys(b).sort(), keys, label);
            for (const key of Object.keys(b)) assert.ok(Number.isInteger(b[key]), `${label}: ${key} = ${b[key]}`);
            const [bw, bh] = extent(b);
            assert.ok(b.x >= m, `${label}: left edge`);
            assert.ok(b.y >= m, `${label}: top edge`);
            assert.ok(b.x + bw <= w - m, `${label}: right edge`);
            assert.ok(b.y + bh <= h - m, `${label}: bottom edge`);
          }
        }
      }
    }
  }
});

test('bubbleAt: the frame is the same size as the corner frame, wherever it goes', () => {
  for (const [w, h] of CANVASES) {
    for (const size of SIZE_NAMES) {
      for (const shape of SHAPES) {
        const corner = bubbleBox(w, h, 'top-left', size, shape);
        for (const x of GRID) {
          const b = bubbleAt(w, h, size, shape, { x, y: 1 - x });
          const label = `${w}x${h} ${size} ${shape} ${x}`;
          assert.deepEqual(extent(b), extent(corner), label);
          if (shape === 'rectangle') assert.equal(b.radius, corner.radius, label);
          else assert.deepEqual([b.r, b.cx, b.cy], [b.d / 2, b.x + b.d / 2, b.y + b.d / 2], label);
        }
      }
    }
  }
});

test('bubbleAt(cornerPos(...)) deep-equals bubbleBox(...) for every corner, size, shape and canvas', () => {
  for (const [w, h] of CANVASES) {
    for (const corner of CORNERS) {
      for (const size of [...SIZE_NAMES, 100, 5000]) {
        for (const shape of SHAPES) {
          const label = `${w}x${h} ${corner} ${size} ${shape}`;
          assert.deepEqual(bubbleAt(w, h, size, shape, cornerPos(w, h, corner, size, shape)),
            bubbleBox(w, h, corner, size, shape), label);
        }
      }
    }
  }
});

test('cornerPos: the corner frame\'s center, as fractions', () => {
  // 1920x1080 medium circle bottom-right: center (1769, 929).
  assert.deepEqual(cornerPos(1920, 1080, 'bottom-right', 'medium', 'circle'), { x: 1769 / 1920, y: 929 / 1080 });
  // 1920x1080 medium rectangle top-right: { x: 1466, y: 32, w: 422, h: 238 } -> center (1677, 151).
  assert.deepEqual(cornerPos(1920, 1080, 'top-right', 'medium', 'rectangle'), { x: 1677 / 1920, y: 151 / 1080 });
  assert.deepEqual(cornerPos(1920, 1080, 'nowhere', 'medium', 'circle'), cornerPos(1920, 1080, 'bottom-right', 'medium', 'circle'),
    'an unknown corner is bottom-right, as in bubbleBox');
});

test('bubbleAt: position (0.5, 0.5) centers the frame to within one pixel', () => {
  for (const [w, h] of CANVASES) {
    for (const size of SIZE_NAMES) {
      for (const shape of SHAPES) {
        const b = bubbleAt(w, h, size, shape, { x: 0.5, y: 0.5 });
        const [bw, bh] = extent(b);
        const label = `${w}x${h} ${size} ${shape}`;
        assert.ok(Math.abs(b.x + bw / 2 - w / 2) <= 1, `${label}: x`);
        assert.ok(Math.abs(b.y + bh / 2 - h / 2) <= 1, `${label}: y`);
      }
    }
  }
});

test('bubbleAt: a known free position on 1920x1080', () => {
  // medium circle d = 238: center (480, 270) -> x = 480 - 119 = 361, y = 270 - 119 = 151
  assert.deepEqual(bubbleAt(1920, 1080, 'medium', 'circle', { x: 0.25, y: 0.25 }),
    { x: 361, y: 151, d: 238, cx: 480, cy: 270, r: 119 });
  // medium rectangle 422x238: center (960, 540) -> x = 749, y = 421
  assert.deepEqual(bubbleAt(1920, 1080, 'medium', 'rectangle', { x: 0.5, y: 0.5 }),
    { x: 749, y: 421, w: 422, h: 238, radius: 19 });
});

test('bubbleAt: a missing or bad position is centered, and never throws', () => {
  for (const shape of SHAPES) {
    const centered = bubbleAt(1920, 1080, 'medium', shape, { x: 0.5, y: 0.5 });
    for (const bad of [null, undefined, {}, 'center', 7, true, [], { x: NaN, y: NaN }, { x: 'a', y: 'b' },
      { x: '0.1', y: '0.9' }, { x: Infinity, y: -Infinity }, { x: null, y: undefined }]) {
      assert.deepEqual(bubbleAt(1920, 1080, 'medium', shape, bad), centered, `${shape} ${JSON.stringify(bad)}`);
    }
    // A bad part alone falls back on its own; the good part is kept.
    const halfBad = bubbleAt(1920, 1080, 'medium', shape, { x: 0.25, y: NaN });
    assert.equal(halfBad.y, centered.y, `${shape}: y centered`);
    assert.notEqual(halfBad.x, centered.x, `${shape}: x kept`);
  }
});

test('bubbleAt: positions far outside 0..1 land in the matching corner', () => {
  for (const [w, h] of CANVASES) {
    for (const size of SIZE_NAMES) {
      for (const shape of SHAPES) {
        const label = `${w}x${h} ${size} ${shape}`;
        assert.deepEqual(bubbleAt(w, h, size, shape, { x: -9, y: -9 }), bubbleBox(w, h, 'top-left', size, shape), label);
        assert.deepEqual(bubbleAt(w, h, size, shape, { x: 9, y: -9 }), bubbleBox(w, h, 'top-right', size, shape), label);
        assert.deepEqual(bubbleAt(w, h, size, shape, { x: -9, y: 9 }), bubbleBox(w, h, 'bottom-left', size, shape), label);
        assert.deepEqual(bubbleAt(w, h, size, shape, { x: 9, y: 9 }), bubbleBox(w, h, 'bottom-right', size, shape), label);
      }
    }
  }
});

test('bubbleAt: is pure, the same inputs always give an equal, fresh result', () => {
  const pos = { x: 0.3, y: 0.6 };
  const a = bubbleAt(1280, 720, 'large', 'rectangle', pos);
  const b = bubbleAt(1280, 720, 'large', 'rectangle', pos);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.deepEqual(pos, { x: 0.3, y: 0.6 }, 'the position passed in is untouched');
});

test('clampPos: is the center of bubbleAt, as fractions', () => {
  for (const [w, h] of CANVASES) {
    for (const size of SIZE_NAMES) {
      for (const shape of SHAPES) {
        for (const x of GRID) {
          const pos = { x, y: x / 2 };
          const b = bubbleAt(w, h, size, shape, pos);
          const [bw, bh] = extent(b);
          assert.deepEqual(clampPos(w, h, size, shape, pos), { x: (b.x + bw / 2) / w, y: (b.y + bh / 2) / h },
            `${w}x${h} ${size} ${shape} ${x}`);
        }
      }
    }
  }
});

test('clampPos: fed back into bubbleAt gives the same frame, and is a fixed point', () => {
  for (const [w, h] of CANVASES) {
    for (const size of SIZE_NAMES) {
      for (const shape of SHAPES) {
        for (const x of GRID) {
          for (const y of GRID) {
            const label = `${w}x${h} ${size} ${shape} (${x}, ${y})`;
            const once = clampPos(w, h, size, shape, { x, y });
            assert.ok(once.x >= 0 && once.x <= 1 && once.y >= 0 && once.y <= 1, `${label}: inside 0..1`);
            assert.deepEqual(bubbleAt(w, h, size, shape, once), bubbleAt(w, h, size, shape, { x, y }), label);
            assert.deepEqual(clampPos(w, h, size, shape, once), once, `${label}: clamping twice changes nothing`);
          }
        }
      }
    }
  }
});

test('clampPos: a position already in reach is kept to within half a pixel; a bad one is centered', () => {
  const p = clampPos(1920, 1080, 'medium', 'circle', { x: 0.4, y: 0.6 });
  assert.ok(Math.abs(p.x * 1920 - 0.4 * 1920) <= 0.5);
  assert.ok(Math.abs(p.y * 1080 - 0.6 * 1080) <= 0.5);
  assert.deepEqual(clampPos(1920, 1080, 'medium', 'circle', null), clampPos(1920, 1080, 'medium', 'circle', { x: 0.5, y: 0.5 }));
  assert.deepEqual(clampPos(1920, 1080, 'small', 'rectangle', { x: 7, y: 7 }), cornerPos(1920, 1080, 'bottom-right', 'small', 'rectangle'));
});

// ------------------------------------------------------------------ moveBubble and layout

test('moveBubble and layout: null with no session, and nothing is emitted', () => {
  compositor.stop();
  const moved = [];
  const off = Takes.bus.on('bubble:moved', (p) => moved.push(p));
  try {
    assert.equal(compositor.moveBubble({ x: 0.5, y: 0.5 }), null);
    assert.equal(compositor.moveBubble(null), null);
    assert.equal(compositor.layout(), null);
    assert.equal(moved.length, 0);
  } finally {
    off();
  }
});

// A stand-in browser just large enough for the canvas picture to start: hidden videos, a canvas whose
// 2D context records what it is asked to draw, and a worker that never ticks on its own.
function installFakeBrowser(t, screenSize) {
  const saved = {};
  for (const key of ['document', 'Worker']) {
    saved[key] = { had: Object.prototype.hasOwnProperty.call(globalThis, key), value: globalThis[key] };
  }
  const calls = [];
  const ctx = {
    lineWidth: 0, strokeStyle: '',
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, translate() {}, scale() {},
    drawImage() {}, moveTo() {}, arcTo() {},
    stroke() { calls.push(['stroke', this.lineWidth]); },
    arc(...args) { calls.push(['arc', ...args]); },
    roundRect(...args) { calls.push(['roundRect', ...args]); }
  };
  const makeVideo = () => ({
    muted: false, playsInline: false, autoplay: false, srcObject: null, parentNode: null,
    readyState: 2, videoWidth: 640, videoHeight: 480,
    addEventListener() {}, removeEventListener() {},
    play() { return Promise.resolve(); }, pause() {},
    requestVideoFrameCallback(cb) { cb(); }
  });
  const workers = [];
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; workers.push(this); }
    postMessage() {}
    terminate() {}
  }
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return makeVideo();
      return {
        width: 0, height: 0, parentNode: null,
        getContext() { return ctx; },
        captureStream() {
          const track = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } };
          return { getTracks: () => [track], getVideoTracks: () => [track] };
        }
      };
    }
  };
  globalThis.Worker = FakeWorker;
  t.after(() => {
    compositor.stop();
    for (const key of Object.keys(saved)) {
      if (saved[key].had) globalThis[key] = saved[key].value; else delete globalThis[key];
    }
  });
  const stream = (settings) => {
    const track = { kind: 'video', readyState: 'live', getSettings: () => settings, stop() {} };
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  };
  return {
    screen: stream({ width: screenSize[0], height: screenSize[1] }),
    camera: stream({ width: 640, height: 480 }),
    // Draw one frame the way a worker tick does, and return what it drew.
    tick() {
      calls.length = 0;
      workers[workers.length - 1].onmessage();
      return calls.slice();
    }
  };
}

test('start with no pos keeps the corner path, and layout reports the corner\'s center', async (t) => {
  const fake = installFakeBrowser(t, [1920, 1080]);
  await compositor.start({ screenStream: fake.screen, cameraStream: fake.camera, bubble: { corner: 'bottom-right', size: 'medium' } });
  const corner = bubbleRect(1920, 1080, 'bottom-right', 'medium');
  assert.deepEqual(fake.tick().find((c) => c[0] === 'arc').slice(1, 4), [corner.cx, corner.cy, corner.r]);
  assert.deepEqual(compositor.layout(), {
    width: 1920, height: 1080, shape: 'circle', size: 'medium',
    pos: cornerPos(1920, 1080, 'bottom-right', 'medium', 'circle'), mirror: true
  });

  // A pos with only one finite part is not a position: the corner is used.
  await compositor.start({ screenStream: fake.screen, cameraStream: fake.camera, bubble: { corner: 'top-left', size: 'small', pos: { x: 0.2 } } });
  const tl = bubbleRect(1920, 1080, 'top-left', 'small');
  assert.deepEqual(fake.tick().find((c) => c[0] === 'arc').slice(1, 4), [tl.cx, tl.cy, tl.r]);
  assert.deepEqual(compositor.layout().pos, cornerPos(1920, 1080, 'top-left', 'small', 'circle'));
});

test('start with a pos places the frame there; moveBubble moves it live and emits the clamped position', async (t) => {
  const fake = installFakeBrowser(t, [1280, 720]);
  const moved = [];
  const off = Takes.bus.on('bubble:moved', (p) => moved.push(p));
  t.after(off);

  await compositor.start({
    screenStream: fake.screen, cameraStream: fake.camera,
    bubble: { corner: 'top-left', size: 'large', shape: 'rectangle', mirror: false, pos: { x: 0.25, y: 0.75 } }
  });
  const placed = bubbleAt(1280, 720, 'large', 'rectangle', { x: 0.25, y: 0.75 });
  let frame = fake.tick();
  assert.deepEqual(frame.find((c) => c[0] === 'roundRect').slice(1, 5), [placed.x, placed.y, placed.w, placed.h]);
  const ring = frame.find((c) => c[0] === 'stroke')[1];
  assert.deepEqual(compositor.layout(), {
    width: 1280, height: 720, shape: 'rectangle', size: 'large',
    pos: clampPos(1280, 720, 'large', 'rectangle', { x: 0.25, y: 0.75 }), mirror: false
  });

  // Far past the top-right: held in the top-right corner, exactly where that corner frame sits.
  const used = compositor.moveBubble({ x: 5, y: -3 });
  assert.deepEqual(used, cornerPos(1280, 720, 'top-right', 'large', 'rectangle'));
  assert.deepEqual(moved, [used], 'one bubble:moved with the clamped position');
  assert.deepEqual(compositor.layout().pos, used);
  const tr = bubbleBox(1280, 720, 'top-right', 'large', 'rectangle');
  frame = fake.tick();
  assert.deepEqual(frame.find((c) => c[0] === 'roundRect').slice(1, 5), [tr.x, tr.y, tr.w, tr.h], 'the next frame shows the move');
  assert.equal(frame.find((c) => c[0] === 'stroke')[1], ring, 'the ring width is unchanged');

  // A bad position centers the frame.
  assert.deepEqual(compositor.moveBubble(null), clampPos(1280, 720, 'large', 'rectangle', { x: 0.5, y: 0.5 }));

  compositor.stop();
  assert.equal(compositor.moveBubble({ x: 0.1, y: 0.1 }), null, 'nothing after stop');
  assert.equal(compositor.layout(), null);
  assert.equal(moved.length, 2);
});

test('moveBubble on a circle moves the circle, keeps the ring, and returns the position used', async (t) => {
  const fake = installFakeBrowser(t, [1920, 1080]);
  await compositor.start({ screenStream: fake.screen, cameraStream: fake.camera, bubble: { corner: 'bottom-left', size: 'small' } });
  const ring = fake.tick().find((c) => c[0] === 'stroke')[1];
  const used = compositor.moveBubble({ x: 0.5, y: 0.5 });
  assert.deepEqual(used, clampPos(1920, 1080, 'small', 'circle', { x: 0.5, y: 0.5 }));
  const b = bubbleAt(1920, 1080, 'small', 'circle', used);
  const frame = fake.tick();
  assert.deepEqual(frame.find((c) => c[0] === 'arc').slice(1, 4), [b.cx, b.cy, b.r]);
  assert.equal(frame.find((c) => c[0] === 'stroke')[1], ring);
  assert.equal(compositor.layout().shape, 'circle');
});

test('moveBubble and layout: null for a passed-through stream', async (t) => {
  class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks.slice(); }
    getTracks() { return this.tracks.slice(); }
    getVideoTracks() { return this.tracks.filter((tr) => tr.kind === 'video'); }
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'MediaStream');
  const before = globalThis.MediaStream;
  globalThis.MediaStream = FakeMediaStream;
  t.after(() => { compositor.stop(); if (had) globalThis.MediaStream = before; else delete globalThis.MediaStream; });

  const video = { kind: 'video', readyState: 'live', stop() {} };
  await compositor.start({ screenStream: new FakeMediaStream([video]), bubble: { pos: { x: 0.5, y: 0.5 } } });
  assert.equal(compositor.moveBubble({ x: 0.5, y: 0.5 }), null);
  assert.equal(compositor.layout(), null);
});
