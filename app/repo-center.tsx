'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  Layers3,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ChevronRight,
  Files,
  Clock3,
  CircleCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTarget } from './target-context';
import ProjectTeam from './project-team';
import { useTeam } from './team-context';
import { flattenProjects, groupProjects, groupServices } from './project-model';
import type { App } from './types';
import type { VersionCapabilities } from './version-panel';
import OpsPanel from './ops-panel';
import GitTreePanel from './git-tree-panel';
import { resolveRepoPath } from './repo-path';

type Project = { id: string; name: string; path: string; existing: boolean };
const noProjects: Project[] = [];
type Commit = {
  id: string;
  short: string;
  date: string;
  message: string;
  refs: string;
  author?: string;
  number: number;
};
type Timeline = {
  branch: string;
  total: number;
  offset: number;
  history: Commit[];
  hasMore: boolean;
};
type Snapshot = {
  branch: string;
  head: string | null;
  changes: { status: string; path: string }[];
  blocked: string;
  revision: string;
  trackedCount: number;
  remoteNames: string[];
};
type ChangedFile = { status: string; path: string };
type FileDiffResult = { text: string; truncated: boolean; note: string };

const formatDate = (value: string) =>
  new Date(value).toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const fileLabel = (status: string) => {
  if (status === '??') return 'Yeni';
  if (status.includes('D')) return 'Silindi';
  if (status.includes('A')) return 'Eklendi';
  if (status.includes('R')) return 'Taşındı';
  if (status.includes('U')) return 'Çakışma';
  return 'Değişti';
};

