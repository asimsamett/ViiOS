# Windows hedef desteği

[English](windows-support.tr.md) | **Türkçe**

<!-- docs-nav:start -->
[Ana sayfa](../README.tr.md) · [Katkı](../CONTRIBUTING.tr.md) · [Lisans](licensing.tr.md) · [Güvenlik](../SECURITY.tr.md)

[Demo](demo.tr.md) · [Sunucu bağlantıları](connections.tr.md) · **Windows desteği** · [Doğrulama](validation.tr.md) · [Telif bildirimleri](notices.tr.md) · [Üçüncü taraflar](../THIRD_PARTY_NOTICES.tr.md)
<!-- docs-nav:end -->

ViiOS, Windows veya Linux üzerinde çalışan denetleyiciden SSH üzerinden Windows hedef yönetebilir. Hedef, `server/agent/windows-agent.ps1` dosyasını Windows PowerShell 5.1 veya üstüyle çalıştırır. Linux denetleyicinin Windows hedefe bağlanmak için PowerShell'e ihtiyacı yoktur.

Hedefte OpenSSH Server önceden kurulmuş, çalışır, erişilebilir ve seçilen hesap için yapılandırılmış olmalıdır. ViiOS, mevcut bir yönetim bağlantısı olmadan ilk SSH bağlantısını uzaktan kuramaz. İlk kurulum yükseltilmiş yönetici hesabı gerektirir. Yerel Windows adaptörü Windows PowerShell 5.1, CIM ve NetTCPIP modülünü kullanır; Python, WSL, Git, Docker veya Linux uyumluluk katmanı gerekmez.

Kurulum, güvenilen betiği `C:\ProgramData\ViiOS\agent\windows-agent.ps1` konumuna yerleştirir. Yardımcı dizinine, betiğine ve isteğe bağlı yapılandırmasına yalnız Administrators ve SYSTEM yazabilmelidir. Betik SSH hesabının yetkileriyle çalışır; işlem kontrolleri Windows ACL'lerinin veya denetleyicideki yetkilendirmenin yerini tutmaz.

## İletişim sözleşmesi

SSH başlatıcısı sabit bir yardımcı adı seçer ve betiği `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ... -Helper <name>` ile çağırır. İstek yalnız standart girdiden UTF-8 JSON nesnesi olarak iletilir; komut satırına eklenmez ve PowerShell olarak değerlendirilmez. JSON nesnesinden sonra standart girdi kapatılır. Boş girdi `{}` sayılır.

Her çağrı BOM içermeyen tek bir UTF-8 JSON değeri döndürür. Hatalar `ok: false`, `available: false`, `status` ve güvenli bir `error` mesajı içeren nesnelerdir. Başarı yalnız süreç çıkış kodundan çıkarılmamalı; JSON hata sonucu incelenmelidir. Ham istisna mesajları, komut argümanları, kimlik bilgileri ve servis komut satırları döndürülmez.

| Yardımcı | Desteklenen davranış |
|---|---|
| `capabilities` | Yardımcı sürümü, işletim sistemi, yönetici durumu, PowerShell sürümü, özellik bayrakları ve sınırlar. |
| `scan` | TCP dinleyicileri, UDP bağlamaları, sahip süreç, servis ilişkisi, çalıştırılabilir dosya dizini, isteğe bağlı sayısal port aralığı ve sınırlı yerel HTTP/HTTPS keşfi. |
| `resources` | Örneklenmiş CPU, çalışma kümesi belleği, süreç G/Ç, dinleyici süreç ağaçları, sunucu belleği/sayfalama dosyası/çalışma süresi ve bağlı sabit birim toplamları. |
| `storage` | `overview`, sınırlı `usage` ve `apps`/`applications` ölçüm anlık görüntüleri. |
| `files` | Özellikler, sanal sürücü/kök gezinmesi, listeleme/arama/okuma/indirme/özellikler, oluşturma/yazma/klasör oluşturma/yükleme, normal dosya kopyalama, aynı birimde taşıma, geri alınabilir çöp kutusu ve geri yükleme. |
| `control` | Yalnız açıkça kaydedilmiş bağımsız uygulama servisleri için durum, başlatma/durdurma/yeniden başlatma. |
| `models` | Erişilebiliyorsa sabit yerel Ollama `/api/tags` uç noktasından salt okunur keşif. |
| `versions` | Kullanılamayan özellik ve yapılandırılmış desteklenmeyen işlem yanıtı. Mevcut depolar değiştirilmez. |
| `concurrency` | Kullanılamayan özellik; model iş yükü veya GPU ölçümü uydurulmaz. |

Özellik desteği, belirli bir hedef kaynağa erişilebildiğini garanti etmez. Yerel Ollama erişilemiyorsa model keşfi `available: false` döndürür. Boş servis izin listesi kontrol özelliğini kapatır. Bu sürümde uygulama servislerini hedef yapılandırmasına yönetici kaydetmelidir; servis kayıt arayüzü henüz yoktur. Windows sürüm yönetimi, Git geçmişi, model eşzamanlılık ölçümleri, akışla yükleme, ZIP dışa aktarma ve özyinelemeli klasör kopyalama desteklenmez.

