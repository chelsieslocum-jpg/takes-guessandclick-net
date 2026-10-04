// Tests for src/js/editor.js: the edit list, the player guard and the trimmed export.
// Run from the repository root: node --test
// Every time is in seconds. The browser parts run here against stand-ins, never a real video or the real library.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const editor = require('../src/js/editor.js');
const { normalizeEdits, keptRanges, editedDuration, mapTime, hasTrim, attachPlayer, exportEdited } = editor;

const DEFAULTS = { trimStart: 0, trimEnd: null, cut: null };
// The worked example: 60 seconds, trim 5 to 50, cut 20 to 30.
const EXAMPLE = { trimStart: 5, trimEnd: 50, cut: { start: 20, end: 30 } };

const clone = (value) => structuredClone(value);
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, (message || 'value') + ': expected ' + expected + ', got ' + actual);

/** Runs fn with a frozen deep copy of the edits and proves the copy is unchanged afterwards. */
function unchanged(edits, fn) {
  const given = clone(edits);
  const before = clone(edits);
  if (given.cut) Object.freeze(given.cut);
  Object.freeze(given);
  const result = fn(given);
  assert.deepEqual(given, before, 'the edits object is never changed');
  return result;
}

// ------------------------------------------------------------------ namespace

test('editor loads under Node and attaches its public methods', () => {
  assert.equal(Takes.editor, editor, 'module.exports is the object on Takes.editor');
  for (const name of ['normalizeEdits', 'keptRanges', 'editedDuration', 'mapTime', 'hasTrim', 'attachPlayer', 'exportEdited']) {
    assert.equal(typeof editor[name], 'function', name);
  }
});

// ------------------------------------------------------------------ normalizeEdits

test('normalizeEdits: the defaults keep everything and trimEnd becomes a number', () => {
  assert.deepEqual(normalizeEdits(DEFAULTS, 60), { trimStart: 0, trimEnd: 60, cut: null });
});

test('normalizeEdits: missing edits, and missing fields, are the defaults', () => {
  const full = { trimStart: 0, trimEnd: 60, cut: null };
  assert.deepEqual(normalizeEdits(undefined, 60), full);
  assert.deepEqual(normalizeEdits(null, 60), full);
  assert.deepEqual(normalizeEdits({}, 60), full);
  assert.deepEqual(normalizeEdits({ trimStart: 'nonsense', trimEnd: 'nonsense', cut: 'nonsense' }, 60), full);
});

test('normalizeEdits: a null trimEnd resolves to the duration', () => {
  assert.deepEqual(normalizeEdits({ trimStart: 5, trimEnd: null, cut: null }, 42.5), { trimStart: 5, trimEnd: 42.5, cut: null });
});

test('normalizeEdits: out-of-range values are held inside the recording', () => {
  assert.deepEqual(normalizeEdits({ trimStart: -10, trimEnd: 999, cut: null }, 60), { trimStart: 0, trimEnd: 60, cut: null });
  assert.deepEqual(normalizeEdits({ trimStart: 5, trimEnd: 61, cut: null }, 60), { trimStart: 5, trimEnd: 60, cut: null });
});

test('normalizeEdits: number-like strings from a range input are read as numbers', () => {
  assert.deepEqual(normalizeEdits({ trimStart: '5', trimEnd: '50', cut: { start: '20', end: '30' } }, 60), EXAMPLE);
});

test('normalizeEdits: a reversed cut is put in order', () => {
  const out = normalizeEdits({ trimStart: 5, trimEnd: 50, cut: { start: 30, end: 20 } }, 60);
  assert.deepEqual(out.cut, { start: 20, end: 30 });
});

test('normalizeEdits: a cut outside the trim, or an empty one, is dropped', () => {
  assert.equal(normalizeEdits({ trimStart: 10, trimEnd: 50, cut: { start: 2, end: 8 } }, 60).cut, null, 'before the trim');
  assert.equal(normalizeEdits({ trimStart: 10, trimEnd: 50, cut: { start: 52, end: 58 } }, 60).cut, null, 'after the trim');
  assert.equal(normalizeEdits({ trimStart: 0, trimEnd: null, cut: { start: 20, end: 20 } }, 60).cut, null, 'empty');
  assert.equal(normalizeEdits({ trimStart: 0, trimEnd: null, cut: { start: 20, end: 20.05 } }, 60).cut, null, 'under 0.1 s');
  assert.equal(normalizeEdits({ trimStart: 0, trimEnd: null, cut: { start: 20 } }, 60).cut, null, 'half a cut');
});

test('normalizeEdits: a cut of exactly 0.1 s is kept despite floating point', () => {
  const out = normalizeEdits({ trimStart: 0, trimEnd: null, cut: { start: 0.2, end: 0.3 } }, 60);
  assert.deepEqual(out.cut, { start: 0.2, end: 0.3 });
});

test('normalizeEdits: a cut overlapping a trim edge is clipped to it', () => {
  assert.deepEqual(normalizeEdits({ trimStart: 10, trimEnd: 50, cut: { start: 5, end: 20 } }, 60).cut, { start: 10, end: 20 });
  assert.deepEqual(normalizeEdits({ trimStart: 10, trimEnd: 50, cut: { start: 40, end: 55 } }, 60).cut, { start: 40, end: 50 });
});

test('normalizeEdits: throws a RangeError when under half a second would be kept', () => {
  const removesAll = (err) => {
    assert.ok(err instanceof RangeError);
    assert.equal(err.message, 'That edit would remove the whole recording.');
    return true;
  };
  assert.throws(() => normalizeEdits({ trimStart: 30, trimEnd: 30.2, cut: null }, 60), removesAll, 'trim leaves 0.2 s');
  assert.throws(() => normalizeEdits({ trimStart: 40, trimEnd: 20, cut: null }, 60), removesAll, 'end before start');
  assert.throws(() => normalizeEdits({ trimStart: 0, trimEnd: null, cut: { start: 0, end: 60 } }, 60), removesAll, 'cut covers everything');
  assert.throws(() => normalizeEdits({ trimStart: 10, trimEnd: 20, cut: { start: 10.2, end: 19.9 } }, 60), removesAll, 'trim plus cut leave 0.3 s');
  assert.doesNotThrow(() => normalizeEdits({ trimStart: 30, trimEnd: 30.5, cut: null }, 60), 'exactly 0.5 s is enough');
});

