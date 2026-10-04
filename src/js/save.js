/* takes:save */
/*
 * save.js: the two ways a recording leaves the app.
 *   1. download            - an ordinary browser download.
 *   2. saveToCloudFolder   - a file written into a folder the person picked,
 *                            ideally a folder that syncs (Drive, OneDrive, Dropbox, iCloud).
 * Takes never uploads anything and cannot know whether a folder really syncs,
 * so no message here claims an upload happened.
 * The folder handle is kept through Takes.library.kvGet / kvSet only; this file never opens IndexedDB.
 *
 * Notes for ui.js:
 *   - chooseCloudFolder() and saveToCloudFolder() must be called straight from a click handler.
 *     The folder picker and the permission prompt both need a fresh click; call them before
 *     any slow work (do the trimmed export first only if it finishes within a few seconds of the click,
 *     otherwise the browser may refuse the prompt and the person is told to click again).
 *   - Every rejection carries err.code and err.toasted = true; this module has already said what happened,
 *     or deliberately said nothing (code 'cancelled').
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var KV_KEY = 'cloudFolder';
  var MAX_NAME_CHARS = 100;
  // Long enough for the browser to have begun reading the Blob for the download.
  var REVOKE_DELAY_MS = 60000;

  // Names Windows keeps for devices; a file called exactly one of these cannot be created there.
  var RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

  // The folder handle for this session, so a save does not wait on storage after the click.
  var memoryHandle = null;

  // ---------------------------------------------------------------- pure helpers

  /**
   * A recording name -> text that is safe as a file name on Windows and macOS, with NO extension.
   * Each of \ / : * ? " < > | and every control character becomes '-'. Trimmed, cut to 100 characters.
   * May return '' (the caller falls back to a dated name).
   */
  function sanitizeName(name) {
    var text = name == null ? '' : String(name);
    text = text.replace(/[\\\/:*?"<>|\u0000-\u001f\u007f]/g, '-');
    text = text.replace(/^\s+|\s+$/g, '');
    if (text.length > MAX_NAME_CHARS) {
      text = text.slice(0, MAX_NAME_CHARS);
      // Never leave half of a two-part character (an emoji) at the cut.
      var last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    }
    // Windows refuses a name that ends in a dot or a space.
    text = text.replace(/[\s.]+$/g, '');
    if (RESERVED.test(text)) text = '_' + text;
    return text;
  }

  /** 'video/mp4;codecs=avc1,mp4a.40.2' -> 'mp4'. Anything unknown is 'mp4', the only format Takes records. */
  function extForMime(mimeType) {
    var type = String(mimeType == null ? '' : mimeType).toLowerCase().split(';')[0].replace(/\s+/g, '');
    if (type === 'video/mp4' || type === 'audio/mp4') return 'mp4';
    if (type === 'video/webm' || type === 'audio/webm') return 'webm';
    if (type === 'text/vtt') return 'vtt';
    return 'mp4';
  }

  function cleanExt(ext) {
    var e = String(ext == null ? '' : ext).replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    return e;
  }

  /**
   * The file name for a recording. ext defaults to the one matching recording.mimeType.
   * An empty name falls back to Takes.util.makeFileName(new Date(recording.createdAt), ext).
   */
  function fileName(recording, ext) {
    var rec = recording || {};
    var e = cleanExt(ext) || extForMime(rec.mimeType);
    var base = sanitizeName(rec.name);
    // A name typed as 'demo.mp4' is saved as 'demo.mp4', never 'demo.mp4.mp4'.
    var tail = '.' + e;
    if (base.length > tail.length && base.slice(-tail.length).toLowerCase() === tail) {
      base = sanitizeName(base.slice(0, -tail.length));
    }
    if (!base) return Takes.util.makeFileName(new Date(rec.createdAt), e);
    return base + '.' + e;
  }

  function splitName(name) {
    var text = String(name);
    var dot = text.lastIndexOf('.');
    if (dot <= 0) return { base: text, ext: '' };
    return { base: text.slice(0, dot), ext: text.slice(dot + 1) };
  }

  function toLookup(existing) {
    var seen = {};
    if (!existing) return seen;
    var add = function (value) { seen['$' + String(value).toLowerCase()] = true; };
    if (typeof existing.forEach === 'function') existing.forEach(function (value) { add(value); });
    return seen;
  }

  /**
   * A base name that is free for EVERY extension in exts, given the names already in the folder.
   * 'demo' -> 'demo', then 'demo (2)', 'demo (3)' and so on. Compared without regard to case,
   * because Windows and macOS folders treat 'Demo.mp4' and 'demo.mp4' as the same file.
   * existing is a Set or an array of file names.
   */
  function uniqueBase(base, exts, existing) {
    var seen = toLookup(existing);
    var list = exts && exts.length ? exts : [''];
    var taken = function (candidate) {
      for (var i = 0; i < list.length; i++) {
        var full = list[i] ? candidate + '.' + list[i] : candidate;
        if (seen['$' + full.toLowerCase()]) return true;
      }
      return false;
    };
    if (!taken(base)) return base;
    var n = 2;
    while (taken(base + ' (' + n + ')')) n++;
    return base + ' (' + n + ')';
  }

  /** 'demo.mp4' with 'demo.mp4' taken -> 'demo (2).mp4'; with that taken too -> 'demo (3).mp4'. */
  function uniqueName(name, existing) {
    var parts = splitName(name);
    var base = uniqueBase(parts.base, [parts.ext], existing);
    return parts.ext ? base + '.' + parts.ext : base;
  }

  // ---------------------------------------------------------------- small internals

  function toast(kind, text) {
    Takes.bus.emit('toast', { kind: kind, text: text });
  }

  function makeError(code, message, cause) {
    var err = new Error(message);
    err.code = code;
    err.toasted = true;
    if (cause) err.cause = cause;
    return err;
  }

  /** Toast an error in plain words and return the Error to reject with. */
  function fail(code, message, cause) {
    toast('error', message);
    return makeError(code, message, cause);
  }

  function pickerSupported() {
    return typeof root.showDirectoryPicker === 'function';
  }

  function unsupportedError() {
    return fail('unsupported',
      'This browser cannot save into a cloud folder. Use Download instead, or open ' +
      Takes.PRODUCT_NAME + ' in Chrome or Edge.');
  }

  function isHandle(value) {
    return !!value && typeof value === 'object' && typeof value.getFileHandle === 'function';
  }

  function folderLabel(handle) {
    var name = handle && typeof handle.name === 'string' ? handle.name : '';
    return name && name !== '\\' && name !== '/' ? name : 'your cloud folder';
  }

  /** What actually gets saved: the trimmed export when one was passed, otherwise the recording itself. */
  function pickSource(recording, blobOverride) {
    var rec = recording || {};
    if (blobOverride && blobOverride.blob) {
      return { blob: blobOverride.blob, mimeType: blobOverride.mimeType || blobOverride.blob.type || rec.mimeType, edited: true };
    }
    return { blob: rec.blob || null, mimeType: rec.mimeType || (rec.blob && rec.blob.type) || '', edited: false };
  }

  async function loadHandle() {
    if (isHandle(memoryHandle)) return memoryHandle;
    var lib = Takes.library;
    if (!lib || typeof lib.kvGet !== 'function') return null;
    var stored = null;
    try { stored = await lib.kvGet(KV_KEY); } catch (err) { stored = null; }
    if (!isHandle(stored)) return null;
    memoryHandle = stored;
    return stored;
  }

  async function forgetHandle() {
    memoryHandle = null;
    var lib = Takes.library;
    if (!lib || typeof lib.kvSet !== 'function') return;
    try { await lib.kvSet(KV_KEY, null); } catch (err) { /* nothing more to do */ }
  }

  /** Turn a file-system failure into a toast and a coded Error. */
  async function fsError(err, handle) {
    var name = err && err.name;
    var label = folderLabel(handle);
    if (name === 'NotFoundError') {
      await forgetHandle();
      return fail('no-folder', 'That cloud folder is gone. Choose it again.', err);
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return fail('permission-denied',
        Takes.PRODUCT_NAME + ' was not allowed to save into ' + label +
        '. Press Save to my cloud folder again and choose Allow, or choose another cloud folder.', err);
    }
    if (name === 'QuotaExceededError') {
      return fail('write-failed',
        'There is not enough free space in ' + label + '. Free some space, or use Download instead.', err);
    }
    return fail('write-failed',
      'The recording could not be saved to ' + label + '. Try again, or use Download instead.', err);
  }

  async function ensurePermission(handle) {
    var opts = { mode: 'readwrite' };
    var state = 'granted';
    if (typeof handle.queryPermission === 'function') state = await handle.queryPermission(opts);
    if (state === 'granted') return;
    if (typeof handle.requestPermission === 'function') {
      try { state = await handle.requestPermission(opts); } catch (err) { state = 'denied'; }
    }
    if (state === 'granted') return;
    throw fail('permission-denied',
      Takes.PRODUCT_NAME + ' needs your OK to save into ' + folderLabel(handle) +
      '. Press Save to my cloud folder again and choose Allow, or choose another cloud folder.');
  }

  async function listNames(handle) {
    var names = [];
    var it = typeof handle.keys === 'function' ? handle.keys() : null;
    if (!it) return names;
    for await (var key of it) names.push(key);
    return names;
  }

  /** Create name in dir and fill it. A file that could not be finished is removed again. */
  async function writeFile(dir, name, data) {
    var created = false;
    var writable = null;
    try {
      var fileHandle = await dir.getFileHandle(name, { create: true });
      created = true;
      writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
    } catch (err) {
      if (writable && typeof writable.abort === 'function') {
        try { await writable.abort(); } catch (ignored) { /* already closed */ }
      }
      if (created && typeof dir.removeEntry === 'function') {
        try { await dir.removeEntry(name); } catch (ignored) { /* leave it */ }
      }
      throw err;
    }
  }

  /** The WebVTT text to write beside the video, or null when there is nothing to write. */
  function vttTextFor(recording, edited) {
    var rec = recording || {};
    var cues = rec.cues;
    var captions = Takes.captions;
    if (!cues || !cues.length) return null;
    if (!captions || typeof captions.toVtt !== 'function') return null;
    if (edited) {
      // The exported file has the trim applied and still holds the cut section.
      if (typeof captions.shiftCuesForEdits !== 'function') return null;
      var edits = rec.edits || {};
      cues = captions.shiftCuesForEdits(cues, {
        trimStart: edits.trimStart || 0,
        trimEnd: edits.trimEnd == null ? null : edits.trimEnd,
        cut: null
      });
      if (!cues || !cues.length) return null;
    }
    return captions.toVtt(cues);
  }

  // ---------------------------------------------------------------- download

  /**
   * Start an ordinary browser download. Synchronous. Returns the file name,
   * or null when nothing could be downloaded (an error toast says why).
   */
  function download(recording, blobOverride) {
    var source = pickSource(recording, blobOverride);
    var name = fileName(recording, extForMime(source.mimeType));
    var doc = root.document;
    var urls = root.URL;
    if (!source.blob) {
      toast('error', 'This recording has no video to download. Try recording it again.');
      return null;
    }
    if (!doc || !doc.body || !urls || typeof urls.createObjectURL !== 'function') {
      toast('error', 'This browser could not start the download. Open ' + Takes.PRODUCT_NAME + ' in Chrome or Edge and try again.');
      return null;
    }
    var url = '';
    try {
      url = urls.createObjectURL(source.blob);
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
      toast('error', 'The download could not start. Try again, or use Save to my cloud folder.');
      return null;
    }
    root.setTimeout(function () {
      try { urls.revokeObjectURL(url); } catch (ignored) { /* nothing */ }
    }, REVOKE_DELAY_MS);
    return name;
  }

  // ---------------------------------------------------------------- cloud folder

  /**
   * Open the folder picker. MUST be called from a click.
   * Resolves with the folder's name, or with null when the person closed the picker (no toast).
   */
  async function chooseCloudFolder() {
    if (!pickerSupported()) throw unsupportedError();
    var handle = null;
    try {
      handle = await root.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw fail('picker-failed',
        'The window for choosing a cloud folder could not open. Press Choose folder again.', err);
    }
    if (!isHandle(handle)) return null;
    memoryHandle = handle;
    var lib = Takes.library;
    if (lib && typeof lib.kvSet === 'function') {
      try { await lib.kvSet(KV_KEY, handle); } catch (err) { /* kept in memory for this visit */ }
    }
    return handle.name;
  }

  /** The remembered folder's name, or null. Never rejects. */
  async function cloudFolderName() {
    try {
      var handle = await loadHandle();
      return handle && typeof handle.name === 'string' ? handle.name : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * The one path to a folder that can be written to: the remembered handle (memory, then storage),
   * or the picker when there is none; then the permission check, then a look inside to prove
   * the folder is still there. Resolves with the handle, or null when the picker was closed.
   */
  async function readyHandle() {
    if (!pickerSupported()) throw unsupportedError();
    var handle = await loadHandle();
    if (!handle) {
      var picked = await chooseCloudFolder();
      if (picked === null) return null;
      return memoryHandle;
    }
    await ensurePermission(handle);
    try {
      // Reading the first entry fails with NotFoundError when the folder was deleted or moved.
      if (typeof handle.keys === 'function') await handle.keys().next();
    } catch (err) {
      throw await fsError(err, handle);
    }
    return handle;
  }

  /**
   * Make sure a folder is chosen AND writable, now. MUST be called from a click, BEFORE any slow work
   * such as a trimmed export; afterwards saveToCloudFolder writes with no further prompt this session.
   * Resolves with the folder's name, or with null when the person closed the picker (no toast).
   */
  async function ensureCloudAccess() {
    var handle = await readyHandle();
    return handle ? handle.name : null;
  }

  /**
   * Write the recording (and its captions, when it has any) into the chosen folder.
   * MUST be called from a click. Never overwrites: a taken name gets ' (2)', ' (3)' and so on.
   * Resolves with { folderName, fileName, vttFileName }.
   */
  async function saveToCloudFolder(recording, blobOverride) {
    if (!pickerSupported()) throw unsupportedError();
    var source = pickSource(recording, blobOverride);
    if (!source.blob) {
      throw fail('write-failed', 'This recording has no video to save. Try recording it again.');
    }

    var handle = await readyHandle();
    if (!handle) throw makeError('cancelled', 'No cloud folder was chosen.');

    var ext = extForMime(source.mimeType);
    var wanted = splitName(fileName(recording, ext));
    var vttText = null;
    try { vttText = vttTextFor(recording, source.edited); } catch (err) { vttText = null; }

    var videoName = '';
    try {
      var existing = await listNames(handle);
      var base = uniqueBase(wanted.base, vttText === null ? [ext] : [ext, 'vtt'], existing);
      videoName = base + '.' + ext;
      await writeFile(handle, videoName, source.blob);
    } catch (err) {
      throw await fsError(err, handle);
    }

    var vttName = null;
    var vttFailed = false;
    if (vttText !== null) {
      var candidate = videoName.slice(0, -(ext.length + 1)) + '.vtt';
      try {
        var BlobClass = root.Blob;
        await writeFile(handle, candidate, new BlobClass([vttText], { type: 'text/vtt' }));
        vttName = candidate;
      } catch (err) {
        vttFailed = true;
      }
    }

    toast('info', 'Saved to ' + folderLabel(handle) +
      '. Your Drive, OneDrive or Dropbox app uploads it from there. Right-click the file in that folder to get a share link.');
    if (vttFailed) {
      toast('error', 'The video was saved, but the captions file was not. Use Download captions instead.');
    }
    return { folderName: handle.name, fileName: videoName, vttFileName: vttName };
  }

  var api = {
    download: download,
    chooseCloudFolder: chooseCloudFolder,
    saveToCloudFolder: saveToCloudFolder,
    ensureCloudAccess: ensureCloudAccess,
    cloudFolderName: cloudFolderName,
    fileName: fileName,
    sanitizeName: sanitizeName,
    extForMime: extForMime,
    uniqueName: uniqueName,
    uniqueBase: uniqueBase
  };
  Takes.save = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
