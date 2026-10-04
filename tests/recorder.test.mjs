// Tests for src/js/recorder.js: the state grid (every cell), and the lifecycle driven by a fake MediaRecorder.
// Run from the repository root: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const recorder = require('../src/js/recorder.js');
const { nextState } = recorder;

const STATES = ['idle', 'countdown', 'recording', 'paused', 'processing'];
const USER_ACTIONS = ['start', 'pause', 'resume', 'stop'];
const INTERNAL_ACTIONS = ['countdown-done', 'done'];

// ------------------------------------------------------------------ module shape

test('recorder loads under Node and attaches itself to Takes', () => {
  assert.equal(Takes.recorder, recorder);
  for (const fn of ['start', 'pause', 'resume', 'stop', 'nextState', 'elapsed', 'getState']) {
    assert.equal(typeof recorder[fn], 'function', fn);
  }
  assert.equal(recorder.getState(), 'idle');
  assert.equal(recorder.elapsed(), 0);
});

// ------------------------------------------------------------------ the grid: 20 cells, one assertion each

test('grid row idle', () => {
  assert.equal(nextState('idle', 'start'), 'countdown');
  assert.equal(nextState('idle', 'pause'), 'idle');
  assert.equal(nextState('idle', 'resume'), 'idle');
  assert.equal(nextState('idle', 'stop'), 'idle');
});

test('grid row countdown', () => {
  assert.equal(nextState('countdown', 'start'), 'countdown');
  assert.equal(nextState('countdown', 'pause'), 'countdown');
  assert.equal(nextState('countdown', 'resume'), 'countdown');
  assert.equal(nextState('countdown', 'stop'), 'idle', 'stop cancels the countdown');
});

test('grid row recording', () => {
  assert.equal(nextState('recording', 'start'), 'recording');
  assert.equal(nextState('recording', 'pause'), 'paused');
  assert.equal(nextState('recording', 'resume'), 'recording');
  assert.equal(nextState('recording', 'stop'), 'processing');
});

test('grid row paused', () => {
  assert.equal(nextState('paused', 'start'), 'paused');
  assert.equal(nextState('paused', 'pause'), 'paused');
  assert.equal(nextState('paused', 'resume'), 'recording');
  assert.equal(nextState('paused', 'stop'), 'processing');
});

test('grid row processing', () => {
  assert.equal(nextState('processing', 'start'), 'processing');
  assert.equal(nextState('processing', 'pause'), 'processing');
  assert.equal(nextState('processing', 'resume'), 'processing');
  assert.equal(nextState('processing', 'stop'), 'processing');
});

// ------------------------------------------------------------------ internal actions

test('countdown-done moves countdown to recording and is ignored everywhere else', () => {
  assert.equal(nextState('countdown', 'countdown-done'), 'recording');
  assert.equal(nextState('idle', 'countdown-done'), 'idle');
  assert.equal(nextState('recording', 'countdown-done'), 'recording');
  assert.equal(nextState('paused', 'countdown-done'), 'paused');
  assert.equal(nextState('processing', 'countdown-done'), 'processing');
});

test('done moves processing to idle and is ignored everywhere else', () => {
  assert.equal(nextState('processing', 'done'), 'idle');
  assert.equal(nextState('idle', 'done'), 'idle');
  assert.equal(nextState('countdown', 'done'), 'countdown');
  assert.equal(nextState('recording', 'done'), 'recording');
  assert.equal(nextState('paused', 'done'), 'paused');
});

// ------------------------------------------------------------------ unknown input

test('an unknown action returns the state unchanged', () => {
  const odd = ['', 'START', 'Stop', 'cancel', 'error', 'constructor', 'toString', '__proto__', 'hasOwnProperty',
    undefined, null, 0, 1, {}, [], ['stop']];
  for (const state of STATES) {
    for (const action of odd) assert.equal(nextState(state, action), state, state + ' × ' + String(action));
  }
});

