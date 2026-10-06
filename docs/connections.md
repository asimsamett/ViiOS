# Sunucu ekleme ve otomatik hazırlık

ViiOS denetleyicisi Windows veya Linux üzerinde Node.js ile çalışır. Sunucular arayüzde **Sunucular → Sunucu ekle** üzerinden eklenir. Bilgisayardaki kişisel SSH yapılandırması, SSH agent veya bir yapay zekâ servisi kullanılmaz. SSH bağlantıları uygulamanın içindeki SSH2 istemcisiyle kurulur.

## Ön koşullar

- Hedefe ağ üzerinden erişilmeli ve SSH/SFTP hizmeti açık olmalı. ViiOS, henüz SSH erişimi olmayan bir makineye uzaktan SSH kuramaz.
- Linux hedefte root veya sudo ile yönetici olabilen yerel bir hesap gerekir. Kurulum, eksikse Python 3, Git, iproute2, sudo, ACL ve kullanıcı yönetimi araçlarını apt, dnf, yum, zypper, apk veya pacman ile hazırlar. Desteklenmeyen paket yöneticileri açık bir kurulum hatası verir.
- Windows hedefte Windows PowerShell 5.1 ve Windows OpenSSH Server/SFTP gerekir. Hesap, SSH oturumunda yönetici yetkilerine sahip olmalıdır. UAC nedeniyle yükseltilmemiş bir oturum yeterli değildir. ViiOS uzaktan UAC ayarlarını değiştirmez.
- Linux bağımlılık kurulumunda hedefin paket depolarına erişmesi gerekir. Windows bileşeni ek bir Python veya Node.js kurulumu istemez.

## Ekleme akışı

1. Görünen adı, IP/DNS adresini, SSH portunu ve hedef işletim sistemini girin.
2. **Sunucu anahtarını denetle** adımı, kullanıcı adı veya parola göndermeden SSH anahtarının SHA256 parmak izini alır. Bu değeri sunucu konsolu veya yöneticiniz gibi ayrı, güvendiğiniz bir kaynaktan doğrulayın. Arayüzde parmak izini onaylayın.
3. SSH kullanıcı adını ve parola veya özel anahtar bilgisini girin. Şifreli özel anahtarların parolası desteklenir. Linux sudo şifresi farklıysa ayrıca girin.
4. ViiOS önce onayladığınız anahtarı doğrular, ardından kimlik doğrular. İşletim sistemi/yetki denetimi, bağımlılıklar, dosya aktarımı, kurulum ve özellik doğrulaması adımları arayüzde izlenir.
5. Hazır sunucu envantere eklenir. Desteklenmeyen veya doğrulanamayan özellikler ayrı yetenek alanlarında gösterilir; boş ölçüm veya sıfır kullanım diye sunulmaz.

Sunucunun anahtarı değişirse bağlantı durdurulur. Normal yeniden deneme, kayıtlı parmak izini değiştirmez. Planlı anahtar değişiminde eski yerel kaydı kaldırıp yeni anahtarı ayrı bir kaynaktan doğrulayarak sunucuyu yeniden ekleyin.

## Sunucuda yapılan kurulum

Linux dosyaları paketin açık manifesti üzerinden aktarılır. Geçici dosyalar özel bir SFTP dizinine konur; boyutları ve SHA256 özetleri doğrulanır. Python dosyaları derlenebilirlik açısından kontrol edilir. Yalnız bu paket içindeki dosyalar kurulur.

- Sürümler: /opt/viios-agent-releases/release-*
- Etkin sürüm bağlantısı: /opt/viios-agent
- Durum dizini: /var/lib/viios-agent
- Git işlemleri: oturum açamayan viios-agent sistem hesabı
- Sudo: /etc/sudoers.d/viios-agent-* altında belirli, tam yardımcı komutları

Yardımcı kod ve kurallar root tarafından sahiplenilir. Kurallar visudo ile doğrulanır. Genel kabuk veya sınırsız sudo kuralı eklenmez. Mevcut, ViiOS olarak tanımlanmayan kurulum dizini otomatik olarak değiştirilmez. Eski ViiOS sürüm dizinleri geri dönüş için saklanır.

Windows bileşeni C:\ProgramData\ViiOS\agent\windows-agent.ps1 konumuna kurulur. Dosyanın SHA256 özeti doğrulanır. Dizin ve mevcut dosyaların izinleri Administrators ve SYSTEM ile sınırlandırılır. Güncelleme dosyayı atomik değiştirir ve önceki sürümü windows-agent.previous.ps1 olarak saklar. Mevcut sunucu uygulamaları veya hizmetleri kurulum sırasında başlatılmaz/durdurulmaz.

