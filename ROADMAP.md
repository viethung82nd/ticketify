# Ticketify — Lộ trình chi tiết

Tài liệu này chia nhỏ mục 12 của [PLAN.md](PLAN.md) thành công việc theo tuần. Mỗi task có thể hoàn thành trong khoảng 0,5–2 ngày.

**Cách làm việc**
- Mỗi giai đoạn tương ứng một GitHub Milestone; mỗi task là một Issue và được làm trong một nhánh/PR riêng.
- PR chỉ được merge khi CI xanh.
- Một giai đoạn chỉ coi là xong khi đạt **Definition of Done (DoD)** của giai đoạn đó.
- Mặc định: `HOLD_TTL = 10 phút`, `PAYMENT_GRACE = 5 phút`, voucher làm ở giai đoạn 5.

---

## Giai đoạn 0 — Nền tảng (tuần 1–2)

### Tuần 1: Khung dự án
- [x] **0.1** Khởi tạo git, pnpm workspace (`apps/api`, `apps/web`, `packages/shared`), `.nvmrc` (Node 24 LTS — NestJS 12 + Jest cần Node ≥ 24.9; Node 22 hết hỗ trợ 04/2027), `.editorconfig`, `.gitignore`
- [x] **0.2** ESLint + Prettier dùng chung; husky + lint-staged; commitlint (Conventional Commits)
- [x] **0.3** `apps/api`: scaffold NestJS; `ConfigModule` kiểm tra biến môi trường bằng zod; logger pino; `ValidationPipe` global; exception filter chuẩn hóa lỗi; Swagger tại `/docs`
- [x] **0.4** `docker-compose.yml`: Postgres 16, Redis 7, RustFS — S3-compatible, thay MinIO vì MinIO ngừng phát hành Docker image (kèm container tạo bucket), Mailpit; tạo `.env.example`
- [x] **0.5** Cài Prisma, viết `PrismaService`, health check (`/health`: kiểm tra DB và Redis)
- [x] **0.6** `ClockService`: inject được để test có thể điều khiển thời gian

### Tuần 2: Schema, test, frontend, CI
- [x] **0.7** Prisma schema cho mọi bảng (trừ voucher) + migration đầu tiên
- [x] **0.8** Migration raw SQL:
  - `btree_gist` + exclusion constraint cho `Showtime`
  - CHECK constraint cho `ShowtimeSeat`
  - partial unique cho `Ticket` và `Payment`
- [x] **0.9** Hạ tầng test:
  - tách cấu hình Jest `unit` / `integration`
  - helper Testcontainers (khởi động PG + Redis, chạy migration)
  - test integration đầu tiên: xác nhận các constraint ở 0.8 chặn đúng
- [x] **0.10** Seed: admin, staff, user mẫu; 1 phòng 10×12 có đủ ghế thường/VIP/đôi; bảng giá; vài phim
- [x] **0.11** `apps/web`: Vite + React + TS, Tailwind, shadcn/ui, React Router, TanStack Query, axios client, layout chung
- [x] **0.12** `packages/shared`: các enum trạng thái, zod schema dùng chung
- [x] **0.13** GitHub Actions CI: install → lint → typecheck → unit → integration → build
- **0.14** Tài liệu & VNPay
  - [x] Vẽ ERD lưu vào `docs/erd.md` (có test so với schema thật)
  - [ ] Đăng ký VNPay sandbox (việc làm tay của chủ dự án; hướng dẫn trong README)

**DoD:** `docker compose up` + `pnpm dev` chạy được cả API lẫn web; CI xanh; test constraint pass.

---

## Giai đoạn 1 — Auth & danh mục (tuần 3–6)

### Tuần 3: Xác thực
- [x] **1.1** Đăng ký, đăng nhập (argon2); access token 15 phút; refresh token 7 ngày đặt trong cookie httpOnly
- [x] **1.2** Refresh token rotation + phát hiện token bị dùng lại (thu hồi cả chuỗi token); logout; `GET /me`
- [x] **1.3** `RolesGuard`, decorator `@Roles` và `@CurrentUser`; rate limit cho login (Redis storage)
- [x] **1.4** Test unit + e2e cho auth (token hết hạn, token dùng lại, sai role)
- [x] **1.5** FE: trang đăng nhập/đăng ký, auth store, interceptor tự gọi refresh, route bảo vệ theo role

