# Ticketify

Web đặt vé xem phim **thời gian thực** cho một rạp: giữ ghế chống bán trùng bằng PostgreSQL, thanh toán VNPay (sandbox), vé PDF có QR, thông báo realtime.

- Kế hoạch & thiết kế: [PLAN.md](PLAN.md) · Lộ trình: [ROADMAP.md](ROADMAP.md) · Quy ước: [CONTRIBUTING.md](CONTRIBUTING.md)
- Sơ đồ CSDL: [docs/erd.md](docs/erd.md) · Ràng buộc SQL viết tay: [apps/api/prisma/README.md](apps/api/prisma/README.md)

> Trạng thái: **Giai đoạn 1 — Quản trị & danh mục** (đến tuần 4). Đã có: đăng ký/đăng nhập, refresh token xoay vòng, phân quyền USER/ADMIN/STAFF; phim, thể loại, upload poster; trang chủ, danh sách và chi tiết phim; trang quản trị phim và thể loại. Chưa có: phòng, ghế, giá, suất chiếu, đặt vé, thanh toán.

## Công nghệ

| Phần | Công nghệ |
|---|---|
| API | NestJS 12 (CommonJS), Prisma 7 + `@prisma/adapter-pg`, PostgreSQL 16, Redis 7 (ioredis), pino, zod, Swagger |
| Web | Vite 8, React 19, TypeScript 6, Tailwind CSS 4, shadcn/ui, React Router 8, TanStack Query, axios |
| Dùng chung | `packages/shared`: enum trạng thái + zod schema (ESM) |
| Hạ tầng dev | Docker Compose: Postgres, Redis, RustFS (S3-compatible), Mailpit |
| Test | Jest 30 (unit / integration), Testcontainers |
| Monorepo | pnpm 12 workspaces, ESLint 10 + Prettier, husky + lint-staged + commitlint |

## Yêu cầu

- **Node.js 24 LTS** (`.nvmrc`; tối thiểu 24.9 vì Jest cần `require(esm)` để nạp NestJS 12)
- **pnpm 12**: `corepack enable` (phiên bản lấy từ `packageManager` trong `package.json`)
- **Docker** (Docker Desktop trên Windows/macOS)

## Chạy local

```bash
cp .env.example .env          # giá trị mặc định đã khớp docker-compose.yml
docker compose up -d          # postgres, redis, s3 (+ s3-init tạo bucket), mailpit
pnpm install                  # build packages/shared + sinh Prisma Client
pnpm db:deploy                # áp dụng migration (gồm ràng buộc SQL viết tay)
pnpm db:seed                  # dữ liệu mẫu, chạy lại bao nhiêu lần cũng được
pnpm dev                      # API + web + shared (watch)
```

| Địa chỉ | Nội dung |
|---|---|
| http://localhost:5173 | Web: `/movies`, `/admin/movies` (tài khoản admin), `/status` gọi `GET /health` của API |
| http://localhost:3000/health | Health check: Postgres + Redis (`503` nếu một trong hai chết) |
| http://localhost:3000/docs | Swagger UI |
| http://localhost:8025 | Mailpit (hộp thư dev) |
| http://localhost:9001 | RustFS console (đăng nhập bằng `S3_ACCESS_KEY` / `S3_SECRET_KEY`) |

Tài khoản seed: `admin@ticketify.local`, `staff@ticketify.local`, `user@ticketify.local`, mật khẩu lấy từ `SEED_*_PASSWORD` trong `.env` (chỉ dùng cho dev).

API **không khởi động** nếu biến môi trường thiếu hoặc sai: lỗi liệt kê từng biến (schema: `apps/api/src/config/env.schema.ts`).

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `pnpm dev` | Chạy API (`nest start --watch`), web (Vite), shared (`tsc --watch`) song song |
| `pnpm lint` | ESLint (typed) + Prettier check |
| `pnpm typecheck` | `tsc --noEmit` cho mọi package |
| `pnpm test:unit` | Unit test (không cần Docker) |
| `pnpm test:integration` | Integration test với Postgres + Redis thật (Testcontainers) |
| `pnpm build` | Build shared, API, web |
| `pnpm db:migrate` | `prisma migrate dev` (tạo migration mới khi đổi schema) |
| `pnpm db:deploy` / `pnpm db:seed` | Áp dụng migration / seed dữ liệu mẫu |

### Integration test

Mặc định global setup tự khởi động **Postgres 16 + Redis 7 bằng Testcontainers** (cần Docker), chạy `prisma migrate deploy` vào một database template, và mỗi test suite được clone một database riêng.

Nếu không có Docker, trỏ sang server có sẵn (user Postgres cần quyền `CREATEDB`; test dùng Redis logical DB 1–15 và sẽ `FLUSHDB` chúng):