test('an unknown state returns that state unchanged, whatever the action', () => {
  const odd = ['', 'IDLE', 'stopped', 'constructor', 'toString', '__proto__', undefined, null, 0, 7];
  for (const state of odd) {
    for (const action of [...USER_ACTIONS, ...INTERNAL_ACTIONS, 'nonsense']) {
      assert.equal(nextState(state, action), state, String(state) + ' × ' + action);
    }
  }
  const obj = { state: 'idle' };
  assert.equal(nextState(obj, 'start'), obj, 'a non-string state comes back as the same reference');
  assert.deepEqual(obj, { state: 'idle' }, 'and untouched');
});

// ------------------------------------------------------------------ purity

test('nextState never returns anything outside the five states, and never changes its answer', () => {
  for (const state of STATES) {
    for (const action of [...USER_ACTIONS, ...INTERNAL_ACTIONS, 'nonsense', undefined]) {
      const first = nextState(state, action);
      assert.ok(STATES.includes(first), state + ' × ' + String(action) + ' gave ' + String(first));
      assert.equal(nextState(state, action), first, 'the same question gets the same answer');
    }
  }
});

test('nextState does not mutate what it is given and does not move the live recorder', () => {
  const states = Object.freeze([...STATES]);
  const actions = Object.freeze([...USER_ACTIONS, ...INTERNAL_ACTIONS]);
  const before = recorder.getState();
  for (const state of states) for (const action of actions) nextState(state, action);
  assert.deepEqual([...states], STATES);
  assert.deepEqual([...actions], [...USER_ACTIONS, ...INTERNAL_ACTIONS]);
  assert.equal(recorder.getState(), before, 'asking the pure function changes no live state');
});

test('every state can get back to idle, and exactly eight transitions change the state', () => {
  let moves = 0;
  for (const state of STATES) {
    for (const action of [...USER_ACTIONS, ...INTERNAL_ACTIONS]) {
      if (nextState(state, action) !== state) moves++;
    }
  }
  assert.equal(moves, 8);
  assert.equal(nextState(nextState('recording', 'stop'), 'done'), 'idle');
  assert.equal(nextState(nextState('paused', 'stop'), 'done'), 'idle');
});

// ------------------------------------------------------------------ lifecycle with a fake MediaRecorder

const MP4_FULL = 'video/mp4;codecs=avc1,mp4a.40.2';

/** Install fake browser classes, a fake clock and a bus log. Everything is removed when the test ends. */
function setup(t, { supported = true, throwOnStart = false, reportedType = MP4_FULL, frames = false } = {}) {
  const made = [];
  // With frames on, a fake requestAnimationFrame queues callbacks until the test calls frame().
  let queued = [];
  if (frames) globalThis.requestAnimationFrame = (fn) => { queued.push(fn); return queued.length; };
  const frame = () => { const run = queued; queued = []; run.forEach((fn) => fn(0)); };

  class FakeStream {
    constructor(tracks) { this.tracks = tracks; }
    getVideoTracks() { return this.tracks.filter((tr) => tr.kind === 'video'); }
    getTracks() { return this.tracks.slice(); }
  }

  class FakeRecorder {
    static isTypeSupported() { return supported; }
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.mimeType = reportedType;
      this.calls = [];
      made.push(this);
    }
    start(timeslice) {
      if (throwOnStart) throw new Error('NotSupportedError');
      this.calls.push(['start', timeslice]);
      this.state = 'recording';
    }
    pause() { this.calls.push(['pause']); this.state = 'paused'; }
    resume() { this.calls.push(['resume']); this.state = 'recording'; }
    stop() { this.calls.push(['stop']); this.state = 'inactive'; }
    // Test helpers: what the browser would do by itself.
    data(text) { if (this.ondataavailable) this.ondataavailable({ data: new Blob([text]) }); }
    stopped() { this.state = 'inactive'; if (this.onstop) this.onstop({}); }
    broke() { if (this.onerror) this.onerror({ error: new Error('boom') }); }
  }

  globalThis.MediaRecorder = FakeRecorder;
  globalThis.MediaStream = FakeStream;

  const clock = { ms: 1000 };
  t.mock.method(globalThis.performance, 'now', () => clock.ms);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const events = [];
  const offs = ['record:state', 'record:done', 'toast'].map((name) =>
    Takes.bus.on(name, (payload) => events.push([name, payload])));

  t.after(() => {
    offs.forEach((off) => off());
    delete globalThis.MediaRecorder;
    delete globalThis.MediaStream;
    delete globalThis.requestAnimationFrame;
  });

  // Step in small slices so a timer set by a timer (the countdown chain) fires on time.
  const advance = (ms) => {
    for (let left = ms; left > 0; left -= 250) {
      const step = Math.min(250, left);
      clock.ms += step;
      t.mock.timers.tick(step);
    }
  };
  // The whole lead-in: the 3 second countdown, then the short wait for the screen to repaint.
  const countIn = () => { advance(3000); advance(300); };
  const video = new FakeStream([{ kind: 'video', id: 'v1' }]);
  const audio = { kind: 'audio', id: 'a1' };
  const states = () => events.filter((e) => e[0] === 'record:state').map((e) => e[1]);
  const toasts = () => events.filter((e) => e[0] === 'toast').map((e) => e[1]);
  return { made, clock, advance, countIn, frame, events, states, toasts, video, audio };
}

