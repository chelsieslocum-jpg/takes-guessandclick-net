/* takes:core */
/*
 * core.js: the single global (Takes), the event bus, shared state,
 * capability detection and the pure helpers every other module uses.
 * Loads as a classic script in the browser and under Node for tests.
 */
(function (root) {
  'use strict';

  // The working name lives here and nowhere else. Rename the product by editing this one line.
  var PRODUCT_NAME = 'Takes';

  // Recording is MP4 only. These are probed in this order.
  var MP4_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];

  var CAP_KEYS = ['displayMedia', 'userMedia', 'mp4', 'dirPicker', 'indexedDB', 'webgpu', 'webcodecs', 'docPip'];

  // ---------------------------------------------------------------- bus

  var listeners = {};

  var bus = {
    /** Subscribe. Returns a function that unsubscribes. */
    on: function (event, fn) {
      if (typeof fn !== 'function') return function () {};
      if (!listeners[event]) listeners[event] = [];
      if (listeners[event].indexOf(fn) === -1) listeners[event].push(fn);
      return function () { bus.off(event, fn); };
    },

    off: function (event, fn) {
      var list = listeners[event];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
      if (list.length === 0) delete listeners[event];
    },

    /** Call every listener. One that throws is logged and never stops the others. */
    emit: function (event, payload) {
      var list = listeners[event];
      if (!list) return;
      var snapshot = list.slice();
      for (var i = 0; i < snapshot.length; i++) {
        try {
          snapshot[i](payload);
        } catch (err) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[' + PRODUCT_NAME + '] a listener for "' + event + '" failed:', err);
          }
        }
      }
    }
  };

  // ---------------------------------------------------------------- helpers

  /**
   * Pick the MP4 recording format this browser supports.
   * isSupported is a function (mimeType) -> boolean; it defaults to MediaRecorder.isTypeSupported.
   * Returns { mimeType, ext: 'mp4' } or throws an Error with a plain-words message.
   */
  function pickMimeType(isSupported) {
    var probe = isSupported;
    if (typeof probe !== 'function') {
      var MR = root.MediaRecorder;
      if (typeof MR !== 'undefined' && MR && typeof MR.isTypeSupported === 'function') {
        probe = function (type) { return MR.isTypeSupported(type); };
      } else {
        probe = function () { return false; };
      }
    }
    for (var i = 0; i < MP4_TYPES.length; i++) {
      var ok = false;
      try { ok = !!probe(MP4_TYPES[i]); } catch (err) { ok = false; }
      if (ok) return { mimeType: MP4_TYPES[i], ext: 'mp4' };
    }
    throw new Error('This browser cannot record MP4 video. Please update Chrome or Edge.');
  }

  /** Seconds -> 'm:ss'. Minutes keep counting past 59. Anything that is not a positive finite number is '0:00'. */
  function formatTime(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s < 0) s = 0;
    var whole = Math.floor(s);
    var m = Math.floor(whole / 60);
    var rest = whole % 60;
    return m + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function slug(text) {
    var out = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return out || 'recording';
  }

  /**
   * (Date, 'mp4') -> 'takes-2026-10-04-0931.mp4', in the computer's local time.
   * The prefix is PRODUCT_NAME, lower-cased. A missing or invalid date means now. ext defaults to 'mp4'.
   */
  function makeFileName(date, ext) {
    var d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    var e = String(ext == null || ext === '' ? 'mp4' : ext).replace(/^\.+/, '');
    return slug(PRODUCT_NAME) + '-' +
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + '.' + e;
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function ordinal(n) {
    var lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 13) return n + 'th';
    var last = n % 10;
    return n + (last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th');
  }

  /**
   * (Date) -> 'Take, October 3rd, 8:59 PM': the name a person sees for a new recording.
   * Local time, month first, ordinal day, 12-hour clock with minutes and no seconds.
   * The first word is PRODUCT_NAME without a final "s". A missing or invalid date means now.
   */
  function makeTakeName(date) {
    var d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    var h = d.getHours();
    var word = PRODUCT_NAME.replace(/s$/, '') || PRODUCT_NAME;
    return word + ', ' + MONTHS[d.getMonth()] + ' ' + ordinal(d.getDate()) + ', ' +
      (h % 12 === 0 ? 12 : h % 12) + ':' + pad2(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  /** Keep value between min and max. A value that is not a number becomes min. */
  function clamp(value, min, max) {
    var v = Number(value);
    if (isNaN(v)) return min;
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  // ---------------------------------------------------------------- capabilities

  /**
   * Work out what this browser can do, store it in Takes.state.caps, emit caps:ready and return it.
   * Synchronous. Every probe is wrapped, so a browser missing a feature yields false, never an error.
   * env is for tests only; it defaults to the real global object.
   */
  function detectCaps(env) {
    var g = env || root;
    var nav = g.navigator;
    var md = null;
    try { md = nav && nav.mediaDevices ? nav.mediaDevices : null; } catch (err) { md = null; }

    function probe(fn) {
      try { return !!fn(); } catch (err) { return false; }
    }

    var caps = {
      displayMedia: probe(function () { return md && typeof md.getDisplayMedia === 'function'; }),
      userMedia: probe(function () { return md && typeof md.getUserMedia === 'function'; }),
      mp4: probe(function () {
        var MR = g.MediaRecorder;
        if (!MR || typeof MR.isTypeSupported !== 'function') return false;
        pickMimeType(function (type) { return MR.isTypeSupported(type); });
        return true;
      }),
      dirPicker: probe(function () { return typeof g.showDirectoryPicker === 'function'; }),
      indexedDB: probe(function () { return !!g.indexedDB && typeof g.indexedDB.open === 'function'; }),
      webgpu: probe(function () { return !!(nav && nav.gpu); }),
      webcodecs: probe(function () { return typeof g.VideoEncoder === 'function'; }),
      docPip: probe(function () {
        return !!g.documentPictureInPicture && typeof g.documentPictureInPicture.requestWindow === 'function';
      })
    };

    // Fill the existing object so anything already holding Takes.state.caps sees the result.
    var target = Takes.state.caps;
    for (var i = 0; i < CAP_KEYS.length; i++) target[CAP_KEYS[i]] = caps[CAP_KEYS[i]];
    bus.emit('caps:ready', target);
    return target;
  }

  // ---------------------------------------------------------------- namespace

  var Takes = {
    PRODUCT_NAME: PRODUCT_NAME,
    bus: bus,
    state: { caps: {}, current: null, recordings: [] },
    util: {
      pickMimeType: pickMimeType,
      formatTime: formatTime,
      makeFileName: makeFileName,
      makeTakeName: makeTakeName,
      clamp: clamp
    },
    detectCaps: detectCaps
  };

  root.Takes = Takes;
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined') module.exports = {
  Takes: (typeof window !== 'undefined' ? window : globalThis).Takes
};
