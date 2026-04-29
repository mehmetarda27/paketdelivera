# Delivera Express Chrome Extension

## Kurulum

1. Chrome'da `chrome://extensions` ac.
2. `Developer Mode` secenegini aktif et.
3. `Load unpacked` butonuna bas.
4. Bu klasoru sec:
   - `C:\Users\LENOVO\Documents\Codex\2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere\chrome-extension`

## Kullanim

1. Platform paneli acik olsun.
2. Delivera extension popup'unu ac.
3. `Backend URL` gir:
   - `https://paketdelivera.onrender.com`
4. Restaurant Token alanina restoran panelindeki `deliveraRestaurantToken` degerini yapistir.
5. Platform secimini kontrol et.
6. Manuel gonderim icin `Siparişi Delivera'ya Gönder` butonuna bas.

## Otomatik İzleme

1. Platform paneli acikken extension acilir.
2. Token ve backend URL girilir.
3. `Otomatik İzleme` acilir.
4. Panel acik kaldigi surece yeni siparis metinleri algilanir.
5. Ayni siparis tekrar gonderilmez.

## Fallback

- Manuel gonderimde API basarisiz olursa extension siparis metnini otomatik clipboard'a kopyalar.
- Sonra Delivera restoran panelindeki `Hizli Siparis Yapistir` alanina yapistirabilirsin.
- Otomatik modda hata olursa sadece popup icinde durum ve hata bilgisi guncellenir.
