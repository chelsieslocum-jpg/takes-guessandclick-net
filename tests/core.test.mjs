// Tests for src/js/core.js: the pure helpers, the bus and capability detection.
// Run from the repository root: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const { pickMimeType, formatTime, makeFileName, clamp } = Takes.util;

const MP4_FULL = 'video/mp4;codecs=avc1,mp4a.40.2';
const MP4_PLAIN = 'video/mp4';

// ------------------------------------------------------------------ namespace

test('core loads under Node and defines the shared namespace', () => {
  assert.equal(globalThis.Takes, Takes, 'core puts the one global on globalThis when there is no window');
  assert.equal(Takes.PRODUCT_NAME, 'Takes');
  assert.deepEqual(Object.keys(Takes.util).sort(), ['clamp', 'formatTime', 'makeFileName', 'makeTakeName', 'pickMimeType']);
  for (const fn of ['on', 'off', 'emit']) assert.equal(typeof Takes.bus[fn], 'function');
  assert.equal(Takes.state.current, null);
  assert.deepEqual(Takes.state.recordings, []);
  assert.equal(typeof Takes.state.caps, 'object');
  assert.equal(typeof Takes.detectCaps, 'function');
});

// ------------------------------------------------------------------ pickMimeType

test('pickMimeType: the first string wins when it is supported', () => {
  const asked = [];
  const result = pickMimeType((type) => { asked.push(type); return true; });
  assert.deepEqual(result, { mimeType: MP4_FULL, ext: 'mp4' });
  assert.deepEqual(asked, [MP4_FULL], 'it stops asking once one is supported');
});

test('pickMimeType: falls to the second string when only that one is supported', () => {
  const result = pickMimeType((type) => type === MP4_PLAIN);
  assert.deepEqual(result, { mimeType: MP4_PLAIN, ext: 'mp4' });
});

test('pickMimeType: neither supported throws a clear, plain-words error', () => {
  assert.throws(() => pickMimeType(() => false), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /cannot record MP4/);
    assert.match(err.message, /update Chrome or Edge/);
    return true;
  });
});

test('pickMimeType: a probe that throws counts as not supported', () => {
  assert.throws(() => pickMimeType(() => { throw new Error('boom'); }), /cannot record MP4/);
});

test('pickMimeType: with no probe and no MediaRecorder (Node) it throws the same clear error', () => {
  assert.throws(() => pickMimeType(), /cannot record MP4/);
});

// ------------------------------------------------------------------ formatTime

test('formatTime: m:ss', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(59.4), '0:59');
  assert.equal(formatTime(59.99), '0:59', 'it floors, so the timer never shows a second that has not finished');
  assert.equal(formatTime(60), '1:00');
  assert.equal(formatTime(605), '10:05');
  assert.equal(formatTime(3725), '62:05', 'minutes keep counting past an hour');
});

test('formatTime: anything that is not a positive finite number is 0:00', () => {
  for (const bad of [NaN, Infinity, -Infinity, -5, undefined, null, 'abc']) {
    assert.equal(formatTime(bad), '0:00', String(bad));
  }
});

// ------------------------------------------------------------------ makeFileName

test('makeFileName: takes-YYYY-MM-DD-HHMM.ext in local time', () => {
  // new Date(y, m, d, h, min) is local time, so this holds in every time zone.
  assert.equal(makeFileName(new Date(2026, 9, 4, 9, 31), 'mp4'), 'takes-2026-10-04-0931.mp4');
  assert.equal(makeFileName(new Date(2026, 0, 2, 0, 5), 'vtt'), 'takes-2026-01-02-0005.vtt');
  assert.equal(makeFileName(new Date(2026, 11, 31, 23, 59), 'mp4'), 'takes-2026-12-31-2359.mp4');
});

test('makeFileName: ext defaults to mp4 and a leading dot is dropped', () => {
  assert.equal(makeFileName(new Date(2026, 9, 4, 9, 31)), 'takes-2026-10-04-0931.mp4');
  assert.equal(makeFileName(new Date(2026, 9, 4, 9, 31), '.vtt'), 'takes-2026-10-04-0931.vtt');
});