## Sanal yollar ve dosya kökleri

Arayüz eğik çizgili sanal yollar kullanır: `/` sabit sürücüleri listeler, `/C:` bir sürücü düğümüdür, `/C:/Users/example/Projects` yerel dizindir. UNC, aygıt yolları, alternatif veri akışları, noktayla üst dizine geçiş, ayrılmış aygıt adları, sonda nokta/boşluk, kontrol karakterleri ve yerel olmayan/çıkarılabilir sürücüler reddedilir. Reparse noktaları, junction ve sembolik bağlantılar izlenmez. Birden fazla hard link'i olan dosyaların içeriği açılamaz veya kopyalanamaz.

Varsayılan dosya yönetimi kökleri, `/C:/Users`, `/C:/Projects`, `/C:/inetpub` ve `/C:/Apps` içinden mevcut olanlardır. Başka sürücü harfleri açık kök tanımıyla kullanılabilir. Yapılandırılmış bir kök veya başka kök içeren üst dizin değiştirilemez, taşınamaz veya çöpe atılamaz. Windows, Program Files, ProgramData, AppData, `.ssh`, `.gnupg` ve `.codex` gibi sistem, yardımcı, kimlik bilgisi ve profil durum konumları izinli kökün içinde de korunur.

Yönetici, kökleri daraltmak ve uygulama servislerini kaydetmek için `C:\ProgramData\ViiOS\agent\windows-agent.json` oluşturabilir:

```json
{
  "roots": ["/C:/Apps", "/D:/Projects"],
  "services": [
    { "name": "ContosoWeb", "ports": [8080] }
  ]
}
```

Yalnız mevcut yerel sabit sürücü dizinleri açılır. Yapılandırma yardımcı dizininin yalnız yöneticiye yazma izni veren ACL'si altında kalmalıdır; uygulama dizinine kullanıcıların değiştirebildiği bir yapılandırma konmamalıdır.

Yazma için güncel dosya revizyonu gerekir. Adaptör son reparse noktasını izlemeden dosyayı açar, özel dosya tanıtıcısı alır ve baytları değiştirmeden kimlik/revizyonu tekrar kontrol eder. Yeni hedefler yalnız yeni oluşturma yöntemiyle açılır. Kopyalama, taşıma ve çöpe atma kaynak revizyonu gerektirir; kopyalama aktarım boyunca okuma tanıtıcısını tutar. Sınırlı tarama ve işlemler sırasında kullanılan üst dizinler yeniden adlandırma/değiştirmeye karşı tutulur. Bu kontroller eski arayüz revizyonlarını yakalar. Yazma yerinde diske aktarılır; elektrik kesintisine karşı atomik işlem değildir. Taşıma/çöp revizyon kontrolü iyimserdir; süreçler arası atomik karşılaştırma-değiştirme işlemi değildir.

Geri alınabilir çöp kutusu her kökün `.viios-trash` dizinindedir; taşıma aynı birimde kalır. Geri yükleme mevcut hedefin üzerine yazmaz. Kalıcı özyinelemeli silme veya otomatik çöp temizleme yoktur. Kökün Windows ACL'leri çöp kutusuna da uygulanır.

Metin düzenleme 1 MiB, JSON yükleme ve indirme 16 MiB ile sınırlıdır; ikili aktarım base64 kullanır. Normal dosya kopyalama sınırı 200 MiB'dir. Klasör kopyalama, birimler arası taşıma ve akışlı ZIP işlemleri desteklenmiyor yanıtı verir. Özellik bilgisi `streamUpload: false`, `streamExport: false`, `directoryCopy: false` ve sayısal sınırları içerir; arayüz bu işlemleri kapatabilir.

## Kaynak ve depolama ölçümleri

Web keşfi yerel TCP dinleyicilerinin bildirdiği adreslere yalnız `GET /` gönderir. Tüm adresleri dinleyen bağlamalar loopback'e eşlenir; açıkça belirtilen özel yerel bağlamalar desteklenir. Genel/harici adresler, yalnız UDP bağlamaları ve yaygın HTTP dışı altyapı portları dışlanır. En fazla altı eşzamanlı işçi, 128 aday, 20 saniyelik zamanlama bütçesi, 1,2 saniyelik denemeler ve 32 KiB yanıt sınırı kullanılır. Yönlendirmeler izlenmez. Geçerli HTTP durum satırı uygulamayı açmayı sağlar; tanınmayan protokoller normal servis olarak kalır. HTTPS yerel keşifte bağlantıya özel sertifika kontrolü kullanır; güven veya sunucu adı doğrulaması başarısızsa `tlsUnverified: true` gösterir. Süreç genelindeki sertifika doğrulaması değiştirilmez. Sunucu adına bağlı sanal host'lar ek yapılandırma gerektirebilir; yavaş servis sonraki taramaya kadar tanınmayabilir.

