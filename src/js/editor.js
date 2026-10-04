/* takes:editor */
/*
 * editor.js: the edit list (trim start, trim end, one middle cut), the player that
 * skips what was removed, and the trimmed file that gets saved.
 * Every time here is in SECONDS. Nothing in this file changes the edits object or the blob it is given.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  // The one outside library this module loads, on demand, only when a trimmed file is asked for.
  var MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/+esm';

  var MIN_KEPT = 0.5;   // an edit must leave at least this much
  var MIN_CUT = 0.1;    // a cut shorter than this is dropped
  var EPS = 1e-9;       // forgives floating point noise in the two limits above
  var SNAP = 0.01;      // how close playback must be to an edge to count as on it
  var TRIM_EPS = 0.001; // a trim smaller than this is no trim

  var MSG_OFFLINE = 'Trimming needs an internet connection to load its tools. Your full recording is still here, and you can save that instead.';
  var MSG_FAILED = 'The trimmed version could not be made. Your full recording is still here, and you can save that instead.';
  var MSG_REMOVES_ALL = 'That edit would remove the whole recording.';

  // ---------------------------------------------------------------- pure helpers

  /** A value as a number. Missing, empty and non-numeric values are NaN (Number(null) would be 0). */
  function num(value) {
    if (value == null || value === '' || typeof value === 'boolean') return NaN;
    return Number(value);
  }

  function hold(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  /**
   * The edits with every value settled, as a NEW object. Never throws.
   * limitSec is the upper limit for every time; Infinity means "no upper limit".
   */
  function resolveEdits(edits, limitSec) {
    var limit = num(limitSec);
    if (isNaN(limit) || limit < 0) limit = 0;
    var src = edits && typeof edits === 'object' ? edits : {};

    var trimStart = num(src.trimStart);
    if (isNaN(trimStart)) trimStart = 0;
    trimStart = hold(trimStart, 0, limit);

    var trimEnd = num(src.trimEnd);
    trimEnd = isNaN(trimEnd) ? limit : hold(trimEnd, trimStart, limit);

    var cut = null;
    var c = src.cut;
    if (c && typeof c === 'object') {
      var a = num(c.start);
      var b = num(c.end);
      if (!isNaN(a) && !isNaN(b)) {
        if (a > b) { var swap = a; a = b; b = swap; }
        a = hold(a, trimStart, trimEnd);
        b = hold(b, trimStart, trimEnd);
        if (b - a >= MIN_CUT - EPS) cut = { start: a, end: b };
      }
    }
    return { trimStart: trimStart, trimEnd: trimEnd, cut: cut };
  }

  function finiteDuration(durationSec) {
    var d = num(durationSec);
    return isFinite(d) && d > 0 ? d : 0;
  }

  /**
   * (edits, durationSec) -> a NEW { trimStart, trimEnd, cut } with trimEnd always a number.
   * Throws a RangeError when the edit would leave less than half a second.
   */
  function normalizeEdits(edits, durationSec) {
    var dur = finiteDuration(durationSec);
    var e = resolveEdits(edits, dur);
    var kept = e.trimEnd - e.trimStart - (e.cut ? e.cut.end - e.cut.start : 0);
    // A recording that is itself shorter than the limit is fine as long as nothing was taken from it.
    if (kept < MIN_KEPT - EPS && kept < dur - EPS) throw new RangeError(MSG_REMOVES_ALL);
    return e;
  }

  /** Ordered [[start, end], ...]: one pair, or two when a cut sits strictly inside the trim. */
  function keptRanges(edits, durationSec) {
    var e = normalizeEdits(edits, durationSec);
    if (!e.cut) return [[e.trimStart, e.trimEnd]];
    var ranges = [];
    if (e.cut.start - e.trimStart > EPS) ranges.push([e.trimStart, e.cut.start]);
    if (e.trimEnd - e.cut.end > EPS) ranges.push([e.cut.end, e.trimEnd]);
    return ranges;
  }

  /** The total length of what is kept, in seconds. */
  function editedDuration(edits, durationSec) {
    var ranges = keptRanges(edits, durationSec);
    var total = 0;
    for (var i = 0; i < ranges.length; i++) total += ranges[i][1] - ranges[i][0];
    return total;
  }

  /**
   * Source time -> edited time, or null inside a removed range.
   * The two-argument form takes no duration: a null trimEnd then means no upper limit.
   * A duration may be passed as a third argument; a null trimEnd then means that duration.
   */
  function mapTime(sourceSec, edits, durationSec) {
    var t = num(sourceSec);
    if (!isFinite(t)) return null;
    var limit = num(durationSec);
    var e = resolveEdits(edits, isFinite(limit) && limit > 0 ? limit : Infinity);
    if (t < e.trimStart || t > e.trimEnd) return null;
    if (e.cut) {
      if (t >= e.cut.start && t < e.cut.end) return null;
      if (t >= e.cut.end) return t - e.trimStart - (e.cut.end - e.cut.start);
    }
    return t - e.trimStart;
  }

  /** True when the start or the end is trimmed. A cut alone is not a trim. */
  function hasTrim(edits, durationSec) {
    var dur = finiteDuration(durationSec);
    var e = resolveEdits(edits, dur);
    return e.trimStart > TRIM_EPS || e.trimEnd < dur - TRIM_EPS;
  }

  /**
   * True when the saved file would differ from the original: there is a trim OR a cut,
   * or (optional third argument) an export option is on: burnCaptions with cues to draw, or size 'vertical'.
   * The UI and the save path ask this to decide whether to call exportEdited first. Never throws.
   */
  function needsExport(edits, durationSec, options) {
    if (hasTrim(edits, durationSec) || !!resolveEdits(edits, finiteDuration(durationSec)).cut) return true;
    if (!options || typeof options !== 'object') return false;
    if (options.size === 'vertical') return true;
    return !!options.burnCaptions && !(Array.isArray(options.cues) && options.cues.length === 0);
  }

  // ---------------------------------------------------------------- player

  var players = typeof WeakMap === 'function' ? new WeakMap() : null;
  var PLAYER_EVENTS = ['timeupdate', 'seeking', 'play', 'loadedmetadata'];

  /**
   * Keep a video element inside the kept ranges: start at trimStart, jump over the cut, pause at trimEnd.
   * Returns detach(). Attaching again to the same video detaches the earlier one first.
   * The edits object is read at each event and never written.
   */
  function attachPlayer(video, edits) {
    if (!video || typeof video.addEventListener !== 'function') return function () {};
    if (players) {
      var earlier = players.get(video);
      if (earlier) earlier();
    }

    var live = true;
    var frame = 0;

    function seek(to) {
      try { video.currentTime = to; } catch (err) { /* not seekable yet; the next event tries again */ }
    }

    function stopAt(end, now) {
      try { if (!video.paused) video.pause(); } catch (err) { /* nothing to pause */ }
      if (Math.abs(now - end) > SNAP) seek(end);
    }

    function enforce(event) {
      if (!live) return;
      var t = Number(video.currentTime);
      if (!isFinite(t)) return;
      var d = Number(video.duration);
      var known = isFinite(d) && d > 0;
      var e = resolveEdits(edits, known ? d : Infinity);
      var endIsTrimmed = isFinite(e.trimEnd) && (!known || e.trimEnd < d - SNAP);

      // Play pressed while sitting at the end: start the kept part again.
      if (event && event.type === 'play' && isFinite(e.trimEnd) && t >= e.trimEnd - SNAP) {
        seek(e.trimStart);
        return;
      }
      if (t < e.trimStart - SNAP) {
        seek(e.trimStart);
        return;
      }
      if (e.cut && t >= e.cut.start && t < e.cut.end - SNAP) {
        if (isFinite(e.trimEnd) && e.cut.end >= e.trimEnd - SNAP) stopAt(e.trimEnd, t);
        else seek(e.cut.end);
        return;
      }
      if (endIsTrimmed && t >= e.trimEnd) stopAt(e.trimEnd, t);
    }

    // timeupdate only fires a few times a second, so while playing the edges are also checked every frame.
    function loop() {
      frame = 0;
      if (!live) return;
      enforce(null);
      if (!video.paused && !video.ended) frame = root.requestAnimationFrame(loop);
    }

    function onEvent(event) {
      enforce(event);
      if (live && event && event.type === 'play' && !frame && typeof root.requestAnimationFrame === 'function') {
        frame = root.requestAnimationFrame(loop);
      }
    }

    for (var i = 0; i < PLAYER_EVENTS.length; i++) video.addEventListener(PLAYER_EVENTS[i], onEvent);

    function detach() {
      if (!live) return;
      live = false;
      for (var j = 0; j < PLAYER_EVENTS.length; j++) video.removeEventListener(PLAYER_EVENTS[j], onEvent);
      if (frame && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(frame);
      frame = 0;
      if (players && players.get(video) === detach) players.delete(video);
    }

    if (players) players.set(video, detach);
    enforce(null);
    return detach;
  }

  // ---------------------------------------------------------------- trimmed file

  function emit(event, payload) {
    if (Takes && Takes.bus) Takes.bus.emit(event, payload);
  }

  /** Announce a failed trim in plain words and build the Error the Promise rejects with. */
  function failure(text, cause) {
    emit('toast', { kind: 'error', text: text });
    var err = new Error(text);
    err.code = 'export-failed';
    err.toasted = true;
    if (cause) err.cause = cause;
    return err;
  }

  /** The call sequence tested on a real recording, with the trim range passed in. */
  function convert(MB, blob, edits, report) {
    var input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
    var output = null;
    return Promise.resolve(input.computeDuration()).then(function (sourceDuration) {
      var start = edits.trimStart;
      var end = edits.trimEnd;
      // The file's own length wins over the stopwatch length the recorder measured.
      if (isFinite(sourceDuration) && sourceDuration > 0) end = Math.min(end, sourceDuration);
      if (!(end - start > 0)) throw new Error('The trim range is empty for this file.');
      output = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.BufferTarget() });
      return MB.Conversion.init({ input: input, output: output, trim: { start: start, end: end } });
    }).then(function (conversion) {
      if (!conversion.isValid) throw new Error('The conversion is not valid.');
      // A dropped track would mean a saved file with no sound or no picture; the full take is better than that.
      var discarded = conversion.discardedTracks;
      if (discarded && discarded.length > 0) throw new Error('The conversion would drop a track.');
      conversion.onProgress = function (fraction) { report(Number(fraction) * 100); };
      return conversion.execute();
    }).then(function () {
      var buffer = output.target.buffer;
      if (!buffer) throw new Error('The conversion finished with nothing in it.');
      return { blob: new Blob([buffer], { type: 'video/mp4' }), mimeType: 'video/mp4' };
    });
  }

  /**
   * Where one sample lands once the cut is taken out. Pure; every value is in seconds on one shared clock.
   * Returns { timestamp, duration }, or null when the sample sits wholly inside the cut.
   * A sample that crosses a cut edge keeps only its part outside the cut.
   */
  function retime(timestampSec, durationSec, cutStartSec, cutEndSec) {
    var ts = Number(timestampSec);
    var dur = Math.max(0, Number(durationSec) || 0);
    var end = ts + dur;
    var length = cutEndSec - cutStartSec;
    var tiny = 1e-6;
    if (!(length > 0) || end <= cutStartSec + tiny) return { timestamp: ts, duration: dur };
    if (ts >= cutEndSec - tiny) return { timestamp: ts - length, duration: dur };
    var after = end > cutEndSec + tiny ? end - cutEndSec : 0;
    if (ts < cutStartSec - tiny) return { timestamp: ts, duration: cutStartSec - ts + after };
    if (after > 0) return { timestamp: cutStartSec, duration: after };
    return null;
  }

  /**
   * The same conversion with the middle cut taken out as well: both tracks are re-encoded, and the library's
   * per-sample hooks drop what lies in the cut and move the rest back so the second kept range follows the first.
   * The hooks see times counted from the trim start, so the cut is expressed on that clock.
   */
  function convertCut(MB, blob, edits, report) {
    var input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
    var output = null;
    var expected = 0;
    var span = 0;
    return Promise.resolve(input.computeDuration()).then(function (sourceDuration) {
      var start = edits.trimStart;
      var end = edits.trimEnd;
      if (isFinite(sourceDuration) && sourceDuration > 0) end = Math.min(end, sourceDuration);
      var cutStart = edits.cut.start - start;
      var cutEnd = Math.min(edits.cut.end, end) - start;
      if (!(cutEnd - cutStart > 0)) throw new Error('The cut is empty for this file.');
      span = end - start;
      expected = end - start - (cutEnd - cutStart);
      if (!(expected > 0)) throw new Error('Nothing is left to keep for this file.');

      var video = {
        codec: 'avc',
        forceTranscode: true,
        process: function (sample) {
          // The library's own progress stays at zero for a recording (its header carries no length),
          // so progress is counted here, from the picture frames as they pass.
          if (span > 0) report(hold(sample.timestamp / span, 0, 1) * 99);
          var to = retime(sample.timestamp, sample.duration, cutStart, cutEnd);
          if (!to) return null;
          if (to.timestamp !== sample.timestamp) sample.setTimestamp(to.timestamp);
          if (to.duration !== sample.duration && typeof sample.setDuration === 'function') sample.setDuration(to.duration);
          return sample;
        }
      };
      var audio = {
        codec: 'aac',
        forceTranscode: true,
        process: function (sample) {
          var ts = sample.timestamp;
          var sampleEnd = ts + sample.duration;
          var tiny = 1e-6;
          if (sampleEnd <= cutStart + tiny) return sample;
          if (ts >= cutEnd - tiny) {
            sample.setTimestamp(ts - (cutEnd - cutStart));
            return sample;
          }
          // The sample touches the cut: keep the frames before it and the frames after it, to the frame.
          var pieces = [];
          var frames = sample.numberOfFrames;
          var headFrames = hold(Math.round((cutStart - ts) * sample.sampleRate), 0, frames);
          var tailFrom = hold(Math.round((cutEnd - ts) * sample.sampleRate), 0, frames);
          if (headFrames > 0) pieces.push(sample.trim(0, headFrames));
          if (tailFrom < frames) {
            var tail = sample.trim(tailFrom, frames);
            tail.setTimestamp(tail.timestamp - (cutEnd - cutStart));
            pieces.push(tail);
          }
          return pieces.length > 0 ? pieces : null;
        }
      };
      // Aim for the picture quality the recording already has: its own overall bitrate, within sane limits.
      if (typeof MB.Quality === 'function' && isFinite(sourceDuration) && sourceDuration > 0 && blob.size > 0) {
        var bitsPerSecond = (blob.size * 8) / sourceDuration;
        video.quality = new MB.Quality(Math.round(hold(bitsPerSecond, 1500000, 12000000)));
        audio.quality = new MB.Quality(128000);
      }

      output = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.BufferTarget() });
      return MB.Conversion.init({
        input: input, output: output, trim: { start: start, end: end },
        video: video, audio: audio, showWarnings: false
      });
    }).then(function (conversion) {
      if (!conversion.isValid) throw new Error('The conversion is not valid.');
      var discarded = conversion.discardedTracks;
      if (discarded && discarded.length > 0) throw new Error('The conversion would drop a track.');
      // The library's own progress number is not used: a recording's header carries no length, and with a trim
      // that starts at zero the library then reports "done" at once. The frame count above does the work.
      return conversion.execute();
    }).then(function () {
      var buffer = output.target.buffer;
      if (!buffer) throw new Error('The conversion finished with nothing in it.');
      var result = { blob: new Blob([buffer], { type: 'video/mp4' }), mimeType: 'video/mp4', cutApplied: true };
      // Trust nothing: read the new file's own length back before saying the cut was applied.
      var check = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(result.blob) });
      return Promise.resolve(check.computeDuration()).then(function (made) {
        if (!(Math.abs(made - expected) <= 0.5)) {
          throw new Error('The file came out ' + made + ' s long, not ' + expected + ' s.');
        }
        return result;
      });
    });
  }

  /**
   * Promise of { blob, mimeType }: the recording as it should be saved. The original blob is never changed.
   * No trim and no cut: resolves with the original blob and loads nothing.
   * Trim only: the trimmed file, by copying; the result has no cutApplied field.
   * With a cut: the file with the trim AND the cut applied, and cutApplied is true. If that cannot be made,
   * it falls back to the trim-only file (or the original when there is no trim) with cutApplied false.
   */
  function exportPlain(recording) {
    var rec = recording || {};
    var blob = rec.blob;
    if (!blob) return Promise.reject(failure(MSG_FAILED));
    var dur = Number(rec.durationMs) / 1000;
    var trimmed = hasTrim(rec.edits, dur);
    var original = { blob: blob, mimeType: rec.mimeType || blob.type };
    if (!trimmed && !resolveEdits(rec.edits, finiteDuration(dur)).cut) return Promise.resolve(original);

    var edits;
    try { edits = normalizeEdits(rec.edits, dur); } catch (err) { return Promise.reject(failure(MSG_FAILED, err)); }

    var id = rec.id;
    var last = -1;
    function report(pct) {
      var p = Math.round(hold(isFinite(pct) ? pct : 0, 0, 100));
      if (p <= last) return; // progress only ever moves forward
      last = p;
      emit('export:progress', { id: id, pct: p });
    }

    report(0);

    if (!edits.cut) {
      return Promise.resolve()
        .then(function () { return api._loadLibrary(); })
        .then(null, function (err) { throw failure(MSG_OFFLINE, err); })
        .then(function (MB) { return convert(MB, blob, edits, report); })
        .then(function (result) {
          report(100);
          return result;
        }, function (err) {
          throw err && err.toasted ? err : failure(MSG_FAILED, err);
        });
    }

    // What is saved when the cut cannot be applied: the trim alone, or the original when there is no trim.
    function withoutCut(MB, cause) {
      if (cause && typeof console !== 'undefined' && console.warn) {
        console.warn('[editor] the cut could not be applied to the saved file:', cause);
      }
      if (!trimmed) return { blob: original.blob, mimeType: original.mimeType, cutApplied: false };
      return convert(MB, blob, edits, report).then(function (result) {
        return { blob: result.blob, mimeType: result.mimeType, cutApplied: false };
      });
    }

    return Promise.resolve()
      .then(function () { return api._loadLibrary(); })
      .then(null, function (err) {
        if (!trimmed) return null; // nothing to trim either: the original is the honest answer, and no tools are needed
        throw failure(MSG_OFFLINE, err);
      })
      .then(function (MB) {
        if (!MB) return withoutCut(null, new Error('The tools could not be loaded.'));
        return convertCut(MB, blob, edits, report).then(null, function (err) { return withoutCut(MB, err); });
      })
      .then(function (result) {
        report(100);
        return result;
      }, function (err) {
        throw err && err.toasted ? err : failure(MSG_FAILED, err);
      });
  }

  // ---------------------------------------------------------------- export options (captions in the picture, vertical)

  var VERTICAL_W = 1080;
  var VERTICAL_H = 1920;
  var VERTICAL_BITRATE = 6000000;
  var PAGE_COLOR = '#151122';
  var CAPTION_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  function even(n) {
    var v = Math.round(n / 2) * 2;
    return v === 0 ? 0 : v; // never a negative zero
  }

  /**
   * The cue covering a time, or null. The start is inside the cue and the end is not.
   * When two cues overlap, the one that began later wins. Pure; cues and time share one clock, in seconds.
   */
  function activeCueAt(cues, timeSec) {
    var t = Number(timeSec);
    if (!Array.isArray(cues) || !isFinite(t)) return null;
    var found = null;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c) continue;
      var start = Number(c.start);
      var end = Number(c.end);
      if (!(start <= t && t < end)) continue;
      if (!found || start >= Number(found.start)) found = c;
    }
    return found;
  }

  /**
   * Word wrap: an array of at most maxLines lines, none longer than maxCharsPerLine and none empty.
   * Text that does not fit ends in an ellipsis. A word longer than a line is broken. Pure.
   */
  function wrapCaption(text, maxCharsPerLine, maxLines) {
    var width = Math.max(1, Math.floor(Number(maxCharsPerLine)) || 1);
    var limit = Math.max(1, Math.floor(Number(maxLines)) || 1);
    var words = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().split(' ');
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (!word) continue;
      while (word.length > width) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    if (lines.length <= limit) return lines;
    var kept = lines.slice(0, limit);
    var lastLine = kept[limit - 1];
    if (lastLine.length > width - 1) lastLine = lastLine.slice(0, width - 1);
    lastLine = lastLine.replace(/[\s.,;:!?-]+$/, '');
    kept[limit - 1] = lastLine + '\u2026';
    return kept;
  }

  /**
   * Where things go in a 1080 x 1920 export. Pure; every number is even.
   * The whole source frame is fitted to the width with its top at about 26% of the height,
   * and captionBand is the empty space below it.
   */
  function verticalLayout(srcW, srcH) {
    var w = Number(srcW) > 0 ? Number(srcW) : 16;
    var h = Number(srcH) > 0 ? Number(srcH) : 9;
    var scale = Math.min(VERTICAL_W / w, VERTICAL_H / h);
    var vw = Math.min(VERTICAL_W, Math.max(2, even(w * scale)));
    var vh = Math.min(VERTICAL_H, Math.max(2, even(h * scale)));
    var x = even((VERTICAL_W - vw) / 2);
    var y = even(VERTICAL_H * 0.26);
    if (y + vh > VERTICAL_H) y = even((VERTICAL_H - vh) / 2 - 0.5); // a tall source is centered instead
    if (y < 0) y = 0;
    var bandY = y + vh;
    return {
      outW: VERTICAL_W,
      outH: VERTICAL_H,
      video: { x: x, y: y, w: vw, h: vh },
      captionBand: { x: 0, y: bandY, w: VERTICAL_W, h: VERTICAL_H - bandY }
    };
  }

  /**
   * Cues in SOURCE time -> cues in the time of the exported file, for the given trim and cut.
   * A cue wholly inside a removed part is dropped; one that crosses an edge is clipped to what is kept.
   * edits must already be settled (a numeric trimEnd). Returns a new array; the cues given are not changed.
   */
  function cuesForExport(cues, edits) {
    var out = [];
    if (!Array.isArray(cues)) return out;
    var cut = edits.cut;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c || !String(c.text == null ? '' : c.text).trim()) continue;
      var a = Math.max(Number(c.start), edits.trimStart);
      var b = Math.min(Number(c.end), edits.trimEnd);
      if (cut) {
        if (a >= cut.start && a < cut.end) a = cut.end;
        if (b > cut.start && b <= cut.end) b = cut.start;
      }
      if (!(b - a > 0.05)) continue;
      var start = mapTime(a, edits);
      var end = mapTime(b, edits);
      if (end === null && cut && b === cut.start) end = cut.start - edits.trimStart; // the cut's first instant is the join
      if (start === null || end === null || !(end > start)) continue;
      out.push({ start: start, end: end, text: String(c.text) });
    }
    return out;
  }

  /** What was asked for, settled. on is false when nothing is. */
  function readOptions(options, recording) {
    var o = options && typeof options === 'object' ? options : {};
    var cues = Array.isArray(o.cues) ? o.cues : (recording && Array.isArray(recording.cues) ? recording.cues : []);
    var burn = !!o.burnCaptions && cues.length > 0;
    var vertical = o.size === 'vertical';
    return { on: burn || vertical, asked: !!o.burnCaptions || vertical, burn: burn, vertical: vertical, cues: cues };
  }

  function makeCanvas(width, height) {
    if (typeof root.OffscreenCanvas === 'function') return new root.OffscreenCanvas(width, height);
    var canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /** Choose the lines and the font size for one cue: shrink a little before cutting text short. */
  function fitCaption(ctx, text, baseSize, maxWidth, maxLines) {
    var plain = String(text).replace(/\s+/g, ' ').trim();
    var scales = [1, 0.9, 0.8, 0.7];
    var size = baseSize;
    var lines = [];
    for (var i = 0; i < scales.length; i++) {
      size = Math.max(12, Math.round(baseSize * scales[i]));
      lines = wrapCaption(plain, Math.max(6, Math.floor(maxWidth / (size * 0.56))), maxLines);
      var cutShort = lines.length > 0 && lines[lines.length - 1].slice(-1) === '\u2026' && plain.slice(-1) !== '\u2026';
      if (!cutShort) break;
    }
    // The character count is an estimate; the real widths decide.
    ctx.font = 'bold ' + size + 'px ' + CAPTION_FONT;
    var widest = 0;
    for (var j = 0; j < lines.length; j++) widest = Math.max(widest, ctx.measureText(lines[j]).width);
    if (widest > maxWidth) {
      size = Math.max(10, Math.floor(size * maxWidth / widest));
      ctx.font = 'bold ' + size + 'px ' + CAPTION_FONT;
      widest = 0;
      for (var k = 0; k < lines.length; k++) widest = Math.max(widest, ctx.measureText(lines[k]).width);
    }
    return { lines: lines, size: size, width: widest };
  }

  /** Draw one caption: a rounded dark box with white bold text. place.top or place.bottom fixes it vertically. */
  function drawCaption(ctx, fit, centerX, place) {
    if (!fit.lines.length) return;
    var size = fit.size;
    var lineHeight = Math.round(size * 1.28);
    var padX = Math.round(size * 0.6);
    var padY = Math.round(size * 0.38);
    var w = Math.ceil(fit.width) + padX * 2;
    var h = lineHeight * fit.lines.length + padY * 2;
    var x = Math.round(centerX - w / 2);
    var y = Math.round(place.top != null ? place.top : place.bottom - h);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, Math.round(size * 0.4));
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.font = 'bold ' + size + 'px ' + CAPTION_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    for (var i = 0; i < fit.lines.length; i++) {
      ctx.fillText(fit.lines[i], centerX, y + padY + lineHeight * (i + 0.5));
    }
  }

  /**
   * The conversion with every picture frame redrawn: captions painted in, and/or the 1080 x 1920 layout.
   * The trim and the cut are applied the same way the cut export applies them. Sound is left as it is
   * unless there is a cut, which has to take the same stretch out of the sound.
   */
  function convertStyled(MB, blob, edits, report, style) {
    var input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
    var output = null;
    var expected = 0;
    var span = 0;
    var burned = false;
    return Promise.all([input.computeDuration(), input.getPrimaryVideoTrack()]).then(function (got) {
      var sourceDuration = got[0];
      var track = got[1];
      if (!track) throw new Error('The recording has no picture.');
      var start = edits.trimStart;
      var end = edits.trimEnd;
      if (isFinite(sourceDuration) && sourceDuration > 0) end = Math.min(end, sourceDuration);
      var cutStart = 0;
      var cutEnd = 0;
      if (edits.cut) {
        cutStart = edits.cut.start - start;
        cutEnd = Math.min(edits.cut.end, end) - start;
        if (!(cutEnd - cutStart > 0)) throw new Error('The cut is empty for this file.');
      }
      span = end - start;
      expected = span - (cutEnd - cutStart);
      if (!(expected > 0)) throw new Error('Nothing is left to keep for this file.');

      var srcW = Number(track.displayWidth);
      var srcH = Number(track.displayHeight);
      if (!(srcW > 0 && srcH > 0)) throw new Error('The size of the picture is not known.');
      var layout = style.vertical ? verticalLayout(srcW, srcH) : null;
      var outW = layout ? layout.outW : even(srcW);
      var outH = layout ? layout.outH : even(srcH);
      var cues = style.burn ? cuesForExport(style.cues, { trimStart: start, trimEnd: end, cut: edits.cut }) : [];
      burned = cues.length > 0;

      var canvas = api._makeCanvas(outW, outH);
      var ctx = canvas.getContext('2d', { alpha: false });
      var fits = {}; // one layout per cue text, worked out once
      function caption(text) {
        if (!fits[text]) {
          fits[text] = layout
            ? fitCaption(ctx, text, Math.round(outH * 0.034), outW * 0.86, 3)
            : fitCaption(ctx, text, Math.max(22, Math.round(outH * 0.042)), outW * 0.86, 2);
        }
        return fits[text];
      }

      var video = {
        codec: 'avc',
        forceTranscode: true,
        processedWidth: outW,
        processedHeight: outH,
        process: function (sample) {
          if (span > 0) report(hold(sample.timestamp / span, 0, 1) * 99);
          var to = retime(sample.timestamp, sample.duration, cutStart, cutEnd);
          if (!to) return null;
          if (to.timestamp !== sample.timestamp) sample.setTimestamp(to.timestamp);
          if (to.duration !== sample.duration && typeof sample.setDuration === 'function') sample.setDuration(to.duration);
          if (layout) {
            ctx.fillStyle = PAGE_COLOR;
            ctx.fillRect(0, 0, outW, outH);
            sample.draw(ctx, layout.video.x, layout.video.y, layout.video.w, layout.video.h);
          } else {
            sample.draw(ctx, 0, 0, outW, outH);
          }
          var cue = burned ? activeCueAt(cues, to.timestamp) : null;
          if (cue) {
            if (layout) drawCaption(ctx, caption(cue.text), outW / 2, { top: layout.captionBand.y + Math.round(outH * 0.035) });
            else drawCaption(ctx, caption(cue.text), outW / 2, { bottom: Math.round(outH * 0.94) });
          }
          // The library takes the picture off the canvas and stamps it with this sample's time.
          return canvas;
        }
      };
      var options = { input: input, output: null, trim: { start: start, end: end }, video: video, showWarnings: false };
      if (edits.cut) {
        options.audio = {
          codec: 'aac',
          forceTranscode: true,
          process: function (sample) {
            var ts = sample.timestamp;
            var sampleEnd = ts + sample.duration;
            var tiny = 1e-6;
            if (sampleEnd <= cutStart + tiny) return sample;
            if (ts >= cutEnd - tiny) {
              sample.setTimestamp(ts - (cutEnd - cutStart));
              return sample;
            }
            var pieces = [];
            var frames = sample.numberOfFrames;
            var headFrames = hold(Math.round((cutStart - ts) * sample.sampleRate), 0, frames);
            var tailFrom = hold(Math.round((cutEnd - ts) * sample.sampleRate), 0, frames);
            if (headFrames > 0) pieces.push(sample.trim(0, headFrames));
            if (tailFrom < frames) {
              var tail = sample.trim(tailFrom, frames);
              tail.setTimestamp(tail.timestamp - (cutEnd - cutStart));
              pieces.push(tail);
            }
            return pieces.length > 0 ? pieces : null;
          }
        };
      }
      if (typeof MB.Quality === 'function') {
        var bitsPerSecond = isFinite(sourceDuration) && sourceDuration > 0 && blob.size > 0 ? (blob.size * 8) / sourceDuration : 4000000;
        video.quality = new MB.Quality(layout ? VERTICAL_BITRATE : Math.round(hold(bitsPerSecond, 1500000, 12000000)));
        if (options.audio) options.audio.quality = new MB.Quality(128000);
      }
      output = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.BufferTarget() });
      options.output = output;
      return MB.Conversion.init(options);
    }).then(function (conversion) {
      if (!conversion.isValid) throw new Error('The conversion is not valid.');
      var discarded = conversion.discardedTracks;
      if (discarded && discarded.length > 0) throw new Error('The conversion would drop a track.');
      return conversion.execute(); // progress is counted from the frames, as in the cut export
    }).then(function () {
      var buffer = output.target.buffer;
      if (!buffer) throw new Error('The conversion finished with nothing in it.');
      var result = { blob: new Blob([buffer], { type: 'video/mp4' }), mimeType: 'video/mp4' };
      if (edits.cut) result.cutApplied = true;
      result.captionsBurned = burned;
      result.size = style.vertical ? 'vertical' : 'original';
      var check = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(result.blob) });
      return Promise.resolve(check.computeDuration()).then(function (made) {
        if (!(Math.abs(made - expected) <= 0.5)) {
          throw new Error('The file came out ' + made + ' s long, not ' + expected + ' s.');
        }
        return result;
      });
    });
  }

  /**
   * exportEdited(recording, options): Promise of { blob, mimeType, ... }. The original blob is never changed.
   * With no options (or none switched on) this is the plain export above, unchanged.
   * options.burnCaptions (boolean) with options.cues (source time, seconds; the recording's own cues when left out)
   * paints the captions into the picture; options.size 'vertical' makes a 1080 x 1920 file.
   * The result then also carries captionsBurned (true or false) and size ('original' or 'vertical').
   * If the options cannot be applied, the plain export is returned with captionsBurned false and size 'original',
   * and no toast: the caller reads those two fields and says so.
   */
  function exportEdited(recording, options) {
    var style = readOptions(options, recording);
    function plain() {
      return exportPlain(recording).then(function (result) {
        if (!style.asked) return result;
        var out = { blob: result.blob, mimeType: result.mimeType };
        if ('cutApplied' in result) out.cutApplied = result.cutApplied;
        out.captionsBurned = false;
        out.size = 'original';
        return out;
      });
    }
    var rec = recording || {};
    if (!style.on || !rec.blob) return plain();

    var edits;
    try { edits = normalizeEdits(rec.edits, Number(rec.durationMs) / 1000); } catch (err) { return plain(); }
    if (!(edits.trimEnd > 0)) return plain(); // a recording with no known length cannot be redrawn

    var id = rec.id;
    var last = -1;
    function report(pct) {
      var p = Math.round(hold(isFinite(pct) ? pct : 0, 0, 100));
      if (p <= last) return;
      last = p;
      emit('export:progress', { id: id, pct: p });
    }

    report(0);
    return Promise.resolve()
      .then(function () { return api._loadLibrary(); })
      .then(function (MB) { return convertStyled(MB, rec.blob, edits, report, style); })
      .then(function (result) {
        report(100);
        return result;
      }, function (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[editor] the export options could not be applied to the saved file:', err);
        }
        return plain();
      });
  }

  // ---------------------------------------------------------------- namespace

  var api = {
    normalizeEdits: normalizeEdits,
    keptRanges: keptRanges,
    editedDuration: editedDuration,
    mapTime: mapTime,
    hasTrim: hasTrim,
    needsExport: needsExport,
    // true: exportEdited takes the middle cut out of the saved file as well as the trim.
    // The UI reads this at start-up to choose the wording of the cut control.
    exportsCut: true,
    // What exportEdited's options can do in this build, so the UI can hide a choice that is not there.
    exportOptions: { burnCaptions: true, vertical: true },
    activeCueAt: activeCueAt,
    wrapCaption: wrapCaption,
    verticalLayout: verticalLayout,
    attachPlayer: attachPlayer,
    exportEdited: exportEdited,
    // Internal, for tests: where a sample lands once the cut is out (pure, tested).
    _retime: retime,
    // Internal, for tests: cues moved into the exported file's time (pure, tested).
    _cuesForExport: cuesForExport,
    // Internal, for tests: where the drawing surface comes from, so a test can stand in for it.
    _makeCanvas: makeCanvas,
    // Internal, for tests: the one place the library is fetched, so a test can stand in for it.
    _loadLibrary: function () { return import(MEDIABUNNY_URL); }
  };

  if (Takes) Takes.editor = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