test('makeFileName: a missing or invalid date falls back to now', () => {
  const shape = /^takes-\d{4}-\d{2}-\d{2}-\d{4}\.mp4$/;
  assert.match(makeFileName(undefined, 'mp4'), shape);
  assert.match(makeFileName(new Date('not a date'), 'mp4'), shape);
});

// ------------------------------------------------------------------ makeTakeName

test('makeTakeName: month first, ordinal day, 12-hour clock, local time', () => {
  const { makeTakeName } = Takes.util;
  assert.equal(makeTakeName(new Date(2026, 9, 3, 20, 59)), 'Take, October 3rd, 8:59 PM');
  assert.equal(makeTakeName(new Date(2026, 9, 3, 20, 59, 58)), 'Take, October 3rd, 8:59 PM', 'no seconds');
  assert.equal(makeTakeName(new Date(2026, 0, 5, 9, 5)), 'Take, January 5th, 9:05 AM', 'minutes keep their zero');
});

test('makeTakeName: every ordinal ending', () => {
  const { makeTakeName } = Takes.util;
  const want = {
    1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 11: '11th', 12: '12th', 13: '13th',
    21: '21st', 22: '22nd', 23: '23rd', 31: '31st'
  };
  for (const [day, text] of Object.entries(want)) {
    assert.equal(makeTakeName(new Date(2026, 9, Number(day), 10, 30)), 'Take, October ' + text + ', 10:30 AM');
  }
});

test('makeTakeName: midnight is 12:00 AM and noon is 12:00 PM', () => {
  const { makeTakeName } = Takes.util;
  assert.equal(makeTakeName(new Date(2026, 9, 4, 0, 0)), 'Take, October 4th, 12:00 AM');
  assert.equal(makeTakeName(new Date(2026, 9, 4, 12, 0)), 'Take, October 4th, 12:00 PM');
  assert.equal(makeTakeName(new Date(2026, 9, 4, 0, 7)), 'Take, October 4th, 12:07 AM');
  assert.equal(makeTakeName(new Date(2026, 9, 4, 23, 59)), 'Take, October 4th, 11:59 PM');
});

test('makeTakeName: a missing or invalid date falls back to now', () => {
  const { makeTakeName } = Takes.util;
  const shape = /^Take, [A-Z][a-z]+ \d{1,2}(st|nd|rd|th), \d{1,2}:\d{2} (AM|PM)$/;
  assert.match(makeTakeName(), shape);
  assert.match(makeTakeName(new Date('not a date')), shape);
});

// ------------------------------------------------------------------ clamp

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
  assert.equal(clamp(2.5, 0, 10), 2.5);
  assert.equal(clamp(NaN, 3, 10), 3, 'not a number becomes min');
  assert.equal(clamp(Infinity, 0, 10), 10);
});

// ------------------------------------------------------------------ bus

test('bus: on, emit and off', () => {
  const seen = [];
  const fn = (payload) => seen.push(payload);
  Takes.bus.on('t:basic', fn);
  Takes.bus.emit('t:basic', { n: 1 });
  Takes.bus.emit('t:basic', { n: 2 });
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);

  Takes.bus.off('t:basic', fn);
  Takes.bus.emit('t:basic', { n: 3 });
  assert.equal(seen.length, 2, 'nothing arrives after off');
});

test('bus: on returns an unsubscribe function, and the same listener is not added twice', () => {
  let count = 0;
  const fn = () => { count++; };
  const unsubscribe = Takes.bus.on('t:unsub', fn);
  Takes.bus.on('t:unsub', fn);
  Takes.bus.emit('t:unsub');
  assert.equal(count, 1);
  unsubscribe();
  Takes.bus.emit('t:unsub');
  assert.equal(count, 1);
});