test('start: counts down 3, 2, 1, signals 0, waits for the repaint, then records in one second chunks', (t) => {
  const h = setup(t);
  assert.equal(recorder.start(h.video, h.audio), undefined, 'start returns nothing');
  assert.equal(recorder.getState(), 'countdown');
  assert.deepEqual(h.states(), [{ state: 'countdown', secondsLeft: 3 }]);
  assert.equal(h.made.length, 0, 'no MediaRecorder exists during the countdown');
  assert.equal(recorder.elapsed(), 0);

  h.advance(1000);
  h.advance(1000);
  assert.deepEqual(h.states(), [
    { state: 'countdown', secondsLeft: 3 },
    { state: 'countdown', secondsLeft: 2 },
    { state: 'countdown', secondsLeft: 1 }
  ]);

  recorder.start(h.video, h.audio);
  recorder.pause();
  recorder.resume();
  assert.equal(h.states().length, 3, 'start, pause and resume are ignored during the countdown');

  h.advance(1000);
  assert.equal(recorder.getState(), 'countdown', 'the wait for the repaint is still the countdown state');
  assert.deepEqual(h.states()[3], { state: 'countdown', secondsLeft: 0 }, 'secondsLeft 0 tells the UI to take the overlay away');
  assert.equal(h.states().length, 4);
  assert.equal(h.made.length, 0, 'no MediaRecorder exists until the screen has repainted');
  h.advance(250);
  assert.equal(h.made.length, 0);
  assert.equal(recorder.elapsed(), 0);

  h.advance(50);
  assert.equal(recorder.getState(), 'recording');
  assert.deepEqual(h.states()[4], { state: 'recording' }, 'the recording payload is exactly { state }');
  assert.equal(h.states().length, 5);
  assert.equal(recorder.elapsed(), 0, 'the duration clock starts when the MediaRecorder starts, not before');
  h.advance(500);
  assert.equal(recorder.elapsed(), 0.5);

  const mr = h.made[0];
  assert.deepEqual(mr.calls, [['start', 1000]]);
  assert.equal(mr.options.mimeType, MP4_FULL);
  assert.equal(mr.options.videoBitsPerSecond, 5000000);
  assert.equal(mr.options.audioBitsPerSecond, 128000);
  assert.deepEqual(mr.stream.tracks.map((tr) => tr.id), ['v1', 'a1'], 'one stream: the video track plus the audio track');

  mr.data('x');
  mr.stopped();
  assert.equal(recorder.getState(), 'idle');
});

test('start with a null audio track records video only', (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  assert.deepEqual(mr.stream.tracks.map((tr) => tr.id), ['v1']);
  assert.equal('audioBitsPerSecond' in mr.options, false);
  mr.data('x');
  mr.stopped();
  assert.equal(recorder.getState(), 'idle');
});

