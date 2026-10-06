import type { App } from './types';
import type { TeamAssignment, TeamAssignmentDraft, TeamData, TeamPerson } from './team-types';

type Service = { id: string; name: string; apps: App[] };

/** Process IDs change on restart; ownership follows the service or its listening port. */
export function stableServiceKey(service: Service): string {
  const units = [...new Set(service.apps.map(app => app.control?.unit).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
  if (units.length === 1) return `unit:${units[0]}`;
  const containers = [...new Set(service.apps.filter(app => app.control?.kind === 'container').map(app => app.control?.label).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
  if (containers.length === 1) return `container:${containers[0]}`;
  const ports = [...new Set(service.apps.map(app => app.port))].sort((a, b) => a - b);
  return ports.length ? `port:${ports[0]}` : `service:${service.id}`;
}

export function projectAssignments(data: TeamData | null, serverId: string, projectId: string, projectPath?: string | null): TeamAssignment[] {
  const scoped = data?.assignments.filter(assignment => assignment.serverId === serverId) || [];
  const direct = scoped.filter(assignment => assignment.projectId === projectId);
  if (direct.length) return direct;
  const normalize = (path?: string | null) => path?.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..')
    ? '/' + path.split('/').filter(part => part && part !== '.').join('/') : null;
  const path = normalize(projectPath);
  if (!path) return [];
  // A repo may be assigned before the application is discovered. Exact folders
  // retain priority; related paths are accepted only for temporary repo identities.
  const aliases = scoped.filter(assignment => normalize(assignment.projectPath) === path);
  if (aliases.length) return new Set(aliases.map(assignment => assignment.projectId)).size === 1 ? aliases : [];
  const contains = (root: string, child: string) => root === '/' || child.startsWith(root + '/');
  const repositories = scoped.filter(assignment => assignment.projectId.startsWith('repo:'))
    .map(assignment => ({ assignment, path: normalize(assignment.projectPath) }))
    .filter((item): item is { assignment: TeamAssignment; path: string } => item.path !== null);
  const ancestors = repositories.filter(item => contains(item.path, path));
  if (ancestors.length) {
    const nearestLength = Math.max(...ancestors.map(item => item.path.length));
    const nearest = ancestors.filter(item => item.path.length === nearestLength).map(item => item.assignment);
    return new Set(nearest.map(assignment => assignment.projectId)).size === 1 ? nearest : [];
  }
  const descendants = repositories.filter(item => contains(path, item.path)).map(item => item.assignment);
  return new Set(descendants.map(assignment => assignment.projectId)).size === 1 ? descendants : [];
}

export function serviceAssignments(assignments: TeamAssignment[], service: Service): TeamAssignment[] {
  const key = stableServiceKey(service);
  // A process can gain/lose listeners; an explicitly assigned port still belongs to it.
  const portKeys = new Set(service.apps.map(app => `port:${app.port}`));
  return assignments.filter(assignment => assignment.serviceKey === key || !!assignment.serviceKey && portKeys.has(assignment.serviceKey));
}

export function assignmentPeople(data: TeamData | null, assignments: TeamAssignment[]): { person: TeamPerson; assignments: TeamAssignment[] }[] {
  const grouped = new Map<string, { person: TeamPerson; assignments: TeamAssignment[] }>();
  for (const assignment of assignments) {
    const person = data?.people.find(person => person.id === assignment.personId);
    if (!person) continue;
    if (!grouped.has(person.id)) grouped.set(person.id, { person, assignments: [] });
    grouped.get(person.id)!.assignments.push(assignment);
  }
  return [...grouped.values()].sort((a, b) => a.person.name.localeCompare(b.person.name, 'tr'));
}

export function assignmentLabel(assignment: Pick<TeamAssignmentDraft, 'role' | 'serviceLabel' | 'serviceKey'>): string {
  return assignment.serviceKey ? `${assignment.role} · ${assignment.serviceLabel || assignment.serviceKey}` : assignment.role;
}

export function validateAssignmentDraft(assignments: TeamAssignmentDraft[], people: TeamPerson[]): string | null {
  if (assignments.length > 60) return 'Bir projeye en fazla 60 görev ekleyebilirsiniz.';
  const peopleIds = new Set(people.map(person => person.id));
  const rows = new Set<string>();
  for (const assignment of assignments) {
    if (!peopleIds.has(assignment.personId)) return 'Her görev için tanımlı bir kişi seçin.';
    const role = assignment.role.trim();
    if (!role) return 'Her kişi için bir görev belirtin.';
    if (role.length > 80) return 'Görev adı en fazla 80 karakter olabilir.';
    const identity = JSON.stringify([assignment.personId, role.toLocaleLowerCase('tr-TR'), assignment.serviceKey || null]);
    if (rows.has(identity)) return 'Aynı kişi, görev ve servis birden fazla kez eklenmiş. Yinelenen satırı kaldırın.';
    rows.add(identity);
  }
  return null;
}
