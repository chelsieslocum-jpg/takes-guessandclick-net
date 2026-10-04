/* takes:capture */
/*
 * capture.js: opens the screen, the camera and the microphone, and mixes
 * every sound source into one audio track.
 * Loads as a classic script in the browser and under Node for tests.
 */
(function (root) {
  'use strict';
  var Takes = root.Takes;

  // The one open capture, or null. A new object is made by every start().
  // stop() sets this back to null, which is also how a start() still in
  // flight learns that it was overtaken and must hand back what it opened.
  var session = null;

  // ---------------------------------------------------------------- pure helpers

  /** What the screen picker is asked for. Sound is a request; the person may still share without it. */
  function displayConstraints() {
    return {
      video: { frameRate: { ideal: 30 } },
      audio: true,
      systemAudio: 'include'
    };
  }

  /** An id of '', null or undefined means the default device. */
  function cleanId(id) {
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /** Camera request: picture only, 1280 by 720 when the camera can do it. */
  function cameraConstraints(cameraId) {
    var video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    var id = cleanId(cameraId);
    if (id) video.deviceId = { exact: id };
    return { video: video, audio: false };
  }

  /** Microphone request: sound only, with the browser's own echo and noise handling left on. */
  function micConstraints(micId) {
    var id = cleanId(micId);
    return { audio: id ? { deviceId: { exact: id } } : true, video: false };
  }

  function errorName(err) {
    return err && typeof err.name === 'string' ? err.name : '';
  }

  /**
   * Turn a failed screen share into { kind, text } for a toast.
   * Closing the picker and refusing the share look the same to the page, so both
   * are the gentle 'info' kind; only a block by the computer or a broken share is 'error'.
   */
  function screenProblem(err) {
    var name = errorName(err);
    var message = err && typeof err.message === 'string' ? err.message : '';
    if (name === 'NotSupportedError' || name === 'TypeError') {
      return {
        kind: 'error',
        text: 'This browser cannot record the screen. Open this page in Chrome or Edge on a computer.'
      };
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      if (/system|policy/i.test(message)) {
        return {
          kind: 'error',
          text: 'This computer is blocking screen recording. Allow screen recording for your browser ' +
            'in the computer\'s privacy settings, then press Record again.'
        };
      }
      return {
        kind: 'info',
        text: 'No screen was shared, so nothing was recorded. Press Record and pick a screen, window or tab.'
      };
    }
    if (name === 'AbortError') {
      return {
        kind: 'info',
        text: 'The screen share was closed before it began. Press Record to try again.'
      };
    }
    return {
      kind: 'error',
      text: 'The screen could not be shared. Close any other app that is recording the screen, then press Record again.'
    };
  }

  /**
   * Why a camera or microphone could not be opened, in plain words.
   * which is 'camera' or 'mic'. The sentence says what happened and what to do; it does
   * not say whether recording carries on, because the caller knows that and this does not.
   */
  function deviceProblemText(which, err) {
    var thing = which === 'camera' ? 'camera' : 'microphone';
    var name = errorName(err);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'The ' + thing + ' is blocked for this page. To use it, allow the ' + thing +
        ' from the icon beside the address bar.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No ' + thing + ' was found. Check that it is plugged in and switched on.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'The ' + thing + ' could not be started. Another app may be using it; close that app and try again.';
    }
    if (name === 'NotSupportedError' || name === 'TypeError') {
      return 'This browser cannot use the ' + thing + '. Open this page in Chrome or Edge.';
    }
    return 'The ' + thing + ' could not be started.';
  }

  var VIRTUAL_CAMERA = /virtual|obs|nvidia broadcast|snap camera|xsplit|manycam|droidcam|iriun|epoccam|camo|mmhmm|streamlabs|ndi|vcam/i;
  var INFRARED_CAMERA = /\bIR\b|infrared/i;

  /** True for a camera made by software (OBS, NVIDIA Broadcast and the like), which shows a placeholder when its app is closed. */
  function isVirtualCamera(label) {
    return typeof label === 'string' && label !== '' && VIRTUAL_CAMERA.test(label);
  }

  /** True for the infrared camera a laptop uses for face sign-in; its picture is gray and of no use here. */
  function isInfraredCamera(label) {
    return typeof label === 'string' && label !== '' && INFRARED_CAMERA.test(label);
  }

  function sameText(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  /**
   * Which camera to use. devices are [{ deviceId, label }] for the cameras only.
   * Returns a deviceId, or null for "let the browser choose".
   *  (a) the device whose id is wantedId;
   *  (b) else the device whose label is wantedLabel (exact, then ignoring case), because a page
   *      opened as a file gets new ids on every visit while the label stays the same;
   *  (c) else the first real webcam: not virtual and not infrared;
   *  (d) else the first camera that is not infrared, so with only virtual cameras the first one
   *      is used, which is better than nothing;
   *  (e) else the first camera that has a label (only infrared ones are left);
   *  (f) else null.
   * A camera the person picked is always respected, even a virtual one.
   * A device with no label (before permission is given) cannot be classified, so steps (c) to (e) skip it.
   */
  function pickCamera(devices, wantedId, wantedLabel) {
    var list = [];
    var i;
    if (devices && typeof devices.length === 'number') {
      for (i = 0; i < devices.length; i++) {
        var d = devices[i];
        if (d && typeof d.deviceId === 'string' && d.deviceId !== '') {
          list.push({ deviceId: d.deviceId, label: typeof d.label === 'string' ? d.label.trim() : '' });
        }
      }
    }
    var id = cleanId(wantedId);
    var label = typeof wantedLabel === 'string' ? wantedLabel.trim() : '';
    if (id) {
      for (i = 0; i < list.length; i++) if (list[i].deviceId === id) return id;
    }
    if (label) {
      for (i = 0; i < list.length; i++) if (list[i].label === label) return list[i].deviceId;
      for (i = 0; i < list.length; i++) if (sameText(list[i].label, label)) return list[i].deviceId;
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].label && !isVirtualCamera(list[i].label) && !isInfraredCamera(list[i].label)) return list[i].deviceId;
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].label && !isInfraredCamera(list[i].label)) return list[i].deviceId;
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].label) return list[i].deviceId;
    }
    return null;
  }

  /**
   * The browser's device list -> { cameras, mics }.
   * A camera is { deviceId, label, virtual, infrared }; a microphone carries the same four keys
   * with both flags false, so the two lists have one shape.
   * Labels are empty until the person has allowed the camera or mic once,
   * so an empty one becomes 'Camera 1', 'Microphone 1' and so on.
   */
  function shapeDevices(list) {
    var cameras = [];
    var mics = [];
    if (!list || typeof list.length !== 'number') return { cameras: cameras, mics: mics };
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d) continue;
      var target = d.kind === 'videoinput' ? cameras : d.kind === 'audioinput' ? mics : null;
      if (!target) continue;
      var id = typeof d.deviceId === 'string' ? d.deviceId : '';
      var label = typeof d.label === 'string' ? d.label.trim() : '';
      var isCamera = target === cameras;
      var virtual = isCamera && isVirtualCamera(label);
      var infrared = isCamera && isInfraredCamera(label);
      if (!label) label = (isCamera ? 'Camera ' : 'Microphone ') + (target.length + 1);
      target.push({ deviceId: id, label: label, virtual: virtual, infrared: infrared });
    }
    return { cameras: cameras, mics: mics };
  }

  // ---------------------------------------------------------------- small tools

  function mediaDevices() {
    try {
      var nav = root.navigator;
      return nav && nav.mediaDevices ? nav.mediaDevices : null;
    } catch (err) {
      return null;
    }
  }

  function toast(kind, text) {
    Takes.bus.emit('toast', { kind: kind, text: text });
  }

  /** An Error that already had its toast, with a short code ui.js can react to. */
  function toastedError(text, code) {
    var err = new Error(text);
    err.code = code;
    err.toasted = true;
    return err;
  }

  function namedError(name, text) {
    var err = new Error(text);
    err.name = name;
    return err;
  }

  function stopStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      try { tracks[i].stop(); } catch (err) { /* already stopped */ }
    }
  }

  function firstLive(tracks) {
    if (!tracks) return null;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i] && tracks[i].readyState !== 'ended') return tracks[i];
    }
    return null;
  }

  /** Tell the app when a track ends by itself. A track ended by stop() is ignored. */
  function watch(s, track, reason, source) {
    if (!track || typeof track.addEventListener !== 'function') return;
    // Each source ('screen', 'camera', 'mic') announces its own ending once, so a lost
    // camera never hides the later news that the person stopped the screen share.
    var handler = function () {
      if (session !== s || s.endedSent[source]) return;
      s.endedSent[source] = true;
      Takes.bus.emit('capture:ended', { reason: reason });
    };
    track.addEventListener('ended', handler);
    s.watchers.push({ track: track, handler: handler });
  }

  /** Close everything one session opened. Safe on a session that is half built or already closed. */
  function teardown(s) {
    if (!s) return;
    var i;
    for (i = 0; i < s.watchers.length; i++) {
      try { s.watchers[i].track.removeEventListener('ended', s.watchers[i].handler); } catch (err) { /* gone */ }
    }
    s.watchers = [];
    for (i = 0; i < s.nodes.length; i++) {
      try { s.nodes[i].disconnect(); } catch (err) { /* gone */ }
    }
    s.nodes = [];
    if (s.mixedTrack) {
      try { s.mixedTrack.stop(); } catch (err) { /* gone */ }
      s.mixedTrack = null;
    }
    closeBubble(s);
    stopStream(s.screenStream);
    stopStream(s.cameraStream);
    stopStream(s.micStream);
    s.screenStream = null;
    s.cameraStream = null;
    s.micStream = null;
    closeContext(s);
  }

  function closeContext(s) {
    var ctx = s.ctx;
    s.ctx = null;
    if (!ctx || ctx.state === 'closed' || typeof ctx.close !== 'function') return;
    try {
      var closing = ctx.close();
      if (closing && typeof closing.catch === 'function') closing.catch(function () {});
    } catch (err) { /* already closed */ }
  }

  // ---------------------------------------------------------------- the bubble video file

  var BUBBLE_WAIT_MS = 8000;

  /** True for something a person can pick in a file chooser (a File or any Blob). */
  function isFileLike(file) {
    return !!file && typeof file === 'object' && typeof file.size === 'number' && typeof file.slice === 'function';
  }

  function playQuietly(el) {
    try {
      var playing = el.play();
      if (playing && typeof playing.catch === 'function') playing.catch(function () {});
    } catch (err) { /* nothing to play */ }
  }

  /**
   * Play a video file the person chose, off the page, and hand back its picture as a stream
   * that the rest of the app treats exactly like a camera.
   * The element is muted, so the file is never heard in the room and cannot leak into the
   * microphone; its sound is taken from the captured stream instead, which muting does not silence.
   * Resolves to { ok: true } or { ok: false, reason: 'unsupported' | 'unreadable' }; never rejects.
   * What it opened is kept on s.bubble, so teardown can always close it.
   */
  function openBubble(s, file) {
    return new Promise(function (resolve) {
      var doc = root.document;
      var urls = root.URL;
      if (!doc || typeof doc.createElement !== 'function' || !urls || typeof urls.createObjectURL !== 'function' ||
          typeof root.MediaStream !== 'function') {
        resolve({ ok: false, reason: 'unsupported' });
        return;
      }
      var el = doc.createElement('video');
      if (typeof el.captureStream !== 'function') {
        resolve({ ok: false, reason: 'unsupported' });
        return;
      }

      var bubble = { el: el, url: null, captured: null, videoStream: null, audioTrack: null };
      s.bubble = bubble;
      var settled = false;
      var timer = null;

      function settle(result) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        el.removeEventListener('loadeddata', onReady);
        el.removeEventListener('error', onError);
        resolve(result);
      }
      function onError() {
        settle({ ok: false, reason: 'unreadable' });
      }
      function onReady() {
        // stop() may have closed this bubble while the file was still loading.
        if (s.bubble !== bubble) {
          settle({ ok: false, reason: 'unreadable' });
          return;
        }
        try {
          playQuietly(el);
          var captured = el.captureStream();
          bubble.captured = captured;
          var picture = firstLive(captured.getVideoTracks());
          if (!picture) {
            settle({ ok: false, reason: 'unreadable' });
            return;
          }
          bubble.videoStream = new root.MediaStream([picture]);
          bubble.audioTrack = firstLive(captured.getAudioTracks());
          settle({ ok: true });
        } catch (err) {
          settle({ ok: false, reason: 'unreadable' });
        }
      }

      try {
        el.playsInline = true;
        el.loop = true;
        el.preload = 'auto';
        el.muted = true;
        el.addEventListener('loadeddata', onReady);
        el.addEventListener('error', onError);
        timer = setTimeout(onError, BUBBLE_WAIT_MS);
        bubble.url = urls.createObjectURL(file);
        el.src = bubble.url;
      } catch (err) {
        onError();
      }
    });
  }

  /** Stop the bubble video, hand back its file link and let go of it. Safe when there is none. */
  function closeBubble(s) {
    var bubble = s.bubble;
    s.bubble = null;
    if (!bubble) return;
    try { bubble.el.pause(); } catch (err) { /* gone */ }
    stopStream(bubble.captured);
    stopStream(bubble.videoStream);
    try {
      bubble.el.removeAttribute('src');
      bubble.el.load();
    } catch (err) { /* gone */ }
    if (bubble.url) {
      try { root.URL.revokeObjectURL(bubble.url); } catch (err) { /* gone */ }
    }
    bubble.el = null;
    bubble.captured = null;
    bubble.videoStream = null;
    bubble.audioTrack = null;
  }

  function bubbleElement() {
    return session && session.bubble && session.bubble.el ? session.bubble.el : null;
  }

  /**
   * Send the bubble video back to its first frame and play it.
   * ui.js calls this when the recorder reaches the 'recording' state, so the file starts
   * from 0 when the recording starts and not when the countdown starts.
   * Does nothing when there is no bubble file.
   */
  function restartBubble() {
    var el = bubbleElement();
    if (!el) return;
    try { el.currentTime = 0; } catch (err) { /* not seekable yet */ }
    playQuietly(el);
  }

  /** Hold the bubble video still while the recording is paused. Does nothing when there is no bubble file. */
  function pauseBubble() {
    var el = bubbleElement();
    if (!el) return;
    try { el.pause(); } catch (err) { /* gone */ }
  }

  /** Carry on playing the bubble video from where it was held. Does nothing when there is no bubble file. */
  function resumeBubble() {
    var el = bubbleElement();
    if (el) playQuietly(el);
  }

  /** Ask for one camera or one microphone. Resolves to { stream, error, usedDefault }; never rejects. */
  async function openDevice(md, which, deviceId) {
    var build = which === 'camera' ? cameraConstraints : micConstraints;
    if (!md || typeof md.getUserMedia !== 'function') {
      return { stream: null, error: namedError('NotSupportedError', 'getUserMedia is missing'), usedDefault: false };
    }
    try {
      return { stream: await md.getUserMedia(build(deviceId)), error: null, usedDefault: false };
    } catch (err) {
      // A remembered device that has since been unplugged: fall back to the default one.
      var name = errorName(err);
      if (!cleanId(deviceId) || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) {
        return { stream: null, error: err, usedDefault: false };
      }
    }
    try {
      return { stream: await md.getUserMedia(build(null)), error: null, usedDefault: true };
    } catch (err2) {
      return { stream: null, error: err2, usedDefault: false };
    }
  }

  /** The id and label of the camera behind a stream, using the device list where the track does not say. */
  function describeCamera(stream, cameras) {
    var track = stream ? firstLive(stream.getVideoTracks()) : null;
    var label = track && typeof track.label === 'string' ? track.label.trim() : '';
    var id = '';
    try {
      var settings = track && typeof track.getSettings === 'function' ? track.getSettings() : null;
      if (settings && typeof settings.deviceId === 'string') id = settings.deviceId;
    } catch (err) { id = ''; }
    for (var i = 0; i < cameras.length; i++) {
      if (id && cameras[i].deviceId === id) {
        if (!label) label = cameras[i].label;
        return { id: id, label: label };
      }
    }
    if (label) {
      for (var n = 0; n < cameras.length; n++) {
        if (cameras[n].label === label) return { id: cameras[n].deviceId, label: label };
      }
    }
    return { id: id, label: label };
  }

  /**
   * Open the camera, then make sure it is the right one.
   * Labels can only be read once the camera is allowed, so the camera is opened first (the remembered
   * id, else the browser's default) and checked afterwards. It is swapped, once at most, when:
   *  - the camera the person picked last time is there under a new id (found by its label), or
   *  - nothing was picked, or the pick is gone, and the browser's default turned out to be a virtual
   *    or infrared camera while a better one exists.
   * A default that is already a real webcam is left alone, whatever its place in the list.
   * Resolves to { stream, error, usedDefault, replaced, id, label }; never rejects.
   * replaced is the label of the virtual or infrared camera that was swapped out, else null.
   */
  async function openCamera(md, want) {
    var wantedId = cleanId(want.cameraId);
    var wantedLabel = typeof want.cameraLabel === 'string' ? want.cameraLabel.trim() : '';
    var first = await openDevice(md, 'camera', wantedId);
    var result = { stream: first.stream, error: first.error, usedDefault: first.usedDefault, replaced: null, id: null, label: null };
    if (!first.stream) return result;

    var cameras = [];
    try {
      if (md && typeof md.enumerateDevices === 'function') cameras = shapeRawCameras(await md.enumerateDevices());
    } catch (err) { cameras = []; }

    function wanted(device) {
      return (!!wantedId && device.id === wantedId) || (!!wantedLabel && sameText(device.label, wantedLabel));
    }
    function finish(stream) {
      var used = describeCamera(stream, cameras);
      result.stream = stream;
      result.id = used.id || null;
      result.label = used.label || null;
      if (wanted(used)) result.usedDefault = false;
      return result;
    }

    var have = describeCamera(first.stream, cameras);
    var chosenId = pickCamera(cameras, wantedId, wantedLabel);
    var chosen = null;
    for (var i = 0; i < cameras.length; i++) if (cameras[i].deviceId === chosenId) chosen = cameras[i];
    if (!chosen) return finish(first.stream);

    var alreadyThere = have.id ? have.id === chosen.deviceId : (have.label !== '' && have.label === chosen.label);
    var poorDefault = isVirtualCamera(have.label) || isInfraredCamera(have.label);
    var chosenIsWanted = wanted({ id: chosen.deviceId, label: chosen.label });
    if (alreadyThere || wanted(have) || (!chosenIsWanted && !poorDefault)) return finish(first.stream);

    // One swap, never a loop: close the camera in hand, open the chosen one.
    stopStream(first.stream);
    try {
      var better = await md.getUserMedia(cameraConstraints(chosen.deviceId));
      if (!chosenIsWanted) result.replaced = have.label;
      return finish(better);
    } catch (err) {
      // The chosen camera would not open: go back to the one that worked.
      try {
        return finish(await md.getUserMedia(cameraConstraints(have.id || (first.usedDefault ? null : wantedId))));
      } catch (err2) {
        result.stream = null;
        result.error = err2;
        return result;
      }
    }
  }

  /** The cameras of a device list with their true labels (empty before permission), for pickCamera. */
  function shapeRawCameras(list) {
    var out = [];
    if (!list || typeof list.length !== 'number') return out;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d && d.kind === 'videoinput' && typeof d.deviceId === 'string') {
        out.push({ deviceId: d.deviceId, label: typeof d.label === 'string' ? d.label.trim() : '' });
      }
    }
    return out;
  }

  /**
   * Mix the microphone and any screen sound into one track.
   * Nothing is connected to the speakers, so the person never hears themselves back.
   * Returns the mixed track, or null when there is no sound at all (and then no AudioContext is made).
   */
  function mixAudio(s) {
    var inputs = [];
    var micTrack = s.micStream ? firstLive(s.micStream.getAudioTracks()) : null;
    var screenTrack = s.screenStream ? firstLive(s.screenStream.getAudioTracks()) : null;
    var fileTrack = s.bubble && s.bubbleSound && s.bubble.audioTrack && s.bubble.audioTrack.readyState !== 'ended' ?
      s.bubble.audioTrack : null;
    if (micTrack) inputs.push(micTrack);
    if (screenTrack) inputs.push(screenTrack);
    if (fileTrack) inputs.push(fileTrack);
    if (inputs.length === 0) return null;

    try {
      var Ctx = root.AudioContext || root.webkitAudioContext;
      if (typeof Ctx !== 'function' || typeof root.MediaStream !== 'function') throw new Error('no Web Audio');
      var ctx = new Ctx();
      s.ctx = ctx;
      var out = ctx.createMediaStreamDestination();
      s.nodes.push(out);
      for (var i = 0; i < inputs.length; i++) {
        var source = ctx.createMediaStreamSource(new root.MediaStream([inputs[i]]));
        source.connect(out);
        s.nodes.push(source);
      }
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var resuming = ctx.resume();
        if (resuming && typeof resuming.catch === 'function') resuming.catch(function () {});
      }
      var mixed = out.stream.getAudioTracks()[0] || null;
      if (!mixed) throw new Error('the mixer gave no track');
      s.mixedTrack = mixed;
      return mixed;
    } catch (err) {
      // The mixer could not be built: hand over one plain track rather than a silent recording.
      for (var n = 0; n < s.nodes.length; n++) {
        try { s.nodes[n].disconnect(); } catch (err2) { /* gone */ }
      }
      s.nodes = [];
      closeContext(s);
      return inputs[0];
    }
  }

  // ---------------------------------------------------------------- start

  function overtaken() {
    // stop() or a newer start() ran while this one was waiting. The person caused it, so no toast.
    return toastedError('Recording setup was stopped before it finished.', 'nothing-to-record');
  }

  async function finishStart(s, md, screenPromise, bubblePromise, want) {
    // 1. The screen. This is the first thing awaited; the request itself was made inside start().
    if (screenPromise) {
      var screenStream = null;
      var screenError = null;
      try {
        screenStream = await screenPromise;
      } catch (err) {
        screenError = err || new Error('unknown');
      }
      if (!screenError && (!screenStream || !firstLive(screenStream.getVideoTracks()))) {
        stopStream(screenStream);
        screenError = new Error('the share had no picture');
      }
      if (screenError) {
        if (session === s) stop();
        var problem = screenProblem(screenError);
        toast(problem.kind, problem.text);
        throw toastedError(problem.text, 'screen-denied');
      }
      if (session !== s) {
        stopStream(screenStream);
        throw overtaken();
      }
      s.screenStream = screenStream;
      watch(s, firstLive(screenStream.getVideoTracks()), 'user-stopped-share', 'screen');
    }

    // 2. The picture for the bubble: a video file the person chose, or else the live camera.
    if (bubblePromise) {
      var opened = await bubblePromise;
      if (session !== s) throw overtaken();
      if (opened.ok) {
        s.cameraStream = s.bubble.videoStream;
      } else if (opened.reason === 'unsupported' && s.screenStream) {
        closeBubble(s);
        toast('error', 'This browser cannot show a video file in the bubble, so this recording carries on ' +
          'without it. Chrome and Edge can.');
      } else {
        var bubbleText = opened.reason === 'unsupported' ?
          'This browser cannot show a video file in the bubble. Open this page in Chrome or Edge.' :
          'That video could not be opened — try an MP4 or WebM file.';
        stop();
        toast('error', bubbleText);
        throw toastedError(bubbleText, 'bubble-failed');
      }
    } else if (want.camera) {
      var cam = await openCamera(md, want);
      if (session !== s) {
        stopStream(cam.stream);
        throw overtaken();
      }
      if (cam.stream) {
        s.cameraStream = cam.stream;
        s.cameraUsed = { id: cam.id, label: cam.label };
        watch(s, firstLive(cam.stream.getVideoTracks()), 'device-lost', 'camera');
        if (cam.replaced) {
          toast('info', 'Using your webcam' + (cam.label ? ' (' + cam.label + ')' : '') + ' rather than ' +
            (isInfraredCamera(cam.replaced) && !isVirtualCamera(cam.replaced) ? 'the infrared camera.' : 'a virtual camera.'));
        } else if (cam.usedDefault) {
          toast('info', 'The camera you picked last time was not found, so your default camera is being used.');
        }
      } else if (s.screenStream) {
        toast('error', deviceProblemText('camera', cam.error) + ' This recording carries on without the camera.');
      } else {
        // No screen and no camera: there is no picture, and a sound-only recording is not offered.
        var text = deviceProblemText('camera', cam.error) + ' With no screen and no camera there is nothing to record.';
        stop();
        toast('error', text);
        throw toastedError(text, 'nothing-to-record');
      }
    }

    // 3. The microphone, again in a request of its own.
    if (want.mic) {
      var mic = await openDevice(md, 'mic', want.micId);
      if (session !== s) {
        stopStream(mic.stream);
        throw overtaken();
      }
      if (mic.stream) {
        s.micStream = mic.stream;
        watch(s, firstLive(mic.stream.getAudioTracks()), 'device-lost', 'mic');
        if (mic.usedDefault) {
          toast('info', 'The microphone you picked last time was not found, so your default microphone is being used.');
        }
      } else {
        toast('error', deviceProblemText('mic', mic.error) + ' This recording carries on without your voice.');
      }
    }

    // 4. One mixed audio track, or null when there is no sound at all.
    return {
      screenStream: s.screenStream,
      cameraStream: s.cameraStream,
      audioTrack: mixAudio(s),
      // Which live camera ended up in use, so ui.js can remember it by label. Both are null
      // when there is no camera or when a bubble video file stands in for it.
      cameraLabelUsed: s.cameraUsed ? s.cameraUsed.label : null,
      cameraIdUsed: s.cameraUsed ? s.cameraUsed.id : null
    };
  }

  /**
   * Open what the person asked for.
   * Call it directly inside the click handler: the screen picker is requested on the
   * first line that touches the browser, before anything is awaited, so the click still counts.
   */
  function start(options) {
    var o = options || {};
    var want = {
      screen: !!o.screen,
      camera: !!o.camera,
      mic: !!o.mic,
      cameraId: o.cameraId,
      // The label of the camera picked last time; it finds the camera again when its id has changed.
      cameraLabel: o.cameraLabel,
      micId: o.micId,
      // A video file to show in the bubble in place of the live camera, and whether its sound is recorded.
      bubbleFile: isFileLike(o.bubbleFile) ? o.bubbleFile : null,
      bubbleSound: o.bubbleSound !== false
    };

    stop();

    if (!want.screen && !want.camera && !want.bubbleFile) {
      var text = 'Pick the screen or the camera first, then press Record.';
      toast('error', text);
      return Promise.reject(toastedError(text, 'nothing-to-record'));
    }

    var md = mediaDevices();
    var s = {
      screenStream: null,
      cameraStream: null,
      micStream: null,
      ctx: null,
      nodes: [],
      mixedTrack: null,
      bubble: null,
      cameraUsed: null,
      bubbleSound: want.bubbleSound,
      watchers: [],
      endedSent: {}
    };
    session = s;

    var screenPromise = null;
    if (want.screen) {
      try {
        if (!md || typeof md.getDisplayMedia !== 'function') {
          throw namedError('NotSupportedError', 'getDisplayMedia is missing');
        }
        screenPromise = md.getDisplayMedia(displayConstraints());
      } catch (err) {
        screenPromise = Promise.reject(err);
      }
    }

    // The file starts loading now, after the screen request, so it is ready by the time a screen is picked.
    var bubblePromise = want.bubbleFile ? openBubble(s, want.bubbleFile) : null;

    return finishStart(s, md, screenPromise, bubblePromise, want);
  }

  // ---------------------------------------------------------------- devices and stop

  /** The cameras and microphones for the two pickers. Never rejects; on any failure both lists are empty. */
  async function listDevices() {
    try {
      var md = mediaDevices();
      if (!md || typeof md.enumerateDevices !== 'function') return shapeDevices([]);
      return shapeDevices(await md.enumerateDevices());
    } catch (err) {
      return shapeDevices([]);
    }
  }

  /** Stop every track and close the mixer. Safe to call twice and before start. Emits nothing. */
  function stop() {
    var s = session;
    session = null;
    teardown(s);
  }

  var api = {
    start: start,
    listDevices: listDevices,
    stop: stop,
    restartBubble: restartBubble,
    pauseBubble: pauseBubble,
    resumeBubble: resumeBubble,
    // Pure helpers, exposed so they can be tested without a browser.
    displayConstraints: displayConstraints,
    cameraConstraints: cameraConstraints,
    micConstraints: micConstraints,
    screenProblem: screenProblem,
    deviceProblemText: deviceProblemText,
    shapeDevices: shapeDevices,
    pickCamera: pickCamera,
    isVirtualCamera: isVirtualCamera,
    isInfraredCamera: isInfraredCamera
  };
  Takes.capture = api;

  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