test('stop during the countdown cancels: idle, null, no recording, no toast', async (t) => {
  const h = setup(t);
  recorder.start(h.video, h.audio);
  h.advance(1000);
  const result = await recorder.stop();
  assert.equal(result, null);
  assert.equal(recorder.getState(), 'idle');
  h.advance(5000);
  assert.equal(h.made.length, 0, 'the cancelled countdown never creates a MediaRecorder');
  assert.deepEqual(h.states(), [
    { state: 'countdown', secondsLeft: 3 },
    { state: 'countdown', secondsLeft: 2 },
    { state: 'idle' }
  ]);
  assert.deepEqual(h.toasts(), []);
});

test('stop during the wait for the repaint cancels: idle, null, no MediaRecorder, no record:done', async (t) => {
  const h = setup(t);
  recorder.start(h.video, h.audio);
  h.advance(3000);
  assert.deepEqual(h.states().at(-1), { state: 'countdown', secondsLeft: 0 });
  h.advance(100);
  assert.equal(recorder.getState(), 'countdown');

  assert.equal(await recorder.stop(), null);
  assert.equal(recorder.getState(), 'idle');
  h.advance(5000);
  assert.equal(recorder.getState(), 'idle', 'the cancelled wait never starts a recording later');
  assert.equal(h.made.length, 0);
  assert.equal(h.events.some((e) => e[0] === 'record:done'), false);
  assert.deepEqual(h.states().map((s) => [s.state, s.secondsLeft]),
    [['countdown', 3], ['countdown', 2], ['countdown', 1], ['countdown', 0], ['idle', undefined]]);
  assert.deepEqual(h.toasts(), []);

  recorder.start(h.video, null);
  h.countIn();
  assert.equal(recorder.getState(), 'recording', 'a fresh start after the cancel works');
  h.made[0].data('x');
  h.made[0].stopped();
});

test('with animation frames: two frames, then 250 ms, then the recorder starts', (t) => {
  const h = setup(t, { frames: true });
  recorder.start(h.video, null);
  h.advance(3000);
  assert.deepEqual(h.states().at(-1), { state: 'countdown', secondsLeft: 0 });

  h.advance(100);
  assert.equal(h.made.length, 0, 'time alone is not enough before the frames have run');
  h.frame();
  h.advance(250);
  assert.equal(h.made.length, 0, 'one frame is not enough');
  h.frame();
  h.advance(200);
  assert.equal(h.made.length, 0, 'the 250 ms pause starts after the second frame');
  h.advance(50);
  assert.equal(recorder.getState(), 'recording');
  assert.equal(h.made.length, 1);

  h.advance(2000);
  h.frame();
  assert.equal(h.made.length, 1, 'the cap timer does not start a second recorder');
  assert.equal(recorder.elapsed(), 2);
  h.made[0].data('x');
  h.made[0].stopped();
});

test('a hidden tab, where animation frames never run: the 600 ms cap starts the recorder', (t) => {
  const h = setup(t, { frames: true });
  recorder.start(h.video, null);
  h.advance(3000);
  h.advance(500);
  assert.equal(recorder.getState(), 'countdown');
  assert.equal(h.made.length, 0);
  h.advance(100);
  assert.equal(recorder.getState(), 'recording');
  assert.equal(h.made.length, 1);
  h.frame();
  h.advance(1000);
  assert.equal(h.made.length, 1);
  h.made[0].data('x');
  h.made[0].stopped();
});

test('stop between the two animation frames cancels, and late frames do nothing', async (t) => {
  const h = setup(t, { frames: true });
  recorder.start(h.video, null);
  h.advance(3000);
  h.frame();
  assert.equal(await recorder.stop(), null);
  h.frame();
  h.advance(2000);
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.made.length, 0);
});

test('stop is ignored when idle and resolves to null', async (t) => {
  const h = setup(t);
  assert.equal(await recorder.stop(), null);
  recorder.pause();
  recorder.resume();
  assert.deepEqual(h.events, []);
  assert.equal(recorder.getState(), 'idle');
});