TCP/UDP dinleyici süreçleri kaynak gruplarını başlatır. Alt süreçler en yakın dinleyici üst sürece aittir; örtüşen süreç ağaçları iki kez sayılmaz. CPU yaklaşık 650 ms farkla ve mantıksal işlemci sayısına göre ölçülür. Süreç kimliği değişir veya kaybolursa örnek kullanılamaz. Windows okuma/yazma sayaçları yalnız fiziksel diski değil tüm G/Ç'yi içerir. Linux yük ortalamaları Windows'ta yoktur; alan açıklamayla boş bırakılır.

Depolama özeti CIM üzerinden bağlı yerel sabit birimleri alır ve birim kimliğine göre tekilleştirir. Yerel kapasite çağrıları boş alan ile SSH hesabının kullanabildiği alanı ayırır. Normal sürücü/bağlama yolu bulunmayan bağlı olmayan kurtarma bölümleri dışlanır. Birim ve klasör toplamları farklı şeyleri ölçer: dosya sistemi metaverisi, diğer kullanıcıların korunan verileri ve ayrılmış kapasite fark oluşturabilir.

Klasör taraması `FileStandardInfo` ile ayrılmış alan metaverisini inceler; dosya içeriği okumaz. Her tarama ağacında hard link'ler tekilleştirilir; reparse girdileri, korunan yollar, erişilemeyen dosyalar ve birim değişiklikleri atlanır. Taramalar genellikle 15.000 girdi ve tarama başına en fazla 8 saniyeyle sınırlıdır. Kullanım isteğinin toplam bütçesi 12 saniye ve en fazla 200 doğrudan girdidir. Uygulama klasörü ölçümleri toplam 20 saniye, 100 yol ve yol başına 5 saniyeyle sınırlıdır. Birden fazla uygulamanın paylaştığı yolların değerleri toplanamaz.

Atlanan veya bütçesi dolan sonuçlarda `partial: true` ve değerlerin alt sınır olduğunu açıklayan `reason` bulunur. Ölçülemeyen değer `null` olur; sıfır uydurulmaz. Sonuçlar `status: ready` ile eşzamanlı sınırlı anlık görüntülerdir; denetleyici bunları ayrıca önbelleğe alabilir veya sorgulayabilir. Adaptör tüm sürücüyü dolaşan arka plan taraması başlatmaz.

## Servis kontrolü

Kontrol kaydı tam Windows servis adını ve beklenen portları belirtir. Servis ayrı süreçte çalışmalı, devre dışı olmamalı ve Running veya Stopped durumunda kararlı olmalıdır. Kayıtlı port başka sürece aitse kontrol kapanır. SSH, WinRM, ViiOS ve temel sistem servisleri yapılandırmaya eklense de korunur. Kayıtlı olmayan dinleyiciler görüntülenebilir; sonlandırılamaz veya kontrol edilemez.

Kontrol belirteci servis adı, PID, süreç başlangıç kimliği, servis durumu ve kayıtlı portlardan üretilir. İşlemden hemen önce yeni ölçüm gönderilen belirteçle eşleşmelidir. Yalnız sabit başlat/durdur/yeniden başlat işlemleri vardır. Durdurma, çalışan bağımlıları reddeden CIM `StopService` yöntemini kullanır; bağımlıları da durdurabilen .NET Framework `ServiceController.Stop()` kullanılmaz. Başlatma, durmuş önkoşul servislerini kendiliğinden başlatmak yerine işlemi reddeder. Adaptör istenen durumu bekler; sonraki envanter dinleyicileri doğrular. İstekten keyfî süreç komutu kabul etmez.

## Yerel doğrulama

Windows'ta bağımsız proje dizininden çalıştırın:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File tests/windows-agent.test.ps1
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/windows-agent.test.ps1
```

Testler yalnız `tests/.windows-agent-test` altındaki benzersiz geçici ortamı oluşturur ve kaldırır. Yol reddi, korunan kökler, oluşturma/okuma/yazma ve eski revizyonlar, kopyalama/taşıma/çöp/geri yükleme, sınırlı yükleme/indirme/arama/alan ölçümü, hard link ve junction, taklit TCP/UDP/CIM envanteri, servis izin listeleri, korunan servisler, eski kontrol belirteçleri, denetleyici istek/yanıt yapıları ve desteklenmeyen özellikler kapsanır. Geçici loopback HTTP örnekleri metaveri tanımayı, dış yönlendirmelerin izlenmemesini, HTTP dışı yanıtların reddini ve UDP'nin dışlanmasını doğrular. Gerçek servis veya uzak sunucularda işlem yapılmaz.

Salt okunur denemelerde kurulu sabit betiğin `capabilities`, `scan`, `resources` veya `{"action":"overview"}` ile `storage` yardımcısı kullanılabilir. Rutin doğrulamada tüm sürücüyü taramak yerine sınırlı test ortamını kullanın. Windows'tan Windows'a ve Linux'tan Windows'a SSH kurulumu için bu yerel adaptör testlerinin ötesinde ayrı hedef entegrasyon kontrolleri gerekir.