### Tuần 4: Phim & lưu trữ
- [x] **1.6** `StorageService` (S3 API — RustFS): upload, presigned URL; upload poster
- [x] **1.7** CRUD phim + thể loại (admin); API public: danh sách phân trang, lọc theo trạng thái/thể loại, chi tiết theo slug
- [x] **1.8** FE: trang chủ, danh sách phim, chi tiết phim; admin: bảng phim + form

### Tuần 5: Phòng, ghế, giá
- [x] **1.9** CRUD phòng; sinh lưới ghế; sửa loại ghế, bật/tắt ghế, ghép cặp ghế đôi
- [x] **1.10** CRUD `SeatPrice` và `Holiday`
- [x] **1.11** `PricingService`: `dayType()` tính theo `Asia/Ho_Chi_Minh`. Unit test các ca biên: 23:30 Chủ nhật giờ VN, suất qua nửa đêm, ngày lễ trùng cuối tuần
- [x] **1.12** FE admin: trình sửa sơ đồ ghế dạng lưới, bảng giá, ngày lễ

### Tuần 6: Suất chiếu & combo
- [x] **1.13** Tạo suất chiếu: `endsAt = startsAt + thời lượng + thời gian dọn phòng`. Trong cùng transaction tạo `Showtime` + sinh `ShowtimeSeat`, chốt giá từng ghế (`PricingService.dayType(startsAt, tx)` + `priceFor`). Lỗi exclusion constraint trả về `409`. **Khóa dòng phòng bằng `SELECT … FROM rooms WHERE id = $1 FOR NO KEY UPDATE` trước khi đọc danh sách ghế**, để không chạy đồng thời với một lần sửa ghế (`PATCH /admin/rooms/:id/seats` giữ `FOR UPDATE` trên cùng dòng) và để các lần tạo suất trong **cùng một phòng** chạy lần lượt. Tuần 6 dùng `FOR SHARE`, đổi ngày 28/10/2026 (tuần 8) vì lỗi 500: exclusion constraint chèn chỉ mục trước rồi mới kiểm tra chồng giờ, nên hai INSERT chồng giờ chạy cùng lúc thấy dòng chưa commit của nhau và chờ nhau; Postgres phá vòng chờ bằng `40P01 deadlock detected` (Prisma `P2034`), mỗi nạn nhân sau `deadlock_timeout` 1 giây. 10 request chồng giờ đến đúng cùng lúc thành 9 lỗi 500 (đôi khi cả người thắng cũng quá `timeout` 5 giây của transaction, `P2028`) thay vì 9 lần `409`. Khi tuần tự theo phòng, INSERT sau luôn thấy INSERT trước đã commit và nhận `23P01` → `409` ngay. `FOR NO KEY UPDATE` không chặn khóa key-share của khóa ngoại tới `rooms`. Transaction tạo suất có `maxWait` 2 giây và `timeout` 5 giây tường minh (`SHOWTIME_TX`); quá hạn → `503 DATABASE_BUSY`. Thứ tự khóa đã chốt (28/10/2026): **tạo suất** khóa `rooms` `FOR NO KEY UPDATE` rồi `movies` `FOR SHARE`; **sửa ghế** khóa `rooms` `FOR UPDATE`; **hủy suất** khóa `showtimes` `FOR NO KEY UPDATE` rồi mọi `showtime_seats` của suất `FOR UPDATE ORDER BY seat_id`
- [x] **1.14** Hủy suất chiếu: chỉ cho phép khi chưa có ghế `HELD/SOLD` (vì không có hoàn tiền)
- [x] **1.15** API public: lịch chiếu theo phim/ngày; `GET /showtimes/:id/seats` trả **mọi ghế của phòng** (left join với `ShowtimeSeat` của suất): ghế có dòng trả `AVAILABLE` / `HELD` còn hạn / `SOLD` kèm giá đã chốt, `HELD` hết hạn trả `AVAILABLE` (hết hạn lười, không ghi DB); ghế không có dòng (tắt lúc tạo suất) trả `UNAVAILABLE`, `price: null`
- [x] **1.16** CRUD combo
- [x] **1.17** FE: lịch chiếu trên trang chi tiết phim; admin: form suất chiếu, quản lý combo

