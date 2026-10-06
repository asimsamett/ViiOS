import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(
  readFileSync(new URL('../app/repo-path.ts', import.meta.url), 'utf8'),
);
const { resolveRepoPath } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
const repo = (id, path) => ({ id, path, name: id });

test('an exact registered folder wins over enclosing and nested repositories', () => {
  const projects = [repo('home', '/home'), repo('plan', '/home/Example_Suite'), repo('app', '/home/Example_Suite/app')];
  const result = resolveRepoPath(projects, '/home/Example_Suite/');
  assert.equal(result.project, projects[1]);
  assert.equal(result.match, 'exact');
  assert.equal(result.ambiguous, false);
});

test('service subdirectories resolve to the closest enclosing repository', () => {
  const projects = [repo('plan', '/home/Example_Suite'), repo('app', '/home/Example_Suite/app')];
  const result = resolveRepoPath(projects, '/home/Example_Suite/app/src/service');
  assert.equal(result.project, projects[1]);
  assert.equal(result.match, 'ancestor');
});

test('a project folder can resolve to its only registered descendant', () => {
  const projects = [repo('other', '/home/Other'), repo('app', '/home/Example_Suite/app')];
  const result = resolveRepoPath(projects, '/home/Example_Suite');
  assert.equal(result.project, projects[1]);
  assert.equal(result.match, 'descendant');
});

test('multiple descendant repos require an explicit selection', () => {
  const projects = [repo('app', '/home/Example_Suite/app'), repo('report', '/home/Example_Suite/report')];
  assert.deepEqual(resolveRepoPath(projects, '/home/Example_Suite'), { project: null, match: null, ambiguous: true });
});

test('prefix collisions never select a neighboring project', () => {
  assert.deepEqual(resolveRepoPath([repo('old', '/home/Example_Suite-old')], '/home/Example_Suite'), { project: null, match: null, ambiguous: false });
  assert.equal(resolveRepoPath([repo('plan', '/home/Example_Suite')], '/home/Example_Suite-old/app').project, null);
});

test('unregistered paths resolve after the new registration arrives', () => {
  const path = '/home/Example_Worker';
  assert.equal(resolveRepoPath([repo('plan', '/home/Example_Suite')], path).project, null);
  const worker = repo('worker', path);
  assert.equal(resolveRepoPath([repo('plan', '/home/Example_Suite'), worker], path).project, worker);
});

test('absolute folder paths normalize harmless separators and reject ambiguous traversal', () => {
  const root = repo('root', '/');
  assert.equal(resolveRepoPath([root], '/home/app').project, root);
  const app = repo('app', '/home/app/');
  assert.equal(resolveRepoPath([app], '/home//app/./').match, 'exact');
  for (const path of ['', 'home/app', '/home/../app', '/home/app\0']) {
    assert.equal(resolveRepoPath([app], path).project, null);
  }
});
