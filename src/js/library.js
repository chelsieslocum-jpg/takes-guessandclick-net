/* takes:library */
/*
 * library.js: the local library of recordings and the one key-value store.
 * This is the ONLY module that opens IndexedDB (database "takes", version 1,
 * stores "recordings" and "kv"). Every method returns a Promise and never
 * rejects because of storage: when IndexedDB is missing, blocked, throws, or a
 * transaction aborts (a full disk included), the library carries on in memory
 * for the rest of the session and says so once.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  var DB_NAME = 'takes';
  var DB_VERSION = 1;
  var STORE_RECORDINGS = 'recordings';
  var STORE_KV = 'kv';

  // A database that never answers must not hang the whole app.
  var OPEN_TIMEOUT_MS = 5000;

  var TOAST_NOT_KEEPING = 'This browser is not saving recordings between visits. ' +
    'Your recordings will only be kept until you close this tab, so download the ones you want to keep.';
  var TOAST_ADD_FAILED = 'This recording could not be saved in the browser (its storage may be full). ' +
    'It is safe for now, but only until you close this tab, so download it before you leave.';

  // ---------------------------------------------------------------- state

  var mem = { recordings: new Map(), kv: new Map() };
  var memoryMode = false;      // true once the session has fallen back to memory
  var announced = false;       // the one toast has been shown
  var db = null;               // the open connection, reused
  var dbPromise = null;
  var fallbackPromise = null;
  var queue = Promise.resolve(); // operations run one at a time, in the order they were asked for

  function noop() {}

  function emit(event, payload) {
    if (Takes && Takes.bus) Takes.bus.emit(event, payload);
  }

  function copy(recording) {
    return Object.assign({}, recording);
  }

  /** Shallow merge. The id can never be changed by a patch. */
  function merge(current, patch) {
    var next = Object.assign({}, current, patch && typeof patch === 'object' ? patch : {});
    next.id = current.id;
    return next;
  }

  function createdAtOf(recording) {
    var n = Number(recording && recording.createdAt);
    return isFinite(n) ? n : 0;
  }

  function sortNewest(list) {
    return list.slice().sort(function (a, b) { return createdAtOf(b) - createdAtOf(a); });
  }

  function hasId(id) {
    return id !== undefined && id !== null && id !== '';
  }

  // ---------------------------------------------------------------- IndexedDB plumbing

  function getFactory() {
    try {
      var factory = root.indexedDB;
      return factory && typeof factory.open === 'function' ? factory : null;
    } catch (err) {
      return null;
    }
  }

  function dropConnection(connection) {
    try { connection.close(); } catch (err) { /* already closed */ }
    if (db === connection) {
      db = null;
      dbPromise = null;
    }
  }

  /** Open the database on first use and reuse the connection afterwards. */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var factory = getFactory();
      if (!factory) {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      var settled = false;
      var timer = null;
      function fail(err) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }

      var request = factory.open(DB_NAME, DB_VERSION);
      timer = setTimeout(function () {
        fail(new Error('The browser storage did not answer in time.'));
      }, OPEN_TIMEOUT_MS);

      request.onupgradeneeded = function () {
        var upgrading = request.result;
        if (!upgrading.objectStoreNames.contains(STORE_RECORDINGS)) {
          upgrading.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        }
        if (!upgrading.objectStoreNames.contains(STORE_KV)) {
          upgrading.createObjectStore(STORE_KV);
        }
      };
      request.onblocked = function () {
        fail(new Error('The browser storage is held open by another tab.'));
      };
      request.onerror = function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        fail(request.error || new Error('The browser storage could not be opened.'));
      };
      request.onsuccess = function () {
        var connection = request.result;
        if (settled) {
          // It opened after we had already given up on it; do not keep it.
          try { connection.close(); } catch (err) { /* nothing to close */ }
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        // Another tab wants a newer version: let go, so it is never blocked by this one.
        connection.onversionchange = function () { dropConnection(connection); };
        connection.onclose = function () { dropConnection(connection); };
        db = connection;
        resolve(connection);
      };
    });
    return dbPromise;
  }

  /**
   * Run work(transaction, setResult) and resolve with the result once the
   * transaction has really committed. An abort (quota included) rejects.
   */
  function withTx(connection, stores, mode, work) {
    return new Promise(function (resolve, reject) {
      var result;
      var transaction = connection.transaction(stores, mode);
      transaction.oncomplete = function () { resolve(result); };
      transaction.onabort = function () {
        reject(transaction.error || new Error('The browser storage refused the change.'));
      };
      try {
        work(transaction, function (value) { result = value; });
      } catch (err) {
        try { transaction.abort(); } catch (abortErr) { /* already finished */ }
        reject(err);
      }
    });
  }

  function idbList(connection) {
    return withTx(connection, STORE_RECORDINGS, 'readonly', function (transaction, set) {
      var request = transaction.objectStore(STORE_RECORDINGS).getAll();
      request.onsuccess = function () { set(sortNewest(request.result || [])); };
    });
  }

  function idbGet(connection, id) {
    return withTx(connection, STORE_RECORDINGS, 'readonly', function (transaction, set) {
      set(null);
      var request = transaction.objectStore(STORE_RECORDINGS).get(id);
      request.onsuccess = function () { set(request.result || null); };
    });
  }

  function idbPut(connection, recording) {
    return withTx(connection, STORE_RECORDINGS, 'readwrite', function (transaction) {
      transaction.objectStore(STORE_RECORDINGS).put(recording);
    });
  }

  function idbUpdate(connection, id, patch) {
    return withTx(connection, STORE_RECORDINGS, 'readwrite', function (transaction, set) {
      set(null);
      var store = transaction.objectStore(STORE_RECORDINGS);
      var request = store.get(id);
      request.onsuccess = function () {
        var current = request.result;
        if (!current) return;
        var next = merge(current, patch);
        store.put(next);
        set(next);
      };
    });
  }

  function idbRemove(connection, id) {
    return withTx(connection, STORE_RECORDINGS, 'readwrite', function (transaction) {
      transaction.objectStore(STORE_RECORDINGS).delete(id);
    });
  }

  function idbKvGet(connection, key) {
    return withTx(connection, STORE_KV, 'readonly', function (transaction, set) {
      var request = transaction.objectStore(STORE_KV).get(key);
      request.onsuccess = function () { set(request.result); };
    });
  }

  // The value is stored as it is (structured clone), never as text, so a folder handle survives.
  function idbKvSet(connection, key, value) {
    return withTx(connection, STORE_KV, 'readwrite', function (transaction) {
      transaction.objectStore(STORE_KV).put(value, key);
    });
  }

  // ---------------------------------------------------------------- memory fallback

  function memList() {
    var list = [];
    mem.recordings.forEach(function (recording) { list.push(copy(recording)); });
    return sortNewest(list);
  }

  /** Copy whatever the database can still give us into memory, without overwriting anything already there. */
  function salvage() {
    var connection = db;
    if (!connection) return Promise.resolve();
    return withTx(connection, [STORE_RECORDINGS, STORE_KV], 'readonly', function (transaction, set) {
      var kv = transaction.objectStore(STORE_KV);
      set({
        recordings: transaction.objectStore(STORE_RECORDINGS).getAll(),
        keys: kv.getAllKeys(),
        values: kv.getAll()
      });
    }).then(function (requests) {
      var recordings = requests.recordings.result || [];
      var keys = requests.keys.result || [];
      var values = requests.values.result || [];
      var i;
      for (i = 0; i < recordings.length; i++) {
        if (recordings[i] && !mem.recordings.has(recordings[i].id)) {
          mem.recordings.set(recordings[i].id, recordings[i]);
        }
      }
      for (i = 0; i < keys.length; i++) {
        if (!mem.kv.has(keys[i])) mem.kv.set(keys[i], values[i]);
      }
    });
  }

  function markCaps() {
    if (Takes && Takes.state && Takes.state.caps) Takes.state.caps.indexedDB = false;
  }

  /** Switch to memory for the rest of the session. Happens once; says so once. */
  function fallBack(err, opName) {
    if (!fallbackPromise) {
      fallbackPromise = salvage().then(noop, noop).then(function () {
        memoryMode = true;
        markCaps();
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[' + (Takes ? Takes.PRODUCT_NAME : 'Takes') + '] keeping recordings in memory only:',
            err && err.message ? err.message : err);
        }
        if (!announced) {
          announced = true;
          emit('toast', { kind: 'error', text: opName === 'add' ? TOAST_ADD_FAILED : TOAST_NOT_KEEPING });
        }
      });
    }
    return fallbackPromise;
  }

  /** Try the database; on any failure fall back and run the same operation against memory. */
  function exec(opName, idbOp, memOp) {
    if (memoryMode) return Promise.resolve().then(memOp);
    return openDb().then(idbOp).then(null, function (err) {
      return fallBack(err, opName).then(memOp);
    });
  }

  function enqueue(job) {
    var run = queue.then(job);
    queue = run.then(noop, noop);
    return run;
  }

  function refresh() {
    return exec('list', idbList, memList).then(function (list) {
      if (Takes && Takes.state) Takes.state.recordings = list;
      return list;
    });
  }

  function changed() {
    return refresh().then(function (list) {
      emit('library:changed', { recordings: list });
    });
  }

  // detectCaps only asks whether IndexedDB exists; if it runs after a fallback, keep the truth.
  if (Takes && Takes.bus) {
    Takes.bus.on('caps:ready', function () {
      if (memoryMode) markCaps();
    });
  }

  // ---------------------------------------------------------------- the api

  function add(recording) {
    if (!recording || typeof recording !== 'object' || !hasId(recording.id)) {
      return Promise.reject(new TypeError('A recording needs an id before it can be stored.'));
    }
    var stored = copy(recording);
    return enqueue(function () {
      return exec('add',
        function (connection) { return idbPut(connection, stored); },
        function () { mem.recordings.set(stored.id, stored); }
      ).then(changed).then(function () { return copy(stored); });
    });
  }

  function list() {
    return enqueue(refresh);
  }

  function get(id) {
    if (!hasId(id)) return Promise.resolve(null);
    return enqueue(function () {
      return exec('get',
        function (connection) { return idbGet(connection, id); },
        function () {
          var found = mem.recordings.get(id);
          return found ? copy(found) : null;
        }
      );
    });
  }

  function update(id, patch) {
    if (!hasId(id)) return Promise.resolve(null);
    return enqueue(function () {
      return exec('update',
        function (connection) { return idbUpdate(connection, id, patch); },
        function () {
          var current = mem.recordings.get(id);
          if (!current) return null;
          var next = merge(current, patch);
          mem.recordings.set(id, next);
          return copy(next);
        }
      ).then(function (updated) {
        if (!updated) return null;
        return changed().then(function () { return updated; });
      });
    });
  }

  function rename(id, name) {
    return update(id, { name: String(name == null ? '' : name) });
  }

  function remove(id) {
    if (!hasId(id)) return Promise.resolve(undefined);
    return enqueue(function () {
      return exec('remove',
        function (connection) { return idbRemove(connection, id); },
        function () { mem.recordings.delete(id); }
      ).then(changed).then(noop);
    });
  }

  function kvGet(key) {
    var k = String(key);
    return enqueue(function () {
      return exec('kvGet',
        function (connection) { return idbKvGet(connection, k); },
        function () { return mem.kv.get(k); }
      );
    });
  }

  function kvSet(key, value) {
    var k = String(key);
    return enqueue(function () {
      return exec('kvSet',
        function (connection) { return idbKvSet(connection, k, value); },
        function () { mem.kv.set(k, value); }
      ).then(noop);
    });
  }

  var api = {
    add: add,
    list: list,
    get: get,
    rename: rename,
    remove: remove,
    update: update,
    kvGet: kvGet,
    kvSet: kvSet
  };

  if (Takes) Takes.library = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
