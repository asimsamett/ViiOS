import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(
  readFileSync(new URL('../app/launcher-data.ts', import.meta.url), 'utf8'),
// These tests exercise the pure preference helpers, never the React hook.
// Production serves bundled React in the browser and has no server-side React package.
).replace(/^import .* from 'react';\r?\n/m, '');
const { normalizeLauncherItems, toggleLauncherPin } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
const apps = [8011, 8013, 5433].map(port => ({
  port,
  name: `Servis ${port}`,
  project: { id: 'example-suite', name: 'Example Suite' },
}));
const legacy = port => ({ id: `app:${port}`, kind: 'app', port, label: `Eski servis ${port}` });
const project = { id: 'project:example-suite', kind: 'project', projectId: 'example-suite', label: 'Example Suite' };
const folder = { id: 'folder:/home', kind: 'folder', path: '/home', label: 'Ana klasör' };

test('legacy endpoint pins converge on one project while preserving unrelated shortcuts and input', () => {
  const pins = [legacy(8011), folder, legacy(5433), project, legacy(8013)];
  const original = structuredClone(pins);
  assert.deepEqual(normalizeLauncherItems(pins, apps), [project, folder]);
  assert.deepEqual(pins, original);
});

test('the first unpin click removes all legacy aliases of the displayed project', () => {
  const pins = [legacy(8011), folder, legacy(5433)];
  assert.deepEqual(toggleLauncherPin(pins, project, apps), [folder]);
  assert.deepEqual(toggleLauncherPin([folder], project, apps), [folder, project]);
});

test('recent aliases deduplicate and retain the most recent opening time', () => {
  const recent = [
    { ...legacy(8011), openedAt: 30 },
    { ...folder, openedAt: 20 },
    { ...legacy(8013), openedAt: 10 },
    { ...project, openedAt: 5 },
  ];
  assert.deepEqual(normalizeLauncherItems(recent, apps), [
    { ...project, openedAt: 30 },
    { ...folder, openedAt: 20 },
  ]);
  assert.equal(normalizeLauncherItems([
    { ...legacy(8011), openedAt: 10 },
    { ...legacy(8013), openedAt: 30 },
  ], apps)[0].openedAt, 30);
});

test('delayed or incomplete inventory preserves saved shortcuts for later migration', () => {
  const pins = [legacy(8011), legacy(9900), folder];
  assert.deepEqual(normalizeLauncherItems(pins, []), pins);
  assert.deepEqual(normalizeLauncherItems(pins, apps), [project, legacy(9900), folder]);
});

test('legacy application actions collapse and refreshed inventory does not change migrated storage', () => {
  const pins = [
    { id: 'action:apps', kind: 'action', label: 'Tüm uygulamalar', view: 'apps' },
    { id: 'action:managed', kind: 'action', label: 'Uygulama yönetimi', view: 'managed' },
    legacy(8011),
  ];
  const migrated = normalizeLauncherItems(pins, apps);
  assert.deepEqual(migrated.map(item => item.id), ['applications', 'project:example-suite']);
  assert.equal(JSON.stringify(normalizeLauncherItems(migrated, structuredClone(apps))), JSON.stringify(migrated));
});
