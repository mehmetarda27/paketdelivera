# Delivera Express Canliya Alma

## 1. Sunucu Hazirligi

Ubuntu 22.04 veya benzeri bir Linux sunucuda:

```bash
sudo apt update
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. Uygulama Dosyalari

Projeyi sunucuya kopyala, sonra `.env.example` dosyasini `.env` olarak duzenle.

Onemli alanlar:

- `PUBLIC_BASE_URL=https://app.deliveraexpress.com`
- `TRUST_PROXY=true`
- `FORCE_HTTPS=true`
- `DELIVERA_ADMIN_USERNAME`
- `DELIVERA_ADMIN_PASSWORD`

## 3. PM2 Ile Calistirma

```bash
cd /var/www/delivera-express
npm install
npm run db:migrate
npm run build
node smoke-test.js
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## 4. Nginx Reverse Proxy

`deploy/nginx/delivera-express.conf` dosyasini `/etc/nginx/sites-available/delivera-express` altina kopyala:

```bash
sudo ln -s /etc/nginx/sites-available/delivera-express /etc/nginx/sites-enabled/delivera-express
sudo nginx -t
sudo systemctl reload nginx
```

## 5. HTTPS Sertifikasi

Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.deliveraexpress.com
```

## 6. Kontrol Listesi

- `https://app.deliveraexpress.com/health`
- `https://app.deliveraexpress.com/metrics`
- Admin panelinden `/api/admin/system-status`
- Admin panelinden `/api/admin/performance-summary`
- `npm run db:migrate` ikinci kez calistiginda yeni migration uygulamamali
- Admin/restoran panellerinde paket listesi varsayilan 100 kayitla acilir; `limit` maksimum 200'dur.
- Login/platform webhook/quick-paste limit asiminda `429 Too many requests` beklenir.
- Admin login
- Restoran login
- Kurye login
- Konum izni
- Platform hesabinin verification durumu
- `logs/admin-bootstrap.txt`
- `logs/password-resets.log`
- `logs/webhooks.log`

## 6.1 Production Kabul Kapisi

Canli musteriden once asagidaki maddeler tek tek dogrulanmali:

- `NODE_ENV=production` ayarli.
- Test/simulasyon endpointleri production'da 404 donuyor.
- `.env` gercek secret manager veya hosting protected variables ile yonetiliyor.
- `DELIVERA_CORS_ORIGINS` sadece canli domainleri iceriyor.
- Reverse proxy `X-Request-Id` gonderiyor veya uygulamanin urettiği `X-Request-Id` loglarda izleniyor.
- `npm run db:migrate` iki kez calisiyor; ikinci calismada `applied: []` donuyor.
- `node smoke-test.js` temp SQLite ile basarili oluyor.
- `node scripts/load-test.js` canli DB'ye yazmadan temp SQLite ile calisiyor.
- `npm run db:backup` sonrasi backup dosyasi farkli bir lokasyona kopyalaniyor.
- Restore islemi staging veya test kopyasinda prova edildi; canli DB uzerine otomatik yazmiyor.
- PM2/systemd restart sonrasi `/health` ve `/metrics` tekrar ayaga kalkiyor.
- Nginx log rotate ve uygulama `logs/` rotasyonu ayarli.
- Admin/restoran/kurye loginleri ve platform webhook secret kontrolleri elle dogrulandi.
- Acil rollback icin son calisan paket, son SQLite backup ve deploy komutu kayitli.

## 6.2 Ilk Restoran / Kurye Kurulum Akisi

1. Admin panelinde gercek restoran adi, bolge, portal kullanici adi, guclu portal sifresi ve koordinatlari gir.
2. Restoran paneline bu portal bilgisiyle giris yap ve platform Restaurant/Store/Vendor ID ile webhook secret bilgisini kaydet.
3. Platform panelinde Delivera webhook URL'sini ve secret bilgisini tanimla.
4. Ilk gercek platform siparisi geldiginde restoran panelinde webhook durumu, admin panelinde aktif siparis ve webhook logu kontrol edilir.
5. Admin panelinde gercek kurye kaydi acilir; kurye mobil panelden giris yapar, konum izni verir ve online olur.
6. Restoran siparisi onaylar; sistem tek aktif paket kuraliyla uygun kuryeye atama yapar.
7. Kurye teslim al, yola cikti ve teslim ettim akisini tamamlar; admin ve restoran panelinde durum gecmisi kontrol edilir.

## 6.3 Gunluk Operasyon Kontrol Listesi

