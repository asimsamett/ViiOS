'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, Folder, GitBranch, GitCommitHorizontal, Loader2, Search } from 'lucide-react';
import { useTarget } from './target-context';

type GraphCommit = {
  id: string;
  short: string;
  date: string;
  author: string;
  message: string;
  refs: string[];
  parents: string[];
};
type GraphRow = { graph: string; commit?: GraphCommit };
type GraphResult = { rows: GraphRow[]; total: number; truncated: boolean };
type TreeResult = { files: string[]; total: number; truncated: boolean };
type Preview = { text: string; truncated: boolean; note: string };
type TreeNode = { name: string; path: string; children: TreeNode[]; file: boolean };

function makeTree(files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [], file: false };
  const index = new Map<string, TreeNode>([['', root]]);
  for (const file of files) {
    let parent = root;
    const parts = file.split('/');
    parts.forEach((name, position) => {
      const path = parts.slice(0, position + 1).join('/');
      let node = index.get(path);
      if (!node) {
        node = { name, path, children: [], file: position === parts.length - 1 };
        index.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    });
  }
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name, 'tr'));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export default function GitTreePanel({ id, generation }: { id: string; generation: number }) {
  const { api } = useTarget();
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [commitId, setCommitId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const read = useCallback(async <T,>(body: Record<string, unknown>, signal: AbortSignal): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api<T>('/versions/action', { method: 'POST', body: JSON.stringify(body), signal });
      } catch (reason) {
        if (signal.aborted || attempt >= 20 || !(reason as Error).message.includes('Başka bir sürüm işlemi sürüyor')) throw reason;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setGraph(null);
      setCommitId(null);
      setLoadingGraph(true);
      setError('');
    });
    void read<GraphResult>({ action: 'graph', id }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setGraph(value);
        setCommitId(value.rows.find((row) => row.commit)?.commit?.id || null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingGraph(false);
      });
    return () => controller.abort();
  }, [read, id, generation]);

  useEffect(() => {
    if (!commitId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setTree(null);
      setFile(null);
      setPreview(null);
      setCollapsed(new Set());
      setLoadingTree(true);
      setError('');
    });
    void read<TreeResult>({ action: 'treeFiles', id, commit: commitId }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setTree(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingTree(false);
      });
    return () => controller.abort();
  }, [read, id, commitId, generation]);

  useEffect(() => {
    if (!commitId || !file) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setPreview(null);
      setLoadingPreview(true);
      setError('');
    });
    void read<Preview>({ action: 'treeFile', id, commit: commitId, file }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPreview(false);
      });
    return () => controller.abort();
  }, [read, id, commitId, file, generation]);

  const nodes = useMemo(() => makeTree(tree?.files || []), [tree]);
  const selected = graph?.rows.find((row) => row.commit?.id === commitId)?.commit;
  const search = query.trim().toLocaleLowerCase('tr-TR');
  const matches = (node: TreeNode): boolean =>
    !search || node.path.toLocaleLowerCase('tr-TR').includes(search) || node.children.some(matches);
  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (!matches(node)) return null;
    const isCollapsed = collapsed.has(node.path) && !search;
    return (
      <div key={node.path}>
        <button
          type="button"
          className="git-tree-node"
          aria-pressed={node.file ? file === node.path : undefined}
          aria-expanded={!node.file ? !isCollapsed : undefined}
          title={node.path}
          style={{ paddingLeft: 10 + Math.min(depth, 12) * 16 }}
          onClick={() => {
            if (node.file) setFile(node.path);
            else setCollapsed((old) => {
              const next = new Set(old);
              if (next.has(node.path)) next.delete(node.path);
              else next.add(node.path);
              return next;
            });
          }}
        >
          {node.file ? <FileCode2 size={14} /> : isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {!node.file && <Folder size={15} />}
          <span>{node.name}</span>
        </button>
        {!node.file && !isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="git-tree-panel">
      <div className="git-tree-intro">
        <div>
          <small>GİT GEÇMİŞİ</small>
          <h2>Git ağacı</h2>
          <p>Dalları, sürümleri ve her sürümdeki dosyaları inceleyin.</p>
        </div>
        <span>{graph?.total ?? '—'} commit</span>
      </div>
      {error && <div className="repo-center-error" role="alert">{error}</div>}
      <div className="git-tree-layout">
        <section className="git-tree-graph" aria-label="Commit grafiği">
          <div className="git-tree-pane-title"><GitBranch size={16} /><strong>Dal geçmişi</strong><small>DEV · UAT · diğer dallar</small></div>
          <div className="git-tree-graph-scroll">
            {loadingGraph && <p className="git-tree-empty"><Loader2 className="spin" size={16} /> Geçmiş yükleniyor…</p>}
            {graph?.rows.map((row, index) => row.commit ? (
              <button
                type="button"
                key={row.commit.id}
                className="git-tree-commit"
                aria-pressed={row.commit.id === commitId}
                onClick={() => setCommitId(row.commit!.id)}
              >
                <code className="git-tree-rails" aria-hidden="true">
                  <span>{row.graph}</span>
                  {row.commit.parents.length > 0 && <span className="git-tree-rail-tail">{(row.graph.replace(/\*/g, '|').replace(/[\\/]/g, ' ') + '\n').repeat(3)}</span>}
                </code>
                <span className="git-tree-commit-info">
                  <span className="git-tree-commit-line"><strong>{row.commit.message}</strong><code>{row.commit.short}</code></span>
                  <span className="git-tree-refs">
                    {row.commit.refs.map((ref) => <span key={ref} data-uat={ref === 'ops/uat'}>{ref.startsWith('HEAD -> ') ? 'DEV · ' + ref.slice(8) : ref === 'ops/uat' ? 'UAT' : ref}</span>)}
                  </span>
                  <small>{row.commit.author} · {new Date(row.commit.date).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}</small>
                </span>
              </button>
            ) : <div key={'rail-' + index} className="git-tree-connector" aria-hidden="true"><code>{row.graph}</code></div>)}
            {graph && graph.total === 0 && <p className="git-tree-empty">Bu repoda henüz commit yok.</p>}
            {graph?.truncated && <p className="git-tree-limit">En yeni 120 commit gösteriliyor.</p>}
          </div>
        </section>
        <section className="git-tree-browser" aria-label="Sürüm dosyaları">
          <div className="git-tree-pane-title"><Folder size={16} /><strong>Dosya ağacı</strong><small>{selected?.short || 'Sürüm seçin'} · {tree?.total ?? '—'} dosya</small></div>
          <label className="git-tree-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Dosya veya klasör ara" aria-label="Git ağacında dosya ara" /></label>
          <div className="git-tree-file-scroll">
            {loadingTree && <p className="git-tree-empty"><Loader2 className="spin" size={16} /> Dosyalar yükleniyor…</p>}
            {tree && !loadingTree && nodes.map((node) => renderNode(node, 0))}
            {tree && tree.total === 0 && <p className="git-tree-empty">Bu sürümde dosya yok.</p>}
            {tree?.truncated && <p className="git-tree-limit">İlk 3.000 dosya gösteriliyor.</p>}
          </div>
        </section>
        <section className="git-tree-preview" aria-label="Dosya önizlemesi">
          <div className="git-tree-pane-title"><GitCommitHorizontal size={16} /><strong>Önizleme</strong><small title={file || ''}>{file || 'Dosya seçin'}</small></div>
          {loadingPreview && <p className="git-tree-empty"><Loader2 className="spin" size={16} /> Dosya yükleniyor…</p>}
          {!file && <p className="git-tree-empty">Soldaki ağaçtan bir dosya seçin.</p>}
          {preview?.text ? <pre className="git-tree-code">{preview.text}</pre> : preview && <p className="git-tree-empty">{preview.note || 'Bu dosya boş.'}</p>}
        </section>
      </div>
    </div>
  );
}
