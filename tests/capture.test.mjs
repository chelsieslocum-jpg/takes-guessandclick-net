// Tests for src/js/capture.js: the pure helpers that choose a camera and shape the device lists.
// Opening a real camera, microphone or screen needs a browser and is not tested here.
// Run from the repository root: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Takes } = require('../src/js/core.js');
const capture = require('../src/js/capture.js');
const { pickCamera, isVirtualCamera, isInfraredCamera, shapeDevices } = capture;

// Four typical cameras: a real webcam, two virtual cameras and an infrared one.
const FHD = { deviceId: 'id-fhd', label: 'USB2.0 FHD UVC WebCam' };
const OBS = { deviceId: 'id-obs', label: 'OBS Virtual Camera' };
const NVIDIA = { deviceId: 'id-nvidia', label: 'Camera (NVIDIA Broadcast)' };
const IR = { deviceId: 'id-ir', label: 'USB2.0 IR UVC WebCam' };

// ------------------------------------------------------------------ loading

test('capture loads under Node and attaches itself to the namespace', () => {
  assert.equal(Takes.capture, capture);
  for (const name of ['start', 'stop', 'listDevices', 'restartBubble', 'pauseBubble', 'resumeBubble', 'pickCamera']) {
    assert.equal(typeof capture[name], 'function', name);
  }
});

test('stop and the bubble controls are safe before any start', () => {
  capture.stop();
  capture.stop();
  capture.restartBubble();
  capture.pauseBubble();
  capture.resumeBubble();
});

// ------------------------------------------------------------------ classifying a camera by its name

test('isVirtualCamera: software cameras are virtual, real webcams are not', () => {
  for (const name of ['OBS Virtual Camera', 'Camera (NVIDIA Broadcast)', 'Snap Camera', 'Iriun Webcam', 'XSplit VCam',
    'ManyCam Virtual Webcam', 'DroidCam Source 3', 'Streamlabs Desktop Virtual Webcam', 'mmhmm Camera', 'NDI Webcam Video 1']) {
    assert.equal(isVirtualCamera(name), true, name);
  }
  for (const name of ['Integrated Camera', 'HD Pro Webcam C920', 'FaceTime HD Camera', 'Brio 4K Stream Webcam',
    'USB2.0 FHD UVC WebCam', 'USB2.0 IR UVC WebCam', 'Integrated IR Camera']) {
    assert.equal(isVirtualCamera(name), false, name);
  }
});

test('isInfraredCamera: only a whole word IR or the word infrared counts', () => {
  for (const name of ['USB2.0 IR UVC WebCam', 'Integrated IR Camera', 'Surface Infrared Camera', 'ir camera']) {
    assert.equal(isInfraredCamera(name), true, name);
  }
  for (const name of ['Iriun Webcam', 'Mirror Cam', 'Mirrorless EOS Webcam Utility', 'First Camera', 'Integrated Camera',
    'HD Pro Webcam C920', 'FaceTime HD Camera', 'Brio 4K Stream Webcam', 'USB2.0 FHD UVC WebCam',
    'OBS Virtual Camera', 'Camera (NVIDIA Broadcast)', 'Snap Camera']) {
    assert.equal(isInfraredCamera(name), false, name);
  }
});

test('an empty or missing label is never classified', () => {
  for (const name of ['', null, undefined, 42]) {
    assert.equal(isVirtualCamera(name), false);
    assert.equal(isInfraredCamera(name), false);
  }
});

// ------------------------------------------------------------------ choosing a camera

test('pickCamera: with nothing remembered, the real webcam wins whatever the order', () => {
  assert.equal(pickCamera([OBS, NVIDIA, IR, FHD]), 'id-fhd', 'virtual first');
  assert.equal(pickCamera([IR, OBS, FHD, NVIDIA]), 'id-fhd', 'infrared first');
  assert.equal(pickCamera([FHD, OBS, NVIDIA, IR]), 'id-fhd', 'webcam first');
  assert.equal(pickCamera([NVIDIA, FHD, IR, OBS], '', ''), 'id-fhd', 'empty strings mean nothing remembered');
  assert.equal(pickCamera([OBS, IR, FHD], null, null), 'id-fhd', 'null means nothing remembered');
});

test('pickCamera: a remembered id that is present is used', () => {
  assert.equal(pickCamera([OBS, NVIDIA, IR, FHD], 'id-fhd', 'anything'), 'id-fhd');
  assert.equal(pickCamera([FHD, OBS], 'id-obs'), 'id-obs', 'the person picked the virtual camera, so it is respected');
  assert.equal(pickCamera([FHD, IR], 'id-ir'), 'id-ir', 'even the infrared one, when it was picked');
});

test('pickCamera: a stale id falls back to the remembered label and returns the new id', () => {
  const renumbered = [{ ...OBS, deviceId: 'new-1' }, { ...FHD, deviceId: 'new-2' }, { ...IR, deviceId: 'new-3' }];
  assert.equal(pickCamera(renumbered, 'id-fhd', 'USB2.0 FHD UVC WebCam'), 'new-2');
  assert.equal(pickCamera(renumbered, 'id-fhd', 'usb2.0 fhd uvc webcam'), 'new-2', 'the label match ignores case');
  assert.equal(pickCamera(renumbered, 'id-fhd', '  USB2.0 FHD UVC WebCam '), 'new-2', 'and stray spaces');
});