function DiffView({ value }: { value: FileDiffResult | null }) {
  if (!value) return null;
  return (
    <div className="repo-center-diff-wrap">
      {value.text ? (
        <pre className="repo-center-diff" aria-label="Dosya farkı">
          {value.text.split('\n').map((line, index) => (
            <span
              key={index}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'added'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'removed'
                    : line.startsWith('@@')
                      ? 'hunk'
                      : line.startsWith('diff ') || line.startsWith('index ')
                        ? 'meta'
                        : undefined
              }
            >
              {line || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <p className="repo-center-muted">
          {value.note || 'Bu dosya için metin farkı bulunmuyor.'}
        </p>
      )}
      {value.truncated && (
        <small className="repo-center-hint">
          Büyük fark çıktısı kısaltıldı.
        </small>
      )}
    </div>
  );
}

export default function RepoCenter({
  apps,
  capability,
  generation,
  requestedProjectId,
  requestedPath,
  visible = true,
  onManage,
  onBusy,
  onChanged,
}: {
  apps: App[];
  capability: VersionCapabilities | null;
  generation: number;
  requestedProjectId?: string | null;
  requestedPath?: { id: number; path: string } | null;
  visible?: boolean;
  onManage: (path?: string) => void;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
}) {
  const { api, id: serverId } = useTarget();
  const { data: teamData } = useTeam();
  const [teamOpenRevision, setTeamOpenRevision] = useState(0);
  const [appliedTeamRequest, setAppliedTeamRequest] = useState('');
  const [projectList, setProjectList] = useState<{ projects: Project[]; generation: number; reload: number } | null>(null);
  const [pathContext, setPathContext] = useState<{ path: string; projectId: string | null; ambiguous: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Snapshot | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [commitId, setCommitId] = useState<string | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiffResult | null>(null);
  const [section, setSection] = useState<
    'overview' | 'history' | 'tree' | 'working' | 'ops'
  >('overview');
  const [query, setQuery] = useState('');
  const [showDiscover, setShowDiscover] = useState(false);
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<string | null>(
    null,
  );
  const [workingDiff, setWorkingDiff] = useState<FileDiffResult | null>(null);
  const [workingError, setWorkingError] = useState('');
  const [loadingWorking, setLoadingWorking] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reload, setReload] = useState(0);
  const projects = projectList?.projects || noProjects;
  const projectsLoaded = projectList?.generation === generation && projectList?.reload === reload;
  const currentId = useRef<string | null>(null);
  const handledRequestedId = useRef<string | null>(null);
  const handledRequestedPath = useRef<{ key: string; projectId: string | null; ambiguous: boolean } | null>(null);
  useEffect(() => {
    currentId.current = selectedId;
  }, [selectedId]);
  const request = useCallback(
    <T,>(body: Record<string, unknown>, signal?: AbortSignal) =>
      api<T>('/versions/action', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    [api],
  );
  const read = useCallback(
    async <T,>(
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await request<T>(body, signal);
        } catch (reason) {
          if (
            signal?.aborted ||
            attempt >= 9 ||
            !(reason as Error).message.includes(
              'Başka bir sürüm işlemi sürüyor',
            )
          )
            throw reason;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
    [request],
  );

  useEffect(() => {
    const controller = new AbortController();
    void api<{ projects: Project[] }>('/versions/projects', {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setProjectList({ projects: value.projects, generation, reload });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [api, generation, reload]);

  useEffect(() => {
    if (!projectsLoaded) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (requestedPath) {
        const key = `${requestedPath.id}:${requestedPath.path}`;
        const resolved = resolveRepoPath(projects, requestedPath.path);
        const projectId = resolved.project?.id || null;
        if (handledRequestedPath.current?.key === key && handledRequestedPath.current.projectId === projectId && handledRequestedPath.current.ambiguous === resolved.ambiguous) return;
        handledRequestedPath.current = { key, projectId, ambiguous: resolved.ambiguous };
        setAppliedTeamRequest(key);
        handledRequestedId.current = null;
        setPathContext({ path: requestedPath.path, projectId, ambiguous: resolved.ambiguous });
        setSelectedId(projectId);
        setSection('overview');
        setQuery('');
        setNotice('');
        setError('');
        setConfirm(false);
        return;
      }
      if (requestedProjectId) {
        if (handledRequestedId.current === requestedProjectId || !projects.some(item => item.id === requestedProjectId)) return;
        handledRequestedId.current = requestedProjectId;
        setPathContext(null);
        setSelectedId(requestedProjectId);
        setSection('ops');
        return;
      }
      setSelectedId(old => projects.some(item => item.id === old) ? old : projects[0]?.id || null);
    });
    return () => { cancelled = true; };
  }, [projects, projectsLoaded, requestedPath, requestedProjectId]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(!!selectedId);
      setError('');
      setStatus(null);
      setTimeline(null);
      setCommitId(null);
      setFiles([]);
      setSelectedFile(null);
      setDiff(null);
      setSelectedWorkingFile(null);
      setWorkingDiff(null);
    });
    if (!selectedId) return () => controller.abort();
    void (async () => {
      try {
        const value = await read<{ state: Snapshot }>(
          { action: 'status', id: selectedId },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatus(value.state);
        setSelectedWorkingFile(value.state.changes[0]?.path || null);
        const history = await read<Timeline>(
          { action: 'timeline', id: selectedId, offset: 0 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setTimeline(history);
        setCommitId(history.history[0]?.id || null);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [read, selectedId, generation, reload]);

  useEffect(() => {
    if (!selectedId || !commitId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoadingFiles(true);
      setDetailError('');
      setFiles([]);
      setSelectedFile(null);
      setDiff(null);
    });
    void read<{ files: ChangedFile[] }>(
      { action: 'commitFiles', id: selectedId, commit: commitId },
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setFiles(value.files);
        setSelectedFile(value.files[0]?.path || null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setDetailError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFiles(false);
      });
    return () => controller.abort();
  }, [read, selectedId, commitId, reload]);

  useEffect(() => {
    if (!selectedId || !commitId || !selectedFile) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoadingDiff(true);
      setDiff(null);
      setDetailError('');
    });
    void read<FileDiffResult>(
      {
        action: 'fileDiff',
        id: selectedId,
        commit: commitId,
        file: selectedFile,
      },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setDiff(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setDetailError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDiff(false);
      });
    return () => controller.abort();
  }, [read, selectedId, commitId, selectedFile, reload]);

  useEffect(() => {
    if (section !== 'working' || !selectedId || !selectedWorkingFile) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoadingWorking(true);
      setWorkingDiff(null);
      setWorkingError('');
    });
    void read<FileDiffResult>(
      { action: 'workingFileDiff', id: selectedId, file: selectedWorkingFile },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setWorkingDiff(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setWorkingError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingWorking(false);
      });
    return () => controller.abort();
  }, [read, selectedId, selectedWorkingFile, section, reload]);

  async function loadMore() {
    if (!selectedId || !timeline?.hasMore || loadingMore) return;
    const projectId = selectedId;
    setLoadingMore(true);
    try {
      const next = await read<Timeline>({
        action: 'timeline',
        id: projectId,
        offset: timeline.history.length,
      });
      if (currentId.current !== projectId) return;
      setTimeline((old) =>
        old ? { ...next, history: [...old.history, ...next.history] } : next,
      );
    } catch (reason) {
      if (currentId.current === projectId) setError((reason as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function restore() {
    if (!selectedId || !commitId || !status || restoring) return;
    setConfirm(false);
    setRestoring(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      await request({
        action: 'restore',
        id: selectedId,
        revision: status.revision,
        commit: commitId,
      });
      setNotice('Seçilen içerik yeni bir sürüm olarak geri getirildi.');
      setReload((value) => value + 1);
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRestoring(false);
      onBusy(false);
    }
  }

  const project = projects.find((item) => item.id === selectedId);
  // Reuse the application's identity even when the Git root is its app subfolder.
  // Remembered assignment metadata also works while an application is offline.
  const appProjects = flattenProjects(groupProjects(apps));
  const teamProjects = new Map<string, { id: string; name: string; directory: string; path: string }>();
  for (const item of teamData?.assignments || []) {
    if (item.serverId === serverId && item.projectPath)
      teamProjects.set(item.projectId, { id: item.projectId, name: item.projectName, directory: item.projectPath, path: item.projectPath });
  }
  for (const item of appProjects) {
    if (item.directory) teamProjects.set(item.id, { ...item, directory: item.directory, path: item.directory });
  }
  const teamPath = pathContext?.path || project?.path;
  const currentTeamMatch = teamPath ? resolveRepoPath(appProjects.filter(item => item.directory).map(item => ({ ...item, directory: item.directory!, path: item.directory! })), teamPath) : null;
  const matchedTeam = currentTeamMatch?.project || (teamPath && !currentTeamMatch?.ambiguous ? resolveRepoPath([...teamProjects.values()], teamPath).project : null);
  const teamProject = matchedTeam || (project ? { id: `repo:${project.id}`, name: project.name, directory: project.path } : null);
  const teamAppProject = appProjects.find(item => item.id === teamProject?.id);
  const teamCard = teamProject ? <ProjectTeam key={teamProject.id} serverId={serverId} project={teamProject}
    services={teamAppProject ? groupServices(teamAppProject) : []} relatedProjects={teamAppProject ? flattenProjects(teamAppProject.children) : []} visible={visible && (!requestedPath || appliedTeamRequest===`${requestedPath.id}:${requestedPath.path}`)}
    popupKey={`${selectedId || teamPath}:${requestedPath?.id || 0}:${teamOpenRevision}`}/> : null;
  const commit = timeline?.history.find((item) => item.id === commitId);
  const matchingApps = apps.filter(
    (app) => app.directory?.replace(/\/$/, '') === project?.path,
  );
  const discovered = new Map<string, App[]>();
  for (const app of apps) {
    const directory = app.directory?.replace(/\/$/, '');
    if (
      !directory ||
      projects.some((item) => item.path === directory) ||
      !(
        capability?.roots?.some((root) => directory.startsWith(root + '/')) ||
        capability?.projectRoots?.some(
          (root) => directory === root || directory.startsWith(root + '/'),
        )
      ) ||
      [
        '/opt/viios',
        '/var/lib/viios',
        '/opt/containerd',
        '/usr',
      ].some((root) => directory === root || directory.startsWith(root + '/'))
    )
      continue;
    discovered.set(directory, [...(discovered.get(directory) || []), app]);
  }
  const search = query.trim().toLocaleLowerCase('tr-TR');
  const visibleProjects = projects.filter(
    (item) =>
      !search ||
      (item.name + ' ' + item.path).toLocaleLowerCase('tr-TR').includes(search),
  );
  const visibleDiscovered = [...discovered.entries()].filter(
    ([path, items]) =>
      !search ||
      (path + ' ' + items.map((item) => item.name + ' ' + item.title).join(' '))
        .toLocaleLowerCase('tr-TR')
        .includes(search),
  );
  const latest = timeline?.history[0];
  const pending = status?.changes || [];

  return (
    <div className="repo-center">
      <header className="repo-center-toolbar">
        <div className="repo-center-brand-icon">
          <FolderGit2 size={20} />
        </div>
        <div className="repo-center-brand-copy">
          <strong>Repo Merkezi</strong>
          <small>Projeler ve Git sürümleri</small>
        </div>
        <span className="repo-center-server">BAĞLI SUNUCU</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
          disabled={loading || restoring}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Yenile
        </Button>
      </header>

      <div className="repo-center-shell">
        <aside className="repo-center-sidebar" aria-label="Proje seçimi">
          <div className="repo-center-sidebar-head">
            <div className="repo-center-label">
              ÇALIŞMA ALANI <span>{projects.length} repo</span>
            </div>
            <label className="repo-center-search">
              <Search size={15} />
              <input
                aria-label="Repo veya uygulama ara"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Repo veya uygulama ara"
              />
            </label>
          </div>
          <div className="repo-center-sidebar-scroll">
            <div className="repo-center-side-section">
              <div className="repo-center-label">
                KAYITLI REPOSİTORYLER <span>{visibleProjects.length}</span>
              </div>
              {visibleProjects.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="repo-center-project"
                  aria-pressed={item.id === selectedId}
                  onClick={() => {
                    setPathContext(null);
                    setTeamOpenRevision(value => value + 1);
                    setSelectedId(item.id);
                    setSection('overview');
                    setNotice('');
                  }}
                >
                  <span className="ui-icon repo-center-project-icon">
                    <FolderGit2 size={16} />
                  </span>
                  <span className="repo-center-project-copy">
                    <strong>{item.name}</strong>
                    <small title={item.path}>{item.path}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
              {projects.length === 0 && (
                <p className="repo-center-side-empty">Henüz repo eklenmedi.</p>
              )}
              {projects.length > 0 && visibleProjects.length === 0 && (
                <p className="repo-center-side-empty">
                  Aramayla eşleşen repo yok.
                </p>
              )}
            </div>
            <div className="repo-center-side-section repo-center-discovered">
              <button
                className="repo-center-discover-toggle"
                type="button"
                aria-expanded={showDiscover || !!search}
                onClick={() => setShowDiscover((value) => !value)}
              >
                <span>
                  Sunucudaki uygulamalar <b>{discovered.size}</b>
                </span>
                <ChevronRight size={14} />
              </button>
              {(showDiscover || !!search) && (
                <>
                  <p className="repo-center-side-help">
                    Bir uygulama seçip projesini Git&apos;e ekleyin.
                  </p>
                  {visibleDiscovered.map(([path, items]) => (
                    <button
                      className="repo-center-app-choice"
                      type="button"
                      key={path}
                      onClick={() => onManage(path)}
                      title={path}
                    >
                      <span className="ui-icon repo-center-app-avatar">
                        <Layers3 size={17} />
                      </span>
                      <span>
                        <strong>
                          {items[0].annotation?.displayName || items[0].name}
                        </strong>
                        <small>{path}</small>
                      </span>
                      <Plus size={14} />
                    </button>
                  ))}
                  {visibleDiscovered.length === 0 && (
                    <p className="repo-center-side-empty">
                      Eklenebilecek uygulama bulunamadı.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="repo-center-sidebar-footer">
            <Button className="repo-center-add" onClick={() => onManage()}>
              <Plus size={16} /> Proje ekle
            </Button>
            <small>Her proje kendi Git geçmişini kullanır.</small>
          </div>
        </aside>

        <main className="repo-center-main">
          {error && (
            <div className="repo-center-error" role="alert">
              {error}
            </div>
          )}
          {notice && <output className="repo-center-notice">{notice}</output>}
          {pathContext && !pathContext.projectId && (
            <section className="repo-center-context" aria-label="Uygulamanın repo bağlantısı">
              <span className="ui-icon repo-center-context-icon"><FolderGit2 size={24} /></span>
              <div>
                <h2>{pathContext.ambiguous ? 'Bu klasör birden fazla repo içeriyor' : 'Bu uygulama için kayıtlı repo yok'}</h2>
                <code>{pathContext.path}</code>
                <p>{pathContext.ambiguous ? 'İlgili repoyu soldan seçebilir veya bu klasörün Git ayarlarını açabilirsiniz.' : 'Bu klasörün Git durumunu kontrol ederek proje ekleme adımına geçebilirsiniz.'}</p>
                <Button onClick={() => onManage(pathContext.path)}><Plus size={16} />Bu klasörü Git’e ekle</Button>
              </div>
            </section>
          )}
          {pathContext && !pathContext.projectId && <div className="repo-team-section">{teamCard}</div>}
          {!projectsLoaded ? (
            !error && <div className="repo-center-loading"><Loader2 size={18} className="spin" />Kayıtlı projeler yükleniyor…</div>
          ) : !project && !pathContext ? (
            <div className="repo-center-welcome">
              <div className="ui-icon repo-center-welcome-icon">
                <FolderGit2 size={30} />
              </div>
              <h2>Projelerinizi tek yerden yönetin</h2>
              <p>
                Sol listeden bir repo seçin veya sunucudaki bir uygulamayı
                ekleyin. Mevcut Git geçmişi varsa sürümler kaldığı yerden
                görünür.
              </p>
              <Button onClick={() => onManage()}>
                <Plus size={16} /> İlk projeyi ekle
              </Button>
            </div>
          ) : project ? (
            <>
              <div className="repo-center-page-head">
                <div className="repo-center-breadcrumb">
                  REPO MERKEZİ <ChevronRight size={12} /> {project.name}
                </div>
                <div className="repo-center-title-row">
                  <div>
                    <h1>{project.name}</h1>
                    <p>
                      {matchingApps.length > 0
                        ? matchingApps
                            .map(
                              (app) => app.annotation?.displayName || app.name,
                            )
                            .join(', ') + ' · '
                        : ''}
                      {project.existing
                        ? 'Mevcut Git deposu'
                        : 'Bu panelle oluşturulan depo'}
                    </p>
                  </div>
                  <Button
                    onClick={() => onManage(project.path)}
                    disabled={restoring}
                  >
                    <Save size={16} /> Sürüm kaydet
                  </Button>
                </div>
                <div className="repo-center-pathline">
                  <span className="repo-center-branch">
                    <GitBranch size={14} />{' '}
                    {timeline?.branch || status?.branch || '—'}
                  </span>
                  <code title={project.path}>{project.path}</code>
                  {status?.remoteNames && status.remoteNames.length > 0 && (
                    <span className="repo-center-remote">
                      Uzak: {status.remoteNames.join(', ')}
                    </span>
                  )}
                </div>
              </div>

              <div className="repo-team-section">{teamCard}</div>
              <div
                className="repo-center-tabs"
                role="tablist"
                aria-label="Repo bölümleri"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === 'overview'}
                  onClick={() => setSection('overview')}
                >
                  Genel bakış
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === 'history'}
                  onClick={() => setSection('history')}
                >
                  Sürümler <span>{timeline?.total ?? '—'}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === 'tree'}
                  onClick={() => setSection('tree')}
                >
                  Git ağacı
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === 'working'}
                  onClick={() => setSection('working')}
                >
                  Çalışma alanı <span>{pending.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === 'ops'}
                  onClick={() => setSection('ops')}
                >
                  Ortamlar
                </button>
              </div>

              <div className="repo-center-content">
                {loading && (
                  <div className="repo-center-loading">
                    <Loader2 className="spin" size={18} /> Repo bilgileri
                    yükleniyor…
                  </div>
                )}
                {status?.blocked && (
                  <div className="repo-center-error" role="alert">
                    {status.blocked}
                  </div>
                )}

                {section === 'overview' && (
                  <div className="repo-center-overview">
                    <div className="repo-center-metrics">
                      <div className="repo-center-metric">
                        <span>
                          <History size={17} /> Toplam sürüm
                        </span>
                        <strong>{timeline?.total ?? '—'}</strong>
                        <small>Seçili dalın Git kayıtları</small>
                      </div>
                      <div className="repo-center-metric">
                        <span>
                          <Files size={17} /> İzlenen dosya
                        </span>
                        <strong>{status?.trackedCount ?? '—'}</strong>
                        <small>Git kapsamındaki dosyalar</small>
                      </div>
                      <div className="repo-center-metric">
                        <span>
                          <FileDiff size={17} /> Bekleyen değişiklik
                        </span>
                        <strong>{status?.changes.length ?? '—'}</strong>
                        <small>Henüz sürüm yapılmamış</small>
                      </div>
                      <div className="repo-center-metric">
                        <span>
                          <Clock3 size={17} /> Son kayıt
                        </span>
                        <strong className="repo-center-metric-date">
                          {latest ? formatDate(latest.date) : '—'}
                        </strong>
                        <small>
                          {latest
                            ? 'Sürüm ' + latest.number
                            : 'Henüz kayıt yok'}
                        </small>
                      </div>
                    </div>
                    <div className="repo-center-overview-grid">
                      <section className="repo-center-card">
                        <div className="repo-center-card-head">
                          <div>
                            <small>SÜRÜM GEÇMİŞİ</small>
                            <h2>Son kayıtlar</h2>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSection('history')}
                          >
                            Tümünü gör <ChevronRight size={14} />
                          </button>
                        </div>
                        {timeline?.history.slice(0, 5).map((item) => (
                          <button
                            type="button"
                            className="repo-center-recent"
                            key={item.id}
                            onClick={() => {
                              setCommitId(item.id);
                              setSection('history');
                            }}
                          >
                            <span className="repo-center-recent-node">
                              <GitCommitHorizontal size={17} />
                            </span>
                            <span>
                              <strong>
                                Sürüm {item.number} <em>{item.message}</em>
                              </strong>
                              <small>
                                {formatDate(item.date)} ·{' '}
                                {item.author || 'Bilinmeyen yazar'} ·{' '}
                                {item.short}
                              </small>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                        {timeline && timeline.total === 0 && (
                          <p className="repo-center-muted">
                            Bu dalda henüz sürüm kaydı yok.
                          </p>
                        )}
                      </section>
                      <section className="repo-center-card">
                        <div className="repo-center-card-head">
                          <div>
                            <small>GÜNCEL DURUM</small>
                            <h2>Çalışma alanı</h2>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSection('working')}
                          >
                            İncele <ChevronRight size={14} />
                          </button>
                        </div>
                        {status && pending.length === 0 && (
                          <div className="repo-center-clean">
                            <CircleCheck size={22} />
                            <strong>Her şey güncel</strong>
                            <small>Kaydedilmeyi bekleyen dosya yok.</small>
                          </div>
                        )}
                        {pending.slice(0, 6).map((item) => (
                          <button
                            type="button"
                            className="repo-center-pending"
                            key={item.path}
                            onClick={() => {
                              setSelectedWorkingFile(item.path);
                              setSection('working');
                            }}
                          >
                            <span
                              className="repo-center-file-badge"
                              data-status={fileLabel(item.status)}
                            >
                              {fileLabel(item.status)}
                            </span>
                            <span title={item.path}>{item.path}</span>
                          </button>
                        ))}
                        {pending.length > 6 && (
                          <button
                            className="repo-center-rest"
                            type="button"
                            onClick={() => setSection('working')}
                          >
                            +{pending.length - 6} dosya daha
                          </button>
                        )}
                      </section>
                    </div>
                  </div>
                )}

                {section === 'history' && (
                  <div className="repo-center-workspace">
                    <section
                      className="repo-center-history"
                      aria-label="Sürüm geçmişi"
                    >
                      <div className="repo-center-pane-head">
                        <div>
                          <small>GIT GEÇMİŞİ</small>
                          <h2>Sürümler</h2>
                        </div>
                        <span>{timeline?.total ?? '—'} kayıt</span>
                      </div>
                      {timeline?.history.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className="repo-center-version"
                          aria-pressed={item.id === commitId}
                          onClick={() => setCommitId(item.id)}
                        >
                          <span className="repo-center-version-top">
                            <b>Sürüm {item.number}</b>
                            <time>{formatDate(item.date)}</time>
                          </span>
                          <strong>{item.message}</strong>
                          <small>
                            {item.author || 'Bilinmeyen yazar'} · {item.short}
                          </small>
                        </button>
                      ))}
                      {timeline && timeline.total === 0 && (
                        <p className="repo-center-muted">
                          Bu dalda henüz kayıt yok.
                        </p>
                      )}
                      {timeline?.hasMore && (
                        <Button
                          className="repo-center-more"
                          variant="outline"
                          size="sm"
                          disabled={loadingMore}
                          onClick={loadMore}
                        >
                          {loadingMore
                            ? 'Yükleniyor…'
                            : 'Daha eski sürümleri göster'}
                        </Button>
                      )}
                    </section>
                    <section
                      className="repo-center-detail"
                      aria-label="Sürüm değişiklikleri"
                    >
                      {commit ? (
                        <>
                          <div className="repo-center-detail-hero">
                            <div className="repo-center-detail-kicker">
                              <GitCommitHorizontal size={15} /> SÜRÜM{' '}
                              {commit.number}
                            </div>
                            <div className="repo-center-detail-title">
                              <h2>{commit.message}</h2>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  restoring ||
                                  loading ||
                                  !!status?.blocked ||
                                  (commit.id === status?.head &&
                                    pending.length === 0)
                                }
                                onClick={() => setConfirm(true)}
                              >
                                <RotateCcw size={14} /> Geri getir
                              </Button>
                            </div>
                            <div className="repo-center-detail-meta">
                              <span>{commit.author || 'Bilinmeyen yazar'}</span>
                              <span>{formatDate(commit.date)}</span>
                              <code title={commit.id}>{commit.short}</code>
                              {commit.refs && <span>{commit.refs}</span>}
                            </div>
                          </div>
                          <div className="repo-center-detail-body">
                            <div className="repo-center-card-head">
                              <div>
                                <small>BU SÜRÜMDE</small>
                                <h2>
                                  Değişen dosyalar <span>{files.length}</span>
                                </h2>
                              </div>
                            </div>
                            {loadingFiles && (
                              <p className="repo-center-muted">
                                Dosyalar yükleniyor…
                              </p>
                            )}
                            {detailError && (
                              <div className="repo-center-error" role="alert">
                                {detailError}
                              </div>
                            )}
                            <div className="repo-center-files">
                              {files.map((item) => (
                                <button
                                  type="button"
                                  key={item.path}
                                  aria-pressed={item.path === selectedFile}
                                  onClick={() => setSelectedFile(item.path)}
                                  title={item.path}
                                >
                                  <FileDiff size={14} />
                                  <span>{item.path}</span>
                                  <span
                                    className="repo-center-file-badge"
                                    data-status={fileLabel(item.status)}
                                  >
                                    {fileLabel(item.status)}
                                  </span>
                                </button>
                              ))}
                            </div>
                            {selectedFile && (
                              <div className="repo-center-diff-title">
                                <FileDiff size={15} /> {selectedFile}
                              </div>
                            )}
                            {loadingDiff && (
                              <p className="repo-center-muted">
                                Fark yükleniyor…
                              </p>
                            )}
                            <DiffView value={diff} />
                          </div>
                        </>
                      ) : (
                        <div className="repo-center-placeholder">
                          <FileDiff size={28} />
                          <p>Değişikliklerini görmek için bir sürüm seçin.</p>
                        </div>
                      )}
                    </section>
                  </div>
                )}

                {section === 'tree' && (
                  <GitTreePanel id={project.id} generation={generation + reload} />
                )}
                {section === 'working' && (
                  <div className="repo-center-working">
                    <div className="repo-center-working-head">
                      <div>
                        <small>GÜNCEL PROJE DOSYALARI</small>
                        <h2>Çalışma alanı</h2>
                        <p>
                          Git kaydına alınmamış dosyaları ve farkları inceleyin.
                        </p>
                      </div>
                      <Button
                        onClick={() => onManage(project.path)}
                        disabled={pending.length === 0 || !!status?.blocked}
                      >
                        <Save size={15} /> Yeni sürüm kaydet
                      </Button>
                    </div>
                    <div className="repo-center-working-summary">
                      <span>
                        <b>{pending.length}</b> bekleyen dosya
                      </span>
                      <span>
                        <b>
                          {
                            pending.filter((item) => item.status === '??')
                              .length
                          }
                        </b>{' '}
                        yeni
                      </span>
                      <span>
                        <b>
                          {
                            pending.filter((item) => item.status.includes('M'))
                              .length
                          }
                        </b>{' '}
                        değişmiş
                      </span>
                      <span>
                        <b>
                          {
                            pending.filter((item) => item.status.includes('D'))
                              .length
                          }
                        </b>{' '}
                        silinmiş
                      </span>
                    </div>
                    {status && pending.length === 0 ? (
                      <div className="repo-center-clean repo-center-clean-large">
                        <CircleCheck size={28} />
                        <strong>Çalışma alanı temiz</strong>
                        <small>
                          Tüm izlenen değişiklikler Git geçmişinde kayıtlı.
                        </small>
                      </div>
                    ) : (
                      <div className="repo-center-working-grid">
                        <section className="repo-center-working-files">
                          <div className="repo-center-pane-head">
                            <div>
                              <small>DOSYALAR</small>
                              <h2>Değişiklik listesi</h2>
                            </div>
                            <span>{pending.length}</span>
                          </div>
                          {pending.map((item) => (
                            <button
                              type="button"
                              key={item.path}
                              aria-pressed={item.path === selectedWorkingFile}
                              onClick={() => setSelectedWorkingFile(item.path)}
                              title={item.path}
                            >
                              <span
                                className="repo-center-file-badge"
                                data-status={fileLabel(item.status)}
                              >
                                {fileLabel(item.status)}
                              </span>
                              <span>{item.path}</span>
                              <ChevronRight size={14} />
                            </button>
                          ))}
                        </section>
                        <section className="repo-center-working-detail">
                          <div className="repo-center-pane-head">
                            <div>
                              <small>DOSYA FARKI</small>
                              <h2>{selectedWorkingFile || 'Dosya seçin'}</h2>
                            </div>
                          </div>
                          {loadingWorking && (
                            <p className="repo-center-muted">
                              Fark yükleniyor…
                            </p>
                          )}
                          {workingError && (
                            <div className="repo-center-error" role="alert">
                              {workingError}
                            </div>
                          )}
                          <DiffView value={workingDiff} />
                        </section>
                      </div>
                    )}
                  </div>
                )}
                {section === 'ops' && (
                  <OpsPanel
                    id={project.id}
                    path={project.path}
                    generation={generation + reload}
                    onManage={onManage}
                    onHistory={() => setSection('history')}
                    onBusy={onBusy}
                  />
                )}
              </div>
            </>
          ) : null}
        </main>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Sürüm {commit?.number} geri getirilsin mi?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Git geçmişi ve sürüm kapsamındaki dosyalar önce yedeklenecek.
              Kaydedilmemiş değişiklikler ayrıca çalışma kaydı olacak. Seçilen
              içerik yeni bir Git kaydı olarak uygulanacak. Çalışan uygulama
              etkilenebilir; otomatik yeniden başlatılmaz.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Vazgeç</AlertDialogCancel>
            <Button onClick={restore}>Yedekle ve geri getir</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