**DoD:** admin tạo được toàn bộ dữ liệu qua UI; test chồng giờ → `409`; test tính giá pass.

**Giai đoạn 1: đã đạt DoD (28/10/2026).** Admin tạo phim, thể loại, phòng + sơ đồ ghế, bảng giá, ngày lễ, suất chiếu và combo qua UI (kiểm chứng bằng Playwright); chồng giờ → `409 SHOWTIME_OVERLAP` (kể cả 10 request đồng thời); test tính giá (múi giờ, qua nửa đêm, ngày lễ, giá chốt) pass.

---

## Giai đoạn 2 — Giữ ghế ⭐ (tuần 7–10)

### Tuần 7: Luồng giữ ghế
- [x] **2.1** `BookingService.hold()`: interactive transaction + raw SQL theo mục 4 của PLAN; `FOR UPDATE NOWAIT`, map lỗi `55P03` thành `409`; kiểm tra `rowCount`. **Sau khi khóa ghế, đọc lại `showtimes.status`** và từ chối nếu `CANCELLED`: hủy suất (1.14) khóa `showtimes` `FOR NO KEY UPDATE` rồi mọi `showtime_seats` của suất `FOR UPDATE ORDER BY seat_id`, nên hai luồng tuần tự hóa trên ghế; INSERT booking chỉ cần khóa key-share trên dòng suất nên không deadlock với lần hủy. Thứ tự khóa đã chốt (28/10/2026): **tạo suất** khóa `rooms` `FOR NO KEY UPDATE` rồi `movies` `FOR SHARE`; **sửa ghế** khóa `rooms` `FOR UPDATE`; **hủy suất** khóa `showtimes` `FOR NO KEY UPDATE` rồi mọi `showtime_seats` của suất `FOR UPDATE ORDER BY seat_id`
- [x] **2.2** Validate:
  - tối đa 6 ghế
  - ghế đôi phải chọn theo cặp
  - suất chiếu chưa bắt đầu: kiểm tra `startsAt > now` (`ClockService`) **trước khi giữ ghế**. `GET /showtimes/:id/seats` vẫn trả sơ đồ của suất đã bắt đầu (chỉ suất `CANCELLED` mới 404), nên không được dựa vào endpoint đó để chặn
  - mỗi user tối đa 1 đơn `PENDING` cho mỗi suất chiếu
- [x] **2.3** Tính giá ở server; tạo `BookingSeat`; tạo `BookingCombo` kèm snapshot giá
- [x] **2.4** Idempotency: header `Idempotency-Key` + `requestHash` (cùng key cùng hash → trả đơn cũ; cùng key khác hash → `422`)
- [x] **2.5** Unit + integration test cho các nhánh validate và idempotency

