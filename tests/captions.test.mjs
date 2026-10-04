// Tests for src/js/captions.js: the pure helpers (all in seconds) and, with stand-ins for the
// browser and the speech library, the order of work inside generate().
// Run from the repository root: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');

// The editor is loaded BEFORE captions, as in the built page: shiftCuesForEdits calls Takes.editor.mapTime.
const EDITOR_PATH = fileURLToPath(new URL('../src/js/editor.js', import.meta.url));
const HAS_EDITOR = existsSync(EDITOR_PATH);
if (HAS_EDITOR) {
  require('../src/js/editor.js');
} else {
  // A stand-in with the editor's mapTime rules, so dropping and clipping can still be tested.
  Takes.editor = {
    mapTime(sourceSec, edits) {
      const e = edits || {};
      const trimStart = e.trimStart || 0;
      const trimEnd = e.trimEnd == null ? Infinity : e.trimEnd;
      if (sourceSec < trimStart || sourceSec > trimEnd) return null;
      if (e.cut) {
        if (sourceSec >= e.cut.start && sourceSec < e.cut.end) return null;
        if (sourceSec >= e.cut.end) return sourceSec - trimStart - (e.cut.end - e.cut.start);
      }
      return sourceSec - trimStart;
    }
  };
}

const captions = require('../src/js/captions.js');
const { formatVttTime, toVtt, splitLongCues, shiftCuesForEdits, chunksToCues } = captions;

const ARROW = '--' + '>';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ' expected ' + b + ', got ' + a);

// ------------------------------------------------------------------ the module

test('captions loads under Node and attaches its public api', () => {
  assert.equal(Takes.captions, captions);
  for (const fn of ['generate', 'toVtt', 'formatVttTime', 'splitLongCues', 'shiftCuesForEdits', 'attach', 'downloadVtt']) {
    assert.equal(typeof captions[fn], 'function', fn);
  }
  assert.equal(captions.DOWNLOAD_SIZE_TEXT, 'about 50 to 70 MB');
  assert.deepEqual(captions.DOWNLOAD_MB, { fast: 70, fallback: 48 });
});

test('downloadSizeText: the exact figure for this computer, and it never rejects', async () => {
  captions._test.reset();
  const gpu = (value) => Object.defineProperty(globalThis.navigator, 'gpu', { value, configurable: true });
  try {
    assert.equal(await captions.downloadSizeText(), 'about 50 MB', 'no graphics card: the fallback');
    gpu({ requestAdapter: async () => ({}) });
    assert.equal(await captions.downloadSizeText(), 'about 70 MB', 'a graphics card: the fast setting');
    gpu({ requestAdapter: async () => null });
    assert.equal(await captions.downloadSizeText(), 'about 50 MB', 'no adapter given');
    gpu({ requestAdapter: async () => { throw new Error('no'); } });
    assert.equal(await captions.downloadSizeText(), 'about 50 MB', 'a failing check');
  } finally {
    delete globalThis.navigator.gpu;
  }
});

test('the source file keeps the single-file rules', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/js/captions.js', import.meta.url)), 'utf8');
  assert.ok(src.startsWith('/* takes:captions */'));
  assert.equal(/^[ \t]*(import|export)\s/m.test(src), false, 'no line starts with a static import or export');
  for (const banned of ['</' + 'script', '<' + 'script', '<' + '!--']) assert.equal(src.includes(banned), false, banned);
  const urls = src.match(/https?:\/\/[^\s'"`)]+/g) || [];
  assert.deepEqual([...new Set(urls)], ['https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0']);
  assert.equal(/one time|one-time/i.test(src), false, 'the model downloads on every open; never promise a single download');
});

// ------------------------------------------------------------------ formatVttTime

test('formatVttTime: hours always shown, milliseconds padded', () => {
  assert.equal(formatVttTime(0), '00:00:00.000');
  assert.equal(formatVttTime(65.5), '00:01:05.500');
  assert.equal(formatVttTime(3661.5), '01:01:01.500');
  assert.equal(formatVttTime(0.001), '00:00:00.001');
  assert.equal(formatVttTime(360000), '100:00:00.000');
});

test('formatVttTime: rounding never produces 1000 ms or 60 s', () => {
  assert.equal(formatVttTime(59.9995), '00:01:00.000');
  assert.equal(formatVttTime(0.9996), '00:00:01.000');
  assert.equal(formatVttTime(3599.9999), '01:00:00.000');
  assert.equal(formatVttTime(59.9994), '00:00:59.999');
  for (let i = 0; i < 2000; i++) {
    const out = formatVttTime(i * 0.73913 + 0.9995);
    assert.match(out, /^\d{2,}:[0-5]\d:[0-5]\d\.\d{3}$/, out);
  }
});

test('formatVttTime: negative and non-finite are zero', () => {
  for (const bad of [-1, -0.0001, NaN, Infinity, -Infinity, undefined, null, 'abc']) {
    assert.equal(formatVttTime(bad), '00:00:00.000', String(bad));
  }
});

// ------------------------------------------------------------------ toVtt

test('toVtt: an empty list is just the header', () => {
  assert.equal(toVtt([]), 'WEBVTT\n');
  assert.equal(toVtt(null), 'WEBVTT\n');
  assert.equal(toVtt(undefined), 'WEBVTT\n');
});

test('toVtt: header, blank line, timing lines, text, no cue numbers', () => {
  const vtt = toVtt([
    { start: 0, end: 2.5, text: 'Hello there.' },
    { start: 2.5, end: 65.5, text: 'Second line.' }
  ]);
  assert.equal(vtt,
    'WEBVTT\n\n' +
    '00:00:00.000 ' + ARROW + ' 00:00:02.500\nHello there.\n\n' +
    '00:00:02.500 ' + ARROW + ' 00:01:05.500\nSecond line.\n');
  const lines = vtt.split('\n');
  assert.equal(lines[0], 'WEBVTT');
  assert.equal(lines[1], '');
  assert.equal(lines.filter((l) => /^\d+$/.test(l)).length, 0, 'no numbered cue lines');
});

test('toVtt: cue text can never break the file', () => {
  const vtt = toVtt([
    { start: 1, end: 2, text: 'a ' + ARROW + ' b' },
    { start: 2, end: 3, text: 'line one\n\nline two\r\n  line three' },
    { start: 3, end: 4, text: '---' + ARROW + ARROW }
  ]);
  const lines = vtt.split('\n');
  const timing = lines.filter((l) => l.includes(ARROW));
  assert.equal(timing.length, 3, 'the arrow appears on the three timing lines only');
  for (const l of timing) assert.match(l, /^\d\d:\d\d:\d\d\.\d{3} --. \d\d:\d\d:\d\d\.\d{3}$/);
  assert.ok(lines.includes('a -> b'));
  assert.ok(lines.includes('line one line two line three'));
  // Every blank line is followed by a timing line or the end: no cue was split in two by a blank line.
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i] === '') assert.ok(lines[i + 1] === '' || lines[i + 1].includes(ARROW) , 'line after blank: ' + lines[i + 1]);
  }
});