test('bus: events are separate, and emitting with no listeners is safe', () => {
  let a = 0;
  const fn = () => { a++; };
  Takes.bus.on('t:a', fn);
  Takes.bus.emit('t:b', {});
  Takes.bus.emit('t:nobody-listens', {});
  assert.equal(a, 0);
  Takes.bus.off('t:a', fn);
  Takes.bus.off('t:never-subscribed', fn);
});

test('bus: a throwing listener does not stop the others', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const order = [];
  const first = () => { order.push('first'); };
  const thrower = () => { order.push('thrower'); throw new Error('listener blew up'); };
  const last = () => { order.push('last'); };
  Takes.bus.on('t:throw', first);
  Takes.bus.on('t:throw', thrower);
  Takes.bus.on('t:throw', last);

  assert.doesNotThrow(() => Takes.bus.emit('t:throw', {}));
  assert.deepEqual(order, ['first', 'thrower', 'last']);
  assert.equal(logged.mock.callCount(), 1, 'the failure is logged, not swallowed silently');

  for (const fn of [first, thrower, last]) Takes.bus.off('t:throw', fn);
});

test('bus: a listener that unsubscribes itself mid-emit does not skip the next one', () => {
  const order = [];
  const once = () => { order.push('once'); Takes.bus.off('t:self', once); };
  const other = () => { order.push('other'); };
  Takes.bus.on('t:self', once);
  Takes.bus.on('t:self', other);
  Takes.bus.emit('t:self');
  Takes.bus.emit('t:self');
  assert.deepEqual(order, ['once', 'other', 'other']);
  Takes.bus.off('t:self', other);
});

// ------------------------------------------------------------------ detectCaps

const CAP_KEYS = ['displayMedia', 'userMedia', 'mp4', 'dirPicker', 'indexedDB', 'webgpu', 'webcodecs', 'docPip'];

test('detectCaps: under Node every capability is false, every key is present, and caps:ready fires', () => {
  let payload = null;
  const fn = (p) => { payload = p; };
  Takes.bus.on('caps:ready', fn);
  const caps = Takes.detectCaps({});
  Takes.bus.off('caps:ready', fn);

  assert.deepEqual(Object.keys(caps).sort(), [...CAP_KEYS].sort());
  for (const key of CAP_KEYS) assert.equal(caps[key], false, key);
  assert.equal(caps, Takes.state.caps, 'it fills Takes.state.caps itself');
  assert.equal(payload, Takes.state.caps, 'caps:ready carries the same object');
});

test('detectCaps: with no argument it reads the real global and does not throw under Node', () => {
  const caps = Takes.detectCaps();
  assert.deepEqual(Object.keys(caps).sort(), [...CAP_KEYS].sort());
  for (const key of CAP_KEYS) assert.equal(typeof caps[key], 'boolean', key);
});

test('detectCaps: a full Chrome-like environment reports everything true', () => {
  const env = {
    navigator: { mediaDevices: { getDisplayMedia() {}, getUserMedia() {} }, gpu: {} },
    MediaRecorder: { isTypeSupported: (type) => type === MP4_PLAIN },
    showDirectoryPicker() {},
    indexedDB: { open() {} },
    VideoEncoder: function VideoEncoder() {},
    documentPictureInPicture: { requestWindow() {} }
  };
  const caps = Takes.detectCaps(env);
  for (const key of CAP_KEYS) assert.equal(caps[key], true, key);
});

test('detectCaps: a browser with a recorder but no MP4 reports mp4 false, and a probe that throws is false', () => {
  const env = {
    navigator: { get mediaDevices() { throw new Error('blocked'); } },
    MediaRecorder: { isTypeSupported: () => false },
    get indexedDB() { throw new Error('blocked'); }
  };
  const caps = Takes.detectCaps(env);
  assert.equal(caps.mp4, false);
  assert.equal(caps.displayMedia, false);
  assert.equal(caps.userMedia, false);
  assert.equal(caps.indexedDB, false);
  Takes.detectCaps({});
});
