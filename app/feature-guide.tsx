'use client';

import { useId, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Compass, Info, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { featureCategories, featureChapters, filterFeatures, type FeatureCategory } from './feature-catalog';
import type { LaunchItem } from './launcher-data';
import './feature-guide.css';

export default function FeatureGuide({ onOpen, unavailable, renderIcon }: {
  onOpen: (item: LaunchItem) => void;
  unavailable: (item: LaunchItem) => string;
  renderIcon: (item: LaunchItem) => ReactNode;
}) {
  const searchId = useId(), categoryId = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FeatureCategory | 'Tümü'>('Tümü');
  const [selected, setSelected] = useState<string | null>(null);
  const [contentsExpanded, setContentsExpanded] = useState(false);
  const results = filterFeatures(query, category);
  const current = selected ? results.find(entry => entry.id === selected) || results[0] : query || category !== 'Tümü' ? results[0] : null;
  const index = current ? results.findIndex(entry => entry.id === current.id) : -1;
  const reason = current ? unavailable(current.item) : '';
  function cover() { setQuery(''); setCategory('Tümü'); setSelected(null); }
  function select(id: string) { setSelected(id); setContentsExpanded(false); }
  function related(id: string) { setQuery(''); setCategory('Tümü'); setSelected(id); }
  return <section className="feature-guide" aria-label="Özellik Rehberi">
    <header className="feature-guide-header">
      <span className="feature-guide-emblem"><BookOpen size={25}/></span>
      <div><p>ViiOS · Kullanım kitapçığı</p><h2>Özellik Rehberi</h2><span>Doğru aracı bulun, ne yaptığını öğrenin, uygulamaya geçin.</span></div>
      <span className="feature-guide-count">{featureChapters.length}<small>uygulama ve araç</small></span>
    </header>
    <div className="feature-guide-tools">
      <div className="feature-guide-search"><label className="sr-only" htmlFor={searchId}>Rehberde ara</label><Search size={17}/><Input id={searchId} placeholder="Uygulama, özellik veya konu ara…" value={query} onChange={event => {setQuery(event.target.value);setSelected(null);}}/>{query && <button type="button" aria-label="Aramayı temizle" onClick={() => setQuery('')}><X size={16}/></button>}</div>
      <label className="sr-only" htmlFor={categoryId}>Rehber kategorisi</label>
      <select id={categoryId} value={category} onChange={event => {setCategory(event.target.value as FeatureCategory | 'Tümü');setSelected(null);}}><option>Tümü</option>{featureCategories.map(value => <option key={value}>{value}</option>)}</select>
      <output aria-label="Rehber sonuç sayısı">{results.length} bölüm</output>
    </div>
    <div className="feature-guide-book">
      <nav className={`feature-guide-contents ${contentsExpanded ? 'is-expanded' : ''}`} aria-label="Kitapçık içindekiler">
        <button type="button" className="feature-guide-contents-toggle" aria-expanded={contentsExpanded} onClick={() => setContentsExpanded(value => !value)}><BookOpen size={16}/>{contentsExpanded ? 'Bölüm listesini kapat' : 'Bölüm listesini aç'}<span>{results.length} bölüm</span></button>
        <button className={`feature-guide-cover-link ${!current && results.length ? 'selected' : ''}`} type="button" onClick={cover} aria-current={!current && results.length ? 'page' : undefined}><Compass size={18}/><span>Kitapçığa genel bakış</span></button>
        <div className="feature-guide-chapters">
          {featureCategories.map(group => {
            const entries = results.filter(entry => entry.category === group);
            return entries.length ? <div className="feature-guide-group" key={group}><h3>{group}</h3>{entries.map(entry => <button key={entry.id} type="button" className={current?.id === entry.id ? 'selected' : ''} aria-current={current?.id === entry.id ? 'page' : undefined} onClick={() => select(entry.id)}><span className="feature-guide-nav-icon">{renderIcon(entry.item)}</span><span>{entry.item.label}</span><ChevronRight size={12}/></button>)}</div> : null;
          })}
          {!results.length && <p className="feature-guide-no-chapters">Eşleşen bölüm yok.</p>}
        </div>
      </nav>
      <div className="feature-guide-reader" key={current?.id || (results.length ? 'cover' : 'empty')}>
        {!results.length ? <div className="feature-guide-empty"><Search size={30}/><h3>Aradığınız konu bulunamadı</h3><p>Başka bir kelime deneyin veya kategori filtresini kaldırın.</p><Button variant="outline" onClick={cover}>Tüm bölümleri göster</Button></div> : current ? <article className="feature-guide-page" aria-label={`${current.item.label} bölümü`}>
          <div className="feature-guide-page-meta"><span>{current.category}</span><span>Bölüm {String(featureChapters.indexOf(current) + 1).padStart(2,'0')}</span></div>
          <header className="feature-guide-page-heading"><span className="feature-guide-app-icon">{renderIcon(current.item)}</span><div><h3>{current.item.label}</h3><p>{current.summary}</p></div></header>
          <section className="feature-guide-use"><h4>Ne zaman kullanılır?</h4><p>{current.when}</p></section>
          <section className="feature-guide-steps"><h4>Nasıl kullanılır?</h4><ol>{current.steps.map((step, position) => <li key={step}><span>{String(position+1).padStart(2,'0')}</span><p>{step}</p></li>)}</ol></section>
          <section className="feature-guide-notes"><h4><Info size={16}/>Bilmeniz gerekenler</h4><ul>{current.notes.map(note => <li key={note}>{note}</li>)}</ul></section>
          <div className="feature-guide-open"><div><small>Nereden açılır?</small><p>ViiOS menüsü / Başlat araması → {current.item.label}</p></div><Button disabled={!!reason || current.id === 'action:features'} onClick={() => onOpen(current.item)}>{current.id === 'action:features' ? <><Check size={15}/>Bu rehberdesiniz</> : <>Uygulamayı aç<ArrowRight size={16}/></>}</Button></div>
          {reason && <p className="feature-guide-capability"><Info size={14}/>{reason} Rehber bölümünü yine de okuyabilirsiniz.</p>}
          {current.related.length > 0 && <div className="feature-guide-related"><h4>Birlikte kullanabileceğiniz araçlar</h4><div>{current.related.map(id => {const entry = featureChapters.find(item => item.id === id);return entry ? <button key={id} type="button" onClick={() => related(id)}>{renderIcon(entry.item)}{entry.item.label}<ChevronRight size={13}/></button> : null;})}</div></div>}
        </article> : <article className="feature-guide-cover">
          <div className="feature-guide-page-meta"><span>Feature info</span><span>Mevcut özellikler</span></div>
          <h3>ViiOS’u yakından tanıyın.</h3>
          <p className="feature-guide-lead">Her simgenin arkasında bir araç var. Bu kitapçık, hangisini ne zaman kullanacağınızı adım adım anlatır.</p>
          <Button onClick={() => select(featureChapters[0].id)}>Kitapçığı okumaya başla<ArrowRight size={16}/></Button>
          <div className="feature-guide-cover-stats"><span><strong>{featureChapters.length}</strong>uygulama ve araç</span><span><strong>{featureCategories.length}</strong>konu başlığı</span></div>
          <div className="feature-guide-category-grid">{featureCategories.map((group, position) => <button type="button" key={group} onClick={() => {setCategory(group);setSelected(null);}}><small>0{position+1}</small><strong>{group}</strong><span>{featureChapters.filter(entry => entry.category === group).length} bölüm<ArrowRight size={14}/></span></button>)}</div>
          <p className="feature-guide-cover-note"><Info size={16}/>Araçlar seçili sunucuyla çalışır. Kullanılabilen işlemler işletim sistemine, bağlantı desteğine ve izinlere göre değişir.</p>
        </article>}
      </div>
    </div>
    <footer className="feature-guide-footer"><button type="button" onClick={cover}><BookOpen size={15}/>İçindekiler</button><output aria-label="Kitapçık sayfası">{current ? `${index+1} / ${results.length}` : results.length ? 'Kapak' : 'Sonuç yok'}</output><div><Button variant="ghost" size="icon" aria-label="Önceki bölüm" disabled={index<=0} onClick={() => select(results[index-1].id)}><ArrowLeft size={17}/></Button><Button variant="ghost" size="icon" aria-label="Sonraki bölüm" disabled={!results.length || index>=results.length-1} onClick={() => select(results[index+1].id)}><ArrowRight size={17}/></Button></div></footer>
  </section>;
}
