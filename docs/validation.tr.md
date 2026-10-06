# Doğrulama

[English](validation.md) | **Türkçe**

Bu kayıtlar tarihseldir; tüm kontrollerin güncel commit üzerinde yeniden çalıştırıldığı anlamına gelmez. Test ve dosya sayıları ilgili tarihteki sürüme aittir. Güncel otomatik sonuçlar [GitHub Actions](https://github.com/asimsamett/ViiOS/actions) ekranındadır.

## 6 Ekim 2026 — İlk GitHub yayını

Standalone önizleme ve örnek verili demo yayımlandı. [Windows/Linux doğrulaması](https://github.com/asimsamett/ViiOS/actions/runs/37422213622) ve [Pages yayını](https://github.com/asimsamett/ViiOS/actions/runs/37422213627) başarılı tamamlandı. Yayında 292 incelenmiş kaynak dosyası vardı. Aşağıdaki tarihsel kayıtlarda belirtilen lint hataları yayından önce düzeltildi. GitHub yayını veya CI'ın henüz yapılmadığını belirten eski notlar ilgili tarihe aittir.

## 5 Ekim 2026 — GitHub Pages için örnek verili demo

Statik demo ayrı bir kaynak kopyasında, GitHub proje adresini taklit eden `/viios-demo/` alt yoluyla derlendi. `dist/client` ve yerel yönetici/sunucu verileri bu işlemde değiştirilmedi. Pages workflow'u yalnız statik demo çıktısını yayınlar; GitHub deposu/Pages ayarı henüz verilmediğinden gerçek GitHub yayını yapılmadı.

- `npm test`: **175 test başarılı**, 0 başarısız. Demo API izolasyonu, statik dosya sunumu, kaynak kopyalama sınırları ve dosya yüklemenin ağ isteğinden önce reddi dahil.
- TypeScript kontrolü ve değişen ön yüz/demo dosyalarının hedefli lint kontrolü başarılı.
- Statik üretim derlemesi başarılı. HTML'deki alt yol içeren 16 varlık bağlantısı HTTP 200 döndü; `index.txt`, `.nojekyll` ve göreli webmanifest yolları doğrulandı. Demo sunucusunda gerçek API uçları bulunmuyor.
- Paylaşım kontrolü **282 kaynak dosyasını** kabul ediyor. Paketleme testlerinde **9 başarılı**, Windows sembolik bağlantı yetkisi nedeniyle 1 atlanan test var.
- Son derlemede **12/12 tarayıcı kontrolü geçti**: masaüstü, uygulamalar, depolama sekmeleri/klasör inceleme, model kataloğu, Linux/Windows geçişi, örnek metin dosyası, tema ve 390 px mobil görünüm. Sunucu ekleme kapalı ve şifre alanı yok. İzlenen **112 statik istekte** gerçek `/api` veya dış sunucu erişimi, başarısız istek/404 ve tarayıcı hatası görülmedi.

## 5 Ekim 2026 — Sunucu verileri olmadan kaynak paylaşımı

Kaynak paketi yalnız `public-source-files.json` içindeki 269 dosyadan hazırlanır. Yerel yönetici/sunucu verileri, şifreleme anahtarları, ortam dosyaları, çıktılar, ekran görüntüleri, yedekler ve eski özel kaynaklar alınmaz. Başlangıç envanterlerinin ve hedef yapılandırmalarının genel, boş varsayılanlarla eşleşmesi zorunludur. Üretilen ZIP'in giriş listesi ve her dosyanın içeriği paketleme sonrasında doğrulanır.

Eski kurulumun SSH hedefi/servisiyle bağlantılı uzak model keşif kodu kaldırıldı. Seçili sunucunun yerel model keşfi korunuyor; eski ek uzak hedef ayarları çalıştırılmıyor. Testlerdeki eski sunucu/proje adları ve iç ağ adresleri yapay örneklerle değiştirildi.

- `npm test`: **163 test başarılı**, 0 başarısız.
- Paketleme koruma testleri: **9 başarılı**, Windows sembolik bağlantı oluşturma yetkisi bulunmadığı için 1 atlandı. Gerçek hard link reddi, veri/anahtar/ortam dosyalarının dışlanması, bilinmeyen yapılandırma alanlarının reddi ve ZIP içerik/özet eşleşmesi doğrulandı.
- Python model testleri: **20 başarılı**, Linux gerektiren model bağlantısı modülü bu Windows ortamında atlandı. NIM/Ollama testleri ayrıca çalıştırıldı ve geçti.
- Kaynak içerik kontrolü: **269 dosya başarılı**. Bilinen eski ortam tanımlayıcıları ve özel ağ IP'leri için hedefli kaynak taraması temiz.
- Bu çalışma yerel hesapları veya sunucu kayıtlarını değiştirmez; üretim sunucusuna ve GitHub'a dağıtım yapılmadı. Önceden oluşturulmuş kaynak ZIP'leri güncellenmedi; yeni `public-source` adlı paket kullanılmalıdır.

Kaynak taraması her tür gizli bilginin yokluğuna dair kapsamlı güvenlik garantisi değildir; dosya listesine yeni kaynak eklenirken içerik incelemesi gerekir. İlk kurulum doğrulamasında aşağıda kaydedilen genel lint sorunları bu kapsamda değiştirilmedi.

## 5 Ekim 2026 — İlk kurulum değişikliği

İlk kurulum ekranı yalnız yönetici şifresi ve şifre tekrarını ister. Kurulum kodu alanı ve `VIIOS_SETUP_TOKEN` ayarı kaldırıldı. Şifre alt sınırı 8 karakterdir; büyük harf, rakam veya özel karakter zorunluluğu yoktur. Kurulum isteği yalnız `password` ve `confirmPassword` alanlarını gönderir. Yönetici şifresini kullanıcı belirler.

- İlgili kurulum, HTTP ve kimlik doğrulama testleri: **6 başarılı**, 0 başarısız.
- `npm run check`, `npm run build` ve değişen kod dosyalarının hedefli lint kontrolü başarılı.
- Tarayıcıda kurulum kodu alanının kaldırılması, 7 karakterin reddedilmesi, yalnız rakamlardan oluşan 8 karakterlik ve karma 9 karakterlik şifrelerin kabul edilmesi doğrulandı. İstek yalnız iki şifre alanını gönderiyor; tarayıcı hatası yok. Mevcut yönetici kaydını değiştirmemek için ilk kurulum API yanıtları tarayıcı testinde taklit edildi.
- Yerel sürüm `http://127.0.0.1:3180` adresinde yeniden başlatıldı; HTTP yanıtı ve kurulum durumu doğrulandı.
- Genel `npm run lint`, bu değişiklikte düzenlenmeyen `server/connection-routes.mjs` ve `app/desktop-layout.ts` dosyalarındaki toplam 3 hata nedeniyle geçmedi.

Aşağıdaki sonuçlar 2 Ekim sürümünün tarihsel doğrulama kaydıdır; bu değişikliğin test sonucu olarak değerlendirilmemelidir.

## 2 Ekim 2026 — Tarihsel doğrulama kaydı

Bu bağımsız kopya Windows üzerinde doğrulandı. Mevcut ViiOS kurulumuna veya üretim sunucusuna dağıtım yapılmadı.

### Geçen kontroller

- `npm test`: **157 test, 157 başarılı**. İlk yönetici kurulumu, gerçek HTTP oturum/CSRF kontrolleri, boş sunucu listesi, hedef izolasyonu ve mevcut uygulama davranışları dahil.
- Bağlantı alt kümesi: **15 test**. Gerçek yerel SSH2 sunucusuyla şifre ve şifreli özel anahtar, parmak izi denetimi, yanlış anahtarda kimlik doğrulamadan durma, JSON stdin, Windows/Linux sabit komut eşlemesi, SSH tüneli, şifreli kayıtlar, kuyruk ve iptal/kaldırma davranışı.
- `npm run check`, `npm run lint`, `npm run build`: başarılı. Derleme Node 22.23.2 ile yapıldı; yalnız paket boyutu bilgilendirmesi kaldı.
- `npm audit`: tüm bağımlılıklarda **0 bildirilen güvenlik açığı**; bu sonuç kapsamlı güvenlik denetimi yerine geçmez.
- Tarayıcı: yönetici kurulumu/giriş, boş çalışma alanı, Linux ve Windows seçenekleri, parmak izi onayı, şifre/anahtar formu, kurulum/hata/yeniden deneme/kaldırma, hazır hedefe geçiş, Windows sanal dosya yolları ve özellik kısıtları. Masaüstü ve mobil, açık/koyu tema. Tarayıcı istisnası yok. UI akışlarında sentetik API verileri kullanıldı.
- Windows: PowerShell 5.1 ve 7 testleri; dosya sınırları, junction/hard link ve eski revision reddi, geçerli JSON yanıtları, izinli servis kontrolleri ve sınırlı yerel HTTP tespiti. Gerçek Windows kaynak ve disk ölçümü salt okunur çalıştırıldı.
- Windows yanıtları mevcut Node denetleyicileri üzerinden ayrıca sınandı: dosya listeleme/oluşturma/okuma/indirme ve 409 hatası; kaynak ölçümleri; disk özeti ve sınırlı klasör/uygulama ölçümü; model ve desteklenmeyen eşzamanlılık yanıtı. 13 yerel yardımcı çağrısı geçti. SSH çalıştırma sınırı yerel PowerShell'e yönlendirildi; gerçek uzak sunucu kullanılmadı.
- Linux yardımcıları: 11 Python dosyası ve üretilen kurulum betiği sözdizimi kontrolünden geçti. Port ayrıştırma için 3, kaynak hesabı için 7 birim test geçti.

### Henüz doğrulanmayanlar

Tam kurulum, yeni bir uzak Linux veya Windows sunucusunda uçtan uca çalıştırılmadı. Linux paket yöneticileri, gerçek sudo/SFTP ortamı, Windows OpenSSH yönetici oturumu ve farklı dağıtımların davranışı hedef ortam testi gerektirir. Kurulum senaryoları sahte uzak çalıştırıcıyla kontrol edildi.

Docker motoru ve Linux çalışma ortamı bu bilgisayarda bulunmadığı için Docker imajı ve tüm Linux dosya/Git testleri çalıştırılmadı. GitHub Actions dosyası Linux/Windows kontrol matrisini içerir; GitHub'a yükleme yapılmadığından bu iş akışı henüz çalışmadı.

Windows Git yönetimi, büyük dosya streaming/ZIP aktarımı ve özel UAT akışları bu sürümün destek kapsamı dışındadır. Ayrıntılar [README](../README.tr.md), [sunucu kurulumu](connections.tr.md) ve [Windows desteği](windows-support.md) içindedir.
