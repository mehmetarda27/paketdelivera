# Delivera Express Chrome Extension

## Kurulum

1. Chrome'da `chrome://extensions` ac.
2. `Developer Mode` secenegini aktif et.
3. `Load unpacked` butonuna bas.
4. Bu klasoru sec:
   - `C:\Users\LENOVO\Documents\Codex\2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere\chrome-extension`

## Kullanim

1. Getir / Trendyol Yemek / Migros Yemek / Yemeksepeti panelini ac.
2. Delivera extension popup'unu ac.
3. `Backend URL` gir:
   - `https://paketdelivera.onrender.com`
4. Restoran panel login sonrasi aldigin `Restaurant Token` bilgisini gir.
5. Platformu sec.
6. `Siparişi Delivera'ya Gönder` butonuna bas.

## Fallback

- API gonderimi basarisiz olursa extension siparis metnini otomatik clipboard'a kopyalar.
- Sonra Delivera restoran panelindeki `Hizli Siparis Yapistir` alanina yapistirabilirsin.
