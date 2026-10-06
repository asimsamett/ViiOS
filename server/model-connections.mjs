// Closed applications have no process environment; show only freshly inspected
// project settings. Never retain a previous process's runtime model as current.
export function enrichClosedModels(apps, profiles = []) {
  return apps.map(app => {
    if (app.active !== false) return app;
    const matches = profiles.map(profile => ({
      profile,
      depth: Math.max(0, ...(profile.roots || []).filter(root => app.directory === root || app.directory?.startsWith(root + '/')).map(root => root.length)),
    })).filter(match => match.depth).sort((a, b) => b.depth - a.depth);
    const profile = matches[0]?.profile;
    return { ...app, modelConnections: profile?.modelConnections || [], modelDiscovery: profile?.modelDiscovery || { status: 'unavailable' } };
  });
}