test('normalizeEdits: a recording shorter than half a second is fine while nothing is taken from it', () => {
  assert.deepEqual(normalizeEdits(DEFAULTS, 0.3), { trimStart: 0, trimEnd: 0.3, cut: null });
  assert.throws(() => normalizeEdits({ trimStart: 0.1, trimEnd: null, cut: null }, 0.3), RangeError);
  assert.deepEqual(normalizeEdits(DEFAULTS, 0), { trimStart: 0, trimEnd: 0, cut: null }, 'an unknown length does not throw');
});

test('normalizeEdits: returns a new object and never changes its input', () => {
  const given = clone(EXAMPLE);
  const out = unchanged(given, (e) => normalizeEdits(e, 60));
  assert.deepEqual(out, EXAMPLE);
  assert.notEqual(out, given);
  assert.notEqual(out.cut, given.cut);
  unchanged({ trimStart: -4, trimEnd: 999, cut: { start: 70, end: 3 } }, (e) => normalizeEdits(e, 60));
  unchanged(DEFAULTS, (e) => normalizeEdits(e, 60));
});

// ------------------------------------------------------------------ keptRanges

test('keptRanges: one pair without a cut', () => {
  assert.deepEqual(keptRanges(DEFAULTS, 60), [[0, 60]]);
  assert.deepEqual(keptRanges({ trimStart: 5, trimEnd: 50, cut: null }, 60), [[5, 50]]);
});

test('keptRanges: two ordered pairs with a cut (the worked example)', () => {
  assert.deepEqual(keptRanges(EXAMPLE, 60), [[5, 20], [30, 50]]);
  assert.deepEqual(keptRanges({ trimStart: 5, trimEnd: 50, cut: { start: 30, end: 20 } }, 60), [[5, 20], [30, 50]]);
});

test('keptRanges: a cut touching a trim edge leaves one pair, never an empty one', () => {
  assert.deepEqual(keptRanges({ trimStart: 10, trimEnd: 50, cut: { start: 5, end: 20 } }, 60), [[20, 50]]);
  assert.deepEqual(keptRanges({ trimStart: 10, trimEnd: 50, cut: { start: 40, end: 55 } }, 60), [[10, 40]]);
});

test('keptRanges: passes the RangeError on and never changes its input', () => {
  assert.throws(() => keptRanges({ trimStart: 30, trimEnd: 30.2, cut: null }, 60), RangeError);
  unchanged(EXAMPLE, (e) => keptRanges(e, 60));
  unchanged(DEFAULTS, (e) => keptRanges(e, 60));
});

// ------------------------------------------------------------------ editedDuration

test('editedDuration: the total of the kept ranges', () => {
  assert.equal(editedDuration(DEFAULTS, 60), 60);
  assert.equal(editedDuration({ trimStart: 5, trimEnd: 50, cut: null }, 60), 45);
  assert.equal(editedDuration(EXAMPLE, 60), 35, 'the worked example');
  assert.equal(editedDuration({ trimStart: 10, trimEnd: 50, cut: { start: 5, end: 20 } }, 60), 30);
  assert.equal(editedDuration(undefined, 12.5), 12.5);
});

test('editedDuration: never changes its input', () => {
  unchanged(EXAMPLE, (e) => editedDuration(e, 60));
  unchanged(DEFAULTS, (e) => editedDuration(e, 60));
});

// ------------------------------------------------------------------ mapTime

test('mapTime: the worked examples', () => {
  assert.equal(mapTime(35, EXAMPLE), 20);
  assert.equal(mapTime(25, EXAMPLE), null);
  assert.equal(mapTime(5, EXAMPLE), 0);
});

test('mapTime: the boundaries', () => {
  assert.equal(mapTime(5, EXAMPLE), 0, 'exactly trimStart is the edited start');
  assert.equal(mapTime(20, EXAMPLE), null, 'exactly the cut start is removed');
  assert.equal(mapTime(30, EXAMPLE), 15, 'exactly the cut end is kept, and lands where the cut began');
  assert.equal(mapTime(50, EXAMPLE), 35, 'exactly trimEnd is the edited end');
  assert.equal(mapTime(50, EXAMPLE), editedDuration(EXAMPLE, 60), 'the edited end is the edited duration');
});

test('mapTime: inside each removed region is null', () => {
  assert.equal(mapTime(0, EXAMPLE), null, 'before trimStart');
  assert.equal(mapTime(4.999, EXAMPLE), null, 'just before trimStart');
  assert.equal(mapTime(25, EXAMPLE), null, 'inside the cut');
  assert.equal(mapTime(29.999, EXAMPLE), null, 'just before the cut end');
  assert.equal(mapTime(50.001, EXAMPLE), null, 'just after trimEnd');
  assert.equal(mapTime(60, EXAMPLE), null, 'after trimEnd');
});

test('mapTime: before the cut shifts by trimStart; after it, by trimStart and the cut length', () => {
  near(mapTime(12.5, EXAMPLE), 7.5, 'before the cut');
  near(mapTime(19.999, EXAMPLE), 14.999, 'just before the cut');
  near(mapTime(42, EXAMPLE), 27, 'after the cut: 42 - 5 - 10');
  near(mapTime(42, { trimStart: 0, trimEnd: null, cut: { start: 20, end: 30 } }), 32, 'a cut alone: 42 - 10');
  near(mapTime(42, { trimStart: 5, trimEnd: null, cut: null }), 37, 'a start trim alone: 42 - 5');
});

test('mapTime: with no duration a null trimEnd means no upper limit', () => {
  assert.equal(mapTime(1e6, DEFAULTS), 1e6);
  assert.equal(mapTime(12, undefined), 12, 'missing edits are the defaults');
  assert.equal(mapTime(0, DEFAULTS), 0);
});

test('mapTime: an optional duration bounds a null trimEnd', () => {
  assert.equal(mapTime(60, DEFAULTS, 60), 60, 'the end itself is kept');
  assert.equal(mapTime(61, DEFAULTS, 60), null);
  assert.equal(mapTime(35, EXAMPLE, 60), 20);
});