test('toVtt: leaves out cues with no text or no length, and does not change its input', () => {
  const cues = [
    { start: 0, end: 1, text: '   ' },
    { start: 2, end: 2, text: 'zero length' },
    { start: 5, end: 4, text: 'backwards' },
    { start: 6, end: 7, text: 'kept' }
  ];
  const before = JSON.stringify(cues);
  assert.equal(toVtt(cues), 'WEBVTT\n\n00:00:06.000 ' + ARROW + ' 00:00:07.000\nkept\n');
  assert.equal(JSON.stringify(cues), before);
});

// ------------------------------------------------------------------ splitLongCues

test('splitLongCues: a short cue is untouched, in a new array', () => {
  const cues = [{ start: 1, end: 3, text: 'Short and sweet.' }];
  const out = splitLongCues(cues, 84);
  assert.deepEqual(out, cues);
  assert.notEqual(out, cues);
  assert.notEqual(out[0], cues[0]);
  const exact = 'x'.repeat(84);
  assert.deepEqual(splitLongCues([{ start: 0, end: 1, text: exact }]), [{ start: 0, end: 1, text: exact }], '84 is the default limit');
});

test('splitLongCues: a long cue splits at spaces and its time is partitioned exactly, in order', () => {
  const words = [];
  for (let i = 0; i < 60; i++) words.push('word' + i);
  const text = words.join(' ');
  const cue = { start: 10, end: 40, text };
  const out = splitLongCues([cue], 40);
  assert.ok(out.length > 2);
  assert.equal(out[0].start, 10);
  assert.equal(out[out.length - 1].end, 40);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i].text.length > 0 && out[i].text.length <= 40, 'piece length ' + out[i].text.length);
    assert.equal(out[i].text, out[i].text.trim());
    assert.ok(out[i].end > out[i].start, 'no zero-length piece');
    if (i > 0) assert.equal(out[i].start, out[i - 1].end, 'pieces touch, no gap and no overlap');
  }
  assert.equal(out.map((c) => c.text).join(' '), text, 'no word lost, none split');
  // Time is shared by share of the characters.
  const total = out.reduce((n, c) => n + c.text.length, 0);
  near(out[0].end - out[0].start, 30 * out[0].text.length / total, 'first share');
});

test('splitLongCues: one very long word is cut hard, never left over the limit', () => {
  const word = 'a'.repeat(200);
  const out = splitLongCues([{ start: 0, end: 10, text: word }], 84);
  assert.deepEqual(out.map((c) => c.text.length), [84, 84, 32]);
  assert.equal(out.map((c) => c.text).join(''), word);
  assert.equal(out[0].start, 0);
  assert.equal(out[2].end, 10);
  near(out[0].end, 4.2);
  const mixed = splitLongCues([{ start: 0, end: 9, text: 'hi ' + 'b'.repeat(25) + ' there' }], 10);
  for (const c of mixed) assert.ok(c.text.length >= 1 && c.text.length <= 10 && c.end > c.start);
  assert.equal(mixed.map((c) => c.text).join('').replace(/ /g, ''), 'hi' + 'b'.repeat(25) + 'there');
});

test('splitLongCues: drops empty cues, never makes an empty or zero-length one, never changes its input', () => {
  const cues = [
    { start: 0, end: 1, text: '' },
    { start: 1, end: 2, text: '    ' },
    { start: 2, end: 2, text: 'no time to share but far too long for the limit given here' },
    { start: 3, end: 9, text: 'one two three four five six seven eight nine ten' }
  ];
  const before = JSON.stringify(cues);
  const out = splitLongCues(cues, 12);
  assert.equal(JSON.stringify(cues), before, 'input untouched');
  assert.ok(out.every((c) => c.text.length > 0));
  assert.equal(out.filter((c) => c.start === 2).length, 1, 'a cue with no length is kept whole, not turned into zero-length pieces');
  assert.ok(out.filter((c) => c.start >= 3).every((c) => c.end > c.start && c.text.length <= 12));
  assert.deepEqual(splitLongCues([], 84), []);
  assert.deepEqual(splitLongCues(null), []);
});

