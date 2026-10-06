# Güvenlik bildirimi

[English](SECURITY.md) | **Türkçe**

<!-- docs-nav:start -->
[Ana sayfa](README.tr.md) · [Katkı](CONTRIBUTING.tr.md) · [Lisans](docs/licensing.tr.md) · **Güvenlik**

[Demo](docs/demo.tr.md) · [Sunucu bağlantıları](docs/connections.tr.md) · [Windows desteği](docs/windows-support.tr.md) · [Doğrulama](docs/validation.tr.md) · [Telif bildirimleri](docs/notices.tr.md) · [Üçüncü taraflar](THIRD_PARTY_NOTICES.tr.md)
<!-- docs-nav:end -->

Güvenlik düzeltmeleri en son yayımlanan ViiOS sürümüne uygulanır. Eski sürümler için ayrı bir bakım takvimi taahhüt edilmez.

## Açık bildirme

Depodaki **Security → Report a vulnerability** üzerinden özel bildirim gönderin. Bu seçenek görünmüyorsa gizli ayrıntı paylaşmadan bir issue açarak özel iletişim kanalı isteyin.

Etkilenen sürümü, beklenen ve gerçekleşen davranışı, etkisini ve mümkünse tamamen yapay verilerle yeniden üretme adımlarını yazın. Gerçek sunucu IP'leri, parolalar, özel anahtarlar, oturum bilgileri veya kullanıcı verileri eklemeyin. Açığın ayrıntılarını ve çalışır saldırı örneklerini herkese açık issue'lara koymayın.

## Kurulum

ViiOS bağlı sunucularda yönetim işlemleri gerçekleştirebilir. Standart lisans kapsamında kurulum yalnız sizin eriştiğiniz özel, ticari olmayan ortamda kullanılmalıdır; kurumsal veya paylaşımlı erişim ayrıca yazılı izin gerektirir. Kayıtlı bağlantıların bulunduğu `data/` dizinini ve özel yapılandırmayı yayımlamayın. Ağdan erişimde HTTPS ve uygun erişim kontrolleri kullanın. GitHub Pages demosu yalnız yapay veri kullanır ve gerçek sunuculara bağlanmaz.