test('mapTime: a time that is not a number is null, and nothing ever throws', () => {
  assert.equal(mapTime(NaN, EXAMPLE), null);
  assert.equal(mapTime(undefined, EXAMPLE), null);
  assert.equal(mapTime(Infinity, DEFAULTS), null);
  assert.equal(mapTime(30.1, { trimStart: 30, trimEnd: 30.2, cut: null }), 30.1 - 30, 'an edit normalizeEdits would refuse still maps');
});

test('mapTime: never changes its input', () => {
  for (const t of [0, 5, 20, 25, 30, 42, 50, 60]) {
    unchanged(EXAMPLE, (e) => mapTime(t, e));
    unchanged(EXAMPLE, (e) => mapTime(t, e, 60));
    unchanged(DEFAULTS, (e) => mapTime(t, e));
  }
});

// ------------------------------------------------------------------ hasTrim

test('hasTrim: true only when the start or the end is trimmed', () => {
  assert.equal(hasTrim(DEFAULTS, 60), false);
  assert.equal(hasTrim(undefined, 60), false);
  assert.equal(hasTrim({ trimStart: 0, trimEnd: 60, cut: null }, 60), false, 'an end at the full length is no trim');
  assert.equal(hasTrim({ trimStart: 0, trimEnd: 999, cut: null }, 60), false, 'an end past the full length is no trim');
  assert.equal(hasTrim({ trimStart: 0, trimEnd: null, cut: { start: 20, end: 30 } }, 60), false, 'a cut alone is not a trim');
  assert.equal(hasTrim({ trimStart: 5, trimEnd: null, cut: null }, 60), true);
  assert.equal(hasTrim({ trimStart: 0, trimEnd: 50, cut: null }, 60), true);
  assert.equal(hasTrim(EXAMPLE, 60), true);
});

test('hasTrim: never throws and never changes its input', () => {
  assert.equal(hasTrim({ trimStart: 30, trimEnd: 30.2, cut: null }, 60), true);
  unchanged(EXAMPLE, (e) => hasTrim(e, 60));
  unchanged(DEFAULTS, (e) => hasTrim(e, 60));
});

// ------------------------------------------------------------------ attachPlayer (against a stand-in video)

function fakeVideo(duration) {
  const listeners = {};
  return {
    duration,
    currentTime: 0,
    paused: true,
    ended: false,
    pauses: 0,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    pause() { this.paused = true; this.pauses++; },
    fire(type) { for (const fn of (listeners[type] || []).slice()) fn({ type }); },
    count() { return Object.values(listeners).reduce((n, list) => n + list.length, 0); }
  };
}

test('attachPlayer: starts at trimStart, skips the cut, pauses at trimEnd', () => {
  const video = fakeVideo(60);
  const edits = clone(EXAMPLE);
  const detach = attachPlayer(video, edits);
  assert.equal(typeof detach, 'function');
  assert.equal(video.currentTime, 5, 'attaching moves a player sitting before trimStart');

  video.paused = false;
  video.currentTime = 12;
  video.fire('timeupdate');
  assert.equal(video.currentTime, 12, 'a kept time is left alone');

  video.currentTime = 20.2;
  video.fire('timeupdate');
  assert.equal(video.currentTime, 30, 'playback inside the cut jumps to the cut end');
  assert.equal(video.paused, false, 'and keeps playing');

  video.currentTime = 2;
  video.fire('seeking');
  assert.equal(video.currentTime, 5, 'a seek before trimStart lands on trimStart');

  video.currentTime = 50.2;
  video.fire('timeupdate');
  assert.equal(video.paused, true, 'playback pauses at trimEnd');
  assert.equal(video.currentTime, 50, 'and sits on trimEnd');

  video.paused = false;
  video.fire('play');
  assert.equal(video.currentTime, 5, 'play pressed at the end starts the kept part again');

  assert.deepEqual(edits, EXAMPLE, 'the edits object is never changed');
  detach();
});

test('attachPlayer: with no trim the video is left to end by itself', () => {
  const video = fakeVideo(60);
  const detach = attachPlayer(video, DEFAULTS);
  video.paused = false;
  video.currentTime = 60;
  video.fire('timeupdate');
  assert.equal(video.pauses, 0);
  assert.equal(video.currentTime, 60);
  detach();
});

test('attachPlayer: detach stops the guard, and a second attach replaces the first', () => {
  const video = fakeVideo(60);
  const detach = attachPlayer(video, EXAMPLE);
  assert.equal(video.count(), 4);
  detach();
  detach();
  assert.equal(video.count(), 0, 'every listener is removed');
  video.currentTime = 25;
  video.fire('timeupdate');
  assert.equal(video.currentTime, 25, 'nothing moves the player after detach');

  attachPlayer(video, EXAMPLE);
  const second = attachPlayer(video, { trimStart: 0, trimEnd: null, cut: { start: 40, end: 45 } });
  assert.equal(video.count(), 4, 'the earlier guard was detached, not stacked');
  video.currentTime = 25;
  video.fire('timeupdate');
  assert.equal(video.currentTime, 25, 'the old cut no longer applies');
  video.currentTime = 41;
  video.fire('timeupdate');
  assert.equal(video.currentTime, 45, 'the new cut does');
  second();
});

test('attachPlayer: something that is not a video still returns a detach function', () => {
  assert.doesNotThrow(() => attachPlayer(null, EXAMPLE)());
  assert.doesNotThrow(() => attachPlayer({}, EXAMPLE)());
});

// ------------------------------------------------------------------ exportEdited (against a stand-in library)

function makeRecording(edits) {
  return {
    id: 'rec-1', name: 'takes-test', blob: new Blob(['original bytes'], { type: 'video/mp4;codecs=avc1,mp4a.40.2' }),
    mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', durationMs: 60000, createdAt: 1, edits, cues: []
  };
}

