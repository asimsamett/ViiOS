# Güvenlik bildirimi

Güvenlik düzeltmeleri en son yayımlanan ViiOS sürümüne uygulanır. Eski sürümler için ayrı bir bakım takvimi taahhüt edilmez.

## Açık bildirme

Depodaki **Security → Report a vulnerability** üzerinden özel bildirim gönderin. Bu seçenek görünmüyorsa gizli ayrıntı paylaşmadan bir issue açarak özel iletişim kanalı isteyin.

Etkilenen sürümü, beklenen ve gerçekleşen davranışı, etkisini ve mümkünse tamamen yapay verilerle yeniden üretme adımlarını yazın. Gerçek sunucu IP'leri, parolalar, özel anahtarlar, oturum bilgileri veya kullanıcı verileri eklemeyin. Açığın ayrıntılarını ve çalışır saldırı örneklerini herkese açık issue'lara koymayın.

## Kurulum

ViiOS bağlı sunucularda yönetim işlemleri gerçekleştirebilir. Kendi kurulumunuzun erişimini yetkili kullanıcılarla sınırlandırın; kayıtlı bağlantıların bulunduğu `data/` dizinini kaynak koduyla yayımlamayın. Ağdan erişimde HTTPS ve uygun erişim kontrolleri kullanın. GitHub Pages demosu yalnız yapay veri kullanır ve gerçek sunuculara bağlanmaz.
