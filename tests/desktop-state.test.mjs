import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(
  readFileSync(new URL('../app/desktop-state.ts', import.meta.url), 'utf8'),
);
const { initialWindowState, clampWindow, focusWindow, activeWindow } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

test('new desktop windows start centered and floating with reachable controls', () => {
  for (const bounds of [
    { width: 1920, height: 1000 },
    { width: 1280, height: 680 },
    { width: 800, height: 500 },
  ]) {
    for (const preferredWidth of [1120, 880]) {
      const { maximized, minimized, rect } = initialWindowState(bounds, preferredWidth);
      assert.equal(maximized, false);
      assert.equal(minimized, false);
      assert.ok(rect.width < bounds.width);
      assert.ok(rect.height < bounds.height);
      assert.equal(rect.x, (bounds.width - rect.width) / 2);
      assert.equal(rect.y, (bounds.height - rect.height) / 2);
      const cascade = initialWindowState(bounds, preferredWidth, 4).rect;
      assert.ok(cascade.x >= 0 && cascade.y >= 0);
      assert.ok(cascade.x + cascade.width <= bounds.width);
      assert.ok(cascade.y + cascade.height <= bounds.height);
    }
  }
});

test('new compact windows fit the viewport without remembering a maximized state', () => {
  for (const bounds of [{ width: 390, height: 700 }, { width: 320, height: 280 }]) {
    const state = initialWindowState(bounds, 1120, 3);
    assert.equal(state.maximized, false);
    assert.deepEqual(state.rect, { x: 0, y: 0, ...bounds });
  }
});

test('reopening existing windows preserves their chosen size and maximize state', () => {
  for (const maximized of [false, true]) {
    const rect = { x: 35, y: 60, width: 820, height: 470 };
    const windows = [
      { id: 'tool', minimized: true, maximized, rect },
      { id: 'other', minimized: false },
    ];
    const reopened = focusWindow(windows, 'tool').at(-1);
    assert.equal(reopened.minimized, false);
    assert.equal(reopened.maximized, maximized);
    assert.equal(reopened.rect, rect);
  }
});

test('resizing the desktop keeps the complete window and its controls reachable', () => {
  for (const bounds of [
    { width: 1600, height: 850 },
    { width: 700, height: 500 },
    { width: 320, height: 280 },
  ]) {
    for (const rect of [
      { x: -20, y: -50, width: 1100, height: 600 },
      { x: 1800, y: 1400, width: 10, height: 10 },
      { x: 50, y: 50, width: 9999, height: 9999 },
    ]) {
      const result = clampWindow(rect, bounds);
      assert.ok(result.x >= 0 && result.y >= 0);
      assert.ok(result.x + result.width <= bounds.width);
      assert.ok(result.y + result.height <= bounds.height);
      assert.ok(result.width >= Math.min(540, bounds.width));
      assert.ok(result.height >= Math.min(360, bounds.height));
    }
  }
});

test('restoring a minimized document preserves its identity and unsaved draft', () => {
  const draft = {
    content: 'Henüz kaydedilmeyen içerik',
    revision: 'before-save',
  };
  const original = [
    { id: 'document', minimized: true, dirty: true, draft },
    { id: 'folder', minimized: false },
  ];
  const restored = focusWindow(original, 'document');
  assert.equal(activeWindow(restored), 'document');
  assert.equal(restored.at(-1).draft, draft);
  assert.equal(restored.at(-1).dirty, true);
  assert.equal(original[0].minimized, true);
  assert.equal(focusWindow(restored, 'document'), restored);
  assert.equal(focusWindow(restored, 'missing'), restored);
});

test('minimized windows do not capture the active taskbar state', () => {
  assert.equal(
    activeWindow([
      { id: 'first', minimized: false },
      { id: 'last', minimized: true },
    ]),
    'first',
  );
  assert.equal(activeWindow([{ id: 'first', minimized: true }]), undefined);
  assert.equal(activeWindow([]), undefined);
});
