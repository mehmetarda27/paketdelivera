# Postgres Gecis Notu

Bu repositorynin mevcut calisan runtime'i `node:sqlite` uzerinde. Bunun sebebi tum backend'in tek dosyada senkron SQLite cagrilariyla kurulmus olmasi. Canliya geciste merkezi veritabani ihtiyaci varsa iki asamali gecis onerilir:

1. Bu surumu PM2 + nginx + HTTPS ile sahaya al.
2. Ardindan veritabani adapter refactor'u yapip runtime'i Postgres'e tasiyalim.

Bu klasor, gecis hazirligi icin Postgres temel semasini ve operasyon notlarini tutar. Yani kurulum paketi hazir, ama runtime bu turda guvenli kalsin diye bozulmadi.