### Tuần 8: Hết hạn & worker
- [x] **2.6** Entry point `main.worker.ts`; module BullMQ dùng chung cho API và worker. `main.worker.ts` dùng `createApplicationContext(WorkerModule)` (không HTTP); `QueueModule` (`infra/queue`) cung cấp `BookingQueueProducer` (API) và `QueueWorkers` (worker), mỗi bên một kết nối ioredis riêng với `maxRetriesPerRequest: null` (không dùng lại client `REDIS`). Worker concurrency 5; `SIGTERM`/`SIGINT` → đóng worker, chờ job đang chạy, rồi đóng DB và Redis. Script `start:worker`, `dev:worker`. **Hạn cứng khi dừng** (28/10/2026): `WORKER_SHUTDOWN_GRACE_MS` 10 giây tính từ tín hiệu; quá hạn → log `error` có tên job và `bookingId`, `process.exit(1)`, không chờ `app.close()`. Lý do: kiểm chứng `SIGTERM` trên Linux cho thấy worker bỏ job sau 10 giây nhưng chỉ thoát sau 20 giây, vì `app.close()` (Prisma disconnect) chờ câu lệnh đang bị chặn; hạn cứng an toàn vì Postgres rollback transaction chưa commit khi kết nối đứt, BullMQ chạy lại job stalled và `expireBooking` idempotent. Kèm theo, transaction hết hạn đơn đặt `SET LOCAL lock_timeout` 3 giây (`WORKER_LOCK_TIMEOUT_MS`): chờ khóa ghế lâu hơn → `55P03`, rollback, job thử lại theo backoff, cron đếm `busy`. **Kết quả đo** (số đo thật, không phải ước lượng: `worker-shutdown.int-spec.ts` trong container Linux `node:24-bookworm-slim`, Postgres 16.15, Redis 7.4.12, process worker thật + `SIGTERM` thật): A — khóa ghế nhả 2 giây sau `SIGTERM`: job xong, thoát mã 0 sau khoảng 2,0–2,1 giây, đơn `EXPIRED`, ghế `AVAILABLE`; B — khóa giữ 20 giây: `lock_timeout` 3 giây cắt câu lệnh đang chờ khóa, job rollback và trả về BullMQ, thoát mã 0 sau khoảng 2,9 giây, đơn `PENDING`, ghế `HELD`; khóa nhả xong, lần chạy lại (worker mới) xử lý xong đơn trong khoảng 0,64 giây; C — câu lệnh treo 20 giây (không phải chờ khóa): hạn cứng 10 giây, thoát mã 1 sau 10,0 giây, đơn vẫn `PENDING`, ghế `HELD` vì transaction đã rollback; phục hồi mất khoảng 30–40 giây vì khóa của job mồ côi trong BullMQ phải hết hạn trước khi đơn được xử lý lại. Không có đơn `EXPIRED` nào còn ghế `HELD`. Suite chỉ chạy khi `RUN_SIGNAL_TESTS=1` và không phải Windows; chỉ workflow `Worker shutdown (Linux)` bật biến (PR đụng `modules/bookings`, `infra/queue`, `main.worker.ts`; push lên `main`; hằng tuần; chạy tay). `pnpm test:integration` mặc định bỏ qua suite này.
- [x] **2.7** Delayed job `expire-booking` và hàm `expireBooking()` (chưa có querydr, sẽ thêm ở 3.7; điểm chèn `TODO(3.7)`). `ExpirationScheduler` đổi tên thành `BookingExpirationQueue`, gọi sau khi transaction giữ ghế commit; enqueue lỗi chỉ ghi log, request vẫn `201` (cron 2.8 là lưới an toàn). `jobId = expire-booking-{bookingId}`: BullMQ từ chối id tự đặt có đúng một dấu `:`, nên không dùng được `expire-booking:{id}` (quy ước jobId của 4.1 đổi thành `{eventId}-{action}`, xem "Đã chốt"). **Thứ tự khóa khi giải phóng ghế** (28/10/2026): `bookings` `FOR UPDATE SKIP LOCKED` rồi các `showtime_seats` `HELD` của đơn `FOR UPDATE ORDER BY seat_id`. Không có vòng chờ: giữ ghế không chờ khóa nào (`NOWAIT`), hủy suất khóa `showtimes` rồi `showtime_seats` và không bao giờ khóa `bookings`. **`SKIP LOCKED` ở `expireBooking`, cron không khóa** (28/10/2026): câu SELECT của cron 2.8 không khóa, nên cron không giữ khóa nào trong suốt vòng lặp; đơn đang bị luồng khác khóa (job của chính đơn đó, hoặc IPN ở tuần 12) trả `skipped` ngay, không chờ, và được thử lại ở lần quét sau. **Chưa ghi outbox `seats.released`**: hoãn sang giai đoạn 4 (4.1), `expireBooking` hiện chỉ đổi trạng thái đơn và ghế
- [x] **2.8** Cron quét mỗi phút với `SKIP LOCKED`: job lặp của BullMQ (`upsertJobScheduler`, 60 giây), chỉ trong worker. Câu `SELECT` lấy 100 đơn quá hạn không khóa; `SKIP LOCKED` nằm ở bước khóa từng đơn trong `expireBooking`. Đủ 100 thì quét tiếp ngay, tối đa 10 vòng mỗi job
- [x] **2.9** `GET /bookings/:id`, `GET /me/bookings`; rate limit `POST /bookings`. Đơn của người khác → `404 BOOKING_NOT_FOUND`; trường `expired` (PENDING quá `holdUntil`); `429 TOO_MANY_ATTEMPTS` theo `BOOKING_RATE_LIMIT_MAX`/`BOOKING_RATE_LIMIT_WINDOW_SECONDS` (10 / 60 giây), đếm trước luồng idempotency
- [x] **2.10** Test hết hạn bằng `ClockService`: job chạy 2 lần, cron và job chạy song song, ghế đã bị booking khác lấy (lazy expiry). `booking-expiry.int-spec.ts`: thêm ghế `SOLD`, cron 150 đơn, enqueue lỗi sau commit, worker thật và tắt worker giữa job, đọc đơn, rate limit

