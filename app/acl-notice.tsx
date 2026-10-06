'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ACL_ERROR_EVENT, type AclErrorCode, type AclNotice } from './acl-errors';

const guidance: Record<AclErrorCode, string> = {
  ACL_UNSUPPORTED: 'Seçili klasörün bulunduğu dosya sistemi ACL işlemini desteklemiyor. Proje için otomatik ek erişim verilemeyebilir. ACL destekleyen bir klasör seçin veya mevcut dosya izinlerini sunucu yöneticinize kontrol ettirin.',
  ACL_ACCESS_DENIED: 'Sunucu bu klasörün ACL izinlerinin okunmasını veya değiştirilmesini reddetti. Proje klasörünün izinlerini ve bağlama ayarlarını sunucu yöneticinize kontrol ettirin.',
  ACL_UPDATE_FAILED: 'Klasörün ACL izinleri işlenemedi. Projeyi yeniden inceleyin; hata sürerse dosya sistemi ve izinleri sunucu yöneticinize kontrol ettirin.',
};

export default function AclNoticeDialog() {
  const [notices, setNotices] = useState<AclNotice[]>([]);
  useEffect(() => {
    const receive = (event: Event) => {
      const notice = (event as CustomEvent<AclNotice>).detail;
      setNotices(current => current.some(item => item.code === notice.code && item.endpoint === notice.endpoint && item.operation === notice.operation) ? current : [...current, notice].slice(0, 5));
    };
    window.addEventListener(ACL_ERROR_EVENT, receive);
    return () => window.removeEventListener(ACL_ERROR_EVENT, receive);
  }, []);
  const notice = notices[0];
  const dismiss = () => setNotices(current => current.slice(1));
  return <Dialog open={!!notice} onOpenChange={open => { if (!open) dismiss(); }}>
    <DialogContent className="acl-error-dialog" showCloseButton={false}>
      <DialogHeader><DialogTitle className="acl-dialog-title"><ShieldAlert size={22} aria-hidden="true"/>Dosya izinleri (ACL)</DialogTitle><DialogDescription>{notice?.operation} tamamlanamadı.</DialogDescription></DialogHeader>
      {notice && <div className="acl-dialog-body"><p className="onboarding-error">{notice.message}</p><p>{guidance[notice.code]}</p><p className="acl-dialog-note">Bu hata ilgili klasör işlemini etkiler; diğer ViiOS ekranlarını kullanmaya devam edebilirsiniz. Yalnızca <code>acl</code> paketini yüklemek, dosya sistemi veya yetki sorununu çözmeyebilir.</p></div>}
      <div className="connection-form-actions"><Button onClick={dismiss}>Anladım</Button></div>
    </DialogContent>
  </Dialog>;
}