test('splitLongCues: no orphan last word; the lines come out similar in length', () => {
  // Wrapped greedily at 84 this is one full line and then the single word "fee.".
  const text = 'This plan is completely free for as long as you like and nobody will ever ask you for a fee.';
  const cues = [{ start: 10, end: 16, text }];
  const before = JSON.stringify(cues);
  const out = splitLongCues(cues, 84);
  assert.equal(JSON.stringify(cues), before, 'input untouched');
  assert.equal(out.length, 2);
  assert.equal(out.map((c) => c.text).join(' '), text);
  for (const c of out) {
    assert.ok(c.text.length <= 84 && c.text.length >= 12, 'no stray fragment: "' + c.text + '"');
    assert.ok(c.text.split(' ').length > 1, 'never a single word');
    assert.ok(c.end - c.start >= 0.6, 'on screen long enough');
  }
  assert.ok(Math.abs(out[0].text.length - out[1].text.length) <= 15, 'similar lengths: ' + out.map((c) => c.text.length));
  assert.equal(out[0].start, 10);
  assert.equal(out[0].end, out[1].start);
  assert.equal(out[1].end, 16);
});

test('splitLongCues: a last line that would flash by in under 0.6 s is joined to the line before', () => {
  // 89 characters spoken in one second: two lines would each be on screen for half a second.
  const words = [];
  for (let i = 0; i < 18; i++) words.push('word');
  const text = words.join(' ');
  assert.equal(text.length, 89);
  const cues = [{ start: 3, end: 4, text }];
  const before = JSON.stringify(cues);
  const out = splitLongCues(cues, 84);
  assert.equal(JSON.stringify(cues), before, 'input untouched');
  assert.deepEqual(out, [{ start: 3, end: 4, text }], 'one cue, within the limit plus the small allowance');
  assert.ok(out[0].text.length <= 84 + 12);
  // The same words over six seconds have time for two lines, and they partition the cue exactly.
  const slow = splitLongCues([{ start: 3, end: 9, text }], 84);
  assert.equal(slow.length, 2);
  assert.equal(slow[0].start, 3);
  assert.equal(slow[0].end, slow[1].start);
  assert.equal(slow[1].end, 9);
  assert.ok(slow.every((c) => c.end - c.start >= 0.6 && c.text.length <= 84));
  // Far too long to join: stays split, never empty, never zero-length.
  const long = splitLongCues([{ start: 0, end: 1, text: text + ' ' + text + ' ' + text }], 84);
  assert.ok(long.length >= 3);
  assert.ok(long.every((c) => c.text.length > 0 && c.end > c.start));
  assert.equal(long[0].start, 0);
  assert.equal(long[long.length - 1].end, 1);
});

// ------------------------------------------------------------------ shiftCuesForEdits

const EDITS = { trimStart: 5, trimEnd: 50, cut: { start: 20, end: 30 } };

test('shiftCuesForEdits matches Takes.editor.mapTime at every boundary (the two must not drift apart)',
  { skip: HAS_EDITOR ? false : 'src/js/editor.js is absent, so the real mapTime cannot be compared' },
  () => {
    const editor = Takes.editor;
    const cues = [
      { start: 5, end: 8, text: 'first' },
      { start: 8.25, end: 12.5, text: 'second' },
      { start: 15, end: 19.9, text: 'before the cut' },
      { start: 30, end: 33.3, text: 'right after the cut' },
      { start: 41.125, end: 50, text: 'to the very end' }
    ];
    for (const edits of [EDITS, { trimStart: 5, trimEnd: 50, cut: null }, { trimStart: 0, trimEnd: null, cut: null }, { trimStart: 2.5, trimEnd: null, cut: { start: 20, end: 30 } }]) {
      const out = shiftCuesForEdits(cues, edits);
      assert.equal(out.length, cues.length, JSON.stringify(edits));
      for (let i = 0; i < cues.length; i++) {
        assert.equal(out[i].start, editor.mapTime(cues[i].start, edits), 'start of cue ' + i);
        assert.equal(out[i].end, editor.mapTime(cues[i].end, edits), 'end of cue ' + i);
        assert.equal(out[i].text, cues[i].text);
      }
    }
    // The worked examples (trim 5 to 50, cut 20 to 30), through the real editor.
    assert.equal(editor.mapTime(35, EDITS), 20);
    assert.deepEqual(shiftCuesForEdits([{ start: 35, end: 36, text: 'x' }], EDITS), [{ start: 20, end: 21, text: 'x' }]);
  });

test('shiftCuesForEdits: drops cues wholly inside a removed range', () => {
  const out = shiftCuesForEdits([
    { start: 0, end: 4, text: 'before the trim' },
    { start: 21, end: 29, text: 'inside the cut' },
    { start: 51, end: 55, text: 'after the trim' },
    { start: 6, end: 7, text: 'kept' }
  ], EDITS);
  assert.deepEqual(out, [{ start: 1, end: 2, text: 'kept' }]);
});