### Tuần 9: Realtime & UI chọn ghế
- [x] **2.11** Socket.IO gateway: xác thực JWT khi handshake, join/leave room `showtime:{id}`, Redis adapter; worker phát sự kiện qua redis-emitter; chỉ emit sau khi commit. `modules/realtime`: `RealtimeGateway` (handshake `auth.token` → `UNAUTHORIZED`/`TOKEN_EXPIRED`/`TOKEN_INVALID`; tối đa 5 room mỗi socket; 30 lần join mỗi phút mỗi user), `RealtimeIoAdapter` (`setupRealtime(app)` trong `main.ts`: chỉ WebSocket, origin từ `CORS_ORIGINS`, Redis adapter trên hai kết nối riêng). `SeatEvents` phát sau commit: API qua gateway, worker qua `@socket.io/redis-emitter`; `expireBooking` trả thêm `showtimeId` và `releasedSeatIds` (`UPDATE … RETURNING seat_id`). Lỗi phát chỉ ghi `warn` (adapter/emitter không bắt lỗi `publish()` nên kết nối publisher được bọc lại để không sinh unhandled rejection). `JwtAuthGuard` (global) cho qua message WebSocket vì socket đã xác thực lúc handshake. `realtime.int-spec.ts`: handshake, room, sự kiện sau commit/không có khi 409 hoặc rollback, worker, hai instance API chung Redis, Redis lỗi
- [x] **2.12** FE sơ đồ ghế: màu theo loại và trạng thái ghế, chọn tối đa 6 ghế, ghế đôi, cập nhật realtime, tải lại khi reconnect hoặc khi nhận `409`. `features/seats` (`useSeatMap`, `SeatMap`, quy tắc thuần trong `seat-selection.ts`); tải lại cả sơ đồ sau mỗi lần join room (kể cả lần đầu), khi `409`, và khi sự kiện không khớp; bàn phím một tab stop + `aria-live`. Thẻ suất chiếu trên trang phim dẫn tới `/showtimes/:id/book`
- [x] **2.13** FE: chọn combo, tóm tắt đơn, đếm ngược theo `expiresAt`, màn hình báo hết hạn. Đồng hồ theo giờ máy chủ: `serverOffsetMs` từ header `Date` (API thêm `exposedHeaders: ['Date']` vào CORS), không đọc được → độ lệch 0 + cảnh báo. Playwright 2 trình duyệt (realtime, xung đột, mất kết nối, đồng hồ lệch 10 phút, hết hạn, bàn phím, giới hạn 6 ghế/ghế đôi) chạy tay trên `localhost`; đưa vào CI ở 5.8

### Tuần 10: Kịch bản A, B
- [ ] **2.14** Kịch bản A: 500 request song song giữ 1 ghế (pool đủ lớn, dùng client riêng). Kỳ vọng đúng 1 thành công, không có 5xx
- [ ] **2.15** Kịch bản B: các nhóm ghế giao nhau, chạy nhiều vòng ngẫu nhiên. Kỳ vọng all-or-nothing, không deadlock
- [ ] **2.16** Sửa lỗi phát sinh; vẽ sequence diagram luồng giữ ghế (Mermaid) vào `docs/`

**DoD:** kịch bản A và B pass trong CI.

---

## Giai đoạn 3 — Thanh toán (tuần 11–13)

### Tuần 11: Tạo thanh toán
- [ ] **3.1** `VnpayService`: sắp xếp tham số, ký và xác minh HMAC-SHA512. Unit test với dữ liệu mẫu trong tài liệu VNPay
- [ ] **3.2** `POST /payments/vnpay`: chỉ cho phép khi booking `PENDING` và `now < expiresAt`; tạo `Payment`; đặt `vnp_ExpireDate`
- [ ] **3.3** `GET /payments/vnpay/return`; FE trang kết quả, polling trạng thái booking cho tới khi có kết quả cuối

