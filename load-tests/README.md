# Load test (k6)

Kịch bản k6 cho ROADMAP 6.1–6.2 (PLAN mục 10, "Load test"). Số liệu đo thật và cách đọc nằm ở
[docs/LOAD_TEST.md](../docs/LOAD_TEST.md) (6.6); thư mục này là công cụ để đo.

| File                            | Nội dung                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `hot-showtime.js`               | Kịch bản 1: dồn dập vào **một** suất chiếu hot. Mỗi lượt: xem sơ đồ ghế → chọn 1–4 ghế liền nhau đang trống → giữ ghế                   |
| `mixed-traffic.js`              | Kịch bản 2: traffic hỗn hợp trên toàn bộ suất chiếu tương lai (xem phim, chi tiết, lịch chiếu, sơ đồ ghế, "vé của tôi", giữ ghế, hủy)   |
| `lib/common.js`                 | Hàm dùng chung: đọc dữ liệu seed, chọn user, chọn ghế, ghi summary                                                                     |
| `run.sh`                        | Chạy một kịch bản trong Docker, ghi cấu hình máy/DB/API, summary JSON thô của k6 và kết quả SQL kiểm trùng                             |
| `sql/verify-no-duplicates.sql`  | Kiểm sau **mỗi** lần chạy: 0 ghế/vé trùng, không giữ ghế dở dang. Khác 0 là lỗi đúng đắn, không phải số liệu hiệu năng                  |
| `sql/reset-hot-showtime.sql`    | Trả suất hot về "toàn bộ ghế trống" trước mỗi lần chạy kịch bản 1 (`run.sh` tự gọi)                                                     |
| `.data/` (không commit)         | `load-data.json` do script seed sinh ra: id suất hot, danh sách phim/suất chiếu, **access token đã ký** của user tải                    |

Cả hai kịch bản dùng executor `constant-arrival-rate`: k6 bắt đầu đúng `RATE` lượt mỗi giây bất kể
server trả nhanh hay chậm, nên khi server chậm đi, số VU tăng (tới `MAX_VUS`) thay vì tải giảm theo.
Lượt nào k6 không kịp bắt đầu được đếm ở `dropped_iterations`: số này khác 0 nghĩa là **máy phát tải
hoặc giới hạn VU** đã không giữ được tải đặt ra, kết quả phải đọc kèm điều đó.

`409` của request giữ ghế (`SEAT_LOCKED`, `SEAT_UNAVAILABLE`, `BOOKING_ALREADY_PENDING`) là hệ thống
từ chối đúng thiết kế, **không** tính là lỗi (`http_req_failed`). Lỗi là 5xx, timeout, và mọi mã
không mong đợi.

## Chuẩn bị (một lần cho mỗi DB tạm)

Không bao giờ dùng DB dev `ticketify`: script seed và `run.sh` từ chối mọi DB không bắt đầu bằng
`ticketify_load`.

```bash
# 1. DB tạm trên Postgres của docker-compose
docker exec ticketify-postgres-1 psql -U ticketify -d postgres -c "CREATE DATABASE ticketify_load01"

# 2. Schema + dữ liệu nền (giá ghế, thể loại). Biến môi trường thật thắng .env
export DATABASE_URL=postgresql://ticketify:ticketify@localhost:5432/ticketify_load01
SEED_ADMIN_PASSWORD=x-admin SEED_STAFF_PASSWORD=x-staff SEED_USER_PASSWORD=x-user pnpm db:deploy
SEED_ADMIN_PASSWORD=x-admin SEED_STAFF_PASSWORD=x-staff SEED_USER_PASSWORD=x-user pnpm db:seed

# 3. Dữ liệu lớn + file cho k6. JWT_ACCESS_SECRET phải trùng secret của API sẽ chạy
JWT_ACCESS_SECRET=<secret của API dưới tải> pnpm --filter @ticketify/api loadtest:seed
```

Mặc định script seed (`apps/api/scripts/load-test-seed.ts`) tạo: 60 phim (70 % đang chiếu),
8 phòng 12 × 16 ghế (hàng E–H là VIP, không có ghế đôi), 5 suất/ngày/phòng từ 60 ngày trước tới
14 ngày sau (3 000 suất, 576 000 `showtime_seats`), 5 000 user, lịch sử bán vé (≈ 45 % cặp ghế của
suất đã chiếu, 15 % của suất sắp chiếu: booking `CONFIRMED` + vé + payment `SUCCESS`, thêm booking
`EXPIRED`), và một **suất hot** 18:45 ngày mai ở "Phòng Load 1" với mọi ghế trống. Các tham số
(`--users`, `--days-back`, `--past-fill`…) ở đầu file. Mật khẩu chung của user tải:
`load-test-password` (chỉ có ý nghĩa trong DB tạm).