```bash
TEST_DATABASE_URL=postgresql://ticketify:ticketify@localhost:5432/postgres \
TEST_REDIS_URL=redis://localhost:6379 \
pnpm test:integration
```

`storage.int-spec.ts` tự chạy một container RustFS riêng (image giống `docker-compose.yml`) và dừng nó giữa chừng để kiểm tra lỗi `503`. Có thể dùng server S3 sẵn có bằng `TEST_S3_ENDPOINT` (kèm `TEST_S3_ACCESS_KEY` / `TEST_S3_SECRET_KEY`, mặc định là thông tin của docker-compose); mỗi lần chạy tạo một bucket riêng rồi xóa đi.

## Danh mục phim và poster

- **Upload poster hai bước**: `POST /admin/uploads/poster` trả về URL PUT đã ký (5 phút, ký cả `Content-Type` và `Content-Length`), trình duyệt PUT thẳng lên RustFS, rồi gửi `key` khi lưu phim. API kiểm tra object bằng `HEAD` trước khi nhận. Bucket cần CORS cho origin của web: `s3-init` trong `docker-compose.yml` đặt CORS theo `CORS_ORIGINS`.
- **`posterUrl`** là URL GET đã ký, sống 1 giờ. Chữ ký SigV4 gắn với host, nên URL trao cho trình duyệt (cả PUT lẫn GET) được ký cho `S3_PUBLIC_ENDPOINT` nếu có, ngược lại cho `S3_ENDPOINT`. API vẫn gọi `HEAD`/`DELETE` qua `S3_ENDPOINT`. Ở local hai giá trị trùng nhau (`http://localhost:9000`), để trống `S3_PUBLIC_ENDPOINT`. Khi deploy, ví dụ API trong Docker dùng `S3_ENDPOINT=http://s3:9000` còn trình duyệt đi qua Caddy thì đặt `S3_PUBLIC_ENDPOINT=https://files.example.com`. Origin công khai cũng phải có trong CORS của bucket.
- **Tìm kiếm không dấu** (`GET /movies?q=`): so khớp `lower(translate(title, …))` với chuỗi tìm kiếm đã bỏ dấu, không cần cột mới hay extension `unaccent`. Giới hạn:
  - chỉ bỏ dấu các chữ cái tiếng Việt ở phía database (tìm `nino` không ra `Niño`);
  - quét tuần tự, không dùng index. Đủ cho danh mục vài trăm phim của một rạp; nếu cần nhanh hơn thì thêm `unaccent` + index `pg_trgm` bằng migration.
- Poster cũ bị xóa khi đổi poster hoặc xóa phim, sau khi transaction đã commit. Xóa lỗi chỉ ghi log cảnh báo, nên có thể còn object mồ côi trên storage (chưa có job dọn).

## Suất chiếu và lịch chiếu (API)

Đặc tả đầy đủ có trong Swagger (`/docs`). Mọi ngày (`date`, `YYYY-MM-DD`) là ngày theo `CINEMA_TZ` (mặc định `Asia/Ho_Chi_Minh`), không phải ngày UTC. Mọi thời điểm gửi lên là ISO 8601 có offset, ví dụ `2026-11-02T19:30:00+07:00`.

| Endpoint | Quyền | Mô tả |
|---|---|---|
| `POST /admin/showtimes` | ADMIN | Tạo suất `{ movieId, roomId, startsAt }`. `endsAt = startsAt + thời lượng + SHOWTIME_CLEANUP_MINUTES` (15 phút). Sinh `ShowtimeSeat` cho mọi ghế đang bật, chốt giá theo loại ngày của `startsAt`. Chồng giờ → `409 SHOWTIME_OVERLAP` |
| `GET /admin/showtimes/preview?movieId=&roomId=&startsAt=` | ADMIN | Xem trước, **không ghi gì**: trả `startsAt`, `endsAt`, `cleanupMinutes`, `dayType` và `conflicts` (các suất chưa hủy trong phòng đang trùng khoảng `[startsAt, endsAt)`). Cùng validation và mã lỗi với `POST`. Chỉ để tham khảo: exclusion constraint vẫn là nơi quyết định khi tạo thật |
| `GET /admin/showtimes?date=` | ADMIN | Suất (mọi trạng thái) bắt đầu trong ngày đó, kèm số ghế đã bán / đang giữ |
| `POST /admin/showtimes/:id/cancel` | ADMIN | Hủy suất chưa bắt đầu và chưa có ghế `HELD`/`SOLD`; hủy lần hai vẫn `200` |
| `GET /showtimes?movieId=&date=` | Public | Suất `SCHEDULED` chưa bắt đầu của phim trong ngày (mặc định hôm nay), kèm số ghế còn trống. `movieId` bắt buộc; phim không tồn tại → `200 []` |
| `GET /showtimes/dates?movieId=` | Public | Các ngày (tăng dần, không trùng) có ít nhất một suất `SCHEDULED` chưa bắt đầu của phim. Trang phim dùng để gợi ý ngày gần nhất có suất. Phim không tồn tại → `{ "dates": [] }` |
| `GET /showtimes/:id/seats` | Public | Lưới phòng và **mọi ghế của phòng**: ghế có `ShowtimeSeat` trả giá đã chốt và trạng thái (`HELD` hết hạn hiện `AVAILABLE`); ghế tắt lúc tạo suất → `UNAVAILABLE`, `price: null`. Suất đã hủy → `404` |

