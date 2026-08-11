# FastSiparis / Posentegra Integration

## Environment

- `POSENTEGRA_API_BASE_URL`: FastSiparis / Posentegra Web API base URL. Hem origin (`https://api.v1.fastsiparis.com`) hem de `/web-api/v1` ile biten koleksiyon adresi kabul edilir; yol iki kez eklenmez.
- `POSENTEGRA_API_KEY`: API key/token. Sent as `Authorization: Bearer ...` and `X-API-Key`.
- `POSENTEGRA_BUSINESS_ID`: Optional business id used to link newly created restaurants.
- `POSENTEGRA_REQUEST_TIMEOUT_MS`: Request timeout, default `8000`.
- `POSENTEGRA_RETRY_ATTEMPTS`: Retry count for idempotent package/status calls, default `3`.
- `POSENTEGRA_OUTBOX_POLL_MS`: Durable outbox sweep interval, default `10000`.
- `WEBHOOK_SECRET`: Incoming webhook secret for `/api/webhooks/orders`.

Secrets are redacted before application logs or `webhook_logs` writes.

## Business Endpoints

Supported client operations:

- `GET /web-api/v1/businesses`
- `POST /web-api/v1/businesses`
- `GET /web-api/v1/businesses/{id}`
- `PUT /web-api/v1/businesses/{id}`
- `DELETE /web-api/v1/businesses/{id}`

Current app usage:

- `POSENTEGRA_BUSINESS_ID` is read from env.
- After restaurant creation, the app calls `POST /web-api/v1/businesses/{id}/restaurants` when `POSENTEGRA_BUSINESS_ID` is configured.

## Restaurant Endpoints

FastSiparis endpoints:

- `POST /web-api/v1/restaurants`
- `POST /web-api/v1/businesses/{id}/restaurants`
- `GET /web-api/v1/restaurants`
- `GET /web-api/v1/restaurants/{id}`
- `PUT /web-api/v1/restaurants/{id}`
- `DELETE /web-api/v1/restaurants/{id}`

App flow:

1. Admin creates a restaurant in Delivera.
2. The restaurant is inserted into `restaurants`.
3. If Posentegra env is configured, Delivera calls `POST /web-api/v1/restaurants`.
   If an existing Posentegra restaurant id was supplied by the admin, creation is skipped and that restaurant is linked instead.
4. The returned `id` is written to `restaurants.posentegra_id`.
5. Delivera immediately selects the row and verifies `posentegra_id`.
6. If the API call or DB verification fails, the local restaurant is removed and the request fails.
   When Delivera created the remote restaurant during this request, it also attempts a compensating `DELETE` so a failed business link does not leave an orphan Posentegra restaurant.

Success response includes the internal restaurant id, name, `posentegra_id`, and `verification`.

## Orders Endpoints

Client operations prepared in `services/posentegraClient.js`:

- `GET /web-api/v1/orders`
- `GET /web-api/v1/orders/{orderId}`
- `POST /web-api/v1/orders/cancel/{orderId}`
- `POST /web-api/v1/orders/change-status/{orderId}`
- `GET /web-api/v1/orders/reasons/{orderId}`
- `POST /web-api/v1/orders/verify/{orderId}`
- `POST /web-api/v1/orders/reports/mark`
- `GET /web-api/v1/orders/reports/pending`

Status change:

- FastSiparis `change-status` isteği body kabul etmez; `POST` çağrısı siparişi yalnızca bir sonraki uzak duruma ilerletir.
- Restaurant approval for Trendyol Yemek, Getir Yemek, Yemeksepeti, or Migros Yemek is queued as Posentegra `accepted` and routed by that order's `pid` and source platform.
- Restaurant rejection for those platforms is queued through `POST /web-api/v1/orders/cancel/{orderId}` with the rejection reason.
- A decision only targets the platform that created the order; approving a Trendyol order never updates Getir, Yemeksepeti, or Migros orders.
- Courier `accepted_by_courier` maps to Posentegra `accepted`.
- Courier `on_route` maps to Posentegra `on_the_way`.
- Courier `delivered` maps to Posentegra `delivered`.
- Courier `failed` maps to Posentegra `failed`.

The API call uses `packages.posentegra_id` first, then order id fallbacks. If the package is platform backed and Posentegra is configured but no pid/order id exists, the status update is rejected and `order_pid_missing_for_status_change` is logged.

## Packages Endpoints

Prepared client operation:

- `POST /web-api/v1/restaurants/{id}/assign-package`

Important id rule:

- `{id}` must be the Posentegra restaurant id (`restaurants.posentegra_id`), not Delivera internal `restaurants.id`.

Manual and extension-created packages are written locally first and queued in `posentegra_outbox` in the same database transaction. The outbox calls `assign-package` with an idempotency key. A Posentegra outage therefore does not block restaurant or courier operations; failures are retried with exponential backoff and become `dead_letter` after 10 delivery cycles.