test('shiftCuesForEdits: clips cues that straddle a boundary to the nearest kept edge', () => {
  const out = shiftCuesForEdits([
    { start: 3, end: 7, text: 'starts before the trim' },   // kept part 5..7  -> 0..2
    { start: 18, end: 24, text: 'ends inside the cut' },    // kept part 18..20 -> 13..15
    { start: 26, end: 33, text: 'starts inside the cut' },  // kept part 30..33 -> 15..18
    { start: 48, end: 60, text: 'runs past the end' },      // kept part 48..50 -> 33..35
    { start: 19, end: 31, text: 'spans the whole cut' }     // 19..20 and 30..31 -> 14..16
  ], EDITS);
  assert.deepEqual(out.map((c) => [c.start, c.end]), [[0, 2], [13, 15], [15, 18], [33, 35], [14, 16]]);
  assert.equal(out[0].text, 'starts before the trim');
});

test('shiftCuesForEdits: a sliver left after clipping is dropped; input is never changed', () => {
  const cues = [
    { start: 19.97, end: 25, text: 'only 0.03 s survives' },
    { start: 19.5, end: 25, text: 'half a second survives' }
  ];
  const edits = { trimStart: 5, trimEnd: 50, cut: { start: 20, end: 30 } };
  const cuesBefore = JSON.stringify(cues);
  const editsBefore = JSON.stringify(edits);
  const out = shiftCuesForEdits(cues, edits);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'half a second survives');
  near(out[0].start, 14.5);
  near(out[0].end, 15);
  assert.equal(JSON.stringify(cues), cuesBefore);
  assert.equal(JSON.stringify(edits), editsBefore);
});

test('shiftCuesForEdits: a trim-only edit list (what a trimmed export uses) and no edits at all', () => {
  const cues = [{ start: 4, end: 9, text: 'a' }, { start: 20, end: 25, text: 'b' }];
  assert.deepEqual(shiftCuesForEdits(cues, { trimStart: 5, trimEnd: 22, cut: null }),
    [{ start: 0, end: 4, text: 'a' }, { start: 15, end: 17, text: 'b' }]);
  assert.deepEqual(shiftCuesForEdits(cues, { trimStart: 0, trimEnd: null, cut: null }), cues);
  assert.deepEqual(shiftCuesForEdits([], EDITS), []);
});

test('shiftCuesForEdits: without the editor module the cues come back unchanged', () => {
  const saved = Takes.editor;
  const cues = [{ start: 1, end: 2, text: 'a' }];
  try {
    delete Takes.editor;
    const out = shiftCuesForEdits(cues, EDITS);
    assert.deepEqual(out, cues);
    assert.notEqual(out, cues, 'still a new array');
  } finally {
    Takes.editor = saved;
  }
});

// ------------------------------------------------------------------ chunksToCues

test('chunksToCues: trims text, drops empty chunks, fills a missing end, stays inside the sound', () => {
  const cues = chunksToCues([
    { timestamp: [0, 2.5], text: ' Hello there. ' },
    { timestamp: [2.5, 2.5], text: '   ' },
    { timestamp: [3, null], text: ' No end on this one.' },
    { timestamp: [6, 8], text: '[BLANK_AUDIO]' },
    { timestamp: [9, 14], text: ' Runs past the end.' },
    { timestamp: [11, null], text: ' Last, with no end.' }
  ], 12);
  assert.deepEqual(cues, [
    { start: 0, end: 2.5, text: 'Hello there.' },
    { start: 3, end: 9, text: 'No end on this one.' },
    { start: 9, end: 12, text: 'Runs past the end.' }
  ], 'the last chunk has no room left inside 12 seconds and is dropped');
  const tail = chunksToCues([{ timestamp: [1, null], text: 'only one' }], 5);
  assert.deepEqual(tail, [{ start: 1, end: 5, text: 'only one' }], 'a missing end on the last chunk is the length of the sound');
});

test('chunksToCues: output is ordered and never overlaps', () => {
  const cues = chunksToCues([
    { timestamp: [0, 5], text: 'a first full line' },
    { timestamp: [4, 6], text: 'b second full line' },
    { timestamp: [8, 8], text: 'c third full line' },
    { timestamp: [9.5, 12], text: 'd fourth full line' }
  ], 30);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].end > cues[i].start);
    if (i > 0) assert.ok(cues[i].start >= cues[i - 1].end, 'cue ' + i + ' starts after the one before');
  }
  assert.deepEqual(cues.map((c) => c.text[0]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(cues[2], { start: 8, end: 9, text: 'c third full line' }, 'a zero-length chunk is given up to a second');
  assert.deepEqual(chunksToCues(undefined, 10), []);
});

test('chunksToCues: a stray word or a blink of a chunk is joined to the line it follows', () => {
  const chunks = [
    { timestamp: [0, 4], text: ' Nobody will ever ask you for a' },
    { timestamp: [4, 4.3], text: ' fee.' },                          // one short word, 0.3 s
    { timestamp: [4.4, 4.8], text: ' And that is the whole of it.' }, // long enough text, but 0.4 s
    { timestamp: [9, 10], text: ' Okay.' },                           // short, but after a real pause: its own cue
    { timestamp: [10.2, 13], text: ' A full sentence follows here.' }
  ];
  const before = JSON.stringify(chunks);
  const cues = chunksToCues(chunks, 20);
  assert.equal(JSON.stringify(chunks), before, 'input untouched');
  assert.deepEqual(cues, [
    { start: 0, end: 4.8, text: 'Nobody will ever ask you for a fee. And that is the whole of it.' },
    { start: 9, end: 10, text: 'Okay.' },
    { start: 10.2, end: 13, text: 'A full sentence follows here.' }
  ]);
  assert.ok(cues.every((c) => c.end > c.start && c.text.length > 0));
});

