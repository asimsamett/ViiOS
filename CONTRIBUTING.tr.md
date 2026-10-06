# ViiOS'a katkı

[English](CONTRIBUTING.md) | **Türkçe**

Hata bildirimleri ve geliştirme önerileri için [Issues](https://github.com/asimsamett/ViiOS/issues), kod değişiklikleri için pull request kullanabilirsiniz. Proje [PolyForm Noncommercial 1.0.0](LICENSE.md) ile paylaşılır; katkılar aynı proje lisansı altında sunulmalıdır. Başkalarına ait kodların lisans ve telif bildirimlerini koruyun.

## Geliştirme

Node.js 22.13+ ve paket kontrolleri için Python 3.9+ gerekir.

```sh
npm ci
npm test
npm run check
npm run lint
npm run build
python scripts/package-source.py --check
python -m unittest discover -s tests -p test_public_source.py
```

Arayüzü gerçek sunucu bağlamadan denemek için `npm run demo:build` ve `npm run demo:serve` kullanın. Windows ve Linux hedeflerinin destek farkları README'de açıklanır.

## Değişiklik gönderme

1. Ayrı bir dalda, tek bir soruna odaklanan değişiklik hazırlayın.
2. Hatanın nasıl oluştuğunu, beklenen davranışı ve yaptığınız kontrolleri açıklayın.
3. Yeni yayımlanacak kaynak dosyalarını içeriklerini inceledikten sonra `public-source-files.json` listesine ekleyin.
4. Otomatik kontrollerin geçtiğini doğrulayarak pull request açın.

Gerçek sunucu adreslerini, kullanıcı bilgilerini, parolaları, anahtarları, envanterleri, günlükleri veya müşteri verilerini issue, ekran görüntüsü ve commitlere eklemeyin. Örneklerde dokümantasyon adresleri ve yapay veriler kullanın. `data/`, `.env`, `outputs/` ve geliştirme aracı oturumları kaynak pakete dahil edilmez.

Güvenlik açıkları için [SECURITY.md](SECURITY.tr.md) yönergesini izleyin.

## Belge dilleri

Varsayılan README ve belgeler İngilizcedir. Türkçe sürümler `.tr.md` son ekini kullanır ve İngilizce sürüme bağlanır. Kurulum veya destek kapsamı değiştiğinde iki sürümü birlikte güncelleyin. Uygulama arayüzü şu anda Türkçedir; İngilizce ekran yönergelerinde görünen Türkçe etiketi de belirtin.
