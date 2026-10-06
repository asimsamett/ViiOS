'use client';

import { useEffect, useState } from 'react';
import { FlaskConical, RotateCcw, X } from 'lucide-react';
import { PUBLIC_BASE_PATH } from '@/lib/public-mode';
import './demo-frame.css';

export default function DemoFrame({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    // Links opened by the simulated desktop must never contact a real target.
    const stopServerNavigation = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const address = new URL(anchor.getAttribute('href') || '', location.href);
      if (address.protocol === 'blob:' || address.protocol === 'data:') return;
      if (address.origin !== location.origin || address.pathname.includes('/api/')) {
        event.preventDefault();
        event.stopPropagation();
        setNotice('Demo, gerçek uygulama veya sunucu bağlantısı açmaz. Örnek ekranları buradan inceleyebilirsiniz.');
      }
    };
    document.addEventListener('click', stopServerNavigation, true);
    document.addEventListener('auxclick', stopServerNavigation, true);
    return () => {
      document.removeEventListener('click', stopServerNavigation, true);
      document.removeEventListener('auxclick', stopServerNavigation, true);
    };
  }, []);
  return <div className="viios-demo">
    <aside className="viios-demo-banner" aria-label="Demo bilgisi">
      <span className="viios-demo-badge"><FlaskConical size={14}/>DEMO</span>
      <p>Örnek veriler <span>· Gerçek sunucu bağlantısı yok</span></p>
      <nav aria-label="Demo ekranları">
        <a href={`${PUBLIC_BASE_PATH}/`}>Masaüstü</a>
        <a href={`${PUBLIC_BASE_PATH}/?view=storage`}>Depolama</a>
        <a href={`${PUBLIC_BASE_PATH}/?view=servers`}>Sunucular</a>
      </nav>
      <button type="button" onClick={() => location.reload()} title="Örnek verileri başlangıca döndür"><RotateCcw size={14}/><span>Demoyu sıfırla</span></button>
    </aside>
    {children}
    {notice && <output className="viios-demo-notice">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Demo bildirimini kapat"><X size={16}/></button></output>}
  </div>;
}