// ------------------------------------------------------------------ generate, with stand-ins

// A stand-in for the browser's decoder: the "blob" carries the samples it should decode to.
class FakeAudioContext {
  constructor(opts) { this.sampleRate = opts.sampleRate; FakeAudioContext.rates.push(opts.sampleRate); }
  async decodeAudioData(buffer) {
    if (buffer.fail) throw new Error('Unable to decode audio data');
    const channels = buffer.channels;
    return {
      length: channels[0].length,
      numberOfChannels: channels.length,
      duration: channels[0].length / this.sampleRate,
      getChannelData: (i) => channels[i]
    };
  }
  close() { FakeAudioContext.closed++; return Promise.resolve(); }
}
FakeAudioContext.rates = [];
FakeAudioContext.closed = 0;

function fakeBlob(channels, opts = {}) {
  const marker = opts.soundTrack === false ? [0, 0, 0, 0] : [0x73, 0x6f, 0x75, 0x6e];
  return {
    size: 8,
    arrayBuffer: async () => ({ channels, fail: !!opts.fail }),
    slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, ...marker, 3, 4]).buffer })
  };
}

function tone(seconds, level) {
  const out = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < out.length; i++) out[i] = level * Math.sin(i / 10);
  return out;
}

function listen() {
  const events = [];
  const offs = ['captions:progress', 'captions:done', 'toast'].map((name) =>
    Takes.bus.on(name, (payload) => events.push({ name, ...payload })));
  return { events, stop: () => offs.forEach((off) => off()) };
}

// A stand-in for the speech library. failFast makes the WebGPU setting throw on its first run.
function fakeLibrary(log, opts = {}) {
  return {
    pipeline: async (task, model, options) => {
      const kind = typeof options.device === 'string' ? 'fallback' : 'fast';
      log.push({ load: kind, task, model, dtype: options.dtype, device: options.device });
      if (opts.failLoad === kind) throw new Error('could not start ' + kind);
      options.progress_callback({ status: 'initiate', file: 'config.json' });
      options.progress_callback({ status: 'progress', file: 'onnx/encoder_model.onnx', loaded: 10 * 1048576, total: 30 * 1048576 });
      options.progress_callback({ status: 'progress', file: 'onnx/encoder_model.onnx', loaded: 30 * 1048576, total: 30 * 1048576 });
      const run = async (samples, runOptions) => {
        log.push({ run: kind, samples: samples.length, runOptions });
        if (opts.failRun === kind) throw new Error('the run failed on ' + kind);
        return opts.result || { text: ' Hello there.', chunks: [{ timestamp: [0, 2], text: ' Hello there.' }, { timestamp: [2, null], text: ' Still talking.' }] };
      };
      run.dispose = async () => { log.push({ dispose: kind }); };
      return run;
    }
  };
}

