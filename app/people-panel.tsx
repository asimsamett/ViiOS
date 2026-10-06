'use client';

import { useState } from 'react';
import { FolderKanban, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, UserRound, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useTeam } from './team-context';
import type { TeamPerson } from './team-types';

type PersonEditor = { person: TeamPerson | null; name: string; revision: number };

export default function PeoplePanel() {
  const { data, loading, error, busy, reload, mutate } = useTeam();
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<PersonEditor | null>(null);
  const [deleting, setDeleting] = useState<{ person: TeamPerson; revision: number } | null>(null);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const people = data?.people ?? [];
  const assignments = data?.assignments ?? [];
  const search = query.trim().toLocaleLowerCase('tr-TR');
  const filtered = people.filter(person => !search || person.name.toLocaleLowerCase('tr-TR').includes(search));
  const editStale = !!editor && !!data && editor.revision !== data.revision;
  const deleteStale = !!deleting && !!data && deleting.revision !== data.revision;

  function edit(person: TeamPerson | null) {
    if (!data) return;
    setNotice('');
    setFormError('');
    setEditor({ person, name: person?.name ?? '', revision: data.revision });
  }

  async function save() {
    if (!editor || !editor.name.trim() || busy) return;
    setFormError('');
    try {
      await mutate(editor.person ? `/team/people/${encodeURIComponent(editor.person.id)}` : '/team/people', editor.person ? 'PATCH' : 'POST', { name: editor.name.trim() }, editor.revision);
      setNotice(editor.person ? 'Kişi bilgisi güncellendi.' : 'Kişi eklendi. Artık uygulamaların ekibine ekleyebilirsiniz.');
      setEditor(null);
    } catch (reason) {
      setFormError((reason as Error).message);
    }
  }

  async function remove() {
    if (!deleting || busy) return;
    setFormError('');
    try {
      await mutate(`/team/people/${encodeURIComponent(deleting.person.id)}`, 'DELETE', {}, deleting.revision);
      setNotice(`${deleting.person.name} kişi listesinden kaldırıldı.`);
      setDeleting(null);
    } catch (reason) {
      setFormError((reason as Error).message);
    }
  }

  return <section className="people-panel" aria-label="Kişiler">
    <header className="people-heading">
      <span className="ui-icon people-heading-icon"><UsersRound size={24} /></span>
      <div><h2>Kişiler <span>{people.length}</span></h2><p>Uygulamalarda ve servislerde görev alan kişileri buradan yönetin.</p></div>
      <Button className="people-add" onClick={() => edit(null)} disabled={!data || busy || loading}><Plus size={16} />Yeni kişi</Button>
    </header>
    {error && <div className="people-error" role="alert"><span>{error}</span><Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={14} />Yenile</Button></div>}
    {notice && <output className="people-notice">{notice}</output>}
    <div className="people-toolbar">
      <label className="people-search" htmlFor="people-search"><Search size={16} /><Input id="people-search" aria-label="Kişilerde ara" placeholder="Kişi adı ara…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <span>{people.length} kişi · {new Set(assignments.map(item => `${item.serverId}:${item.projectId}`)).size} uygulamada görev</span>
      <Button variant="ghost" size="sm" aria-label="Kişi listesini yenile" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></Button>
    </div>
    {loading && !data ? <div className="people-empty"><Loader2 size={25} className="spin" /><output>Kişiler yükleniyor…</output></div> : !data ? <div className="people-empty"><UsersRound size={30} /><h3>Kişi listesi alınamadı</h3><p>Bağlantıyı kontrol edip listeyi yenileyin.</p></div> : people.length === 0 ? <div className="people-empty">
      <span className="ui-icon people-empty-icon"><UsersRound size={30} /></span><h3>İlk kişiyi ekleyin</h3><p>Önce ekipteki kişilerin adlarını ekleyin. Ardından bir uygulamanın detayındaki ekip bölümünden kişileri ve görevlerini seçin.</p><Button onClick={() => edit(null)} disabled={busy}><Plus size={16} />Kişi ekle</Button>
    </div> : filtered.length === 0 ? <div className="people-empty"><Search size={28} /><h3>Eşleşen kişi yok</h3><p>Farklı bir adla arayın veya aramayı temizleyin.</p><Button variant="outline" onClick={() => setQuery('')}>Aramayı temizle</Button></div> : <div className="people-list">
      {filtered.map(person => {
        const tasks = assignments.filter(item => item.personId === person.id);
        const projects = new Map(tasks.map(item => [`${item.serverId}:${item.projectId}`, item.projectName]));
        const roles = [...new Set(tasks.map(item => item.role))];
        return <article className="person-row" key={person.id}>
          <span className="ui-icon person-icon"><UserRound size={22} /></span>
          <div className="person-copy"><h3>{person.name}</h3><p>{tasks.length ? `${projects.size} uygulama · ${tasks.length} görev` : 'Henüz bir uygulamaya atanmadı'}</p>{roles.length > 0 && <div className="person-roles">{roles.slice(0, 4).map(role => <span key={role}>{role}</span>)}{roles.length > 4 && <span>+{roles.length - 4} görev türü</span>}</div>}</div>
          <div className="person-projects">{[...projects.entries()].slice(0, 3).map(([id, name]) => <span key={id}><FolderKanban size={13} />{name}</span>)}{projects.size > 3 && <small>+{projects.size - 3} uygulama</small>}</div>
          <div className="person-actions"><Button variant="outline" size="sm" aria-label={`${person.name} adını düzenle`} disabled={busy} onClick={() => edit(person)}><Pencil size={14} /><span>Düzenle</span></Button><Button variant="ghost" size="sm" className="person-delete" aria-label={`${person.name} kişisini sil`} disabled={busy || tasks.length > 0} title={tasks.length ? 'Önce uygulamalardaki görevlerini kaldırın' : 'Kişiyi sil'} onClick={() => { setFormError(''); setNotice(''); setDeleting({ person, revision: data.revision }); }}><Trash2 size={15} /></Button></div>
        </article>;
      })}
    </div>}
    {people.length > 0 && <p className="people-hint">Görevi bulunan bir kişiyi silmek için önce ilgili uygulamaların ekip bölümünden görevlerini kaldırın.</p>}

    <Dialog open={!!editor} onOpenChange={open => { if (!open && !busy) setEditor(null); }}>
      <DialogContent className="person-dialog" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{editor?.person ? 'Kişiyi düzenle' : 'Yeni kişi'}</DialogTitle><DialogDescription>Kişinin uygulama ve servis görevlerinde görünecek adını yazın.</DialogDescription></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <label htmlFor="person-name">Ad soyad</label><Input id="person-name" autoComplete="off" maxLength={100} value={editor?.name ?? ''} disabled={busy} onChange={event => setEditor(current => current ? { ...current, name: event.target.value } : current)} />
          {editStale && <p className="person-form-error">Kişi listesi değişti. Güncel bilgileri incelemek için vazgeçip düzenlemeyi yeniden açın.</p>}
          {formError && <p className="person-form-error" role="alert">{formError}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setEditor(null)}>Vazgeç</Button><Button type="submit" disabled={busy || editStale || !editor?.name.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}{editor?.person ? 'Değişiklikleri kaydet' : 'Kişiyi ekle'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Kişi silinsin mi?</AlertDialogTitle><AlertDialogDescription>{deleting?.person.name} kişi listesinden kaldırılacak. Uygulamalarda görevi bulunan kişiler silinemez.</AlertDialogDescription></AlertDialogHeader>{deleteStale && <p className="person-form-error">Kişi listesi değişti. Vazgeçip güncel kişileri ve görevleri inceleyin.</p>}{formError && <p className="person-form-error" role="alert">{formError}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>Vazgeç</AlertDialogCancel><Button variant="destructive" disabled={busy || deleteStale} onClick={() => void remove()}>{busy && <Loader2 size={15} className="spin" />}Kişiyi sil</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
}
