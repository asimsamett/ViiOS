import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(readFileSync(new URL('../app/team-model.ts', import.meta.url), 'utf8'));
const { stableServiceKey, projectAssignments, serviceAssignments, assignmentPeople, assignmentLabel, validateAssignmentDraft } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const service = (apps, id = 'pid:100') => ({ id, name: 'Example Suite', apps });
const app = (port, overrides = {}) => ({ port, pid: 100, ...overrides });
const people = [{ id: 'ayse', name: 'Ayşe' }, { id: 'mert', name: 'Mert' }];
const assignments = [
  { id: '1', serverId: 'fixture', projectId: 'plan', personId: 'ayse', role: 'UI', serviceKey: null, serviceLabel: null },
  { id: '2', serverId: 'fixture', projectId: 'plan', personId: 'mert', role: 'Backend', serviceKey: 'unit:plan.service', serviceLabel: 'Plan API' },
  { id: '3', serverId: 'fixture', projectId: 'plan', personId: 'mert', role: 'Veritabanı', serviceKey: 'container:plan-db', serviceLabel: 'PostgreSQL' },
  { id: '4', serverId: 'archive', projectId: 'plan', personId: 'ayse', role: 'Test', serviceKey: null, serviceLabel: null },
  { id: '5', serverId: 'fixture', projectId: 'worker', personId: 'ayse', role: 'UI', serviceKey: null, serviceLabel: null },
];
const data = { revision: 1, people, assignments };

test('service ownership is stable across process restarts and endpoint ordering', () => {
  assert.equal(stableServiceKey(service([app(8011, { control: { unit: 'plan.service' } })])), 'unit:plan.service');
  assert.equal(stableServiceKey(service([app(8011, { pid: 200, control: { unit: 'plan.service' } })], 'pid:200')), 'unit:plan.service');
  assert.equal(stableServiceKey(service([app(5433, { control: { kind: 'container', label: 'plan-db' } })])), 'container:plan-db');
  assert.equal(stableServiceKey(service([app(9001), app(8011)])), 'port:8011');
  assert.equal(stableServiceKey(service([app(8011, { pid: 200 }), app(9001, { pid: 200 })], 'pid:200')), 'port:8011');
});

test('project assignments never bleed across servers or applications', () => {
  assert.deepEqual(projectAssignments(data, 'fixture', 'plan').map(item => item.id), ['1', '2', '3']);
  assert.deepEqual(projectAssignments(null, 'fixture', 'plan'), []);
  assert.deepEqual(projectAssignments(data, 'fixture', 'unknown'), []);
});

test('multiple responsibilities are grouped beneath the correct person', () => {
  const grouped = assignmentPeople(data, projectAssignments(data, 'fixture', 'plan'));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].person.name, 'Ayşe');
  assert.deepEqual(grouped[1].assignments.map(item => item.role), ['Backend', 'Veritabanı']);
  assert.equal(assignmentLabel(assignments[0]), 'UI');
  assert.equal(assignmentLabel(assignments[1]), 'Backend · Plan API');
});

test('service badges show only ownership scoped to their own service', () => {
  const scoped = projectAssignments(data, 'fixture', 'plan');
  assert.deepEqual(serviceAssignments(scoped, service([app(8011, { control: { unit: 'plan.service' } })])).map(item => item.id), ['2']);
  assert.deepEqual(serviceAssignments(scoped, service([app(5433, { control: { kind: 'container', label: 'plan-db' } })])).map(item => item.id), ['3']);
  assert.deepEqual(serviceAssignments(scoped, service([app(8080)])), []);
});

test('port assignment survives a changed primary listener and discovered systemd unit', () => {
  const portOwner = [{ ...assignments[1], serviceKey: 'port:9001' }];
  assert.equal(serviceAssignments(portOwner, service([app(8011), app(9001)])).length, 1);
  assert.equal(serviceAssignments(portOwner, service([app(9001, { control: { unit: 'plan.service' } })])).length, 1);
});