function setGpu(present) {
  if (present) {
    Object.defineProperty(globalThis.navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
  } else {
    delete globalThis.navigator.gpu;
  }
}

async function withBrowser(opts, body) {
  const hadCtx = 'AudioContext' in globalThis;
  const oldCtx = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  setGpu(!!opts.gpu);
  captions._test.reset();
  const heard = listen();
  try {
    return await body(heard.events);
  } finally {
    heard.stop();
    captions._test.setLibraryLoader();
    captions._test.reset();
    setGpu(false);
    if (hadCtx) globalThis.AudioContext = oldCtx; else delete globalThis.AudioContext;
  }
}

test('generate: says it is working first, loads the wasm setting with no graphics card, returns split cues', async () => {
  await withBrowser({ gpu: false }, async (events) => {
    const log = [];
    let loads = 0;
    captions._test.setLibraryLoader(async () => { loads++; return fakeLibrary(log); });
    const left = tone(4, 0.4);
    const right = tone(4, 0.2);
    const result = await captions.generate({ id: 'r1', blob: fakeBlob([left, right]), durationMs: 4000 });

    assert.deepEqual(events[0], { name: 'captions:progress', id: 'r1', phase: 'download', pct: 0 }, 'the working state is announced before anything else');
    assert.deepEqual(result.cues, [{ start: 0, end: 2, text: 'Hello there.' }, { start: 2, end: 4, text: 'Still talking.' }]);
    assert.equal(result.vtt, toVtt(result.cues));
    const done = events.filter((e) => e.name === 'captions:done');
    assert.equal(done.length, 1);
    assert.deepEqual(done[0], { name: 'captions:done', id: 'r1', cues: result.cues, vtt: result.vtt });
    assert.equal(events[events.length - 1].name, 'captions:done');
    assert.equal(events.filter((e) => e.name === 'toast').length, 0);

    const prog = events.filter((e) => e.name === 'captions:progress');
    for (const p of prog) assert.ok(p.pct === null || (p.pct >= 0 && p.pct <= 100), 'pct is 0 to 100 or null: ' + p.pct);
    const phases = prog.map((p) => p.phase);
    assert.equal(phases.indexOf('transcribe'), phases.lastIndexOf('transcribe'), 'transcribe is announced once');
    assert.ok(phases.lastIndexOf('download') < phases.indexOf('transcribe'));
    assert.ok(prog.some((p) => p.phase === 'download' && p.pct === 100));
    assert.equal(prog.find((p) => p.phase === 'transcribe').pct, null);

    assert.deepEqual(log[0], { load: 'fallback', task: 'automatic-speech-recognition', model: 'onnx-community/whisper-tiny.en_timestamped', dtype: 'q8', device: 'wasm' });
    assert.deepEqual(log[1].runOptions, { return_timestamps: true, chunk_length_s: 30 });
    assert.equal(log[1].samples, 64000);
    assert.deepEqual(FakeAudioContext.rates.slice(-1), [16000]);
    assert.ok(FakeAudioContext.closed > 0, 'the audio context is closed');

    // A second recording in the same visit reuses the loaded model: no second download.
    await captions.generate({ id: 'r2', blob: fakeBlob([left]), durationMs: 4000 });
    assert.equal(loads, 1, 'the library is fetched once per visit');
    assert.equal(log.filter((l) => l.load).length, 1, 'the model is loaded once per visit');
  });
});

test('generate: uses the fast setting when a graphics card is found', async () => {
  await withBrowser({ gpu: true }, async () => {
    const log = [];
    captions._test.setLibraryLoader(async () => fakeLibrary(log));
    await captions.generate({ id: 'r1', blob: fakeBlob([tone(2, 0.5)]) });
    assert.deepEqual(log[0].dtype, { encoder_model: 'fp32', decoder_model_merged: 'q8' });
    assert.deepEqual(log[0].device, { encoder_model: 'webgpu', decoder_model_merged: 'wasm' });
    assert.equal(captions._test.sessionKind(), 'fast');
  });
});

test('generate: the fast setting failing on load or on its first run falls back once and is remembered', async () => {
  for (const how of ['failLoad', 'failRun']) {
    await withBrowser({ gpu: true }, async (events) => {
      const log = [];
      captions._test.setLibraryLoader(async () => fakeLibrary(log, { [how]: 'fast' }));
      const result = await captions.generate({ id: 'r1', blob: fakeBlob([tone(4, 0.5)]) });
      assert.equal(result.cues.length, 2, how);
      assert.deepEqual(log.filter((l) => l.load).map((l) => l.load), ['fast', 'fallback'], how);
      assert.equal(events.filter((e) => e.name === 'toast').length, 0, 'a quiet fallback, no toast');
      assert.equal(captions._test.sessionKind(), 'fallback');
      await captions.generate({ id: 'r2', blob: fakeBlob([tone(2, 0.5)]) });
      assert.deepEqual(log.filter((l) => l.load).map((l) => l.load), ['fast', 'fallback'], 'the fast setting is not tried again');
    });
  }
});

test('generate: silence, and a recording with no sound track, are zero cues with an info toast and no download', async () => {
  await withBrowser({ gpu: false }, async (events) => {
    let loads = 0;
    captions._test.setLibraryLoader(async () => { loads++; return fakeLibrary([]); });
    const silent = await captions.generate({ id: 's', blob: fakeBlob([new Float32Array(32000)]) });
    assert.deepEqual(silent, { cues: [], vtt: 'WEBVTT\n' });
    const noTrack = await captions.generate({ id: 'n', blob: fakeBlob(null, { fail: true, soundTrack: false }) });
    assert.deepEqual(noTrack, { cues: [], vtt: 'WEBVTT\n' });
    assert.equal(loads, 0, 'nothing is downloaded for a recording with nothing said');
    const toasts = events.filter((e) => e.name === 'toast');
    assert.deepEqual(toasts.map((t) => [t.kind, t.text]), [['info', 'No speech found in this recording'], ['info', 'No speech found in this recording']]);
    assert.deepEqual(events.filter((e) => e.name === 'captions:done').map((e) => [e.id, e.cues.length, e.vtt]), [['s', 0, 'WEBVTT\n'], ['n', 0, 'WEBVTT\n']]);
  });
});

test('generate: speech the model hears nothing in is also zero cues, not an error', async () => {
  await withBrowser({ gpu: false }, async (events) => {
    captions._test.setLibraryLoader(async () => fakeLibrary([], { result: { text: '', chunks: [{ timestamp: [0, 2], text: ' [BLANK_AUDIO]' }] } }));
    const result = await captions.generate({ id: 'q', blob: fakeBlob([tone(2, 0.01)]) });
    assert.deepEqual(result, { cues: [], vtt: 'WEBVTT\n' });
    assert.deepEqual(events.filter((e) => e.name === 'toast').map((t) => t.kind), ['info']);
  });
});

test('generate: failures toast in plain words and reject with the coded error', async () => {
  await withBrowser({ gpu: false }, async (events) => {
    const expectFail = async (promise, textPattern) => {
      const before = events.filter((e) => e.name === 'toast').length;
      await assert.rejects(promise, (err) => {
        assert.equal(err.code, 'captions-failed');
        assert.equal(err.toasted, true);
        return true;
      });
      const toasts = events.filter((e) => e.name === 'toast').slice(before);
      assert.equal(toasts.length, 1, 'exactly one toast per failure');
      assert.equal(toasts[0].kind, 'error');
      assert.match(toasts[0].text, textPattern);
    };

    // Offline: the library cannot be fetched.
    captions._test.setLibraryLoader(async () => { throw new TypeError('Failed to fetch dynamically imported module'); });
    await expectFail(captions.generate({ id: 'a', blob: fakeBlob([tone(1, 0.5)]) }), /internet connection/);

    // The library came down but the model would not start on either setting.
    captions._test.setLibraryLoader(async () => fakeLibrary([], { failLoad: 'fallback' }));
    await expectFail(captions.generate({ id: 'b', blob: fakeBlob([tone(1, 0.5)]) }), /internet connection/);

    // The model ran and failed.
    captions._test.reset();
    captions._test.setLibraryLoader(async () => fakeLibrary([], { failRun: 'fallback' }));
    await expectFail(captions.generate({ id: 'c', blob: fakeBlob([tone(1, 0.5)]) }), /could not be made/);

    // The sound is there but cannot be read.
    await expectFail(captions.generate({ id: 'd', blob: fakeBlob(null, { fail: true, soundTrack: true }) }), /could not be read/);

    // No blob at all.
    await expectFail(captions.generate({ id: 'e' }), /no video to caption/);

    assert.equal(events.filter((e) => e.name === 'captions:done').length, 0, 'a failure never emits captions:done');
  });
});

test('generate: with no audio decoder (plain Node) it fails in plain words instead of throwing', async () => {
  captions._test.reset();
  const heard = listen();
  try {
    await assert.rejects(captions.generate({ id: 'x', blob: fakeBlob([tone(1, 0.5)]) }), (err) => err.code === 'captions-failed' && err.toasted === true);
    assert.equal(heard.events[0].name, 'captions:progress');
    assert.equal(heard.events.filter((e) => e.name === 'toast' && e.kind === 'error').length, 1);
  } finally {
    heard.stop();
  }
});

// ------------------------------------------------------------------ attach and downloadVtt, with stand-ins

test('attach: one captions track per video, emptied and refilled, returned showing', () => {
  const hadCue = 'VTTCue' in globalThis;
  const oldCue = globalThis.VTTCue;
  globalThis.VTTCue = class { constructor(start, end, text) { this.startTime = start; this.endTime = end; this.text = text; } };
  try {
    const made = [];
    const video = {
      textTracks: made,
      addTextTrack(kind, label, language) {
        const track = {
          kind, label, language, mode: 'disabled', cues: [],
          addCue(c) { this.cues.push(c); },
          removeCue(c) { this.cues.splice(this.cues.indexOf(c), 1); }
        };
        made.push(track);
        return track;
      }
    };
    const first = captions.attach(video, [{ start: 0, end: 1, text: 'one' }, { start: 1, end: 2, text: 'two' }, { start: 3, end: 3, text: 'no length' }]);
    assert.deepEqual([first.kind, first.label, first.language, first.mode], ['captions', 'English', 'en', 'showing']);
    assert.deepEqual(first.cues.map((c) => [c.startTime, c.endTime, c.text]), [[0, 1, 'one'], [1, 2, 'two']]);
    first.mode = 'hidden';
    const second = captions.attach(video, [{ start: 5, end: 6, text: 'three' }]);
    assert.equal(second, first, 'the same track is reused');
    assert.equal(made.length, 1, 'no second track is added');
    assert.deepEqual(second.cues.map((c) => c.text), ['three']);
    assert.equal(second.mode, 'showing');
    assert.equal(captions.attach(null, []), null);
  } finally {
    if (hadCue) globalThis.VTTCue = oldCue; else delete globalThis.VTTCue;
  }
});

test('downloadVtt: no cues is an info toast and null; under Node (no page) it says so instead of throwing', () => {
  const heard = listen();
  try {
    assert.equal(captions.downloadVtt({ id: 'a', name: 'demo', cues: [] }, false), null);
    assert.equal(captions.downloadVtt({ id: 'a', name: 'demo', cues: [{ start: 0, end: 1, text: 'hi' }] }, false), null);
    assert.deepEqual(heard.events.map((e) => e.kind), ['info', 'error']);
  } finally {
    heard.stop();
  }
});

// ------------------------------------------------------------------ transcript tools

const { toText, toSrt, formatSrtTime, searchCues } = captions;

test('formatSrtTime: comma milliseconds, same rounding care as the VTT form', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(59.9995), '00:01:00,000');
  assert.equal(formatSrtTime(3661.5), '01:01:01,500');
  assert.equal(formatSrtTime(-3), '00:00:00,000');
  assert.equal(formatSrtTime(NaN), '00:00:00,000');
  for (let i = 0; i < 500; i++) assert.match(formatSrtTime(i * 0.73913 + 0.9995), /^\d{2,}:[0-5]\d:[0-5]\d,\d{3}$/);
});