/** A stand-in for the library with the shape tested on a real recording. It records how it was called. */
function fakeLibrary(options = {}) {
  const calls = { trim: null, source: null, executed: false, inits: [], frames: [] };
  class BlobSource { constructor(blob) { this.blob = blob; if (!calls.source) calls.source = blob; } }
  // A 4-byte blob is the stand-in's own output; anything else is the recording.
  class Input {
    constructor(o) { this.options = o; }
    async getPrimaryVideoTrack() { return options.noPicture ? null : { displayWidth: 1920, displayHeight: 1080 }; }
    async computeDuration() { return this.options.source.blob.size === 4 ? (options.outputDuration ?? 35) : (options.sourceDuration ?? 60); }
  }
  class Quality { constructor(v) { this.value = v; } }
  class BufferTarget { constructor() { this.buffer = null; } }
  class Mp4OutputFormat {}
  class Output { constructor(o) { this.target = o.target; this.format = o.format; } }
  const Conversion = {
    async init(o) {
      const { input, output, trim } = o;
      calls.inits.push(o);
      if (options.failCut && o.video) throw new Error('the cut conversion fell over');
      calls.trim = trim;
      assert.ok(input instanceof Input && output instanceof Output);
      const conversion = {
        isValid: options.isValid !== false,
        discardedTracks: options.discardedTracks || [],
        onProgress: null,
        async execute() {
          calls.executed = true;
          if (options.throwOnExecute) throw new Error('decoder fell over');
          if (conversion.onProgress) for (const p of [0.25, 0.5, 1]) conversion.onProgress(p);
          if (o.video && o.video.process && options.frames) {
            for (const t of options.frames) calls.frames.push({ t, returned: o.video.process(Object.assign(fakeVideoSample(t, 0.04), { draw() {} })) });
          }
          output.target.buffer = new Uint8Array([1, 2, 3, 4]).buffer;
        }
      };
      return conversion;
    }
  };
  return { calls, lib: { Input, Output, Conversion, ALL_FORMATS: [], BlobSource, Mp4OutputFormat, BufferTarget, Quality } };
}

/** Swaps in a loader, collects bus events, runs fn, and always puts everything back. */
async function withLoader(loader, fn) {
  const real = editor._loadLibrary;
  const seen = { progress: [], toasts: [], loads: 0 };
  const offProgress = Takes.bus.on('export:progress', (p) => seen.progress.push(p));
  const offToast = Takes.bus.on('toast', (t) => seen.toasts.push(t));
  editor._loadLibrary = () => { seen.loads++; return loader(); };
  try {
    return await fn(seen);
  } finally {
    editor._loadLibrary = real;
    offProgress();
    offToast();
  }
}

test('exportEdited: with no trim and no cut it resolves the original blob and loads nothing', async () => {
  for (const edits of [DEFAULTS, { trimStart: 0, trimEnd: 60, cut: { start: 20, end: 20.05 } }]) {
    await withLoader(() => { throw new Error('the library must not be loaded'); }, async (seen) => {
      const recording = makeRecording(clone(edits));
      const out = await exportEdited(recording);
      assert.equal(out.blob, recording.blob, 'the very same blob');
      assert.equal(out.mimeType, recording.mimeType);
      assert.equal('cutApplied' in out, false);
      assert.equal(seen.loads, 0);
      assert.deepEqual(seen.progress, []);
      assert.deepEqual(seen.toasts, []);
    });
  }
});

test('exportEdited: with a trim and no cut it converts the trim range by copying and reports progress from 0 to 100', async () => {
  const fake = fakeLibrary();
  await withLoader(async () => fake.lib, async (seen) => {
    const recording = makeRecording({ trimStart: 5, trimEnd: 50, cut: null });
    const original = recording.blob;
    const out = await exportEdited(recording);

    assert.deepEqual(fake.calls.trim, { start: 5, end: 50 }, 'the trim range');
    assert.deepEqual(Object.keys(fake.calls.inits[0]).sort(), ['input', 'output', 'trim'], 'the trim-only call is the proven one, with no re-encode options');
    assert.equal('cutApplied' in out, false, 'no cut, so no cutApplied field');
    assert.equal(fake.calls.source, original, 'the library reads the original blob');
    assert.equal(fake.calls.executed, true);
    assert.equal(out.mimeType, 'video/mp4');
    assert.ok(out.blob instanceof Blob);
    assert.equal(out.blob.type, 'video/mp4');
    assert.equal(out.blob.size, 4);
    assert.notEqual(out.blob, original);

    assert.deepEqual(seen.progress.map((p) => p.pct), [0, 25, 50, 100]);
    assert.ok(seen.progress.every((p) => p.id === 'rec-1'));
    assert.deepEqual(seen.toasts, []);

    assert.equal(recording.blob, original, 'the recording still holds its original blob');
    assert.equal(await original.text(), 'original bytes', 'and the original bytes are untouched');
    assert.deepEqual(recording.edits, { trimStart: 5, trimEnd: 50, cut: null }, 'the edits are never changed');
  });
});

test('exportEdited: the trim end is held to the real length of the file', async () => {
  const fake = fakeLibrary({ sourceDuration: 48.5 });
  await withLoader(async () => fake.lib, async () => {
    await exportEdited(makeRecording({ trimStart: 5, trimEnd: null, cut: null }));
    assert.deepEqual(fake.calls.trim, { start: 5, end: 48.5 });
  });
});

const TRIM_ONLY = { trimStart: 5, trimEnd: 50, cut: null };

async function expectFailure(loader, edits, textPattern) {
  await withLoader(loader, async (seen) => {
    const recording = makeRecording(clone(edits));
    const original = recording.blob;
    await assert.rejects(exportEdited(recording), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'export-failed');
      assert.equal(err.toasted, true);
      return true;
    });
    assert.equal(seen.toasts.length, 1, 'exactly one toast');
    assert.equal(seen.toasts[0].kind, 'error');
    assert.match(seen.toasts[0].text, textPattern);
    assert.match(seen.toasts[0].text, /full recording is still here/);
    assert.equal(recording.blob, original, 'the original blob is still on the recording');
  });
}

test('exportEdited: when the library cannot be loaded it says so in plain words and rejects', async () => {
  await expectFailure(async () => { throw new TypeError('Failed to fetch dynamically imported module'); }, EXAMPLE, /internet connection/);
});

test('exportEdited: an invalid conversion, a dropped track or a thrown error each fail the same clean way', async () => {
  for (const edits of [TRIM_ONLY, EXAMPLE]) {
    await expectFailure(async () => fakeLibrary({ isValid: false }).lib, edits, /could not be made/);
    await expectFailure(async () => fakeLibrary({ discardedTracks: [{ reason: 'undecodable' }] }).lib, edits, /could not be made/);
    await expectFailure(async () => fakeLibrary({ throwOnExecute: true }).lib, edits, /could not be made/);
  }
});