test('draft allows multiple developers and duties but rejects duplicate or unknown people', () => {
  const drafts = assignments.slice(0, 3);
  assert.equal(validateAssignmentDraft(drafts, people), null);
  assert.equal(validateAssignmentDraft([], people), null);
  assert.match(validateAssignmentDraft(Array.from({ length: 61 }, (_, index) => ({ ...drafts[0], role: `Görev ${index}` })), people), /en fazla 60/);
  assert.match(validateAssignmentDraft([{ ...drafts[0], personId: 'missing' }], people), /tanımlı bir kişi/);
  assert.match(validateAssignmentDraft([{ ...drafts[0], role: '  ' }], people), /görev belirtin/);
  assert.match(validateAssignmentDraft([drafts[0], { ...drafts[0], role: ' UI ' }], people), /birden fazla/);
  assert.equal(validateAssignmentDraft([drafts[0], { ...drafts[0], role: 'Backend' }], people), null);
  assert.equal(validateAssignmentDraft([drafts[1], { ...drafts[1], serviceKey: 'unit:other.service' }], people), null);
});

test('all grouping and validation helpers leave stored metadata untouched', () => {
  const before = JSON.stringify(data);
  assignmentPeople(data, projectAssignments(data, 'fixture', 'plan'));
  validateAssignmentDraft(assignments, people);
  assert.equal(JSON.stringify(data), before);
});

test('an application discovered after repo assignment reuses an unambiguous exact-folder team', () => {
  const assigned = { ...assignments[0], projectId: 'repo:plan', projectPath: '/home/Example_Suite' };
  const snapshot = { ...data, assignments: [assigned] };
  assert.deepEqual(projectAssignments(snapshot, 'fixture', 'plan', '/home//Example_Suite/./'), [assigned]);
  for (const path of ['/home/Example_Suite-old', '/home/../Example_Suite', 'home/Example_Suite']) {
    assert.deepEqual(projectAssignments(snapshot, 'fixture', 'plan', path), []);
  }
  assert.deepEqual(projectAssignments(snapshot, 'archive', 'plan', '/home/Example_Suite'), []);
});

test('repo-only identity can follow a sole child Git folder or the nearest enclosing Git root', () => {
  const root = { ...assignments[0], projectId: 'repo:root', projectPath: '/home' };
  const plan = { ...assignments[1], projectId: 'repo:plan', projectPath: '/home/Example_Suite/app' };
  assert.deepEqual(projectAssignments({ ...data, assignments: [plan] }, 'fixture', 'plan', '/home/Example_Suite'), [plan]);
  assert.deepEqual(projectAssignments({ ...data, assignments: [root, plan] }, 'fixture', 'plan', '/home/Example_Suite/app/src'), [plan]);
  assert.deepEqual(projectAssignments({ ...data, assignments: [plan] }, 'fixture', 'plan', '/home/Example_Suite-old'), []);
  assert.deepEqual(projectAssignments({ ...data, assignments: [plan] }, 'archive', 'plan', '/home/Example_Suite'), []);
});

test('multiple related repo identities remain ambiguous and normal applications never inherit related folder teams', () => {
  const repo = { ...assignments[0], projectId: 'repo:app', projectPath: '/home/Example_Suite/app' };
  const report = { ...assignments[1], projectId: 'repo:report', projectPath: '/home/Example_Suite/report' };
  assert.deepEqual(projectAssignments({ ...data, assignments: [repo, report] }, 'fixture', 'plan', '/home/Example_Suite'), []);
  assert.deepEqual(projectAssignments({ ...data, assignments: [repo, { ...report, projectPath: repo.projectPath }] }, 'fixture', 'plan', '/home/Example_Suite/app/src'), []);
  const normal = { ...repo, projectId: 'plan-app' };
  for (const path of ['/home/Example_Suite', '/home/Example_Suite/app/src']) {
    assert.deepEqual(projectAssignments({ ...data, assignments: [normal] }, 'fixture', 'different-app', path), []);
  }
  const exactNormal = { ...normal, projectPath: '/home/Example_Suite' };
  assert.deepEqual(projectAssignments({ ...data, assignments: [repo, exactNormal] }, 'fixture', 'plan', '/home/Example_Suite'), [exactNormal]);
});

test('direct project identity wins and ambiguous folder aliases are never merged', () => {
  const original = { ...assignments[0], projectId: 'repo:plan', projectPath: '/home/Example_Suite' };
  const direct = { ...assignments[1], projectId: 'plan', projectPath: '/home/Example_Suite' };
  const snapshot = { ...data, assignments: [original, direct] };
  assert.deepEqual(projectAssignments(snapshot, 'fixture', 'plan', '/home/Example_Suite'), [direct]);
  assert.deepEqual(projectAssignments(snapshot, 'fixture', 'new-project', '/home/Example_Suite'), []);
  assert.deepEqual(projectAssignments({ ...data, assignments: [original, { ...direct, serverId: 'archive' }] }, 'fixture', 'new-project', '/home/Example_Suite'), [original]);
});