## Giữ ghế (API)

`POST /bookings` (đăng nhập, header `Idempotency-Key` bắt buộc, 8–128 ký tự `A–Z a–z 0–9 . _ ~ : -`), body `{ showtimeId, seatIds, comboItems? }`:

- 1–6 ghế, không trùng; ghế đôi phải chọn đủ cặp (`422 COUPLE_INCOMPLETE`). `comboItems: [{ comboId, quantity }]` chỉ nhận combo đang bật (`422 COMBO_NOT_AVAILABLE`).
- Thành công → `201`, đơn `PENDING`: ghế `HELD` tới `holdUntil = expiresAt + PAYMENT_GRACE_SECONDS`, `expiresAt = lúc tạo + HOLD_TTL_SECONDS`. Giá ghế lấy từ giá đã chốt của suất, combo lưu snapshot tên và giá.
- Gửi lại cùng key và cùng nội dung → `200` với đơn cũ; cùng key khác nội dung → `422 IDEMPOTENCY_KEY_REUSED`.
- Ghế đang bị request khác khóa → `409 SEAT_LOCKED`; ghế đã bán hoặc đang được giữ → `409 SEAT_UNAVAILABLE` (`details.seatIds`). Client tải lại sơ đồ ghế khi nhận `409`.
- Suất đã hủy → `409 SHOWTIME_CANCELLED`; suất đã bắt đầu → `422 SHOWTIME_STARTED`; đã có đơn `PENDING` còn hạn cho suất này → `409 BOOKING_ALREADY_PENDING`.

## Cấu trúc

```
apps/api/            NestJS API (sau này thêm worker)
  prisma/            schema, migrations (kèm SQL viết tay), seed
  src/config         env schema (zod) + AppConfig
  src/common         exception filter, định dạng lỗi
  src/infra          prisma, redis, clock, storage (S3)
  src/modules        health, auth, users, movies (phim, thể loại, upload poster)
  test/              integration test + helper Testcontainers
apps/web/            React app
packages/shared/     enum + zod schema dùng chung
docs/                ERD, tài liệu thiết kế
```

## VNPay sandbox (việc làm tay)

Tích hợp VNPay bắt đầu ở giai đoạn 3, nhưng nên đăng ký sớm vì cần thời gian duyệt:

1. Đăng ký merchant test tại **https://sandbox.vnpayment.vn/devreg/** (đường dẫn theo các hướng dẫn cộng đồng; nếu đổi, tìm mục đăng ký trên https://sandbox.vnpayment.vn). VNPay gửi qua email **Terminal ID (`vnp_TmnCode`)** và **Secret Key (`vnp_HashSecret`)**, cùng thông tin đăng nhập trang quản trị merchant sandbox và thẻ test.
2. Điền vào `.env` (không commit file này):

   | Biến | Giá trị |
   |---|---|
   | `VNPAY_TMN_CODE` | Terminal ID |
   | `VNPAY_HASH_SECRET` | Secret Key |
   | `VNPAY_PAYMENT_URL` | `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html` (mặc định) |
   | `VNPAY_RETURN_URL` | URL trang kết quả trên web, ví dụ `http://localhost:5173/payment/result` |

3. Hai biến đầu đang là tùy chọn ở giai đoạn 0; giai đoạn 3 sẽ chuyển thành bắt buộc. URL IPN cần một tunnel công khai (cloudflared/ngrok), xem PLAN mục 5.

## Quyết định đáng chú ý

- **Node 24 thay vì 22**: NestJS 12 chỉ phát hành ESM; Jest chỉ nạp được qua `require(esm)` trên Node ≥ 24.9, và Node 22 hết hỗ trợ 04/2027.
- **RustFS thay MinIO**: MinIO ngừng phát hành Docker image chính thức; code sẽ dùng S3 API chuẩn nên có thể đổi nhà cung cấp.
- **Thời gian**: logic nghiệp vụ chỉ đọc giờ qua `ClockService`; ESLint chặn `new Date()` / `Date.now()` trong `apps/api`.
- **Ràng buộc ở tầng DB**: exclusion constraint chống chồng suất chiếu, CHECK trạng thái ghế, partial unique cho vé và thanh toán, có integration test chứng minh từng ràng buộc.
- Đây là môi trường demo trên một máy, **không phải high availability**.
