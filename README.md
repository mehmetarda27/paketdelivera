# Delivera Express

Mersin icin restoran kaynakli siparisleri dispatch sistemine dusuren, admin tarafinda otomatik kurye atayan ve kurye tarafinda teslimat is akisini gosteren cok sayfali bir Node uygulamasi. Sistem multi-restaurant mantigi ile calisir; her restoran sadece kendi tenant verisini gorur, admin ise filtreli veya tum operasyon gorunumu ile sistemi yonetir.

## Sayfalar

- [index.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/index.html): giris ve rol secim sayfasi
- [restaurant.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/restaurant.html): restoran paneli
- [admin.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/admin.html): admin operasyon paneli
- [courier.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/courier.html): kurye calisma paneli

## Desteklenen Platform Mantigi

- Trendyol Go
- GetirYemek
- Yemeksepeti
- Migros Yemek

Restoran panelinde hangi platformlardan siparis aldigi tanimlanabilir. Her paket kaydinda platform ve harici siparis numarasi tutulur.
Odeme yontemi de siparis verisinin zorunlu bir parcasi olarak islenir.

Her restoran icin platform hesabi ayri tutulur:

- `restaurant_id` tenant izolasyonu
- `external_store_id` veya `vendor_id` platform eslemesi
- platform webhook auth bilgisi
- platform API credential alanlari

## Cekirdek Akis

1. Restoran paneli bir restoran ve entegrasyon bilgisi olusturur.
2. Restoran paneli artik portal kullanici adi ve sifresi ile oturum acar; entegrasyon icin API key ve webhook secret ayrica uretilir.
3. Restoran panelinden platform hesabi kaydedilir ve platforma verilecek webhook URL otomatik uretilir.
4. Trendyol Go, GetirYemek, Yemeksepeti veya Migros Yemek siparisi kendi webhook modeliyle bu URL'ye gonderir.
5. Sistem platform hesabini store/vendor kimligi ile bulur, auth dogrular ve siparisi normalize eder.
6. Paket tenant izole sekilde veritabanina yazilir.
7. Webhook imzasi ve platform yetkisi dogrulanir.
8. Backend paketi alir, bolgesini okur ve atama motoruna yollar.
9. Ayni bolgedeki aktif kuryeler arasindan 5 km icindeki en yakin ve en dusuk yuke sahip kurye secilir.
10. Admin paneli tum platform kaynakli paketleri tek listede izler, restoran bazli filtreler ve audit kayitlarini gorur.
11. Kurye paneli sadece atanmis isleri gosterir, canli konum yollar ve durum gunceller.

## Teknik Dosyalar

- [server.js](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/server.js)
- [shared.js](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/shared.js)
- [landing.js](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/landing.js)
- [restaurant.js](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/restaurant.js)
- [admin.js](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/admin.js)
- [courier.js](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/courier.js)
- [styles.css](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/styles.css)
- `delivera.sqlite`: ana veritabani dosyasi
- `logs/webhooks.log`: webhook log kayitlari

## Calistirma

1. VS Code terminalini ac.
2. Su komutu calistir:

```powershell
node server.js
```

3. Tarayicida `http://localhost:3000` ac.
4. Restoran, admin ve kurye sayfalarini ayri sekilde kullan.

## Giris Bilgileri

- Admin panel varsayilan girisi:
  `kullanici adi: admin`
  `sifre: Delivera123!`
- Istersen bunlari ortam degiskenleri ile degistirebilirsin:
  `DELIVERA_ADMIN_USERNAME`
  `DELIVERA_ADMIN_PASSWORD`
- Restoran hesabi olustururken portal kullanici adi ve sifresi otomatik ya da manuel tanimlanir.
- Kurye girisleri admin panelinden uretilen kullanici adi ve sifre ile yapilir.

## Guvenlik ve Operasyon

- Veriler SQLite icinde tutulur.
- Admin, restoran ve kurye oturumlari ayri token tablolari ile yonetilir.
- Kurye sifreleri `scrypt` ile hashlenir.
- Restoran portal sifreleri ve admin sifresi de `scrypt` ile hashlenir.
- Restoran entegrasyonlari `x-api-key` ve `x-delivera-signature` ile dogrulanir.
- Rate limiting uygulanir: genel API, entegrasyon, admin yazma islemleri ve kurye login akislari ayridir.
- Webhook cagrilari hem SQLite log tablosuna hem `logs/webhooks.log` dosyasina yazilir.
- Audit log sistemi admin, restoran, entegrasyon ve kurye hareketlerini kaydeder.
- Kurye tarafinda tarayici geolocation ile canli konum gonderilir; admin panel bu veriyi son sinyal zamaniyla gosterir.

## API Ornekleri

- `GET /api/bootstrap`
- `POST /api/admin/login`
- `GET /api/admin/bootstrap`
- `POST /api/restaurants`
- `POST /api/restaurant/session`
- `GET /api/restaurant/bootstrap`
- `POST /api/restaurant/platform-accounts`
- `POST /api/restaurant/packages`
- `POST /api/admin/couriers`
- `POST /api/integrations/orders`
- `POST /api/platforms/trendyol-go/webhook`
- `POST /api/platforms/getiryemek/webhook`
- `POST /api/platforms/yemeksepeti/webhook`
- `POST /api/platforms/migros-yemek/webhook`
- `POST /api/courier/login`
- `GET /api/courier/me`
- `PATCH /api/courier/location`
- `PATCH /api/courier/packages/:id/status`
- `PATCH /api/admin/packages/:id/status`
- `PATCH /api/admin/couriers/:id/availability`
- `POST /api/admin/packages/:id/reassign`

## Hizli Kontrol

Asagidaki komut admin login, restoran olusturma, restoran login, kurye ekleme ve paket olusturma akisini otomatik smoke test olarak calistirir:

```powershell
node smoke-test.js
```

## Canli Entegrasyon Kurulumu

1. Restoran panelinde restoran hesabi olustur.
2. Restoran panelinde ilgili platform icin `Platform Hesabi` kaydi gir.
3. Sistem sana platforma verecegin webhook URL ve auth bilgisini gosterecek.
4. Platform partner panelinde veya entegrasyon ekraninda bu URL ve auth bilgisini tanimla.
5. Siparis olustugu anda platform webhook'u bizim `/api/platforms/<platform>/webhook` endpointine duser.
6. Sistem siparisi normalize eder, tenant bazli paketi olusturur ve uygun kuriyeye atar.

Not:

- Trendyol tarafinda resmi dokumanda webhook create/update ve API key/basic auth modeli bulunuyor.
- Yemeksepeti tarafinda resmi dokumanda webhook ve secret/basic auth mantigi bulunuyor.
- GetirYemek ve Migros Yemek icin bu projede ayni adapter girisleri hazirlandi; canliya geciste ilgili merchant panel credential bilgileri ile baglarsin.

## Sonraki Seviye Adimlar

- SQLite yerine Postgres gibi merkezi veritabani
- Refresh token, session timeout ve parola yenileme akisi
- Harita servis entegrasyonu ile yol mesafesi ve ETA optimizasyonu
- Yedekleme, raporlama ve operasyon alarm mekanizmalari
