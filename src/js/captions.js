/* takes:captions */
/*
 * captions.js: closed captions made on the person's own computer.
 *   generate(recording)  - decodes the sound, loads a small English speech model, returns cues.
 *   toVtt / formatVttTime / splitLongCues / shiftCuesForEdits / chunksToCues - pure helpers, all in SECONDS.
 *   attach(video, cues)  - shows the cues on a video through a text track.
 *   downloadVtt(recording, forExport) - saves the cues as a .vtt file.
 * Cues are always kept in SOURCE time (the time of the original blob). They are shifted
 * only for a .vtt written beside a trimmed file.
 *
 * Measured in Chrome 154, and relied on by this file:
 *   - the fast setting (encoder on WebGPU, decoder on wasm) and the fallback (all wasm) both work;
 *   - both freeze the page for a second or two at a time while a stretch of sound is processed;
 *   - the ONNX proxy worker fails when the page is a file on the computer, so it is never used;
 *   - the model was downloaded again on every page open, so the loaded model is kept in memory
 *     for the visit and no message here promises a single download.
 *
 * Notes for ui.js:
 *   - DOWNLOAD_SIZE_TEXT ('about 50 to 70 MB') is the default string for #tk-captions-size.
 *     downloadSizeText() resolves to the exact one for this computer ('about 70 MB' or 'about 50 MB').
 *     DOWNLOAD_MB holds the two measured totals.
 *   - generate() emits captions:progress { id, phase, pct } with pct null while it transcribes
 *     (the model gives no progress and the page is frozen in bursts anyway): show the sweeping bar.
 *   - generate() has already toasted when it rejects (err.toasted is true, err.code is 'captions-failed').
 *   - a recording with no speech resolves with zero cues and an info toast; it is not an error.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
  var MODEL = 'onnx-community/whisper-tiny.en_timestamped';

  // Measured over the network, in megabytes, for the two settings: model files plus the library and its runtime.
  var DOWNLOAD_MB = { fast: 70, fallback: 48 };
  // The model files alone, which is what the library's own progress reports.
  var MODEL_MB = { fast: 63, fallback: 41.5 };
  // The range shown until downloadSizeText() has found out which setting this computer will use.
  var DOWNLOAD_SIZE_TEXT = 'about 50 to 70 MB';
  var SIZE_TEXT = { fast: 'about 70 MB', fallback: 'about 50 MB' };

  var CONFIGS = {
    fast: {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
      device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }
    },
    fallback: { dtype: 'q8', device: 'wasm' }
  };

  var MAX_CUE_CHARS = 84;
  var MIN_CUE_SEC = 0.05;
  // A last line shorter than this, in characters or in seconds, is an orphan and is joined to the line before it.
  var ORPHAN_CHARS = 12;
  var ORPHAN_SEC = 0.6;
  // How far apart two chunks of speech may be and still be joined.
  var JOIN_GAP_SEC = 0.5;
  // The transcript starts a new paragraph after a pause this long, or once one has grown this long.
  var PARAGRAPH_GAP_SEC = 2;
  var PARAGRAPH_CHARS = 500;
  var SAMPLE_RATE = 16000;
  // A decoded peak below this is silence (the threshold measured on real recordings).
  var SILENCE_PEAK = 0.001;
  var IMPORT_TIMEOUT_MS = 120000;
  var ADAPTER_TIMEOUT_MS = 8000;
  // A model download that reports nothing for this long is treated as a lost connection.
  var STALL_TIMEOUT_MS = 120000;
  var REVOKE_DELAY_MS = 60000;
  // How much of each end of the file is searched for the marker of a sound track.
  var SCAN_BYTES = 4 * 1024 * 1024;

  var EMPTY_VTT = 'WEBVTT\n';
  var ARROW = '--' + '>';

  var TEXT_NO_SPEECH = 'No speech found in this recording';
  var TEXT_OFFLINE = 'Captions need an internet connection to download their tools. Check your connection, then click Add captions again.';
  var TEXT_NO_BLOB = 'This recording has no video to caption. Try recording it again.';
  var TEXT_NO_DECODER = 'This browser cannot read the sound in a recording, so captions cannot be made here. Open the page in Chrome or Edge.';
  var TEXT_DECODE = 'The sound in this recording could not be read, so captions could not be made. The recording itself is fine and can still be saved.';
  var TEXT_MODEL = 'Captions could not be made for this recording. Click Add captions to try again; the recording itself is fine and can still be saved.';

  // ---------------------------------------------------------------- pure helpers

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  /** Seconds -> 'HH:MM:SS.mmm', hours always shown. Negative or not finite is '00:00:00.000'. */
  function formatVttTime(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s < 0) s = 0;
    // Round ONCE to whole milliseconds, then split, so 59.9995 becomes 00:01:00.000 and never 59.1000.
    var totalMs = Math.round(s * 1000);
    var ms = totalMs % 1000;
    var totalSec = (totalMs - ms) / 1000;
    var sec = totalSec % 60;
    var totalMin = (totalSec - sec) / 60;
    var min = totalMin % 60;
    var hours = (totalMin - min) / 60;
    return pad(hours, 2) + ':' + pad(min, 2) + ':' + pad(sec, 2) + '.' + pad(ms, 3);
  }

  /** One line of safe cue text: line breaks collapsed, and the timing arrow can never appear. */
  function cleanCueText(text) {
    var out = String(text == null ? '' : text);
    out = out.replace(/\s+/g, ' ').replace(/^ | $/g, '');
    while (out.indexOf(ARROW) !== -1) out = out.split(ARROW).join('->');
    return out;
  }

  /**
   * Cues -> WebVTT text: 'WEBVTT', a blank line, then per cue a timing line, the text and a blank line.
   * Cues carry no numbers. A cue with no text, or one that does not end after it starts, is left out.
   * An empty list gives 'WEBVTT' and one line break.
   */
  function toVtt(cues) {
    var out = EMPTY_VTT;
    var list = cues && cues.length ? cues : [];
    for (var i = 0; i < list.length; i++) {
      var cue = list[i] || {};
      var start = num(cue.start);
      var end = num(cue.end);
      var text = cleanCueText(cue.text);
      if (!text || start === null || end === null || !(end > start)) continue;
      if (start < 0) start = 0;
      out += '\n' + formatVttTime(start) + ' ' + ARROW + ' ' + formatVttTime(end) + '\n' + text + '\n';
    }
    return out;
  }

  // ---- transcript tools

  /** Seconds -> 'HH:MM:SS,mmm' for SubRip: the same care as formatVttTime, with a comma before the milliseconds. */
  function formatSrtTime(seconds) {
    return formatVttTime(seconds).replace('.', ',');
  }

  /** Seconds -> 'm:ss', or 'h:mm:ss' from one hour on. Floored. */
  function formatStamp(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s < 0) s = 0;
    var whole = Math.floor(s);
    var sec = whole % 60;
    var min = Math.floor(whole / 60) % 60;
    var hours = Math.floor(whole / 3600);
    if (hours > 0) return hours + ':' + pad(min, 2) + ':' + pad(sec, 2);
    return min + ':' + pad(sec, 2);
  }

  function flatText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  /**
   * Cues -> a transcript to read. A new string; the cues are never changed. An empty list gives ''.
   * options.timestamps false (the default): flowing paragraphs, a new one after a pause of more than
   * 2 seconds, or at the end of a sentence once a paragraph has passed about 500 characters.
   * options.timestamps true: one line per cue, '[m:ss] text' ('[h:mm:ss] text' from one hour on).
   */
  function toText(cues, options) {
    var stamps = !!(options && options.timestamps);
    var list = cues && cues.length ? cues : [];
    var lines = [];
    var para = '';
    var prevEnd = null;
    for (var i = 0; i < list.length; i++) {
      var cue = list[i] || {};
      var text = flatText(cue.text);
      if (!text) continue;
      if (stamps) { lines.push('[' + formatStamp(cue.start) + '] ' + text); continue; }
      var start = num(cue.start);
      var paused = prevEnd !== null && start !== null && start - prevEnd > PARAGRAPH_GAP_SEC;
      var full = para.length >= PARAGRAPH_CHARS && /[.!?]["')\]]*$/.test(para);
      if (para && (paused || full)) { lines.push(para); para = ''; }
      para = para ? para + ' ' + text : text;
      var end = num(cue.end);
      if (end !== null) prevEnd = end;
    }
    if (stamps) return lines.join('\n');
    if (para) lines.push(para);
    return lines.join('\n\n');
  }

  /**
   * Cues -> a SubRip (.srt) file: blocks numbered from 1, a timing line with comma milliseconds,
   * the text, a blank line between blocks. An empty list gives ''. Cues with no text or no length are left out.
   */
  function toSrt(cues) {
    var blocks = [];
    var list = cues && cues.length ? cues : [];
    for (var i = 0; i < list.length; i++) {
      var cue = list[i] || {};
      var start = num(cue.start);
      var end = num(cue.end);
      var text = cleanCueText(cue.text);
      if (!text || start === null || end === null || !(end > start)) continue;
      if (start < 0) start = 0;
      blocks.push((blocks.length + 1) + '\n' + formatSrtTime(start) + ' ' + ARROW + ' ' + formatSrtTime(end) + '\n' + text + '\n');
    }
    return blocks.join('\n');
  }

  /** The indexes of the cues whose text contains the query. Case is ignored, and so is space around the query. */
  function searchCues(cues, query) {
    var q = flatText(query).toLowerCase();
    var found = [];
    if (!q) return found;
    var list = cues && cues.length ? cues : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && flatText(list[i].text).toLowerCase().indexOf(q) !== -1) found.push(i);
    }
    return found;
  }

  /**
   * Break text into lines of about width characters, at spaces, none longer than maxChars.
   * A word longer than maxChars is cut hard; a word between the two takes a line of its own.
   */
  function wrapText(text, width, maxChars) {
    var words = text.split(' ');
    var pieces = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (!word) continue;
      while (word.length > maxChars) {
        if (line) { pieces.push(line); line = ''; }
        var cutAt = maxChars;
        // Never leave half of a two-part character (an emoji) at the cut.
        var code = word.charCodeAt(cutAt - 1);
        if (cutAt > 1 && code >= 0xd800 && code <= 0xdbff) cutAt--;
        pieces.push(word.slice(0, cutAt));
        word = word.slice(cutAt);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { pieces.push(line); line = word; }
    }
    if (line) pieces.push(line);
    return pieces;
  }

  /**
   * The lines for one long cue: as few as fit, evened out so the last one is not a stray word,
   * and with a last line that is still an orphan (very short, or on screen for under 0.6 seconds)
   * joined to the one before when that stays within the limit plus a small allowance.
   */
  function balancedLines(text, maxChars, spanSec) {
    var pieces = wrapText(text, maxChars, maxChars);
    if (pieces.length < 2) return pieces;
    var count = pieces.length;
    for (var width = Math.ceil(text.length / count); width < maxChars; width++) {
      var tried = wrapText(text, width, maxChars);
      if (tried.length <= count) { pieces = tried; break; }
    }
    var allowance = Math.min(ORPHAN_CHARS, Math.floor(maxChars / 7));
    while (pieces.length > 1) {
      var last = pieces[pieces.length - 1];
      var prev = pieces[pieces.length - 2];
      var total = 0;
      for (var i = 0; i < pieces.length; i++) total += pieces[i].length;
      var lastSec = spanSec > 0 ? spanSec * (last.length / total) : Infinity;
      var orphan = last.length < allowance || lastSec < ORPHAN_SEC;
      // Only whole words are joined; the tail of a word that was cut hard stays where it is.
      var wholeWord = text.charAt(text.length - last.length - 1) === ' ';
      if (!orphan || !wholeWord || prev.length + 1 + last.length > maxChars + allowance) break;
      pieces.splice(pieces.length - 2, 2, prev + ' ' + last);
    }
    return pieces;
  }

  /**
   * A NEW array in which no cue's text is longer than maxChars (84 when not given), bar a small
   * allowance (at most 12 characters) used only to keep a stray last word with its line.
   * A long cue becomes consecutive cues, split at spaces into lines of similar length, sharing its time
   * by their share of the characters.
   * A cue with no text is dropped. The input is never changed.
   */
  function splitLongCues(cues, maxChars) {
    var max = Math.floor(Number(maxChars));
    if (!isFinite(max) || max < 1) max = MAX_CUE_CHARS;
    var out = [];
    var list = cues && cues.length ? cues : [];
    for (var i = 0; i < list.length; i++) {
      var cue = list[i];
      if (!cue) continue;
      var raw = String(cue.text == null ? '' : cue.text);
      var flat = raw.replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (!flat) continue;
      if (raw.length <= max) { out.push({ start: cue.start, end: cue.end, text: raw }); continue; }
      var start = Number(cue.start);
      var end = Number(cue.end);
      var timed = isFinite(start) && isFinite(end) && end > start;
      var pieces = balancedLines(flat, max, timed ? end - start : 0);
      // Time cannot be shared out of a cue that has none, so that cue is kept whole.
      if (pieces.length < 2 || !isFinite(start) || !isFinite(end) || !(end > start)) {
        out.push({ start: cue.start, end: cue.end, text: pieces.length === 1 ? pieces[0] : raw });
        continue;
      }
      var total = 0;
      for (var p = 0; p < pieces.length; p++) total += pieces[p].length;
      var span = end - start;
      var done = 0;
      var from = start;
      var made = [];
      for (var q = 0; q < pieces.length; q++) {
        done += pieces[q].length;
        var to = q === pieces.length - 1 ? end : start + span * (done / total);
        made.push({ start: from, end: to, text: pieces[q] });
        from = to;
      }
      var sound = true;
      for (var r = 0; r < made.length; r++) if (!(made[r].end > made[r].start)) sound = false;
      if (sound) for (var s = 0; s < made.length; s++) out.push(made[s]);
      else out.push({ start: cue.start, end: cue.end, text: raw });
    }
    return out;
  }

  function copyCues(cues) {
    var out = [];
    var list = cues && cues.length ? cues : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) out.push({ start: list[i].start, end: list[i].end, text: list[i].text });
    }
    return out;
  }

  /**
   * Source-time cues -> a NEW array in EDITED time, for a file that has the edits applied.
   * Every time is mapped by Takes.editor.mapTime; nothing here re-does that arithmetic.
   * A cue wholly inside a removed range is dropped; one that starts or ends inside a removed
   * range is clipped to the nearest kept edge; one shorter than 0.05 seconds afterwards is dropped.
   * Without the editor module the cues come back unchanged (as copies).
   */
  function shiftCuesForEdits(cues, edits) {
    var editor = Takes.editor;
    if (!editor || typeof editor.mapTime !== 'function') return copyCues(cues);
    var e = edits || { trimStart: 0, trimEnd: null, cut: null };
    var map = function (t) {
      var v = editor.mapTime(t, e);
      return typeof v === 'number' && isFinite(v) ? v : null;
    };
    // The places where kept and removed stretches meet. They are only read, never used for arithmetic.
    var edges = [];
    var addEdge = function (v) { var n = num(v); if (n !== null) edges.push(n); };
    addEdge(e.trimStart);
    addEdge(e.trimEnd);
    if (e.cut) { addEdge(e.cut.start); addEdge(e.cut.end); }

    var out = [];
    var list = cues && cues.length ? cues : [];
    for (var i = 0; i < list.length; i++) {
      var cue = list[i];
      if (!cue) continue;
      var s = num(cue.start);
      var en = num(cue.end);
      if (s === null || en === null || !(en > s)) continue;
      var points = [s, en];
      for (var k = 0; k < edges.length; k++) if (edges[k] > s && edges[k] < en) points.push(edges[k]);
      points.sort(function (a, b) { return a - b; });
      var first = null;
      var last = null;
      for (var j = 0; j + 1 < points.length; j++) {
        var a = points[j];
        var b = points[j + 1];
        if (!(b > a)) continue;
        var mid = map(a + (b - a) / 2);
        if (mid === null) continue; // this stretch of the cue was removed
        // Inside one kept stretch edited time runs at the same speed as source time,
        // so an edge mapTime calls removed (the start of the cut) is reached from the middle.
        var half = (b - a) / 2;
        var ma = map(a);
        var mb = map(b);
        if (ma === null) ma = mid - half;
        if (mb === null) mb = mid + half;
        if (first === null) first = ma;
        last = mb;
      }
      if (first === null || last === null) continue;
      if (first < 0) first = 0;
      if (last - first < MIN_CUE_SEC) continue;
      out.push({ start: first, end: last, text: cue.text });
    }
    return out;
  }

  /**
   * The speech model's chunks ([{ timestamp: [start, end], text }]) -> cues in seconds.
   * Text is trimmed and empty chunks dropped; a missing end takes the next chunk's start, or the
   * length of the sound; everything is held inside the sound's length, in order, never overlapping.
   */
  function chunksToCues(chunks, durationSec) {
    var dur = Number(durationSec);
    var hasDur = isFinite(dur) && dur > 0;
    var items = [];
    var list = chunks && chunks.length ? chunks : [];
    for (var i = 0; i < list.length; i++) {
      var chunk = list[i] || {};
      var text = String(chunk.text == null ? '' : chunk.text).replace(/\s+/g, ' ').replace(/^ | $/g, '');
      // The model writes this marker for a stretch with nothing said in it.
      text = text.replace(/\[BLANK_AUDIO\]/g, '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (!text) continue;
      var ts = chunk.timestamp || [];
      items.push({ start: num(ts[0]), end: num(ts[1]), text: text });
    }
    var hold = function (v) {
      if (v < 0) return 0;
      if (hasDur && v > dur) return dur;
      return v;
    };
    var out = [];
    var prevEnd = 0;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var nextStart = null;
      for (var n = j + 1; n < items.length; n++) {
        if (items[n].start !== null) { nextStart = items[n].start; break; }
      }
      var start = hold(it.start === null ? prevEnd : it.start);
      if (start < prevEnd) start = prevEnd;
      var end = it.end;
      if (end === null) end = nextStart !== null ? nextStart : (hasDur ? dur : start + 2);
      end = hold(end);
      if (end - start < MIN_CUE_SEC) {
        // The model gave this chunk no usable length: give it up to a second, without running into the next one.
        end = hold(start + 1);
        if (nextStart !== null && nextStart > start && nextStart < end) end = nextStart;
      }
      if (end - start < MIN_CUE_SEC) continue;
      var before = out.length ? out[out.length - 1] : null;
      var tiny = end - start < ORPHAN_SEC || it.text.length < ORPHAN_CHARS;
      if (before && tiny && start - before.end <= JOIN_GAP_SEC) {
        // A stray word or a blink of a chunk reads better with the line it follows; splitLongCues evens out the result.
        before.end = end;
        before.text += ' ' + it.text;
      } else {
        out.push({ start: start, end: end, text: it.text });
      }
      prevEnd = end;
    }
    return out;
  }

  // ---------------------------------------------------------------- small internals

  function emit(event, payload) {
    Takes.bus.emit(event, payload);
  }

  function toast(kind, text) {
    emit('toast', { kind: kind, text: text });
  }

  /** Toast an error in plain words and return the Error to reject with. */
  function fail(message, cause) {
    toast('error', message);
    var err = new Error(message);
    err.code = 'captions-failed';
    err.toasted = true;
    if (cause) err.cause = cause;
    return err;
  }

  function progress(id, phase, pct) {
    emit('captions:progress', { id: id, phase: phase, pct: pct });
  }

  function later(ms) {
    return new Promise(function (resolve) { root.setTimeout(resolve, ms); });
  }

  /** Give the browser a chance to paint before heavy work. Never hangs, even in a hidden tab. */
  function nextPaint() {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function () { if (!settled) { settled = true; resolve(); } };
      if (typeof root.requestAnimationFrame === 'function') {
        root.requestAnimationFrame(function () { root.setTimeout(done, 0); });
        root.setTimeout(done, 150);
      } else {
        root.setTimeout(done, 0);
      }
    });
  }

  function withTimeout(promise, ms, what) {
    return new Promise(function (resolve, reject) {
      var timer = root.setTimeout(function () {
        var err = new Error(what + ' took too long');
        err.stalled = true;
        reject(err);
      }, ms);
      Promise.resolve(promise).then(
        function (value) { root.clearTimeout(timer); resolve(value); },
        function (err) { root.clearTimeout(timer); reject(err); });
    });
  }

  // ---------------------------------------------------------------- sound

  /** The recording's sound as one channel of 16 kHz samples: { samples, duration, peak }. */
  async function decodeAudio(blob) {
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (typeof Ctx !== 'function') {
      var missing = new Error('no AudioContext');
      missing.noDecoder = true;
      throw missing;
    }
    var ac = new Ctx({ sampleRate: SAMPLE_RATE });
    try {
      var buf = await ac.decodeAudioData(await blob.arrayBuffer());
      var n = buf.length;
      var channels = buf.numberOfChannels;
      var mono = new Float32Array(n);
      for (var c = 0; c < channels; c++) {
        var data = buf.getChannelData(c);
        for (var i = 0; i < n; i++) mono[i] += data[i] / channels;
      }
      var peak = 0;
      for (var j = 0; j < n; j++) {
        var a = mono[j] < 0 ? -mono[j] : mono[j];
        if (a > peak) peak = a;
      }
      var duration = Number(buf.duration);
      if (!isFinite(duration) || duration <= 0) duration = n / SAMPLE_RATE;
      return { samples: mono, duration: duration, peak: peak };
    } finally {
      try { var closing = ac.close(); if (closing && closing.catch) closing.catch(function () {}); } catch (ignored) { /* already closed */ }
    }
  }

  function bytesHaveSoundMarker(bytes) {
    // 'soun' is the handler name an MP4 file gives a sound track.
    for (var i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 0x73 && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x75 && bytes[i + 3] === 0x6e) return true;
    }
    return false;
  }

  /** true or false when the file could be read, null when it could not. */
  async function blobHasSoundTrack(blob) {
    try {
      var size = blob.size;
      var head = new Uint8Array(await blob.slice(0, Math.min(size, SCAN_BYTES)).arrayBuffer());
      if (bytesHaveSoundMarker(head)) return true;
      if (size > SCAN_BYTES) {
        var tail = new Uint8Array(await blob.slice(Math.max(SCAN_BYTES, size - SCAN_BYTES), size).arrayBuffer());
        if (bytesHaveSoundMarker(tail)) return true;
      }
      return false;
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------------- the model

  // Kept for the whole visit, so a second recording does not download the model again.
  var libraryPromise = null;
  var session = null;        // { transcriber, kind }
  var useFallback = false;   // set once the fast setting has failed in this visit
  var queue = Promise.resolve();
  var loadLibraryImpl = function () { return import(LIB_URL); };

  function loadLibrary() {
    if (!libraryPromise) {
      libraryPromise = withTimeout(Promise.resolve().then(loadLibraryImpl), IMPORT_TIMEOUT_MS, 'Loading the caption tools')
        .then(function (lib) {
          if (!lib || typeof lib.pipeline !== 'function') throw new Error('the caption library has no pipeline');
          return lib;
        });
      libraryPromise.catch(function () { libraryPromise = null; });
    }
    return libraryPromise;
  }

  async function hasGpuAdapter() {
    var nav = root.navigator;
    var gpu = null;
    try { gpu = nav && nav.gpu ? nav.gpu : null; } catch (err) { gpu = null; }
    if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
    try { return !!(await withTimeout(gpu.requestAdapter(), ADAPTER_TIMEOUT_MS, 'Asking for the graphics card')); }
    catch (err) { return false; }
  }

  /**
   * The download size for THIS computer, in plain words: 'about 70 MB' when the fast setting will be
   * used, 'about 50 MB' for the fallback. Promise of a string; never rejects. Asks for the graphics
   * card only (quick, nothing is downloaded), so it can be called when the Review view opens.
   */
  async function downloadSizeText() {
    try {
      if (session) return SIZE_TEXT[session.kind];
      if (useFallback) return SIZE_TEXT.fallback;
      return (await hasGpuAdapter()) ? SIZE_TEXT.fast : SIZE_TEXT.fallback;
    } catch (err) {
      return DOWNLOAD_SIZE_TEXT;
    }
  }

  /** Adds up the library's per-file progress into one 0 to 99 figure, or null while no size is known. */
  function makeTracker(id, kind, onBeat) {
    var files = {};
    var expected = MODEL_MB[kind] * 1048576;
    var lastPct = -1;
    return function (p) {
      try {
        onBeat();
        if (!p || !p.file || typeof p.loaded !== 'number') return;
        var f = files[p.file] || { loaded: 0, total: 0 };
        if (p.loaded > f.loaded) f.loaded = p.loaded;
        if (typeof p.total === 'number' && p.total > f.total) f.total = p.total;
        files[p.file] = f;
        var loaded = 0;
        var total = 0;
        for (var key in files) { loaded += files[key].loaded; total += files[key].total; }
        if (!(total > 0)) {
          if (lastPct < 0) { lastPct = 0; progress(id, 'download', null); }
          return;
        }
        // Files announce themselves one at a time, so the measured size steadies the figure early on.
        var pct = Math.floor((loaded / Math.max(total, expected)) * 100);
        if (pct > 99) pct = 99;
        if (pct > lastPct) { lastPct = pct; progress(id, 'download', pct); }
      } catch (err) { /* progress is never worth failing for */ }
    };
  }

  function loadPipeline(lib, id, kind) {
    var cfg = CONFIGS[kind];
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var beat = function () {
        if (settled) return;
        if (timer) root.clearTimeout(timer);
        timer = root.setTimeout(function () {
          if (settled) return;
          settled = true;
          var err = new Error('the caption model stopped downloading');
          err.stalled = true;
          reject(err);
        }, STALL_TIMEOUT_MS);
      };
      beat();
      var finish = function (fn, value) {
        if (settled) return;
        settled = true;
        if (timer) root.clearTimeout(timer);
        fn(value);
      };
      Promise.resolve().then(function () {
        return lib.pipeline('automatic-speech-recognition', MODEL, {
          dtype: cfg.dtype,
          device: cfg.device,
          progress_callback: makeTracker(id, kind, beat)
        });
      }).then(
        function (transcriber) { finish(resolve, { transcriber: transcriber, kind: kind }); },
        function (err) { finish(reject, err); });
    });
  }

  async function dropSession() {
    var old = session;
    session = null;
    try { if (old && old.transcriber && typeof old.transcriber.dispose === 'function') await old.transcriber.dispose(); }
    catch (err) { /* nothing more to do */ }
  }

  /** The loaded model: from memory when there is one, otherwise fast first and the fallback once. */
  async function ensureSession(lib, id) {
    if (session) return session;
    var kind = 'fallback';
    if (!useFallback && await hasGpuAdapter()) kind = 'fast';
    if (kind === 'fast') {
      try {
        session = await loadPipeline(lib, id, 'fast');
      } catch (err) {
        if (err && err.stalled) throw err;
        useFallback = true;
        progress(id, 'download', 0);
        await nextPaint();
      }
    }
    if (!session) session = await loadPipeline(lib, id, 'fallback');
    return session;
  }

  async function transcribe(lib, id, samples) {
    for (;;) {
      var current;
      try {
        current = await ensureSession(lib, id);
      } catch (err) {
        throw fail(TEXT_OFFLINE, err);
      }
      progress(id, 'download', 100);
      await nextPaint();
      progress(id, 'transcribe', null);
      await nextPaint();
      try {
        var out = await current.transcriber(samples, { return_timestamps: true, chunk_length_s: 30 });
        if (Array.isArray(out)) out = out[0];
        return out || {};
      } catch (err) {
        // A model that failed is not kept; the next try loads a fresh one.
        await dropSession();
        if (current.kind === 'fast') {
          useFallback = true;
          progress(id, 'download', 0);
          await nextPaint();
          continue;
        }
        throw fail(TEXT_MODEL, err);
      }
    }
  }

  // ---------------------------------------------------------------- generate

  function finish(id, cues, quiet) {
    var vtt = toVtt(cues);
    if (!cues.length && !quiet) toast('info', TEXT_NO_SPEECH);
    emit('captions:done', { id: id, cues: cues, vtt: vtt });
    return { cues: cues, vtt: vtt };
  }

  async function generateNow(recording) {
    var rec = recording || {};
    var id = rec.id;
    // Said first, and painted, before anything heavy starts.
    progress(id, 'download', 0);
    await nextPaint();

    var blob = rec.blob;
    if (!blob || typeof blob.arrayBuffer !== 'function') throw fail(TEXT_NO_BLOB);

    // The sound is read BEFORE the model is fetched, so a recording with nothing said costs no download.
    var audio = null;
    try {
      audio = await decodeAudio(blob);
    } catch (err) {
      if (err && err.noDecoder) throw fail(TEXT_NO_DECODER, err);
      // A recording made with no microphone has no sound track at all; that is "no speech", not a failure.
      if ((await blobHasSoundTrack(blob)) === false) return finish(id, []);
      throw fail(TEXT_DECODE, err);
    }
    if (!audio.samples.length || audio.peak < SILENCE_PEAK) return finish(id, []);
    await nextPaint();

    var lib;
    try {
      lib = await loadLibrary();
    } catch (err) {
      throw fail(TEXT_OFFLINE, err);
    }

    var out = await transcribe(lib, id, audio.samples);
    await nextPaint();

    var cues;
    try {
      cues = splitLongCues(chunksToCues(out.chunks, audio.duration), MAX_CUE_CHARS);
    } catch (err) {
      throw fail(TEXT_MODEL, err);
    }
    return finish(id, cues);
  }

  /**
   * Make captions for a recording. Promise of { cues, vtt }, cues in SOURCE time, already split at 84 characters.
   * Emits captions:progress, then captions:done. Stores nothing.
   * One recording is handled at a time; a second call waits for the first.
   */
  function generate(recording) {
    var run = queue.then(function () { return generateNow(recording); });
    queue = run.then(function () {}, function () {});
    return run;
  }

  // ---------------------------------------------------------------- showing and saving

  var tracks = typeof WeakMap === 'function' ? new WeakMap() : null;

  function findTrack(video) {
    var found = tracks ? tracks.get(video) : null;
    if (found) return found;
    var list = video.textTracks;
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && t.kind === 'captions' && t.label === 'English' && t.language === 'en') return t;
    }
    return null;
  }

  /**
   * Show source-time cues on a video. ONE track per video: called again, it empties that track and refills it.
   * Returns the TextTrack with mode 'showing', or null when this browser has no text tracks.
   */
  function attach(video, cues) {
    var Cue = root.VTTCue;
    if (!video || typeof video.addTextTrack !== 'function' || typeof Cue !== 'function') return null;
    var track = findTrack(video);
    if (!track) track = video.addTextTrack('captions', 'English', 'en');
    if (tracks) tracks.set(video, track);
    // A disabled track has no cue list, so it is woken before it is emptied.
    track.mode = 'hidden';
    var old = track.cues;
    if (old) {
      for (var i = old.length - 1; i >= 0; i--) {
        try { track.removeCue(old[i]); } catch (err) { /* already gone */ }
      }
    }
    var list = cues && cues.length ? cues : [];
    for (var j = 0; j < list.length; j++) {
      var cue = list[j] || {};
      var start = num(cue.start);
      var end = num(cue.end);
      var text = cleanCueText(cue.text);
      if (!text || start === null || end === null || !(end > start)) continue;
      try { track.addCue(new Cue(start < 0 ? 0 : start, end, text)); } catch (err) { /* skip a cue the browser refuses */ }
    }
    track.mode = 'showing';
    return track;
  }

  /**
   * Download the recording's captions as a .vtt file. Synchronous. Returns the file name,
   * or null when there was nothing to download (a toast says why).
   * forExport true shifts the cues for the trim, as the file saved beside a trimmed video needs.
   */
  function downloadVtt(recording, forExport) {
    return downloadCues(recording, forExport, 'vtt', 'text/vtt', toVtt);
  }

  /**
   * Download the transcript as flowing paragraphs in a .txt file. Same shape and same time handling as downloadVtt
   * (times do not appear in it, but cues inside a removed part are left out when the caller shifted them).
   */
  function downloadText(recording, forExport) {
    return downloadCues(recording, forExport, 'txt', 'text/plain', function (cues) { return toText(cues) + '\n'; });
  }

  /** Download the captions as a SubRip .srt file. Same shape and same time handling as downloadVtt. */
  function downloadSrt(recording, forExport) {
    return downloadCues(recording, forExport, 'srt', 'application/x-subrip', toSrt);
  }

  function downloadCues(recording, forExport, ext, mimeType, render) {
    var rec = recording || {};
    var cues = rec.cues && rec.cues.length ? rec.cues : [];
    if (forExport) {
      var edits = rec.edits || {};
      cues = shiftCuesForEdits(cues, {
        trimStart: edits.trimStart || 0,
        trimEnd: edits.trimEnd == null ? null : edits.trimEnd,
        cut: null
      });
    }
    if (!cues.length) {
      toast('info', 'There are no captions to download yet. Click Add captions first.');
      return null;
    }
    var name = Takes.save && typeof Takes.save.fileName === 'function'
      ? Takes.save.fileName(rec, ext)
      : Takes.util.makeFileName(new Date(rec.createdAt), ext);
    var doc = root.document;
    var urls = root.URL;
    var BlobClass = root.Blob;
    if (!doc || !doc.body || !urls || typeof urls.createObjectURL !== 'function' || typeof BlobClass !== 'function') {
      toast('error', 'This browser could not start the download. Open ' + Takes.PRODUCT_NAME + ' in Chrome or Edge and try again.');
      return null;
    }
    var url = '';
    try {
      url = urls.createObjectURL(new BlobClass([render(cues)], { type: mimeType + ';charset=utf-8' }));
      var link = doc.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      link.style.display = 'none';
      doc.body.appendChild(link);
      link.click();
      doc.body.removeChild(link);
    } catch (err) {
      if (url) { try { urls.revokeObjectURL(url); } catch (ignored) { /* nothing */ } }
      toast('error', 'The captions download could not start. Try again.');
      return null;
    }
    root.setTimeout(function () {
      try { urls.revokeObjectURL(url); } catch (ignored) { /* nothing */ }
    }, REVOKE_DELAY_MS);
    return name;
  }

  // ---------------------------------------------------------------- for tests only

  var testHooks = {
    /** Swap the loader of the speech library for a stand-in. Pass nothing to put the real one back. */
    setLibraryLoader: function (fn) {
      loadLibraryImpl = typeof fn === 'function' ? fn : function () { return import(LIB_URL); };
    },
    /** Forget the loaded library, the loaded model and which setting worked. */
    reset: function () {
      libraryPromise = null;
      session = null;
      useFallback = false;
      queue = Promise.resolve();
    },
    sessionKind: function () { return session ? session.kind : null; }
  };

  var api = {
    generate: generate,
    toVtt: toVtt,
    formatVttTime: formatVttTime,
    splitLongCues: splitLongCues,
    shiftCuesForEdits: shiftCuesForEdits,
    chunksToCues: chunksToCues,
    attach: attach,
    downloadVtt: downloadVtt,
    toText: toText,
    toSrt: toSrt,
    formatSrtTime: formatSrtTime,
    searchCues: searchCues,
    downloadText: downloadText,
    downloadSrt: downloadSrt,
    DOWNLOAD_SIZE_TEXT: DOWNLOAD_SIZE_TEXT,
    downloadSizeText: downloadSizeText,
    DOWNLOAD_MB: DOWNLOAD_MB,
    MODEL: MODEL,
    _test: testHooks
  };
  Takes.captions = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