test('toText: flowing paragraphs, a new one after a pause of more than 2 seconds', () => {
  const cues = [
    { start: 0, end: 2, text: ' Hello  there. ' },
    { start: 2.5, end: 4, text: 'This carries\non.' },
    { start: 4, end: 5, text: '   ' },
    { start: 6, end: 8, text: 'Exactly two seconds later.' },
    { start: 10.5, end: 12, text: 'After a long pause.' }
  ];
  const before = JSON.stringify(cues);
  assert.equal(toText(cues), 'Hello there. This carries on. Exactly two seconds later.\n\nAfter a long pause.');
  assert.equal(toText(cues, { timestamps: false }), toText(cues));
  assert.equal(JSON.stringify(cues), before, 'input untouched');
  assert.equal(toText([]), '');
  assert.equal(toText(null), '');
  assert.equal(toText([], { timestamps: true }), '');
});

test('toText: a long stretch breaks at a sentence end after about 500 characters', () => {
  const cues = [];
  for (let i = 0; i < 30; i++) cues.push({ start: i * 2, end: i * 2 + 2, text: i % 2 ? 'and it ends right here.' : 'This sentence runs on' });
  const paras = toText(cues).split('\n\n');
  assert.ok(paras.length >= 2);
  for (const para of paras.slice(0, -1)) {
    assert.ok(para.length >= 500 && para.length < 600, 'paragraph length ' + para.length);
    assert.ok(para.endsWith('.'), 'breaks only at a sentence end');
  }
  assert.equal(paras.join(' '), cues.map((c) => c.text).join(' '), 'no words lost');
});

