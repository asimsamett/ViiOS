# ViiOS Standalone

<img src="public/brand/viios-icon-192.png" alt="ViiOS" width="80" height="80">

**Visual Infrastructure Intelligence** — Windows veya Linux üzerinde çalışır; kendi Windows ve Linux sunucularınızı yönetmek için boş çalışma alanıyla başlar. AI hesabı, AI aracı veya geliştiricinin SSH ayarları gerekmez. Arayüz Türkçedir.

[Canlı demo](https://asimsamett.github.io/viios/) · [Sürümler](https://github.com/asimsamett/viios/releases) · [Katkı rehberi](CONTRIBUTING.md) · [Güvenlik bildirimi](SECURITY.md)

**Ticari olmayan kullanım:** ViiOS, [PolyForm Noncommercial 1.0.0](LICENSE.md) lisansıyla paylaşılır. Lisansın izin verdiği ticari olmayan amaçlarla kullanılabilir, değiştirilebilir ve dağıtılabilir. Bu lisans ticari kullanım izni vermez; ticari kullanım için hak sahibinden ayrıca izin alınması gerekir. Lisans metni ve [NOTICE](NOTICE) bildirimi korunmalıdır. Üçüncü taraf bileşenlerin kendi lisansları geçerlidir; [bildirimlere](THIRD_PARTY_NOTICES.md) bakın.

## Örnek verili demo ve GitHub önizlemesi

Arayüzü sunucu eklemeden görmek için `npm ci`, `npm run demo:build`, ardından `npm run demo:serve` çalıştırın. Terminaldeki 4180 portlu adres örnek Linux/Windows sunucuları, uygulamalar, depolama ve dosya ekranlarını açar. Demo hiçbir gerçek sunucuya bağlanmaz; bağlantı bilgileri ve şifreler istenmez.

GitHub'da **Settings → Pages → Source: GitHub Actions** seçin, ardından **Actions → Publish ViiOS demo to GitHub Pages** workflow'unu çalıştırın. Workflow dosyası bu pakette bulunur; sonraki `main` güncellemelerinde demo otomatik yayınlanır. Yayın adresi GitHub Pages ekranında görünür. [Demo kurulumu ve veri ayrımı](docs/demo.md).

## Başlatma

Node.js **22.13+** kurun, projeyi indirip klasörünü açın.

- **Windows:** `start.cmd` dosyasını çalıştırın.
- **Linux:** `sh start.sh` komutunu çalıştırın.
- **Manuel:** `npm ci`, `npm run setup`, ardından `npm start`.

İlk hazırlık internetten npm paketlerini ve önizlemeler için Chromium'u indirir. Sonraki açılışlar kayıtlı kurulumu kullanır. Linux'ta tarayıcı sistem kütüphaneleri eksikse `npx playwright install --with-deps chromium` kullanın; sistem paketleri için yetki gerekir.

**http://127.0.0.1:3180** adresini açın. İlk kurulumda en az **8 karakterli** yönetici şifresini iki kez girip oluşturun, ardından bu şifreyle giriş yapın. Kurulum kodu istenmez; büyük harf, rakam veya özel karakter zorunluluğu yoktur.

## Sunucu ekleme

1. **Sunucular → Sunucu ekle** ekranında hedefi **Linux** veya **Windows** seçin. Bu seçim ViiOS'un çalıştığı bilgisayardan bağımsızdır.
2. IP/sunucu adı ve SSH portunu girin. Gösterilen SSH parmak izini sunucu yöneticisi veya konsolundan aldığınız değerle karşılaştırıp onaylayın.
3. Kullanıcı adı ve şifre veya SSH özel anahtarı girin. Linux'ta gerektiğinde sudo şifresini girin.
4. ViiOS bağlantıyı sınar, sabit yardımcılarını kurar ve özelliklerini doğrular. İlerleme ve hata nedenleri görünür; başarısız kurulum yeniden denenebilir.
5. Hazır sunucuyu seçin. Ekranlar seçili sunucunun verilerini gösterir; kayıtlar yeniden açılışta korunur.

Hedefte **erişilebilir SSH hizmeti**, geçerli giriş bilgileri ve kurulum yetkisi gerekir. Linux'ta root veya sudo; Windows'ta OpenSSH Server, SFTP ve yönetici hesabı gerekir. SSH kapalı bir bilgisayara yalnız IP ve şifreyle erişim kurulamaz. [Windows hazırlığı](docs/windows-support.md).

Linux yardımcısı `/opt/viios-agent`, verileri `/var/lib/viios-agent`; Windows yardımcısı `C:\ProgramData\ViiOS\agent` altında bulunur. Linux'ta eksik bağımlılıklar desteklenen paket yöneticisiyle kurulur. Sunucu ekleme bu konumlara yazılmasına ve gerekli yardımcı yetkilerinin oluşturulmasına izin verir. Mevcut uygulamalar taşınmaz veya kendiliğinden yeniden başlatılmaz.

## Sunucu bağlantısını düzenleme

**Sunucular** ekranındaki **Düzenle** düğmesi hazır, hatalı, bekleyen veya kurulumu süren kaydın bağlantı sihirbazını açar. Görünen ad, Linux/Windows seçimi, IP veya sunucu adı, SSH portu, kullanıcı adı ve kimlik doğrulama yöntemi değiştirilebilir. **Sunucu → Kimlik → Bağlantı** adımlarında ilerleyin; SSH parmak izini yeniden kontrol edip onaylayın.

**Kayıtlı SSH kimlik bilgilerini kullan** seçeneği mevcut şifreyi veya özel anahtarı korur; kayıtlı gizli bilgiler ekrana getirilmez. Değiştirmek için bu seçeneği kaldırıp yeni bilgileri girin. Kimlik doğrulama yöntemi değiştiğinde yeni yöntemin bilgileri gerekir. Linux'ta gerekiyorsa yalnız bu kurulum için sudo şifresi girin.

**Kaydet ve yeniden bağlan**, aynı sunucu kaydını güncelleyip bağlantı ve kurulum adımlarını yeniden başlatır. Sunucu kimliği, veri klasörü ve Dock/masaüstü düzeni korunur. Kurulum sürüyorsa önce mevcut deneme durdurulur. Başka bir pencerede bağlantı bilgileri değiştirilmişse güncel kaydı yeniden açın; ekrandaki kurulum ilerlemesi tek başına düzenleme çakışması oluşturmaz.

## Destek kapsamı

| İşlev | Linux hedef | Windows hedef |
|---|---|---|
| Şifre/anahtar ile ekleme ve kurulum takibi | Var | Var; OpenSSH önkoşulu |
| Port/uygulama envanteri, raporlar | Var | Var |
| CPU, bellek, işlemler ve diskler | Var | Var; Windows sayaçları |
| Genel depolama, klasör/uygulama kullanımı | Var | Var; bağlı sabit diskler |
| Dosya gezgini ve temel dosya işlemleri | İzin verilen kökler | İzin verilen kökler |
| Büyük yükleme ve ZIP aktarımı | Var | Bu sürümde desteklenmez |
| Servis kontrolü | Doğrulanan, korunmayan servisler | Doğrulanan ve izin verilen Windows servisleri |
| Git sürüm yönetimi | Var | Bu sürümde desteklenmez |
| Model envanteri | Yerel yapılandırma/servis keşfi | Yerel Ollama varsa |
| Özel UAT dağıtımı ve model yük testi | Bu dağıtımda yapılandırılmamış | Bu dağıtımda yapılandırılmamış |

Klasör ölçümleri süre/kayıt sınırlarına tabidir; eksik ölçümler belirtilir. Disk kapasitesi bağlı dosya sistemlerinden ölçülür; ağ diskleri ve ayrı havuz hesabı gerektiren depolar her zaman toplama dahil değildir. Chromium yoksa diğer ekranlar kullanılabilir. Yalnız hedef sunucu içinden erişilen uygulamalar için SSH tüneli ViiOS'un çalıştığı bilgisayarda açılır; başka bilgisayardaki tarayıcı için otomatik uygulama yayınlama servisi sağlanmaz.

## Dock ve masaüstü kısayolları

Dock’taki ve masaüstündeki **+** düğmelerinden veya ViiOS menüsündeki **Masaüstünü düzenle** seçeneğinden düzenleyiciyi açın. Uygulama, yönetim aracı, klasör veya `http://` / `https://` adresi ekleyin; adını değiştirin, yukarı/aşağı taşıyın veya kaldırın. Dock ve masaüstü listeleri ayrı düzenlenir; **Kaydet** seçili sunucunun düzenini kalıcı olarak saklar.

Düzen, tarayıcı belleği yerine ViiOS’un özel veri klasöründeki `servers/<sunucu-kimliği>/desktop-layout.json` dosyasındadır. Farklı tarayıcıdan aynı sunucuya girildiğinde kayıtlı düzen kullanılır. Yeni eklenen sunucu kendi varsayılan düzeniyle başlar; düzenleyici her sunucuda kullanılabilir.

**Dışa aktar** ve **İçe aktar** ile düzeni JSON dosyası olarak başka bir ViiOS kurulumuna veya sunucuya taşıyabilirsiniz. Hedefte bulunmayan uygulama veya özellik kayıtları görünür kalır ve düzenlenebilir. **Varsayılan** seçili alanı ilk düzenine döndürür; değişikliği uygulamak için kaydedin. Dock en fazla 32, masaüstü en fazla 16 kısayol içerir. Başlat aramasındaki eski sabitlemeler ve son kullanılanlar ayrı kalır.

Kaynak ZIP kişisel veri ve ayarları içermez. Mevcut kurulumun kaynaklarını güncellerken `data/` klasörünü koruyun; klasörün tamamını taşımak sunucu kayıtlarıyla birlikte kaydedilmiş düzenleri de taşır. `DATA_DIR` kullanılıyorsa aynı özel veri dizinini koruyun.

## Veriler ve erişim

Linux hedeflerde **`acl` paketi isteğe bağlıdır**. Yalnız `getfacl` / `setfacl` eksik diye kurulum durmaz veya paket yöneticisi çalıştırılmaz. ViiOS, proje erişim izinlerini Python üzerinden doğrudan yönetir. Sunucu ekleme ekranı bu durumu açıklar; kurulumda ACL komutları bulunamadığında sunucu kartında bilgi gösterilir. Bu kontrol, dosya sisteminin ACL desteğini ölçmez.

Dosya sistemi ACL işlemlerini desteklemiyorsa ya da izin değişikliğini reddediyorsa bazı proje klasörlerinde sürüm yönetimi için ek erişim hazırlama işlemi kullanılamayabilir. ViiOS bu tür bir işlem hatasında açıklayıcı bir popup gösterir; izleme ve mevcut izinlerle yapılabilen dosya işlemleri devam eder. `acl` paketini yüklemek tek başına dosya sistemi veya yetki sorunlarını çözmez. Yapılandırılmış sunuculardaki yardımcılar kaynak kodu güncellenince kendiliğinden değiştirilmez; yeni hata kodları güncel yardımcılarla yapılan kurulumlarda iletilir.

`data/` yönetici şifre özetini, şifreli bağlantı bilgilerini ve sunucu kayıtlarını saklar. Şifreleme anahtarı aynı özel dizindedir; bu dizini birlikte yedekleyin. Windows ACL ve Linux dosya izinleri erişimi sınırlar. ViiOS yöneticisi eklenen sunuculara verilen yönetim yetkisini kullanabilir.

**GitHub'a data, .env, outputs, logs veya özel anahtarlar koymayın.** `.gitignore` ve kaynak ZIP'i bunları dışlar. Sunucu kaydını kaldırmak hedefteki yardımcıları veya uygulamaları silmez.

### Paylaşılacak kaynak paketini hazırlama

Klasörün tamamını elle ZIP'lemek yerine `python scripts/package-source.py` çalıştırın (paketi hazırlayan bilgisayarda Python 3.9+ gerekir). Paketleyici yalnız `public-source-files.json` içinde açıkça listelenmiş kaynak dosyalarını alır. Yeni dosyalar incelenip listeye eklenene kadar pakete girmez. `data/`, `outputs/`, ortam ayarları, özel anahtarlar, günlükler, yerel veritabanları ve AI geliştirme aracı dizinleri kaynak listesine eklense bile reddedilir. Sembolik bağlantılar, hard link dosyaları ve Windows junction noktaları kabul edilmez.

Paketleme, kaynaklardaki özel ağ IP'lerini, bazı anahtar/token biçimlerini ve boş olması gereken başlangıç envanterlerini kontrol eder. Bu tarama manuel içerik incelemesini tamamlar; her tür gizli bilgiyi tanıyacağı varsayılmamalıdır. Yalnız kontrol için `python scripts/package-source.py --check`; koruma testleri için `python -m unittest discover -s tests -p test_public_source.py` kullanın.

Sonuç `outputs/releases/ViiOS-Standalone-<sürüm>-public-source-<özet>.zip` dosyasıdır. İçindeki `ViiOS-Standalone/` klasörü paylaşılacak kaynaktır; yanındaki `.sha256` dosyası ZIP'in doğrulama özetidir. ZIP içindeki `PUBLIC-SOURCE-MANIFEST.json`, her dosyanın boyutunu ve SHA-256 özetini içerir. Paket yazıldıktan sonra giriş listesi ve tüm dosya içerikleri tekrar doğrulanır. Önceden üretilmiş ZIP'ler otomatik güncellenmez; komutun son verdiği paketi kullanın.

Şifre değiştirme: `npm run set-password`, sonra ViiOS'u yeniden başlatın. Ağdan kullanım için `.env.example` temelinde `APP_HOST` ayarlayın; HTTPS ters vekil kullanıp `COOKIE_SECURE=true` ve doğru `APP_ORIGIN` değerini girin.

## Docker ve geliştirme

İsteğe bağlı: `docker compose up --build -d`. İlk açılışta tarayıcıdan yönetici şifrenizi oluşturun. Veri named volume içinde kalır; varsayılan port yereldir. Bu çalışma ortamında Docker motoru bulunmadığından imaj çalıştırma testi yapılmamıştır.

Kontroller: `npm test`, `npm run check`, `npm run build`. Geliştirme için bir terminalde `npm start`, diğerinde `npm run dev`; vekil 3180'e bağlanır. Windows yardımcı testleri PowerShell 5.1, Linux yardımcı testleri Linux gerektirir.

Proje: [asimsamett/viios](https://github.com/asimsamett/viios). Kullanım koşulları için [LICENSE.md](LICENSE.md), katkı göndermek için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasını okuyun.
