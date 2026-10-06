'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Pencil, Plus, Save, Trash2, UserRound, UsersRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTeam } from './team-context';
import { assignmentLabel, assignmentPeople, projectAssignments, serviceAssignments, stableServiceKey, validateAssignmentDraft } from './team-model';
import type { ProjectService } from './project-model';
import type { TeamAssignment, TeamAssignmentDraft, TeamData } from './team-types';

export type TeamProject = { id: string; name: string; directory: string | null };
export type ProjectTeamProps = { serverId: string; project: TeamProject; relatedProjects?: TeamProject[]; services?: ProjectService[]; popupKey?: string | number; visible?: boolean };
type Draft = TeamAssignmentDraft & { localId: number };
const roles = ['Proje sorumlusu', 'UI', 'Backend', 'Servis', 'Tasarım', 'Test'];

function combinedAssignments(data: TeamData | null, serverId: string, projectId: string, projectPath?: string | null, relatedProjects: TeamProject[] = []): TeamAssignment[] {
  const rows = [...projectAssignments(data, serverId, projectId, projectPath), ...relatedProjects.flatMap(project => projectAssignments(data, serverId, project.id, project.directory))];
  return [...new Map(rows.map(row => [row.id, row])).values()];
}

export function ProjectTeamSummary({ serverId, projectId, projectPath, relatedProjects }: { serverId: string; projectId: string; projectPath?: string | null; relatedProjects?: TeamProject[] }) {
  const { data } = useTeam();
  const people = assignmentPeople(data, combinedAssignments(data, serverId, projectId, projectPath, relatedProjects));
  if (!people.length) return null;
  const names = people.map(({ person }) => person.name).join(', ');
  return <span className="project-team-summary" title={names}><UsersRound size={13} aria-hidden="true"/><span>{names}</span></span>;
}

export function ServiceTeam({ serverId, projectId, projectPath, service, relatedProjects }: { serverId: string; projectId: string; projectPath?: string | null; service: ProjectService; relatedProjects?: TeamProject[] }) {
  const { data } = useTeam();
  const people = assignmentPeople(data, serviceAssignments(combinedAssignments(data, serverId, projectId, projectPath, relatedProjects), service));
  if (!people.length) return null;
  return <div className="service-team" aria-label={`${service.name} geliştiricileri`}>{people.map(({ person, assignments }) => <span className="project-person-tag" key={person.id}><UserRound size={13} aria-hidden="true"/><strong>{person.name}</strong><span>{assignments.map(assignment => assignment.role).join(', ')}</span></span>)}</div>;
}