test('exportEdited: an edit that removes everything is refused before anything is loaded', async () => {
  await withLoader(() => { throw new Error('the library must not be loaded'); }, async (seen) => {
    await assert.rejects(exportEdited(makeRecording({ trimStart: 30, trimEnd: 30.2, cut: null })), { code: 'export-failed' });
    assert.equal(seen.loads, 0);
    assert.equal(seen.toasts.length, 1);
  });
});

// ------------------------------------------------------------------ the cut in the saved file

test('_retime: where a sample lands once a cut of 15 to 25 is taken out', () => {
  const retime = editor._retime;
  assert.deepEqual(retime(10, 0.5, 15, 25), { timestamp: 10, duration: 0.5 }, 'before the cut: untouched');
  assert.deepEqual(retime(14.5, 0.5, 15, 25), { timestamp: 14.5, duration: 0.5 }, 'ending exactly at the cut start: untouched');
  assert.equal(retime(15, 0.5, 15, 25), null, 'starting exactly at the cut start: dropped');
  assert.equal(retime(20, 0.5, 15, 25), null, 'inside the cut: dropped');
  assert.equal(retime(24.5, 0.5, 15, 25), null, 'ending exactly at the cut end: dropped');
  assert.deepEqual(retime(25, 0.5, 15, 25), { timestamp: 15, duration: 0.5 }, 'starting exactly at the cut end: lands on the join');
  assert.deepEqual(retime(40, 0.5, 15, 25), { timestamp: 30, duration: 0.5 }, 'after the cut: moved back by the cut length');
  assert.deepEqual(retime(14.75, 0.5, 15, 25), { timestamp: 14.75, duration: 0.25 }, 'crossing the cut start: shortened');
  assert.deepEqual(retime(24.75, 0.5, 15, 25), { timestamp: 15, duration: 0.25 }, 'crossing the cut end: only the part after it, on the join');
  assert.deepEqual(retime(14, 12, 15, 25), { timestamp: 14, duration: 2 }, 'spanning the whole cut: both outside parts');
  assert.deepEqual(retime(10, 0.5, 15, 15), { timestamp: 10, duration: 0.5 }, 'an empty cut changes nothing');
});

test('_retime: the kept samples of a steady stream come out back to back with no gap and no overlap', () => {
  const step = 1 / 32;
  let expected = 0;
  let kept = 0;
  for (let i = 0; i < 45 * 32; i++) {
    const to = editor._retime(i * step, step, 15, 25);
    if (!to) continue;
    near(to.timestamp, expected, 'sample ' + i);
    expected = to.timestamp + to.duration;
    kept++;
  }
  near(expected, 35, 'total length');
  assert.equal(kept, 35 * 32);
});

function fakeVideoSample(timestamp, duration) {
  return { timestamp, duration, setTimestamp(t) { this.timestamp = t; }, setDuration(d) { this.duration = d; } };
}
function fakeAudioSample(timestamp, numberOfFrames, sampleRate = 48000) {
  return {
    timestamp, numberOfFrames, sampleRate, duration: numberOfFrames / sampleRate,
    setTimestamp(t) { this.timestamp = t; },
    trim(from, to = numberOfFrames) { return fakeAudioSample(timestamp + from / sampleRate, to - from, sampleRate); }
  };
}

test('exportEdited: with a cut it re-encodes over the trim range, drops the cut and resolves cutApplied true', async () => {
  const fake = fakeLibrary();
  await withLoader(async () => fake.lib, async (seen) => {
    const recording = makeRecording(clone(EXAMPLE));
    const original = recording.blob;
    const out = await exportEdited(recording);
    assert.equal(out.cutApplied, true);
    assert.equal(out.mimeType, 'video/mp4');
    assert.equal(out.blob.type, 'video/mp4');
    assert.notEqual(out.blob, original);
    assert.equal(fake.calls.inits.length, 1);
    const init = fake.calls.inits[0];
    assert.deepEqual(init.trim, { start: 5, end: 50 });
    assert.equal(init.video.codec, 'avc');
    assert.equal(init.audio.codec, 'aac');

    // The hooks see times counted from the trim start, so the cut of 20 to 30 is 15 to 25 on their clock.
    const v = init.video.process;
    assert.equal(v(fakeVideoSample(10, 0.04)).timestamp, 10);
    assert.equal(v(fakeVideoSample(20, 0.04)), null);
    near(v(fakeVideoSample(30, 0.04)).timestamp, 20);
    const a = init.audio.process;
    assert.equal(a(fakeAudioSample(10, 1024)).timestamp, 10);
    assert.equal(a(fakeAudioSample(20, 1024)), null);
    near(a(fakeAudioSample(30, 1024)).timestamp, 20);
    const head = a(fakeAudioSample(15 - 512 / 48000, 1024));
    assert.equal(head.length, 1);
    assert.equal(head[0].numberOfFrames, 512, 'a sample crossing the cut start keeps only its frames before it');
    const tail = a(fakeAudioSample(25 - 512 / 48000, 1024));
    assert.equal(tail.length, 1);
    assert.equal(tail[0].numberOfFrames, 512, 'a sample crossing the cut end keeps only its frames after it');
    near(tail[0].timestamp, 15, 'and they land exactly on the join');

    assert.equal(seen.progress[0].pct, 0);
    assert.equal(seen.progress[seen.progress.length - 1].pct, 100);
    assert.ok(seen.progress.every((p, i) => i === 0 || p.pct > seen.progress[i - 1].pct), 'progress only moves forward');
    assert.deepEqual(seen.toasts, []);
    assert.equal(recording.blob, original);
    assert.equal(await original.text(), 'original bytes');
    assert.deepEqual(recording.edits, EXAMPLE, 'the edits are never changed');
  });
});

test('exportEdited: a cut with no trim is applied too', async () => {
  const fake = fakeLibrary({ outputDuration: 50 });
  await withLoader(async () => fake.lib, async () => {
    const out = await exportEdited(makeRecording({ trimStart: 0, trimEnd: null, cut: { start: 20, end: 30 } }));
    assert.equal(out.cutApplied, true);
    assert.deepEqual(fake.calls.inits[0].trim, { start: 0, end: 60 });
  });
});