test('pickCamera: an exact label match beats one that differs only in case', () => {
  const twins = [{ deviceId: 'lower', label: 'hd webcam' }, { deviceId: 'exact', label: 'HD Webcam' }];
  assert.equal(pickCamera(twins, null, 'HD Webcam'), 'exact');
});

test('pickCamera: a remembered label that is the OBS camera is respected', () => {
  const renumbered = [{ ...FHD, deviceId: 'new-1' }, { ...OBS, deviceId: 'new-2' }];
  assert.equal(pickCamera(renumbered, 'id-obs', 'OBS Virtual Camera'), 'new-2');
});

test('pickCamera: a remembered camera that is gone falls back to the real webcam', () => {
  assert.equal(pickCamera([OBS, FHD, IR], 'id-gone', 'HD Pro Webcam C920'), 'id-fhd');
});

test('pickCamera: with only virtual cameras the first one is used, which is better than nothing', () => {
  assert.equal(pickCamera([OBS, NVIDIA]), 'id-obs');
  assert.equal(pickCamera([IR, NVIDIA, OBS]), 'id-nvidia', 'a virtual camera still beats the infrared one');
});

test('pickCamera: with only an infrared camera, that one is used', () => {
  assert.equal(pickCamera([IR]), 'id-ir');
});

test('pickCamera: before permission the labels are empty, so nothing is classified', () => {
  const blank = [{ deviceId: 'a', label: '' }, { deviceId: 'b', label: '' }];
  assert.equal(pickCamera(blank), null, 'nothing remembered: let the browser choose');
  assert.equal(pickCamera(blank, 'b'), 'b', 'a remembered id still matches');
  assert.equal(pickCamera(blank, 'gone', 'USB2.0 FHD UVC WebCam'), null);
  assert.equal(pickCamera([{ deviceId: '', label: '' }]), null, 'an empty id is not a device that can be asked for');
});

test('pickCamera: no devices, or a list that is not a list, is null', () => {
  assert.equal(pickCamera([]), null);
  assert.equal(pickCamera(null), null);
  assert.equal(pickCamera(undefined, 'id-fhd', 'USB2.0 FHD UVC WebCam'), null);
});

test('pickCamera does not change the list it is given', () => {
  const list = [OBS, IR, FHD];
  const before = JSON.stringify(list);
  pickCamera(list, 'x', 'y');
  assert.equal(JSON.stringify(list), before);
});

// ------------------------------------------------------------------ the device lists

test('shapeDevices: cameras carry the virtual and infrared flags, microphones carry them as false', () => {
  // The microphone label is a typical example of a software microphone.
  const shaped = shapeDevices([
    { kind: 'videoinput', ...OBS },
    { kind: 'videoinput', ...IR },
    { kind: 'videoinput', ...FHD },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone (NVIDIA Broadcast)' },
    { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers' },
  ]);
  assert.deepEqual(shaped, {
    cameras: [
      { deviceId: 'id-obs', label: 'OBS Virtual Camera', virtual: true, infrared: false },
      { deviceId: 'id-ir', label: 'USB2.0 IR UVC WebCam', virtual: false, infrared: true },
      { deviceId: 'id-fhd', label: 'USB2.0 FHD UVC WebCam', virtual: false, infrared: false },
    ],
    mics: [{ deviceId: 'mic-1', label: 'Microphone (NVIDIA Broadcast)', virtual: false, infrared: false }],
  });
});

test('shapeDevices: a device with no label yet is numbered and not classified', () => {
  const shaped = shapeDevices([
    { kind: 'videoinput', deviceId: '', label: '' },
    { kind: 'audioinput', deviceId: 'a', label: 'USB Mic' },
    { kind: 'audioinput', deviceId: 'b', label: '' },
  ]);
  assert.deepEqual(shaped.cameras, [{ deviceId: '', label: 'Camera 1', virtual: false, infrared: false }]);
  assert.deepEqual(shaped.mics.map((m) => m.label), ['USB Mic', 'Microphone 2']);
  assert.deepEqual(shapeDevices(null), { cameras: [], mics: [] });
});

test('listDevices never rejects; under Node both lists are empty', async () => {
  assert.deepEqual(await capture.listDevices(), { cameras: [], mics: [] });
});

// ------------------------------------------------------------------ the requests

test('the camera request asks for 1280 by 720 and names a device only when one is given', () => {
  assert.deepEqual(capture.cameraConstraints(), { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  assert.deepEqual(capture.cameraConstraints('').video.deviceId, undefined);
  assert.deepEqual(capture.cameraConstraints('id-fhd').video.deviceId, { exact: 'id-fhd' });
  assert.deepEqual(capture.micConstraints(null), { audio: true, video: false });
  assert.deepEqual(capture.micConstraints('m').audio, { deviceId: { exact: 'm' } });
  assert.equal(capture.displayConstraints().audio, true);
});