- Gun basinda `/health` ve `/metrics` cevaplari kontrol edilir.
- Admin panelinde aktif kurye, atama bekleyen ve teslimattaki siparis sayilari incelenir.
- `npm run db:backup` ile gunluk SQLite backup alinir ve uygulama disi lokasyona kopyalanir.
- Webhook loglarinda 401/403/5xx artisi var mi kontrol edilir.
- Atama bekleyen paketler ve busy/offline kurye oranlari izlenir.
- Gun sonunda kurye kapanis, nakit mutabakat ve teslim edilemeyen paketler kontrol edilir.

## 6.4 Ilk Hafta Canli Izleme

- Her gun p95 response time, 5xx sayisi ve SQLite dosya buyume hizi kaydedilir.
- Ilk 100 gercek sipariste duplicate/idempotency ve restoran izolasyonu elle spot-check edilir.
- Kurye tek aktif paket kuralinin ihlal edilmedigi admin raporundan kontrol edilir.
- Platform callback retry/DLQ planinda kalan isler icin hata listesi tutulur.
- Restore proseduru canli kopya uzerinde degil, staging kopyasinda prova edilir.

## 7. Backup / Restore

Canliya almadan once ve her migration oncesi:

```bash
npm run db:backup
```

Restore varsayilan olarak mevcut database'in ustune yazmaz:

```bash
DELIVERA_RESTORE_OVERWRITE=1 npm run db:restore -- backups/delivera-YYYY-MM-DD.sqlite
```

## 8. Migration Runner

`scripts/migrate.js`, `migrations/` klasorundeki sirali dosyalari calistirir ve `schema_migrations` tablosuna kaydeder. Migration kurallari:

- Tablo drop etmez.
- Production verisi silmez.
- Eksik tablo/kolon/index ekler.
- Ayni migration ikinci kez uygulanmaz.
- Runtime bugun SQLite kalir; PostgreSQL adapter sonraki kontrollu refactor adimidir.

## 9. Metrics

Prometheus benzeri metrikler:

```bash
curl https://app.deliveraexpress.com/metrics
```

Temel sinyaller: app up, request count, error count, response time percentile, DB boyutu, tablo sayilari, queue derinligi.
Her HTTP yanitinda `X-Request-Id` header'i doner. Hata ararken bu deger proxy logu, uygulama logu ve admin performance payload'i ile birlikte takip edilir.

### 9.1 Logging / Alerting

Uygulama `services/logger.js` ile JSON structured log basar. `LOG_LEVEL=info` varsayilandir; desteklenen seviyeler `debug`, `info`, `warn`, `error`. Hata loglarinda endpoint, method, requestId ve statusCode bulunur. `401`, `403`, `429` ve `5xx` durumlari loglanir; normal 2xx/3xx trafik log spam'i azaltmak icin yazilmaz.

Canli izleme icin onerilen minimum alarm seti:

- `/health` 2 dakika ust uste basarisiz olursa critical.
- `/metrics` icinde `delivera_up 0` gorulurse critical.
- 5 dakika pencerede `delivera_errors_total` artis hizi beklenenin ustundeyse warning.
- P95 response time 2 saniyeyi 10 dakika asarsa warning.
- SQLite dosya boyutu beklenmedik sekilde hizli buyurse warning.
- `queueService` DLQ veya init error uretirse warning.
- Disk doluluk yuzdesi 80 ustu warning, 90 ustu critical.

Sentry/OpenTelemetry sonraki adimdir. Entegrasyon yapilirken requestId trace/span attribute olarak tasinmali, platform webhook secretlari ve tokenlar redact edilmelidir.

## 10. Load Smoke

`node scripts/load-test.js` varsayilan olarak production DB'ye yazmaz; temp SQLite dosyasi olusturur ve test sonunda temizler. Hafif smoke varsayilani:

- 100 restoran
- 120 kurye
- 300 paket
- concurrency 5 ve 10

## 11. Docker Compose Hazirligi

`docker-compose.yml` app, Redis ve Postgres servislerini birlikte tanimlar. Runtime bugun SQLite uzerinde kalir; Postgres ve Redis servisleri adapter refactor sonrasi kullanima alinacak sekilde hazirdir.

```bash
docker compose up -d --build
docker compose logs -f app
```

## 12. Platform Merchant Credential Dogrulama

- Trendyol Go icin sistem resmi webhook listeleme servisine istek atarak credential'i kontrol etmeyi dener.
- Diger platformlar icin opsiyonel verify URL env degiskeni girilebilir.
- Verify endpoint verilmemisse hesap `pending` kalir, ilk basarili webhook geldigi anda `verified` olur.

## 13. Postgres Notu

Bu turda runtime'i bozmayalim diye uygulama cekirdegi SQLite uzerinde birakildi. Bunun ustune deployment, refresh token, parola reset ve reverse proxy/HTTPS paketi yerlestirildi. Postgres'e tam gecis, tek dosyadaki senkron SQL katmani async adapter'a tasinacagi icin ayri ve kontrollu bir refactor gerektirir.
