# GitHub Pages demosu

[English](demo.md) | **Türkçe**

<!-- docs-nav:start -->
[Ana sayfa](../README.tr.md) · [Katkı](../CONTRIBUTING.tr.md) · [Lisans](licensing.tr.md) · [Güvenlik](../SECURITY.tr.md)

**Demo** · [Sunucu bağlantıları](connections.tr.md) · [Windows desteği](windows-support.tr.md) · [Doğrulama](validation.tr.md) · [Telif bildirimleri](notices.tr.md) · [Üçüncü taraflar](../THIRD_PARTY_NOTICES.tr.md)
<!-- docs-nav:end -->

ViiOS'un örnek verili arayüzü GitHub Pages üzerinde statik bir site olarak yayınlanabilir. Demo için sunucu, SSH hesabı, şifre, veritabanı veya AI servisi gerekmez. Sayfa açıldığında örnek masaüstü görünür.

**Yayımlama kısıtı:** Aşağıdaki yayımlama adımları yalnız telif hakkı sahibi veya ayrıca yazılı izin almış kişiler içindir. [Türkçe lisans rehberi](licensing.tr.md), özel ortamda ticari olmayan yerel önizlemeye izin verir; yeniden dağıtım veya üçüncü kişilere barındırma hakkı vermez. Hak sahibinin resmî demosu, başka bir kopyayı yayımlama izni değildir.

## GitHub'da yayınlama

1. Temiz kaynak paketini açın ve içindeki dosyaları GitHub deponuzun köküne yükleyin. `.github/workflows/demo-pages.yml` dosyası da depoda bulunmalı.
2. Deponun **Settings → Pages → Build and deployment → Source** alanında **GitHub Actions** seçin.
3. **Actions → Publish ViiOS demo to GitHub Pages → Run workflow** ile yayınlamayı başlatın. Sonraki `main` güncellemelerinde workflow otomatik çalışır.
4. İşlem bitince `github-pages` ortamında veya Settings → Pages ekranında görünen bağlantıyı açın. Proje depolarında adres genellikle `https://<kullanıcı>.github.io/<depo>/` biçimindedir. Kendi depo adresinizi README'ye bir demo bağlantısı olarak ekleyebilirsiniz.

Workflow, Pages'in bildirdiği alt yolu kullanır; depo adı kodda sabit değildir. Yalnız üretilmiş statik demo dosyaları yayınlanır. Sunucu uygulaması, kaynak klasörünün tamamı veya çalışma verileri Pages'e gönderilmez. Kaynak dosyalarını GitHub'a yüklemek tek başına Pages'i etkinleştirmez; ikinci adım gereklidir.

GitHub'ın resmi yönergesi: [GitHub Pages için özel workflow kullanımı (İngilizce)](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Bilgisayarda önizleme

Node.js 22.13+ ile proje klasöründe:

```sh
npm ci
npm run demo:build
npm run demo:serve
```

Terminalde yazan adresi açın; varsayılan adres `http://127.0.0.1:4180/` olur. Gerçek yönetim uygulamasının 3180 portundan ayrıdır. İlk iki komut paketleri indirip demoyu derler; önceden hazırlanmış demoyu açmak için yalnız son komut gerekir.

GitHub alt yolunu yerelde sınamak için derlemeden önce `VIIOS_DEMO_BASE_PATH=/viios-demo` ayarlayın. PowerShell örneği:

```powershell
$env:VIIOS_DEMO_BASE_PATH = '/viios-demo'
npm run demo:build
npm run demo:serve
```

Bu durumda adres `http://127.0.0.1:4180/viios-demo/` olur. `VIIOS_DEMO_PORT` değişkeniyle önizleme portu değiştirilebilir.

## Neler gösterilir?

- Örnek Linux ve Windows sunucuları ve uygulama masaüstleri.
- Uygulama/port envanteri ve demo için çizilmiş uygulama görselleri.
- Disk kapasitesi, klasör ve uygulama kullanımı, CPU/bellek göstergeleri.
- Örnek dosya gezgini, metin dosyaları, model envanteri ve sürüm geçmişi.
- Açık/koyu tema, masaüstü görünümü ve örnek kısayol düzeni.

Ekranlardaki tüm isimler, IP adresleri, dosyalar ve ölçümler temsilidir. Görseller gerçek uygulamalardan alınmış ekran görüntüleri değildir. Yeni sunucu ekleme, bağlantı bilgisi düzenleme, gerçek şifre kaydetme, dosya yükleme, servis yönetimi ve model çalıştırma demo modunda kapalıdır. Desteklenen görsel düzen değişiklikleri yalnız sayfanın belleğinde kalır; **Demoyu sıfırla** ile başlangıç durumuna dönülür. Tema tercihi tarayıcıda saklanabilir.

## Verilerin ayrılması

`demo/fixtures.mjs` örnek içerikleri üretir; `demo/api.mjs` istekleri tarayıcının belleğinde yanıtlar. Bilinmeyen veya dış adresli isteklerin gerçek ağa yönlendirildiği bir geri dönüş yolu yoktur. API okumaları demo taşıyıcısından geçer; dosya yükleme ayrıca ağ isteği oluşturulmadan reddedilir.

`scripts/build-demo.mjs`, yalnız `public-source-files.json` içindeki kaynakları geçici bir derleme klasörüne alır. `.env`, `data/`, `outputs/`, kayıtlı bağlantılar ve anahtarlar kopyalanmaz; ortamdaki uygulama ayarları da derlemeye aktarılmaz. Normal uygulamanın `dist/client` çıktısı değiştirilmez. Demo dosyaları `outputs/demo-site/` altında üretilir ve Git'ten dışlanır. Workflow bu statik klasörü Pages artifact'i olarak yayınlar.

Normal `npm run build` ve `npm start` komutları gerçek, kimlik doğrulamalı yönetim uygulamasını kullanır. Demo oluşturmak yerel hesabı veya kayıtlı sunucuları değiştirmez.