test('pause, resume and stop: duration comes from timestamps minus paused time', async (t) => {
  const h = setup(t);
  recorder.start(h.video, h.audio);
  h.countIn();
  const mr = h.made[0];

  h.advance(2500);
  assert.equal(recorder.elapsed(), 2.5);
  mr.data('aa');

  recorder.pause();
  assert.equal(recorder.getState(), 'paused');
  recorder.pause();
  h.advance(10000);
  assert.equal(recorder.elapsed(), 2.5, 'the clock stands still while paused');

  recorder.resume();
  assert.equal(recorder.getState(), 'recording');
  recorder.resume();
  h.advance(1500);
  assert.equal(recorder.elapsed(), 4);
  mr.data('bbb');
  assert.deepEqual(mr.calls, [['start', 1000], ['pause'], ['resume']], 'a repeated pause or resume is ignored');

  let settled = false;
  const promise = recorder.stop().then((v) => { settled = true; return v; });
  assert.equal(recorder.getState(), 'processing');
  assert.deepEqual(mr.calls[3], ['stop']);

  assert.equal(await recorder.stop(), null, 'a second stop while processing is ignored');
  recorder.start(h.video, h.audio);
  recorder.pause();
  recorder.resume();
  assert.equal(recorder.getState(), 'processing');
  assert.equal(settled, false, 'stop waits for the final data and the stop event');

  h.advance(700);
  mr.data('c');
  mr.stopped();
  const result = await promise;

  assert.equal(recorder.getState(), 'idle');
  assert.equal(recorder.elapsed(), 0);
  assert.equal(result.durationMs, 4000, 'time spent processing is not counted');
  assert.equal(Number.isInteger(result.durationMs), true);
  assert.deepEqual(Object.keys(result).sort(), ['blob', 'createdAt', 'durationMs', 'id', 'mimeType']);
  assert.equal(typeof result.id, 'string');
  assert.ok(result.id.length > 0);
  assert.equal(typeof result.createdAt, 'number');
  assert.equal(result.mimeType, MP4_FULL);
  assert.ok(result.blob instanceof Blob);
  assert.equal(result.blob.type, MP4_FULL);
  assert.equal(await result.blob.text(), 'aabbbc', 'every chunk, in order');

  const tail = h.events.slice(-3);
  assert.deepEqual(tail.map((e) => e[0]), ['record:state', 'record:done', 'record:state']);
  assert.deepEqual(tail[0][1], { state: 'processing' });
  assert.equal(tail[1][1], result, 'stop resolves with the record:done payload itself');
  assert.deepEqual(tail[2][1], { state: 'idle' });
  assert.deepEqual(h.states().map((s) => s.state),
    ['countdown', 'countdown', 'countdown', 'countdown', 'recording', 'paused', 'recording', 'processing', 'idle']);
  assert.deepEqual(h.toasts(), []);
});

test('stop while paused: the pause is not counted', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(1234);
  mr.data('x');
  recorder.pause();
  h.advance(60000);
  const promise = recorder.stop();
  mr.stopped();
  const result = await promise;
  assert.equal(result.durationMs, 1234);
});

test('two recordings in a row get different ids and a fresh clock', async (t) => {
  const h = setup(t);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    recorder.start(h.video, null);
    h.countIn();
    const mr = h.made[i];
    h.advance(2000);
    mr.data('x');
    const promise = recorder.stop();
    mr.stopped();
    const result = await promise;
    assert.equal(result.durationMs, 2000);
    ids.push(result.id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('a recorder that stops by itself (every track ended) still delivers the take', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(2000);
  mr.data('x');
  mr.stopped();
  assert.equal(recorder.getState(), 'idle');
  const names = h.events.slice(-3).map((e) => e[0] + (e[1].state ? ':' + e[1].state : ''));
  assert.deepEqual(names, ['record:state:processing', 'record:done', 'record:state:idle']);
  assert.equal(h.events.at(-2)[1].durationMs, 2000);
  assert.equal(await recorder.stop(), null, 'the stop that ui.js sends afterwards is ignored');
});

test('no data arrived: an error toast, null, and back to idle', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  const promise = recorder.stop();
  mr.stopped();
  assert.equal(await promise, null);
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.events.some((e) => e[0] === 'record:done'), false);
  const toasts = h.toasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'error');
  assert.match(toasts[0].text, /empty/);
  assert.deepEqual(h.states().slice(-2), [{ state: 'processing' }, { state: 'idle' }]);
});