test('exportEdited: when the cut cannot be applied it falls back to the trim-only file and says cutApplied false', async () => {
  for (const options of [{ failCut: true }, { outputDuration: 45 }]) {
    const fake = fakeLibrary(options);
    await withLoader(async () => fake.lib, async (seen) => {
      const recording = makeRecording(clone(EXAMPLE));
      const out = await exportEdited(recording);
      assert.equal(out.cutApplied, false);
      assert.equal(out.blob.type, 'video/mp4');
      assert.notEqual(out.blob, recording.blob);
      const lastInit = fake.calls.inits[fake.calls.inits.length - 1];
      assert.deepEqual(Object.keys(lastInit).sort(), ['input', 'output', 'trim'], 'the fallback is the proven trim-only call');
      assert.deepEqual(lastInit.trim, { start: 5, end: 50 });
      assert.deepEqual(seen.toasts, [], 'no toast: the caller reads cutApplied and says so itself');
    });
  }
});

test('exportEdited: a cut with no trim falls back to the original blob when it cannot be applied', async () => {
  const cutOnly = { trimStart: 0, trimEnd: null, cut: { start: 20, end: 30 } };
  await withLoader(async () => fakeLibrary({ failCut: true }).lib, async (seen) => {
    const recording = makeRecording(clone(cutOnly));
    const out = await exportEdited(recording);
    assert.equal(out.cutApplied, false);
    assert.equal(out.blob, recording.blob);
    assert.deepEqual(seen.toasts, []);
  });
  await withLoader(async () => { throw new TypeError('offline'); }, async (seen) => {
    const recording = makeRecording(clone(cutOnly));
    const out = await exportEdited(recording);
    assert.equal(out.cutApplied, false);
    assert.equal(out.blob, recording.blob, 'offline with nothing to trim: the original, and no error');
    assert.deepEqual(seen.toasts, []);
  });
});

// ------------------------------------------------------------------ export options: captions in the picture, vertical

const { activeCueAt, wrapCaption, verticalLayout, needsExport } = editor;

test('activeCueAt: the cue covering a time; the start is inside and the end is not', () => {
  const cues = [{ start: 1, end: 3, text: 'one' }, { start: 3, end: 5, text: 'two' }, { start: 8, end: 9, text: 'three' }];
  const before = clone(cues);
  assert.equal(activeCueAt(cues, 0.99), null);
  assert.equal(activeCueAt(cues, 1).text, 'one', 'exactly the start');
  assert.equal(activeCueAt(cues, 2.5).text, 'one');
  assert.equal(activeCueAt(cues, 3).text, 'two', 'exactly the end belongs to the next cue');
  assert.equal(activeCueAt(cues, 5), null, 'exactly the last end is outside');
  assert.equal(activeCueAt(cues, 6), null, 'between cues');
  assert.equal(activeCueAt(cues, 8.5).text, 'three');
  assert.equal(activeCueAt([{ start: 0, end: 10, text: 'long' }, { start: 2, end: 4, text: 'later' }], 3).text, 'later', 'of two overlapping cues the later one wins');
  assert.equal(activeCueAt([], 1), null);
  assert.equal(activeCueAt(null, 1), null);
  assert.equal(activeCueAt(cues, NaN), null);
  assert.equal(activeCueAt([null, { start: 'x' }, { start: 1, end: 2, text: 'ok' }], 1.5).text, 'ok', 'broken cues are skipped');
  assert.deepEqual(cues, before, 'the cues are never changed');
});

test('wrapCaption: word wrap with no empty line and an ellipsis only when text is left out', () => {
  assert.deepEqual(wrapCaption('hello world', 20, 2), ['hello world']);
  assert.deepEqual(wrapCaption('the quick brown fox jumps', 10, 3), ['the quick', 'brown fox', 'jumps']);
  assert.deepEqual(wrapCaption('  spaced   out \n text ', 20, 2), ['spaced out text'], 'runs of spaces and line breaks collapse');
  assert.deepEqual(wrapCaption('', 10, 2), []);
  assert.deepEqual(wrapCaption(null, 10, 2), []);
  assert.deepEqual(wrapCaption('abcdefghijkl', 5, 3), ['abcde', 'fghij', 'kl'], 'a word longer than a line is broken');
  const cutShort = wrapCaption('the quick brown fox jumps over the lazy dog', 10, 2);
  assert.equal(cutShort.length, 2);
  assert.equal(cutShort[0], 'the quick');
  assert.equal(cutShort[1].slice(-1), '\u2026', 'text that does not fit ends in an ellipsis');
  for (const [text, width, lines] of [['one two three four five six seven eight nine ten', 7, 2], ['a b c d e f g h i j k l m n o p', 3, 3], ['supercalifragilistic expialidocious', 6, 2], ['x', 1, 1]]) {
    const out = wrapCaption(text, width, lines);
    assert.ok(out.length >= 1 && out.length <= lines, 'at most ' + lines + ' lines');
    for (const line of out) {
      assert.ok(line.length > 0, 'never an empty line');
      assert.ok(line.length <= width, '"' + line + '" fits ' + width);
    }
  }
  assert.deepEqual(wrapCaption('fits exactly', 12, 1), ['fits exactly'], 'no ellipsis when everything fits');
});

test('verticalLayout: 1080 by 1920, the video fitted to the width, the band below it, every number even', () => {
  const l = verticalLayout(1920, 1080);
  assert.equal(l.outW, 1080);
  assert.equal(l.outH, 1920);
  assert.deepEqual(l.video, { x: 0, y: 500, w: 1080, h: 608 });
  assert.deepEqual(l.captionBand, { x: 0, y: 1108, w: 1080, h: 812 });
  for (const [w, h] of [[1920, 1080], [2880, 1800], [1280, 720], [1440, 900], [640, 480], [1080, 1920], [720, 1280], [1000, 1000], [1919, 1079]]) {
    const v = verticalLayout(w, h);
    for (const n of [v.outW, v.outH, v.video.x, v.video.y, v.video.w, v.video.h, v.captionBand.x, v.captionBand.y, v.captionBand.w, v.captionBand.h]) {
      assert.equal(n % 2, 0, w + 'x' + h + ': ' + n + ' is even');
      assert.ok(n >= 0);
    }
    assert.ok(v.video.x + v.video.w <= 1080 && v.video.y + v.video.h <= 1920, 'the video stays inside the frame');
    assert.ok(Math.abs(v.video.w / v.video.h - w / h) < 0.01, 'the shape of the picture is kept');
    assert.equal(v.captionBand.y, v.video.y + v.video.h, 'the band starts where the video ends');
    assert.equal(v.captionBand.y + v.captionBand.h, 1920, 'and runs to the bottom');
  }
  assert.equal(verticalLayout(2880, 1800).video.w, 1080, 'a wide source fills the width');
  assert.equal(verticalLayout(1080, 1920).video.h, 1920, 'a source that is already vertical fills the frame');
  assert.doesNotThrow(() => verticalLayout(0, NaN));
});