### Tuần 12: IPN
- [ ] **3.4** `confirmPayment()` theo bảng IPN trong PLAN: thứ tự khóa `Payment → Booking → Seats`, chuyển trạng thái, tạo `Ticket`, ghi outbox
- [ ] **3.5** Nhánh đơn `EXPIRED`: giành lại ghế nếu tất cả còn trống, ngược lại chuyển `NEEDS_REVIEW`
- [ ] **3.6** Cấu hình cloudflared tunnel; thanh toán thật trên sandbox bằng thẻ test; đối chiếu mã phản hồi và hành vi retry IPN với tài liệu, cập nhật PLAN nếu khác

### Tuần 13: querydr, ngoại lệ, kịch bản C
- [ ] **3.7** Tích hợp querydr vào `expireBooking()` (gọi HTTP ngoài transaction, rồi kiểm tra lại điều kiện)
- [ ] **3.8** Admin: danh sách `NEEDS_REVIEW`, nút "Đã xử lý" kèm ghi chú, audit log
- [ ] **3.9** Kịch bản C: IPN trùng, sai chữ ký, sai số tiền, IPN trong grace period, IPN sau khi ghế đã bán cho người khác, IPN chạy song song với expire job

**DoD:** kịch bản C pass; thanh toán sandbox chạy được end-to-end.

---

## Giai đoạn 4 — Giao vé (tuần 14–16)

### Tuần 14: Outbox & thông báo
- [ ] **4.1** Outbox relay trong worker:
  - poll định kỳ, claim theo lô bằng `SKIP LOCKED`
  - backoff qua `nextRetryAt`, ghi `lastError`
  - BullMQ jobId = `{eventId}-{action}` (gạch ngang, không dùng `:`; xem "Đã chốt")
  - ghi outbox `seats.released` trong `expireBooking` (hoãn từ 2.7, cùng transaction với việc trả ghế)
- [ ] **4.2** Module notifications: lưu DB + emit tới room `user:{id}`; API danh sách thông báo / đánh dấu đã đọc
- [ ] **4.3** FE: chuông thông báo, danh sách, toast khi đơn được xác nhận

### Tuần 15: PDF & email
- [ ] **4.4** PDF bằng pdfkit + qrcode, mỗi vé 1 trang. **Phải nhúng font Unicode** (vd. Be Vietnam Pro) vì font chuẩn của PDF không hiển thị được tiếng Việt có dấu
- [ ] **4.5** Upload lên S3 (RustFS) với key cố định; endpoint tải PDF qua presigned URL (chỉ chủ đơn được tải)
- [ ] **4.6** Email: Nodemailer + template Handlebars (`confirmed`, `needs_review`), đính kèm PDF, kiểm tra/ghi `emailSentAt`; xem kết quả qua Mailpit

### Tuần 16: Check-in & kịch bản D
- [ ] **4.7** Token QR ký HMAC; `POST /tickets/check-in` (role STAFF), trả về: hợp lệ / đã dùng / sai suất chiếu / không tồn tại
- [ ] **4.8** FE staff: quét QR bằng camera + nhập mã thủ công; FE user: lịch sử vé, tải PDF
- [ ] **4.9** Kịch bản D: kill worker sau khi DB commit; SMTP lỗi; RustFS không truy cập được (dừng container trong test); khởi động lại và xác minh mọi sự kiện được xử lý, không có vé trùng

**DoD:** kịch bản D pass; luồng chọn ghế → thanh toán → nhận email có PDF chạy trọn vẹn.

---

## Giai đoạn 5 — Voucher & hoàn thiện (tuần 17–19)

### Tuần 17: Voucher
- [ ] **5.1** Migration `Voucher`, `VoucherUsage`; CRUD voucher (admin)
- [ ] **5.2** Giữ lượt voucher trong transaction giữ ghế; chuyển `CONSUMED` khi đơn xác nhận, `RELEASED` khi đơn hết hạn
- [ ] **5.3** Test: 2 đơn cùng tranh lượt cuối cùng, giới hạn lượt theo user, đơn hết hạn trả lại lượt, client sửa payload