test('a MediaRecorder error with data already received keeps the take: record:done with the partial file', async (t) => {
  const h = setup(t);
  recorder.start(h.video, h.audio);
  h.countIn();
  const mr = h.made[0];
  h.advance(2000);
  mr.data('aa');
  mr.data('bb');
  mr.broke();
  assert.equal(recorder.getState(), 'processing', 'the clock is stopped and the last chunk is awaited');
  assert.deepEqual(mr.calls.at(-1), ['stop'], 'the broken recorder is asked to stop');
  assert.equal(h.events.some((e) => e[0] === 'record:done'), false, 'nothing is assembled before the stop event');

  h.advance(400);
  mr.data('c');
  mr.stopped();
  assert.equal(recorder.getState(), 'idle');
  assert.equal(recorder.elapsed(), 0);

  const done = h.events.filter((e) => e[0] === 'record:done').map((e) => e[1]);
  assert.equal(done.length, 1);
  assert.equal(await done[0].blob.text(), 'aabbc', 'every chunk received, the last one included');
  assert.equal(done[0].durationMs, 2000, 'the duration stops at the error');
  assert.equal(done[0].mimeType, MP4_FULL);
  assert.equal(typeof done[0].id, 'string');

  assert.equal(h.toasts().length, 1);
  assert.equal(h.toasts()[0].kind, 'error');
  assert.match(h.toasts()[0].text, /ended early/);
  assert.match(h.toasts()[0].text, /kept/);
  assert.deepEqual(h.states().slice(-2), [{ state: 'processing' }, { state: 'idle' }]);

  const count = h.events.length;
  mr.broke();
  mr.data('late');
  mr.stopped();
  h.advance(2000);
  assert.equal(h.events.length, count, 'the finished recorder can no longer emit anything');
  assert.equal(await recorder.stop(), null);
});

test('a MediaRecorder error with data, and the stop event never comes: the take is still kept after a second', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(1000);
  mr.data('x');
  mr.broke();
  assert.equal(recorder.getState(), 'processing');
  h.advance(1000);
  assert.equal(recorder.getState(), 'idle');
  const done = h.events.filter((e) => e[0] === 'record:done').map((e) => e[1]);
  assert.equal(done.length, 1);
  assert.equal(await done[0].blob.text(), 'x');
  assert.equal(done[0].durationMs, 1000);
  assert.match(h.toasts()[0].text, /ended early/);
});

test('a MediaRecorder error with NO data received: an error toast, idle, and no record:done', async (t) => {
  const h = setup(t);
  recorder.start(h.video, h.audio);
  h.countIn();
  const mr = h.made[0];
  mr.broke();
  mr.stopped();
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.events.some((e) => e[0] === 'record:done'), false);
  assert.equal(h.toasts().length, 1);
  assert.equal(h.toasts()[0].kind, 'error');
  assert.match(h.toasts()[0].text, /could not be saved/);
  assert.deepEqual(h.states().slice(-2), [{ state: 'processing' }, { state: 'idle' }]);
  assert.equal(await recorder.stop(), null);
});

test('a MediaRecorder error while stop() is waiting: that stop resolves with the kept take, or null when there is no data', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  let mr = h.made[0];
  mr.data('x');
  let promise = recorder.stop();
  mr.broke();
  mr.stopped();
  const kept = await promise;
  assert.equal(await kept.blob.text(), 'x');
  assert.equal(h.events.filter((e) => e[0] === 'record:done')[0][1], kept);
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.toasts().length, 1);

  recorder.start(h.video, null);
  h.countIn();
  mr = h.made[1];
  promise = recorder.stop();
  mr.broke();
  mr.stopped();
  assert.equal(await promise, null);
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.toasts().length, 2);
});

