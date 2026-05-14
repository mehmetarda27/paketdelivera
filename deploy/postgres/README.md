# Postgres Gecis Notu

Mevcut runtime `node:sqlite` uzerinde calisiyor. Bu turda database sifirlanmadi ve uygulama zorla Postgres'e alinmadi. Amac, production gecisini kontrollu yapmak icin Postgres servis ve migration zeminini hazirlamak.

## Hazir Olanlar

- `docker-compose.yml` icinde `postgres:16-alpine` servisi.
- `deploy/postgres/init/001_extensions.sql` ile ilk extension bootstrap.
- `/health` ve `/api/admin/system-status` icinde `DATABASE_URL`/`POSTGRES_URL` konfigurasyonunun gorunurlugu.
- `PRODUCTION_ROADMAP.md` icinde adapter ve cutover plani.

## Gecis Sirası

1. Mevcut SQLite icin `npm run backup:sqlite` calistir.
2. Inline schema kodlarini versiyonlu migration dosyalarina ayir.
3. DB facade ekle: `get`, `all`, `run`, `transaction`.
4. SQLite adapter'i facade arkasinda calistir ve smoke test gecir.
5. Postgres adapter'i `pg.Pool` ile ekle.
6. Export/import scripti yaz: SQLite kaynak, Postgres hedef.
7. Shadow read testleri ve load smoke calistir.
8. Maintenance penceresinde cutover yap, rollback icin SQLite backup'i sakla.

## Connection Pool Hedefi

Baslangic ayarlari:

- `max`: 10-20 connection
- `idleTimeoutMillis`: 30000
- `connectionTimeoutMillis`: 5000
- Transaction timeout ve query log threshold: 1000 ms

Bu degerler load-test sonucuna gore arttirilir.
