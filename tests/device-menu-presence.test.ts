import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceMenuOptions } from '../lib/interview/device-menu-options';
import { DEVICE_MENU_EXIT_MS, deviceMenuInteraction, deviceMenuItemIndex, deviceMenuPresenceReducer as reduce, initialDeviceMenuPresence, type DeviceMenu } from '../lib/interview/device-menu-presence';
const clickedOpen = (menu: DeviceMenu) => { const entry = reduce(initialDeviceMenuPresence, { type: 'toggle', menu }); return reduce(entry, { type: 'finish_enter', revision: entry.revision }); };

test('device options have unique keys for blank and repeated IDs, and unique device keys survive reordering', () => {
  const camera = (deviceId: string, groupId = '') => ({ kind: 'videoinput' as const, deviceId, groupId });
  const devices = [camera(''), camera(''), camera('same'), camera('same'), camera('same', 'other-group'), camera('unique')];
  const options = deviceMenuOptions(devices, 'videoinput');
  assert.equal(new Set(options.map(option => option.key)).size, devices.length);
  assert.deepEqual(options.map(option => option.device), devices);
  assert.deepEqual(deviceMenuOptions(devices, 'audioinput'), []);
  const reordered = deviceMenuOptions([...devices].reverse(), 'videoinput');
  assert.equal(options.find(option => option.device.deviceId === 'unique')!.key, reordered.find(option => option.device.deviceId === 'unique')!.key);
});

test('closing retains the rendered device menu until its own exit finishes', () => {
  const open = clickedOpen('mic');
  const closing = reduce(open, { type: 'close' });
  assert.equal(closing.menu, 'mic'); assert.equal(closing.phase, 'closing');
  assert.equal(DEVICE_MENU_EXIT_MS, 550);
  const closed = reduce(closing, { type: 'finish_exit', revision: closing.revision });
  assert.equal(closed.menu, null); assert.equal(closed.phase, 'closed');
});

test('reopening the same menu prevents a queued old exit from unmounting it', () => {
  const open = clickedOpen('speaker');
  const closing = reduce(open, { type: 'close' });
  const reopened = reduce(closing, { type: 'toggle', menu: 'speaker' });
  assert.equal(reopened.phase, 'open'); assert.equal(reopened.menu, 'speaker');
  assert.ok(reopened.revision > closing.revision);
  assert.equal(reduce(reopened, { type: 'finish_exit', revision: closing.revision }), reopened);
});

test('switching menus during an exit cannot close the newly selected menu', () => {
  const closingMic = reduce(clickedOpen('mic'), { type: 'close' });
  const camera = reduce(closingMic, { type: 'toggle', menu: 'camera' });
  assert.equal(camera.phase, 'entering'); assert.equal(camera.menu, 'camera');
  assert.equal(reduce(camera, { type: 'finish_exit', revision: closingMic.revision }), camera);
  const closingCamera = reduce(camera, { type: 'close' });
  assert.equal(reduce(closingCamera, { type: 'finish_exit', revision: closingMic.revision }), closingCamera);
  assert.equal(reduce(closingCamera, { type: 'finish_exit', revision: closingCamera.revision }).phase, 'closed');
});

test('repeated dismissal does not restart the exit and selecting another open menu switches immediately', () => {
  assert.equal(reduce(initialDeviceMenuPresence, { type: 'close' }), initialDeviceMenuPresence);
  const mic = clickedOpen('mic');
  const speaker = reduce(mic, { type: 'toggle', menu: 'speaker' });
  assert.equal(speaker.phase, 'entering'); assert.equal(speaker.menu, 'speaker');
  const closing = reduce(speaker, { type: 'toggle', menu: 'speaker' });
  assert.equal(closing.phase, 'closing'); assert.equal(reduce(closing, { type: 'close' }), closing);
});

test('the still-mounted 550ms closing menu becomes inert and hidden to accessibility immediately', () => {
  const open = clickedOpen('speaker');
  assert.deepEqual(deviceMenuInteraction(open), { inert: false, 'aria-hidden': false });
  const closing = reduce(open, { type: 'close' });
  assert.equal(closing.menu, 'speaker'); assert.deepEqual(deviceMenuInteraction(closing), { inert: true, 'aria-hidden': true });
  const reopened = reduce(closing, { type: 'toggle', menu: 'speaker' });
  assert.deepEqual(deviceMenuInteraction(reopened), { inert: false, 'aria-hidden': false });
  assert.equal(reduce(reopened, { type: 'finish_exit', revision: closing.revision }), reopened);
});

test('stagger indices follow the first four rows and cap every later device at 320ms', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(deviceMenuItemIndex), [0, 1, 2, 3, 3, 3]);
  assert.deepEqual([0, 1, 2, 3, 99].map(index => (deviceMenuItemIndex(index) + 1) * 80), [80, 160, 240, 320, 320]);
  assert.equal(deviceMenuItemIndex(-5), 0); assert.equal(deviceMenuItemIndex(NaN), 0); assert.equal(deviceMenuItemIndex(Infinity), 0);
  assert.equal(deviceMenuItemIndex(1.9), 1);
});