test('needsExport: a trim, a cut or an option that is on; two-argument calls are unchanged', () => {
  const cues = [{ start: 1, end: 2, text: 'hi' }];
  assert.equal(needsExport(DEFAULTS, 60), false);
  assert.equal(needsExport(EXAMPLE, 60), true);
  assert.equal(needsExport({ trimStart: 0, trimEnd: null, cut: { start: 20, end: 30 } }, 60), true);
  assert.equal(needsExport(DEFAULTS, 60, undefined), false);
  assert.equal(needsExport(DEFAULTS, 60, {}), false);
  assert.equal(needsExport(DEFAULTS, 60, { size: 'original', burnCaptions: false }), false);
  assert.equal(needsExport(DEFAULTS, 60, { size: 'vertical' }), true);
  assert.equal(needsExport(DEFAULTS, 60, { burnCaptions: true, cues }), true);
  assert.equal(needsExport(DEFAULTS, 60, { burnCaptions: true }), true, 'cues not given: the recording may have some');
  assert.equal(needsExport(DEFAULTS, 60, { burnCaptions: true, cues: [] }), false, 'nothing to draw');
  assert.equal(needsExport(EXAMPLE, 60, { burnCaptions: false }), true);
  unchanged(EXAMPLE, (e) => needsExport(e, 60, { size: 'vertical' }));
});

test('_cuesForExport: cues land in the exported file\'s time, and cues in a removed part are dropped', () => {
  const cues = [
    { start: 0, end: 4, text: 'before the trim' },
    { start: 4, end: 8, text: 'crosses the trim start' },
    { start: 12, end: 14, text: 'kept, before the cut' },
    { start: 18, end: 22, text: 'runs into the cut' },
    { start: 22, end: 28, text: 'inside the cut' },
    { start: 28, end: 33, text: 'comes out of the cut' },
    { start: 40, end: 44, text: 'kept, after the cut' },
    { start: 48, end: 55, text: 'crosses the trim end' },
    { start: 52, end: 58, text: 'after the trim' },
    { start: 41, end: 42, text: '   ' },
  ];
  const before = clone(cues);
  const out = editor._cuesForExport(cues, normalizeEdits(EXAMPLE, 60));
  assert.deepEqual(out, [
    { start: 0, end: 3, text: 'crosses the trim start' },
    { start: 7, end: 9, text: 'kept, before the cut' },
    { start: 13, end: 15, text: 'runs into the cut' },
    { start: 15, end: 18, text: 'comes out of the cut' },
    { start: 25, end: 29, text: 'kept, after the cut' },
    { start: 33, end: 35, text: 'crosses the trim end' },
  ]);
  assert.deepEqual(cues, before, 'the cues are never changed');
  assert.deepEqual(editor._cuesForExport(cues.slice(2, 3), normalizeEdits(DEFAULTS, 60)), [{ start: 12, end: 14, text: 'kept, before the cut' }], 'no edits: unchanged times');
});

/** A drawing surface that records what was drawn on it. */
function fakeCanvasFactory(log) {
  return (width, height) => {
    const ctx = {
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect: (...a) => log.push(['fillRect', ctx.fillStyle, ...a]),
      beginPath() {}, rect() {}, roundRect: (...a) => log.push(['box', ...a]), fill: () => log.push(['fill', ctx.fillStyle]),
      fillText: (text, x, y) => log.push(['text', text, x, y, ctx.font]),
      measureText: (text) => ({ width: text.length * (parseInt(/(\d+)px/.exec(ctx.font)[1], 10) * 0.5) }),
    };
    return { width, height, getContext: () => ctx };
  };
}

async function withCanvas(fn) {
  const real = editor._makeCanvas;
  const log = [];
  editor._makeCanvas = fakeCanvasFactory(log);
  try { return await fn(log); } finally { editor._makeCanvas = real; }
}

function fakeDrawableSample(timestamp, duration, log) {
  return Object.assign(fakeVideoSample(timestamp, duration), { draw: (ctx, ...a) => log.push(['frame', timestamp, ...a]) });
}

const SOME_CUES = [{ start: 6, end: 9, text: 'Before the cut.' }, { start: 22, end: 26, text: 'Inside the cut.' }, { start: 31, end: 34, text: 'After the cut.' }];

test('exportEdited options: with none switched on the plain export runs exactly as before', async () => {
  for (const options of [undefined, null, {}, { burnCaptions: false, size: 'original' }, { burnCaptions: true, cues: [] }]) {
    await withLoader(() => { throw new Error('the library must not be loaded'); }, async (seen) => {
      const recording = makeRecording(clone(DEFAULTS));
      const out = await exportEdited(recording, options);
      assert.equal(out.blob, recording.blob);
      assert.equal(seen.loads, 0);
      if (options && options.burnCaptions) assert.deepEqual([out.captionsBurned, out.size], [false, 'original'], 'asked for, nothing to draw');
      else assert.deepEqual(Object.keys(out).sort(), ['blob', 'mimeType'], 'no extra fields when nothing was asked for');
    });
  }
});