test('pause throwing is treated as a recorder error and keeps what was recorded', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(1500);
  mr.data('x');
  mr.pause = () => { throw new Error('InvalidStateError'); };
  recorder.pause();
  mr.stopped();
  assert.equal(recorder.getState(), 'idle');
  const done = h.events.filter((e) => e[0] === 'record:done').map((e) => e[1]);
  assert.equal(done.length, 1);
  assert.equal(done[0].durationMs, 1500);
  assert.match(h.toasts()[0].text, /ended early/);
});

test('stop() on a recorder the browser already stopped waits for the last chunk and the stop event', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(1800);
  mr.data('first');

  // The share ended: the browser made the recorder inactive, its last chunk and stop event are still queued.
  mr.state = 'inactive';
  let settled = false;
  const promise = recorder.stop().then((v) => { settled = true; return v; });
  await Promise.resolve();
  assert.equal(recorder.getState(), 'processing');
  assert.equal(settled, false, 'nothing is assembled while the final data is still expected');
  assert.equal(mr.calls.some((c) => c[0] === 'stop'), false, 'an inactive recorder is not stopped again');
  assert.equal(h.events.some((e) => e[0] === 'record:done'), false);

  mr.data('-last');
  mr.stopped();
  const result = await promise;
  assert.equal(await result.blob.text(), 'first-last', 'the blob includes the last chunk');
  assert.equal(result.durationMs, 1800);
  assert.equal(recorder.getState(), 'idle');
  assert.deepEqual(h.toasts(), []);
});

test('a short take with no chunk yet, stopped by the browser first, is not reported empty', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(400);
  mr.state = 'inactive';
  const promise = recorder.stop();
  mr.data('only');
  mr.stopped();
  const result = await promise;
  assert.equal(await result.blob.text(), 'only');
  assert.equal(result.durationMs, 400);
  assert.deepEqual(h.toasts(), []);
});

test('an inactive recorder whose stop event never comes finishes after about a second', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(1000);
  mr.data('x');
  mr.state = 'inactive';
  const promise = recorder.stop();
  h.advance(750);
  assert.equal(recorder.getState(), 'processing');
  h.advance(250);
  const result = await promise;
  assert.equal(await result.blob.text(), 'x');
  assert.equal(recorder.getState(), 'idle');
});

test('no MP4 support: the toast says to update Chrome or Edge, and the state returns to idle', (t) => {
  const h = setup(t, { supported: false });
  recorder.start(h.video, h.audio);
  h.countIn();
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.made.length, 0);
  assert.equal(h.toasts().length, 1);
  assert.equal(h.toasts()[0].kind, 'error');
  assert.match(h.toasts()[0].text, /Please update Chrome or Edge/);
  assert.deepEqual(h.states().at(-1), { state: 'idle' });
});

test('MediaRecorder.start throwing, or a stream with no video: a toast and idle', (t) => {
  const h = setup(t, { throwOnStart: true });
  recorder.start(h.video, null);
  h.countIn();
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.toasts().length, 1);

  recorder.start(null, h.audio);
  h.countIn();
  assert.equal(recorder.getState(), 'idle');
  assert.equal(h.toasts().length, 2);
  assert.match(h.toasts()[1].text, /no picture/);
  for (const toast of h.toasts()) assert.equal(toast.kind, 'error');
});

test('the stop event never arrives: the watchdog finishes with what was recorded', async (t) => {
  const h = setup(t);
  recorder.start(h.video, null);
  h.countIn();
  const mr = h.made[0];
  h.advance(1000);
  mr.data('x');
  const promise = recorder.stop();
  h.advance(15000);
  const result = await promise;
  assert.equal(result.durationMs, 1000);
  assert.equal(recorder.getState(), 'idle');
});

test('without MediaRecorder at all (plain Node) start ends in idle with a plain-words toast', (t) => {
  const seen = [];
  const off = Takes.bus.on('toast', (p) => seen.push(p));
  t.after(off);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  recorder.start({ getVideoTracks: () => [{ kind: 'video' }] }, null);
  for (let i = 0; i < 3; i++) t.mock.timers.tick(1000);
  t.mock.timers.tick(300);
  assert.equal(recorder.getState(), 'idle');
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /Please update Chrome or Edge/);
});
