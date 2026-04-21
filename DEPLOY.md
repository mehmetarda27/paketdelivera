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
- Admin login
- Restoran login
- Kurye login
- Konum izni
- Platform hesabinin verification durumu
- `logs/admin-bootstrap.txt`
- `logs/password-resets.log`
- `logs/webhooks.log`

## 7. Platform Merchant Credential Dogrulama

- Trendyol Go icin sistem resmi webhook listeleme servisine istek atarak credential'i kontrol etmeyi dener.
- Diger platformlar icin opsiyonel verify URL env degiskeni girilebilir.
- Verify endpoint verilmemisse hesap `pending` kalir, ilk basarili webhook geldigi anda `verified` olur.

## 8. Postgres Notu

Bu turda runtime'i bozmayalim diye uygulama cekirdegi SQLite uzerinde birakildi. Bunun ustune deployment, refresh token, parola reset ve reverse proxy/HTTPS paketi yerlestirildi. Postgres'e tam gecis, tek dosyadaki senkron SQL katmani async adapter'a tasinacagi icin ayri ve kontrollu bir refactor gerektirir.