test('toText with timestamps: one line per cue, m:ss, h:mm:ss past an hour', () => {
  const cues = [
    { start: 0, end: 2, text: 'First.' },
    { start: 65.9, end: 70, text: ' Second  line. ' },
    { start: 3725, end: 3730, text: 'Past the hour.' }
  ];
  const before = JSON.stringify(cues);
  assert.equal(toText(cues, { timestamps: true }), '[0:00] First.\n[1:05] Second line.\n[1:02:05] Past the hour.');
  assert.equal(JSON.stringify(cues), before);
});

test('toSrt: numbered from 1, comma milliseconds, blank line between blocks, text cannot break the file', () => {
  const cues = [
    { start: 0, end: 2.5, text: 'Hello there.' },
    { start: 2.5, end: 2.5, text: 'no length, left out' },
    { start: 3, end: 65.5, text: 'a ' + ARROW + ' b\n\nnext' }
  ];
  const before = JSON.stringify(cues);
  assert.equal(toSrt(cues),
    '1\n00:00:00,000 ' + ARROW + ' 00:00:02,500\nHello there.\n\n' +
    '2\n00:00:03,000 ' + ARROW + ' 00:01:05,500\na -> b next\n');
  assert.equal(JSON.stringify(cues), before);
  assert.equal(toSrt([]), '');
  assert.equal(toSrt(null), '');
});

test('searchCues: case-insensitive, trimmed query, no match, empty query', () => {
  const cues = [{ start: 0, end: 1, text: 'Hello There' }, { start: 1, end: 2, text: 'nothing' }, { start: 2, end: 3, text: 'say hello  there again' }];
  const before = JSON.stringify(cues);
  assert.deepEqual(searchCues(cues, 'hello'), [0, 2]);
  assert.deepEqual(searchCues(cues, '  HELLO THERE '), [0, 2]);
  assert.deepEqual(searchCues(cues, 'zebra'), []);
  assert.deepEqual(searchCues(cues, ''), []);
  assert.deepEqual(searchCues(cues, '   '), []);
  assert.deepEqual(searchCues(cues, null), []);
  assert.deepEqual(searchCues(null, 'x'), []);
  assert.equal(JSON.stringify(cues), before);
});

test('downloadText and downloadSrt: named like the recording, and shifted the same way the .vtt is', () => {
  const saved = { doc: globalThis.document, hadDoc: 'document' in globalThis, create: URL.createObjectURL, revoke: URL.revokeObjectURL, save: Takes.save };
  const links = [];
  const blobs = [];
  globalThis.document = { body: { appendChild() {}, removeChild() {} }, createElement: () => { const a = { style: {}, click() { links.push(a.download); } }; return a; } };
  URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:x'; };
  URL.revokeObjectURL = () => {};
  Takes.save = { fileName: (rec, ext) => rec.name + '.' + ext };
  const heard = listen();
  try {
    const rec = { id: 'a', name: 'demo', edits: { trimStart: 5, trimEnd: null, cut: null }, cues: [{ start: 1, end: 2, text: 'trimmed away' }, { start: 6, end: 8, text: 'kept' }] };
    const before = JSON.stringify(rec);
    assert.equal(captions.downloadText(rec, false), 'demo.txt');
    assert.equal(captions.downloadSrt(rec, true), 'demo.srt');
    assert.equal(captions.downloadVtt(rec, true), 'demo.vtt');
    assert.deepEqual(links, ['demo.txt', 'demo.srt', 'demo.vtt']);
    assert.equal(JSON.stringify(rec), before);
    assert.equal(captions.downloadSrt({ name: 'none', cues: [] }), null);
    assert.equal(captions.downloadText({ name: 'none', cues: [] }), null);
    assert.deepEqual(heard.events.map((e) => e.kind), ['info', 'info']);
    return Promise.all(blobs.map((b) => b.text())).then((texts) => {
      assert.equal(texts[0], 'trimmed away\n\nkept\n', 'a 4 second gap starts a new paragraph');
      assert.equal(texts[1], '1\n00:00:01,000 ' + ARROW + ' 00:00:03,000\nkept\n');
      assert.equal(texts[2], 'WEBVTT\n\n00:00:01.000 ' + ARROW + ' 00:00:03.000\nkept\n');
    });
  } finally {
    heard.stop();
    if (saved.hadDoc) globalThis.document = saved.doc; else delete globalThis.document;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    if (saved.save) Takes.save = saved.save; else delete Takes.save;
  }
});
