type RepoLocation = { id: string; path: string };

const normalizedPath = (value: string) => {
  if (!value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) return null;
  return '/' + value.split('/').filter(part => part && part !== '.').join('/');
};
const containsPath = (root: string, path: string) =>
  root === path || root === '/' || path.startsWith(root + '/');

export function resolveRepoPath<T extends RepoLocation>(projects: T[], requestedPath: string): {
  project: T | null;
  match: 'exact' | 'ancestor' | 'descendant' | null;
  ambiguous: boolean;
} {
  const requested = normalizedPath(requestedPath);
  if (!requested) return { project: null, match: null, ambiguous: false };
  const candidates = projects
    .map(project => ({ project, path: normalizedPath(project.path) }))
    .filter((item): item is { project: T; path: string } => item.path !== null);
  const exact = candidates.find(item => item.path === requested);
  if (exact) return { project: exact.project, match: 'exact', ambiguous: false };
  const ancestor = candidates
    .filter(item => containsPath(item.path, requested))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (ancestor) return { project: ancestor.project, match: 'ancestor', ambiguous: false };
  const descendants = candidates.filter(item => containsPath(requested, item.path));
  return descendants.length === 1
    ? { project: descendants[0].project, match: 'descendant', ambiguous: false }
    : { project: null, match: null, ambiguous: descendants.length > 1 };
}