test('exportEdited options: burnCaptions draws the right cue on each frame, in the exported file\'s time', async () => {
  await withCanvas(async (log) => {
    const fake = fakeLibrary();
    await withLoader(async () => fake.lib, async (seen) => {
      const recording = makeRecording(clone(EXAMPLE));
      const cuesBefore = clone(SOME_CUES);
      const out = await exportEdited(recording, { burnCaptions: true, cues: SOME_CUES });
      assert.deepEqual(Object.keys(out).sort(), ['blob', 'captionsBurned', 'cutApplied', 'mimeType', 'size']);
      assert.deepEqual([out.cutApplied, out.captionsBurned, out.size, out.mimeType], [true, true, 'original', 'video/mp4']);
      const init = fake.calls.inits[0];
      assert.deepEqual(init.trim, { start: 5, end: 50 });
      assert.equal(init.video.processedWidth, 1920);
      assert.equal(init.video.processedHeight, 1080);
      assert.ok(init.audio && typeof init.audio.process === 'function', 'a cut takes the same stretch out of the sound');

      // The hook's clock starts at the trim start: source 7 s is 2 s, source 22 s is 17 s (in the cut), source 32 s is 27 s.
      const process = init.video.process;
      const draw = (t) => { log.length = 0; const s = fakeDrawableSample(t, 0.04, log); const r = process(s); return { r, s, texts: log.filter((e) => e[0] === 'text').map((e) => e[1]) }; };
      const a = draw(2);
      assert.deepEqual(a.texts, ['Before the cut.']);
      assert.equal(a.r.width, 1920, 'the hook hands back the drawing surface');
      const gap = draw(10);
      assert.deepEqual(gap.texts, [], 'between cues nothing is drawn');
      assert.equal(log.filter((e) => e[0] === 'box').length, 0, 'and no box');
      assert.equal(draw(17).r, null, 'a frame inside the cut is dropped');
      const c = draw(27);
      assert.deepEqual(c.texts, ['After the cut.'], 'the cue for that source moment');
      near(c.s.timestamp, 17, 'and the frame is moved back by the cut');
      assert.equal(seen.progress[0].pct, 0);
      assert.equal(seen.progress[seen.progress.length - 1].pct, 100);
      assert.deepEqual(seen.toasts, []);
      assert.deepEqual(SOME_CUES, cuesBefore, 'the cues are never changed');
      assert.deepEqual(recording.edits, EXAMPLE);
    });
  });
});

test('exportEdited options: vertical makes a 1080 by 1920 picture with the captions in the band below the video', async () => {
  await withCanvas(async (log) => {
    const fake = fakeLibrary({ outputDuration: 60, frames: [10, 20, 30, 40, 50] });
    await withLoader(async () => fake.lib, async (seen) => {
      const recording = makeRecording(clone(DEFAULTS));
      recording.cues = [{ start: 6, end: 9, text: 'From the recording itself.' }];
      const out = await exportEdited(recording, { burnCaptions: true, size: 'vertical' });
      assert.deepEqual(Object.keys(out).sort(), ['blob', 'captionsBurned', 'mimeType', 'size'], 'no cut, so no cutApplied');
      assert.deepEqual([out.captionsBurned, out.size], [true, 'vertical']);
      const init = fake.calls.inits[0];
      assert.equal(init.video.processedWidth, 1080);
      assert.equal(init.video.processedHeight, 1920);
      assert.equal(init.audio, undefined, 'with no cut the sound is left alone');
      assert.deepEqual(seen.progress.map((p) => p.pct), [0, 17, 33, 50, 66, 83, 100], 'progress comes from the frames as they pass');

      log.length = 0;
      init.video.process(fakeDrawableSample(7, 0.04, log));
      assert.deepEqual(log[0], ['fillRect', '#151122', 0, 0, 1080, 1920], 'the frame is filled with the page color first');
      assert.deepEqual(log[1], ['frame', 7, 0, 500, 1080, 608], 'then the whole picture, fitted to the width');
      const text = log.filter((e) => e[0] === 'text');
      assert.ok(text.length >= 1 && text.length <= 3, 'at most three lines');
      assert.equal(text.map((e) => e[1]).join(' '), 'From the recording itself.', 'the recording\'s own cues are used when none are passed');
      for (const e of text) assert.ok(e[3] > 1108, 'every line sits below the video');
    });
  });
});

test('exportEdited options: when they cannot be applied it falls back to the plain export and says so in the result', async () => {
  // No drawing surface under Node, a recording with no picture, a conversion that throws, a file of the wrong length.
  const cases = [
    { canvas: false, lib: {} },
    { canvas: true, lib: { noPicture: true } },
    { canvas: true, lib: { failCut: true } },
    { canvas: true, lib: { outputDuration: 12 } },
  ];
  for (const c of cases) {
    const body = async () => {
      const fake = fakeLibrary(c.lib);
      await withLoader(async () => fake.lib, async (seen) => {
        const recording = makeRecording({ trimStart: 5, trimEnd: 50, cut: null });
        const out = await exportEdited(recording, { burnCaptions: true, cues: SOME_CUES, size: 'vertical' });
        assert.deepEqual([out.captionsBurned, out.size], [false, 'original']);
        assert.equal('cutApplied' in out, false);
        assert.equal(out.blob.type, 'video/mp4', 'the plain trimmed file');
        assert.notEqual(out.blob, recording.blob);
        const lastInit = fake.calls.inits[fake.calls.inits.length - 1];
        assert.deepEqual(Object.keys(lastInit).sort(), ['input', 'output', 'trim'], 'the fallback is the proven trim-only call');
        assert.deepEqual(seen.toasts, [], 'no toast: the caller reads the fields and says so itself');
      });
    };
    if (c.canvas) await withCanvas(body); else await body();
  }
});

test('exportEdited options: with no edits the fallback is the original blob, and a cut keeps its own cutApplied', async () => {
  await withLoader(async () => { throw new TypeError('offline'); }, async (seen) => {
    const recording = makeRecording(clone(DEFAULTS));
    const out = await exportEdited(recording, { size: 'vertical' });
    assert.equal(out.blob, recording.blob);
    assert.deepEqual([out.captionsBurned, out.size], [false, 'original']);
    assert.deepEqual(seen.toasts, []);
  });
  await withCanvas(async () => {
    const fake = fakeLibrary({ noPicture: true });
    await withLoader(async () => fake.lib, async () => {
      const out = await exportEdited(makeRecording(clone(EXAMPLE)), { size: 'vertical' });
      assert.deepEqual([out.cutApplied, out.captionsBurned, out.size], [true, false, 'original'], 'the cut export still succeeded');
    });
  });
});