Restaurant approval/rejection and courier lifecycle changes are persisted locally first. Restaurant approval uses the idempotent `order.status:{packageId}:accepted` key, rejection uses `order.cancel:{packageId}`, and courier `on_route`, `delivered`, and `failed` transitions use their status keys. All events use the durable outbox; only idempotent operations are automatically retried. If Posentegra returns a canonical `pid` for a manually assigned package, `packages.posentegra_id` is updated before later status events are delivered.

`change-status` hedef durum yerine "bir adım ilerlet" komutu olduğu için durum olaylarında otomatik HTTP retry kapalıdır. Aynı paket ve aynı durum `dedupe_key` ile tek satıra düşer; tamamlanan satır yeniden kuyruğa alınmaz. Timeout, 5xx veya prosesin gönderim sırasında kapanması gibi uzak sonucun belirsiz olduğu durumlar ilk hatada `dead_letter` olur. Daha ileri durumlar önceki adım tamamlanana kadar bekletilir. Operatör önce Posentegra'daki uzak durumu kontrol eder, ardından gerekiyorsa admin retry endpointini bilinçli olarak kullanır. Bu tercih kaçırılan bir otomatik tekrar yerine yanlışlıkla iki kez durum ilerletmeyi öncelikli olarak engeller.

Operations endpoints (admin session required):

- `GET /api/admin/posentegra-outbox?status=dead_letter&limit=100`
- `POST /api/admin/posentegra-outbox/{id}/retry`

## PID Logic

Incoming order JSON may include:

- `pid`
- `restaurantId`
- `restaurant.id`
- `provider.id`

Storage:

- `packages.posentegra_id` stores `pid`.
- `platform_orders.posentegra_id` stores `pid`.
- `packages.platform_restaurant_id` stores incoming `restaurantId`.
- `platform_orders.platform_restaurant_id` stores incoming `restaurantId`.

Duplicate rule:

- Same restaurant and same `pid` does not create a second package.
- Existing package/order is updated and idempotent response is returned.

## Restaurant Matching

Matching order:

1. Platform-specific columns:
   - `yemeksepeti_restaurant_id`
   - `getir_restaurant_id`
   - `trendyol_restaurant_id`
   - `migros_restaurant_id`
2. `restaurants.posentegra_id`
3. Legacy `external_restaurant_ids`

The matched internal `restaurants.id` is written to:

- `packages.restaurant_id`
- `platform_orders.restaurant_id`

## Logging

Render/application logs include:

- `posentegra_restaurant_create_start`
- `posentegra_restaurant_create_success`
- `posentegra_restaurant_create_failed`
- `posentegra_id_db_update_success`
- `posentegra_id_db_verify_failed`
- `order_pid_detected`
- `order_pid_linked`
- `order_pid_duplicate_skipped`
- `package_platform_restaurant_id_saved`
- `platform_restaurant_matched`
- `platform_restaurant_not_matched`
- `posentegra_status_change_start`
- `posentegra_status_change_success`
- `posentegra_status_change_failed`
- `order_pid_missing_for_status_change`

FastSiparis request/response summaries are written to `webhook_logs` with secrets redacted.

## DB Checks

```sql
SELECT
  id,
  name,
  posentegra_id,
  trendyol_restaurant_id,
  yemeksepeti_restaurant_id,
  getir_restaurant_id,
  migros_restaurant_id
FROM restaurants
ORDER BY created_at DESC;
```

```sql
SELECT
  p.id,
  p.tracking_no,
  p.restaurant_id,
  r.name AS restaurant_name,
  p.source,
  p.platform_restaurant_id,
  p.posentegra_id,
  po.posentegra_id AS order_posentegra_id,
  po.platform_restaurant_id AS order_platform_restaurant_id,
  po.platform_order_id
FROM packages p
LEFT JOIN restaurants r ON r.id = p.restaurant_id
LEFT JOIN platform_orders po
  ON po.package_id = p.id
  OR po.platform_order_id = p.external_order_id
  OR po.posentegra_id = p.posentegra_id
ORDER BY p.created_at DESC
LIMIT 20;
```

## Test Steps

1. Configure `POSENTEGRA_API_BASE_URL`, `POSENTEGRA_API_KEY`, and optional `POSENTEGRA_BUSINESS_ID`.
2. Create a restaurant from admin panel.
3. Verify `restaurants.posentegra_id` is filled.
4. Send webhook with `restaurantId = restaurants.posentegra_id` and `pid = test-pid-001`.
5. Verify package and platform order rows contain the same pid and platform restaurant id.
6. Assign the package to a courier.
7. Change courier status and verify Posentegra `change-status/{pid}` is called.
8. Run:

```bash
npm run check
npm test
npm run db:migrate
```
