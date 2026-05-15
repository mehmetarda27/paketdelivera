# Platform Webhook Fixtures

Bu fixture'lar gercek platform secret'i icermez. Tum HMAC degerleri `fixture-secret` ile, body'nin minified JSON hali uzerinden uretilmistir.

Provider notlari:

- Trendyol Yemek: Resmi partner dokumanindaki nihai header adi musteri onboarding sirasinda tekrar dogrulanmali; su an `x-platform-signature` HMAC-SHA256 ve legacy token fallback test edilir.
- Getir Yemek: `x-webhook-signature` HMAC-SHA256 beklenir; partner ortami farkli timestamp header'i isterse mapper genisletilecek.
- Yemeksepeti: `x-webhook-signature` HMAC-SHA256 ana yol, `x-yemeksepeti-token` sadece legacy fallback olarak kalir.
- Migros Yemek: `x-platform-signature` HMAC-SHA256 ana yol, `x-partner-token` sadece legacy fallback olarak kalir.

Replay attack riski: Bugunku dogrulama payload HMAC'ini kontrol eder, ancak provider timestamp/nonce header'i standartlasmadigi icin zaman penceresi ve nonce saklama zorlamasi henuz aktif degildir. Canli partner sozlesmesinde timestamp header'i netlesince 5 dakikalik kabul penceresi ve Redis/SQLite nonce idempotency kaydi eklenmelidir.