## Kimlik bilgileri

SSH parolası veya özel anahtarı denetleyicinin veri dizinindeki connections/servers.json içinde AES-256-GCM ile şifrelenir. Kimlik bilgileri sunucu kimliği, adresi, portu, kullanıcı adı, işletim sistemi, kimlik doğrulama türü ve sabitlenmiş sunucu anahtarına bağlanır. API listeleri şifrelenmiş veya açık kimlik bilgilerini döndürmez.

Şifreleme anahtarı connections/master.key dosyasındadır. POSIX'te dizinler 0700 ve dosyalar 0600; Windows'ta denetleyiciyi çalıştıran kullanıcı ve SYSTEM erişimi kullanılır. Bu, aynı kullanıcı hesabını ele geçiren birine karşı ayrı bir kasa koruması değildir. Veri yedeğinde sunucu kayıtlarıyla anahtarı birlikte, güvenli yerde koruyun. Anahtar kaybolursa mevcut kayıtlar için sessizce yeni anahtar üretilmez.

Sudo şifresi yalnız etkin kurulum işinin belleğinde tutulur; dosyaya kaydedilmez. Parolalar komut satırına konmaz. SSH komutunun stdin akışından sudo'ya aktarılır. Hata yanıtlarında ham uzak çıktı veya kimlik bilgileri gösterilmez.

## Hata, yeniden deneme ve kaldırma

Aynı anda en fazla iki sunucu hazırlanır; diğerleri sırada bekler. Aynı sunucu için yeniden denemeler birleştirilir. İşlemler zaman aşımı ve çıktı sınırlarıyla çalışır. ViiOS kurulum sırasında kapanırsa kayıt “yarıda kaldı” durumuna alınır; uygulama yeniden açıldığında parola gerektirebilecek kurulum otomatik tekrar başlatılmaz.

**Yeniden dene**, kayıtlı SSH bilgileri ve parmak iziyle kurulumu tekrar dener. Farklı bir sudo parolası verilebilir. Yanlış SSH şifresi, özel anahtar veya IP bilgisi için sunucuyu kaldırıp yeniden ekleyin. **Kaldır**, yerel kaydı ve etkin bağlantıları kaldırır; uzak ViiOS dosyalarını veya sunucu uygulamalarını silmez.

Linux/Windows desteği eşit özellik seti anlamına gelmez. Windows Git sürümleme ve model eşzamanlılık ölçümleri bu sürümde kullanılamaz. Windows dosya/kontrol sınırları için [Windows destek belgesi](windows-support.md) geçerlidir. UAT çalışma ortamları iki platformda da devre dışıdır.

## API sözleşmesi

Bu uçlar ViiOS yönetici oturumu ve mutasyonlar için aynı kaynak koruması altında sunulur:

- GET /api/connections → servers dizisi.
- POST /api/connections/probe → host, port ve platform alır; fingerprint ve algorithm döner. Kimlik bilgisi almaz.
- POST /api/connections → name, host, port, username, platform, authType, fingerprint ve ilgili password/privateKey/passphrase alanlarını alır. İsteğe bağlı sudoPassword yalnız bu kurulum içindir. HTTP 202 ve server kaydı döner.
- GET /api/connections/:id → server kaydı.
- POST /api/connections/:id/retry → isteğe bağlı sudoPassword; HTTP 202 ve server kaydı.
- DELETE /api/connections/:id → yalnız yerel kayıt kaldırılır; ok yanıtı.

Sunucu durumları pending, installing, ready ve error değerlerini alır. phase, message, capabilities, updatedAt ve errorCode alanları ilerlemeyi açıklar. Özel kimlik bilgileri bu kayıtta yoktur. Her sunucu rastgele srv- önekli kimliğe sahiptir. Mutasyonlar ve anahtar sorguları IP başına dakikada 20 istekle sınırlıdır.

## Doğrulama kapsamı

Bağlantı testleri yerel SSH2 test sunucusuyla anahtar sabitleme, parmak izi sorgusunun kimlik bilgisi göndermemesi, parola/şifreli anahtar oturumu, JSON stdin, Windows komut eşlemesi ve yerel tünelleri doğrular. Kurulum testleri Linux/Windows komutlarını, SFTP aktarım manifestini, yetki kontrolünü, parola sızıntısını ve kısmi özellik durumlarını sahte uzak çalıştırıcıyla denetler. Gerçek üretim sunucusuna bu testler kapsamında bağlanılmaz. Gerçek, yeni bir Linux/Windows hedefinde tam uzaktan kurulum henüz doğrulanmış değildir.