test('a click mounts a painted entry state before the RAF completion starts the CSS transition', () => {
  const entry = reduce(initialDeviceMenuPresence, { type: 'toggle', menu: 'mic' });
  assert.equal(entry.phase, 'entering'); assert.equal(entry.activation, 'pinned');
  assert.equal(reduce(entry, { type: 'finish_enter', revision: entry.revision - 1 }), entry);
  assert.equal(reduce(entry, { type: 'finish_enter', revision: entry.revision }).phase, 'open');
});

test('real mouse hover opens and leaves close; touch and pen hover never activate a menu', () => {
  for (const pointerType of ['touch', 'pen', '']) assert.equal(reduce(initialDeviceMenuPresence, { type: 'hover_enter', menu: 'mic', pointerType }), initialDeviceMenuPresence);
  const entry = reduce(initialDeviceMenuPresence, { type: 'hover_enter', menu: 'mic', pointerType: 'mouse' });
  assert.equal(entry.phase, 'entering'); assert.equal(entry.activation, 'hover');
  const open = reduce(entry, { type: 'finish_enter', revision: entry.revision });
  assert.equal(reduce(open, { type: 'hover_enter', menu: 'mic', pointerType: 'mouse' }), open);
  assert.equal(reduce(open, { type: 'hover_leave', menu: 'mic', pointerType: 'touch' }), open);
  assert.equal(reduce(open, { type: 'hover_leave', menu: 'mic', pointerType: 'mouse' }).phase, 'closing');
});

test('the first click pins a hover-open menu, leave cannot close it, and a second click closes it', () => {
  const entry = reduce(initialDeviceMenuPresence, { type: 'hover_enter', menu: 'speaker', pointerType: 'mouse' });
  const pinnedEntry = reduce(entry, { type: 'toggle', menu: 'speaker' });
  assert.equal(pinnedEntry.activation, 'pinned'); assert.equal(pinnedEntry.phase, 'entering');
  assert.equal(pinnedEntry.revision, entry.revision);
  const open = reduce(pinnedEntry, { type: 'finish_enter', revision: entry.revision });
  assert.equal(reduce(open, { type: 'hover_leave', menu: 'speaker', pointerType: 'mouse' }), open);
  assert.equal(reduce(open, { type: 'toggle', menu: 'speaker' }).phase, 'closing');
});

test('hover switches devices and an old group leave or queued RAF cannot close or open the new one', () => {
  const old = reduce(initialDeviceMenuPresence, { type: 'hover_enter', menu: 'mic', pointerType: 'mouse' });
  const camera = reduce(old, { type: 'hover_enter', menu: 'camera', pointerType: 'mouse' });
  assert.equal(camera.menu, 'camera'); assert.equal(camera.phase, 'entering');
  assert.equal(reduce(camera, { type: 'hover_leave', menu: 'mic', pointerType: 'mouse' }), camera);
  assert.equal(reduce(camera, { type: 'finish_enter', revision: old.revision }), camera);
  const closing = reduce(camera, { type: 'close' });
  assert.equal(reduce(closing, { type: 'finish_enter', revision: camera.revision }), closing);
});

test('mouse reentry reverses a closing panel while its stale exit cannot unmount the reopened menu', () => {
  const entry = reduce(initialDeviceMenuPresence, { type: 'hover_enter', menu: 'mic', pointerType: 'mouse' });
  const hover = reduce(entry, { type: 'finish_enter', revision: entry.revision });
  const closing = reduce(hover, { type: 'hover_leave', menu: 'mic', pointerType: 'mouse' });
  const reopened = reduce(closing, { type: 'hover_enter', menu: 'mic', pointerType: 'mouse' });
  assert.equal(reopened.phase, 'open'); assert.equal(reopened.activation, 'hover');
  assert.equal(reduce(reopened, { type: 'finish_exit', revision: closing.revision }), reopened);
  assert.equal(reduce(reopened, { type: 'finish_enter', revision: hover.revision }), reopened);
});

test('hover close and click reentry before the initial RAF cannot bypass the painted entry stage', () => {
  const hover = reduce(initialDeviceMenuPresence, { type: 'hover_enter', menu: 'speaker', pointerType: 'mouse' });
  const closing = reduce(hover, { type: 'close' });
  const clicked = reduce(closing, { type: 'toggle', menu: 'speaker' });
  assert.equal(clicked.phase, 'entering'); assert.equal(clicked.activation, 'pinned'); assert.equal(clicked.entered, false);
  assert.equal(reduce(clicked, { type: 'finish_enter', revision: hover.revision }), clicked);
  assert.equal(reduce(clicked, { type: 'finish_exit', revision: closing.revision }), clicked);
  assert.equal(reduce(clicked, { type: 'finish_enter', revision: clicked.revision }).phase, 'open');
});