export default function ProjectTeam({ serverId, project, relatedProjects = [], services = [], popupKey, visible = true }: ProjectTeamProps) {
  const { data, loading, error, busy, mutate, reload } = useTeam();
  const assignments = projectAssignments(data, serverId, project.id, project.directory);
  const displayedAssignments = combinedAssignments(data, serverId, project.id, project.directory, relatedProjects);
  const people = assignmentPeople(data, displayedAssignments);
  const displayedLabel = (assignment: TeamAssignment) => assignments.some(own => own.id === assignment.id)
    ? assignmentLabel(assignment) : `${assignmentLabel(assignment)} · ${assignment.projectName}`;
  const [popup, setPopup] = useState(false), [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft[]>([]), [draftRevision, setDraftRevision] = useState(0);
  const [saveError, setSaveError] = useState(''), [saved, setSaved] = useState(false);
  const handledPopup = useRef<string | null>(null), sequence = useRef(0);
  const developerButton = useRef<HTMLButtonElement | null>(null);
  const roleListId = useId();
  const scope = `${serverId}:${project.id}`;
  const openKey = `${scope}:${popupKey ?? ''}`;
  const editingScope = useRef(scope);

  useEffect(() => {
    if (editingScope.current === scope) return;
    editingScope.current = scope;
    setEditing(false); setSaved(false); setSaveError('');
  }, [scope]);

  useEffect(() => {
    if (!visible || loading || !data || error || handledPopup.current === openKey) return;
    handledPopup.current = openKey;
    setPopup(assignmentPeople(data, combinedAssignments(data, serverId, project.id, project.directory, relatedProjects)).length > 0);
  }, [visible, loading, data, error, openKey, serverId, project.id, project.directory, relatedProjects]);

  const serviceOptions = new Map(services.map(service => [stableServiceKey(service), service.name]));
  for (const assignment of draft) if (assignment.serviceKey && !serviceOptions.has(assignment.serviceKey)) serviceOptions.set(assignment.serviceKey, assignment.serviceLabel || assignment.serviceKey);
  const beginEditing = () => {
    if (!data) return;
    setDraft(assignments.map(({ personId, role, serviceKey, serviceLabel }) => ({ personId, role, serviceKey, serviceLabel, localId: ++sequence.current })));
    setDraftRevision(data.revision); setSaveError(''); setSaved(false); setEditing(true);
  };
  const updateDraft = (localId: number, values: Partial<TeamAssignmentDraft>) => setDraft(rows => rows.map(row => row.localId === localId ? { ...row, ...values } : row));
  const save = async () => {
    if (!data || busy) return;
    const updated = draft.map(({ personId, role, serviceKey, serviceLabel }) => ({ personId, role: role.trim(), serviceKey, serviceLabel }));
    const validation = validateAssignmentDraft(updated, data.people);
    if (validation) { setSaveError(validation); return; }
    setSaveError('');
    try {
      await mutate('/team/assignments', 'PUT', { serverId, projectId: assignments[0]?.projectId || project.id, projectName: project.name, projectPath: project.directory, assignments: updated }, draftRevision);
      setEditing(false); setSaved(true);
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : 'Görevler kaydedilemedi.'); }
  };

  return <section className="project-team" aria-label={`${project.name} proje ekibi`}>
    <header className="project-team-header"><span className="ui-icon project-team-icon"><UsersRound size={20} aria-hidden="true"/></span><div><h3>Proje ekibi</h3><p>{people.length ? `${people.length} kişi · ${displayedAssignments.length} görev` : loading ? 'Kişiler yükleniyor…' : error ? 'Ekip bilgisi alınamadı.' : 'Bu projede çalışan kişileri ve görevlerini belirleyin.'}</p></div><div className="project-team-actions">{people.length > 0 && <Button ref={developerButton} variant="outline" onClick={() => setPopup(true)}><UsersRound size={15}/>Geliştirenler</Button>}<Button variant="outline" onClick={beginEditing} disabled={!data || loading || busy || editing}><Pencil size={14}/>{assignments.length ? 'Görevleri düzenle' : 'Kişi ata'}</Button></div></header>
    {error && !editing && <div className="project-team-error" role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void reload()}>Yeniden dene</Button></div>}
    {!editing && people.length > 0 && <div className="project-team-people">{people.map(({ person, assignments: owned }) => <div className="project-team-person" key={person.id}><span className="ui-icon project-team-person-icon"><UserRound size={17} aria-hidden="true"/></span><div><strong>{person.name}</strong><div className="project-person-roles">{owned.map(assignment => <span key={assignment.id}>{displayedLabel(assignment)}</span>)}</div></div></div>)}</div>}
    {saved && !editing && <output className="project-team-saved">Proje ekibi kaydedildi.</output>}
    {editing && <div className="project-team-editor"><p className="project-team-help">{relatedProjects.length > 0 && <>Burada yalnızca <strong>{project.name}</strong> için görevler düzenlenir. Alt proje ekiplerini ilgili projenin detayından düzenleyebilirsiniz. </>}Kişiyi, görevini ve varsa sorumlu olduğu servisi seçin. Bir kişiye birden fazla görev verebilirsiniz.</p>{!data?.people.length && <p className="project-team-empty">Önce ana paneldeki <strong>Kişiler</strong> ekranında isim tanımlayın. Ardından burada projeye ve servislerine atayabilirsiniz.</p>}
      <datalist id={roleListId}>{roles.map(role => <option key={role} value={role}>{role}</option>)}</datalist>
      <div className="project-team-drafts">{draft.map((row, index) => <div className="project-team-draft" key={row.localId}><label><span>Kişi</span><select aria-label={`${index + 1}. görev kişisi`} value={row.personId} disabled={busy} onChange={event => updateDraft(row.localId, { personId: event.target.value })}><option value="">Kişi seçin</option>{data?.people.map(person => <option value={person.id} key={person.id}>{person.name}</option>)}</select></label><label htmlFor={`${roleListId}-role-${row.localId}`}><span>Görev</span><Input id={`${roleListId}-role-${row.localId}`} aria-label={`${index + 1}. görev adı`} value={row.role} list={roleListId} maxLength={80} placeholder="UI, Backend, Servis…" disabled={busy} onChange={event => updateDraft(row.localId, { role: event.target.value })}/></label><label><span>Kapsam</span><select aria-label={`${index + 1}. görev servisi`} value={row.serviceKey || ''} disabled={busy} onChange={event => updateDraft(row.localId, { serviceKey: event.target.value || null, serviceLabel: event.target.value ? serviceOptions.get(event.target.value) || null : null })}><option value="">Proje geneli</option>{[...serviceOptions].map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><Button variant="ghost" className="project-team-remove" aria-label={`${index + 1}. görevi kaldır`} title="Görevi kaldır" disabled={busy} onClick={() => setDraft(rows => rows.filter(item => item.localId !== row.localId))}><Trash2 size={16}/></Button></div>)}</div>
      {data && data.revision !== draftRevision && <p className="project-team-error">Siz düzenlerken ekip bilgileri değişti. Güncel kayıtları kullanmak için vazgeçip düzenlemeyi yeniden açın.</p>}
      {saveError && <p className="project-team-error" role="alert">{saveError}</p>}
      {draft.length >= 60 && <p className="project-team-help">Bir projeye en fazla 60 görev ekleyebilirsiniz.</p>}<footer className="project-team-editor-actions"><Button variant="outline" disabled={!data?.people.length || busy || draft.length >= 60} onClick={() => setDraft(rows => [...rows, { localId: ++sequence.current, personId: '', role: 'Proje sorumlusu', serviceKey: null, serviceLabel: null }])}><Plus size={15}/>Görev ekle</Button><div><Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setSaveError(''); }}>Vazgeç</Button><Button disabled={busy || data?.revision !== draftRevision} onClick={() => void save()}><Save size={15}/>{busy ? 'Kaydediliyor…' : 'Ekibi kaydet'}</Button></div></footer>
    </div>}
    <Dialog open={visible && popup && people.length > 0} onOpenChange={setPopup}><DialogContent className="project-team-dialog" showCloseButton={false} finalFocus={() => visible ? developerButton.current || false : false}><div className="project-team-dialog-heading"><span className="ui-icon project-team-icon"><UsersRound size={23} aria-hidden="true"/></span><div><DialogTitle>Bu projeyi geliştirenler</DialogTitle><DialogDescription>{project.name}</DialogDescription></div><Button variant="ghost" aria-label="Geliştirenler penceresini kapat" onClick={() => setPopup(false)}><X size={18}/></Button></div><div className="project-team-dialog-people">{people.map(({ person, assignments: owned }) => <div className="project-team-person" key={person.id}><span className="ui-icon project-team-person-icon"><UserRound size={19} aria-hidden="true"/></span><div><strong>{person.name}</strong><div className="project-person-roles">{owned.map(assignment => <span key={assignment.id}>{displayedLabel(assignment)}</span>)}</div></div></div>)}</div><footer><Button variant="outline" onClick={() => setPopup(false)}>Projeyi görüntüle</Button></footer></DialogContent></Dialog>
  </section>;
}