Token được ký sẵn bằng `JWT_ACCESS_SECRET` (mặc định sống 8 giờ, `--token-ttl-hours`) thay vì gọi
`POST /auth/login` cho từng user: login bị giới hạn theo IP (`LOGIN_RATE_LIMIT_MAX` × 4 mỗi cửa sổ)
và không phải thứ cần đo ở đây.

## Chạy API và worker dưới tải

Chạy bản build (không phải `pnpm dev`), `NODE_ENV=production`, mỗi thứ một tiến trình như bản
deploy (PLAN mục 11: 1 API + 1 worker). Đặt **mọi** biến môi trường cần thiết trong shell và chạy từ
một thư mục không có `.env`, để không lấy nhầm giá trị (VNPay thật, DB dev) từ `.env` của repo:

- `DATABASE_URL` trỏ DB tạm, `DATABASE_POOL_MAX=10` (mặc định production). **Số đo với pool 40 chỉ
  dành cho kịch bản A (2.14), không dùng làm kết quả.**
- `REDIS_URL=redis://localhost:6379/14` (một DB Redis riêng; dọn bằng `FLUSHDB` khi xong).
- `VNPAY_*` giả, `MOMO_*` và `SEPAY_*` để trống: load test không gọi cổng thanh toán nào.
- `PORT=3100` (để cổng 3000 cho server dev), `JWT_ACCESS_SECRET` trùng với lúc seed.

## Chạy

```bash
LOAD_DB=ticketify_load01 POOL_MAX=10 RATE=100 DURATION=2m load-tests/run.sh hot-showtime
LOAD_DB=ticketify_load01 POOL_MAX=10 RATE=50  DURATION=3m load-tests/run.sh mixed-traffic
```

Mỗi lần chạy tạo `load-tests/results/<thời điểm UTC>-<kịch bản>[-LABEL]/`:

- `meta.json`: CPU, RAM, hệ điều hành, Docker Desktop (CPU/RAM của VM), Postgres (`max_connections`,
  `shared_buffers`, kích thước DB), `DATABASE_POOL_MAX` của API, tham số k6;
- `summary.json`: summary **thô** của k6 (mọi metric, p50/p90/p95/p99 theo từng endpoint);
- `k6-stdout.txt`: bản tóm tắt ngắn;
- `verify.txt`: kết quả `sql/verify-no-duplicates.sql`. `run.sh` dừng với mã 3 nếu một quy tắc khác 0.

`POOL_MAX` phải khai đúng giá trị API đang chạy: `run.sh` không nhìn được vào tiến trình API.

Biến cho k6: `RATE`, `DURATION`, `PRE_VUS`, `MAX_VUS`, `MAX_SEATS` (1–6). Biến khác của `run.sh`:
`BASE_URL` (mặc định `http://host.docker.internal:3100`), `PG_CONTAINER`, `K6_IMAGE` (mặc định
`grafana/k6:2.4.0`), `RESULTS_ROOT`, `LABEL`.

## Giới hạn cần ghi kèm mọi số liệu

- **Máy phát tải và máy chủ là cùng một máy** (PLAN muốn tách riêng). k6, API, worker, Postgres và
  Redis tranh nhau cùng CPU/RAM, nên số đo thấp hơn khi tách máy, và độ trễ không gồm mạng thật.
- Postgres và Redis chạy trong VM của Docker Desktop (WSL2), API và worker chạy trực tiếp trên
  Windows; k6 gọi API qua `host.docker.internal`.
- Token ký sẵn: không đo `POST /auth/login` (argon2, tốn CPU, bị rate limit).
- Không đo thanh toán, IPN, PDF, email: các luồng đó phụ thuộc cổng thanh toán và SMTP thật.

## Dọn dẹp

```bash
# dừng API + worker dưới tải, rồi:
docker exec ticketify-postgres-1 psql -U ticketify -d postgres -c "DROP DATABASE ticketify_load01"
docker exec ticketify-redis-1 redis-cli -n 14 FLUSHDB
```
