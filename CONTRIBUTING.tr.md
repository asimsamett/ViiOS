# ViiOS'a katkı

[English](CONTRIBUTING.md) | **Türkçe**

<!-- docs-nav:start -->
[Ana sayfa](README.tr.md) · **Katkı** · [Lisans](docs/licensing.tr.md) · [Güvenlik](SECURITY.tr.md)

[Demo](docs/demo.tr.md) · [Sunucu bağlantıları](docs/connections.tr.md) · [Windows desteği](docs/windows-support.tr.md) · [Doğrulama](docs/validation.tr.md) · [Telif bildirimleri](docs/notices.tr.md) · [Üçüncü taraflar](THIRD_PARTY_NOTICES.tr.md)
<!-- docs-nav:end -->

[Issues](https://github.com/asimsamett/ViiOS/issues) üzerinden korunan yazılım kodu içermeyen hata bildirimleri ve öneriler paylaşabilirsiniz. [ViiOS Private Noncommercial License 1.0](docs/licensing.tr.md), özel ortamda değişikliğe izin verir; değişiklikleri yayımlama veya kod aktarma izni genel olarak vermez. Herkese açık patch, fork veya pull request hazırlamadan önce ayrıca yazılı katkı ve yayımlama izni alın; bağımsız platform hakları için [lisans notlarını](docs/licensing.tr.md) okuyun. Üçüncü taraf bildirimlerini koruyun.

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

## Değişiklik önerme

1. Sorunu ve beklenen davranışı yazılım kodu yüklemeden açıklayın.
2. Kod katkısı için önce hak sahibinden özel iletişim kanalı ve ayrıca yazılı koşullar isteyin.
3. İzin verilene kadar değişiklikleri kendi özel yerel ortamınızda tutun; patch yayımlamayın veya göndermeyin.
4. İzin verilirse yalnız o iznin kapsadığı aktarım/yayımlama yolunu kullanın. Otomatik telif devri veya genel dağıtım izni oluşmaz.

Gerçek sunucu adreslerini, kullanıcı bilgilerini, parolaları, anahtarları, envanterleri, günlükleri veya müşteri verilerini issue, ekran görüntüsü ve commitlere eklemeyin. Örneklerde dokümantasyon adresleri ve yapay veriler kullanın. `data/`, `.env`, `outputs/` ve geliştirme aracı oturumları kaynak pakete dahil edilmez.

Güvenlik açıkları için [güvenlik bildirimini](SECURITY.tr.md) yönergesini izleyin.

## Belge dilleri

Varsayılan README ve belgeler İngilizcedir. Türkçe sürümler `.tr.md` son ekini kullanır ve İngilizce sürüme bağlanır. Kurulum veya destek kapsamı değiştiğinde iki sürümü birlikte güncelleyin. Uygulama arayüzü şu anda Türkçedir; İngilizce ekran yönergelerinde görünen Türkçe etiketi de belirtin.