### Tuần 18: Admin & FE
- [ ] **5.4** FE: ô nhập voucher, bảng chi tiết giá (từng ghế, combo, giảm giá)
- [ ] **5.5** Admin: danh sách đơn có bộ lọc; dashboard đơn giản (doanh thu theo ngày, tỷ lệ lấp đầy theo suất chiếu)

### Tuần 19: Hoàn thiện FE
- [ ] **5.6** Responsive; trạng thái loading/error/empty; accessibility cơ bản
- [ ] **5.7** Vitest + RTL cho sơ đồ ghế và các form
- [ ] **5.8** Playwright: đăng nhập → chọn ghế → thanh toán (IPN giả lập) → xem vé

**DoD:** voucher hoạt động, test tranh chấp lượt cuối pass; luồng Playwright pass trong CI.

---

## Giai đoạn 6 — Hiệu năng & chất lượng (tuần 20–21)

### Tuần 20: Load test
- [ ] **6.1** Script k6 (`constant-arrival-rate`): suất chiếu hot, traffic hỗn hợp; seed dữ liệu lớn
- [ ] **6.2** Chạy test, ghi đầy đủ cấu hình máy và DB; sau mỗi lần chạy query SQL xác nhận 0 ghế/vé trùng
- [ ] **6.3** Tối ưu: `EXPLAIN ANALYZE` các truy vấn nóng, thêm index, chỉnh pool size; cache danh sách phim (tùy chọn)

### Tuần 21: Chất lượng & bảo mật
- [ ] **6.4** Bổ sung test để đạt coverage: tổng ≥ 80%, module lõi ≥ 90%
- [ ] **6.5** Rà soát bảo mật:
  - IDOR: user chỉ xem/tải được đơn và vé của mình
  - cấu hình cookie, CORS, helmet
  - rate limit
  - `pnpm audit`
- [ ] **6.6** Viết `docs/LOAD_TEST.md` với số liệu đo thực tế

**DoD:** có báo cáo load test; đạt ngưỡng coverage; không còn lỗ hổng mức cao.

---

## Giai đoạn 7 — Deploy & tài liệu (tuần 22–24)

### Tuần 22: Hạ tầng
- [ ] **7.1** Dockerfile multi-stage: API và worker dùng chung một image (khác lệnh chạy); web build ra file tĩnh, phục vụ qua Caddy
- [ ] **7.2** `docker-compose.prod.yml`; chuẩn bị VPS: user không phải root, firewall, Docker, domain + HTTPS qua Caddy, quản lý secrets

### Tuần 23: CD & vận hành
- [ ] **7.3** Workflow CD: build → push GHCR → SSH → chạy migrate (bước riêng) → `up -d` → smoke test
- [ ] **7.4** Backup pg_dump hằng ngày ra nơi lưu trữ ngoài VPS; chạy thử khôi phục và ghi lại kết quả
- [ ] **7.5** Cấu hình URL IPN của VNPay cho môi trường deploy; bảo vệ Bull Board sau guard admin; kiểm thử toàn bộ luồng trên bản deploy

### Tuần 24: Tài liệu & dự phòng
- [ ] **7.6** README: kiến trúc, sequence diagram, hướng dẫn chạy 1 lệnh, kết quả test/load test, giới hạn đã biết (không HA, email at-least-once, `NEEDS_REVIEW` xử lý thủ công)
- [ ] **7.7** Video demo (chọn ghế realtime trên 2 trình duyệt, thanh toán, nhận email, check-in)
- [ ] **7.8** Thời gian còn lại dùng làm dự phòng

**DoD:** bản demo public chạy ổn định; README và video hoàn chỉnh.

---

## Đã chốt

| Hạng mục | Quyết định |
|---|---|
| Thời gian dọn phòng `SHOWTIME_CLEANUP_MINUTES` | **15 phút** (env, số nguyên ≥ 0), chủ dự án xác nhận 28/10/2026. `endsAt = startsAt + thời lượng + dọn phòng`; đổi giá trị chỉ áp dụng cho suất tạo sau đó |
| Khóa `FOR SHARE` trên phim khi tạo suất | Giữ (28/10/2026): phim không thể chuyển `ENDED` hay đổi thời lượng giữa lúc tạo suất. Thứ tự khóa đầy đủ ở ghi chú 1.13 và 2.1 |
| Khóa phòng khi tạo suất | `FOR NO KEY UPDATE` thay cho `FOR SHARE` (28/10/2026, tuần 8): các lần tạo suất cùng phòng chạy lần lượt, không còn deadlock giữa các INSERT chồng giờ (lỗi 500 của test 10 request song song). Lý do ở ghi chú 1.13 |
| Transaction không lấy được connection / quá `timeout` | `503 DATABASE_BUSY` (28/10/2026), không phải 500; pool mặc định giữ 10. Chi tiết trong CONTRIBUTING.md |
| Sơ đồ ghế của suất đã bắt đầu | Vẫn trả về (28/10/2026); luồng giữ ghế tự kiểm tra `startsAt > now` (2.2) |
| `GET /showtimes?movieId=<không tồn tại>` | Trả `200 []`, không 404 (28/10/2026) |
| `CINEMA_TZ` của web | Hằng `DEFAULT_CINEMA_TIME_ZONE` trong `packages/shared`; test bắt khi lệch với env schema (28/10/2026) |
| jobId của BullMQ | `{eventId}-{action}`, ví dụ `expire-booking-{bookingId}` (28/10/2026). BullMQ từ chối id tự đặt chứa `:` ("Custom Id cannot contain :"), nên quy ước `{eventId}:{action}` cũ của PLAN §7 / 4.1 không dùng được |
| Khóa khi hết hạn đơn | `expireBooking` khóa đơn `FOR UPDATE SKIP LOCKED`; câu SELECT của cron không khóa (28/10/2026). Lý do ở ghi chú 2.7 |
| Outbox `seats.released` | Hoãn sang 4.1 (28/10/2026); `expireBooking` hiện chưa ghi outbox |

## Quyết định chờ

| Hạng mục | Ghi chú |
|---|---|
| Tên ngày lễ (`Holiday.name`, nullable) | Chưa thêm cột. Khi cần, gom vào **một** migration chỉ thêm cột nullable (expand-only, như migration `movie_synopsis`), không đổi dữ liệu cũ |
| Hủy giữ ghế `DELETE /bookings/:id` | Giai đoạn 2 chưa có (28/10/2026, tuần 9): đóng trang thì ghế vẫn bị giữ tới hết hạn. Cần quyết định có thêm API hủy đơn `PENDING` của chính user (nhả ghế ngay, phát `seat:released`) hay không. Nếu có, phải chặn khi đã có `Payment` `PENDING` (giai đoạn 3) và giữ thứ tự khóa `Payment → Booking → Seats` |
| Đặt lại cùng suất trong thời gian chờ thanh toán | Sau `expiresAt`, đơn vẫn chặn đơn mới cùng suất (`BOOKING_ALREADY_PENDING`, vì kiểm `hold_until > now`) và ghế cũ vẫn `HELD` thêm `PAYMENT_GRACE_SECONDS` (5 phút). Nút "Chọn lại ghế" của màn hình hết hạn vì vậy có thể bị từ chối tới 5 phút. Chờ quyết định: giữ nguyên (an toàn với IPN trễ), hay đổi kiểm tra sang `expires_at`, hay giải quyết cùng API hủy giữ ghế ở trên |

---

## Đường găng và rủi ro

| Rủi ro | Ảnh hưởng | Cách giảm |
|---|---|---|
| Chưa có tài khoản VNPay sandbox khi tới tuần 11 | Chặn giai đoạn 3 | Đăng ký từ tuần 1; trong lúc chờ, test bằng IPN giả lập có chữ ký |
| Giai đoạn 2 trễ | Kéo trễ mọi giai đoạn sau | Đây là phần ưu tiên số 1; nếu trễ thì cắt bớt giai đoạn 5 (dashboard, voucher) trước |
| Prisma khó dùng cho SQL khóa | Chậm tuần 7 | Dùng `$queryRaw` trong interactive transaction ngay từ đầu, không cố ép qua Prisma API |
| Test concurrency không ổn định trên CI | CI lúc xanh lúc đỏ | Chạy trên Testcontainers riêng, cố định pool size, assert dựa trên trạng thái cuối trong DB |

**Thứ tự cắt giảm nếu thiếu thời gian:** dashboard admin → voucher → Playwright → API instance thứ hai. **Không cắt:** kịch bản A–D, IPN, outbox.
