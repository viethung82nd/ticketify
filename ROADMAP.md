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
  - mỗi user tối đa 1 đơn `PENDING` **còn hạn `expiresAt`** cho mỗi suất chiếu. Làm rõ 29/10/2026, không đổi thiết kế: sau `expiresAt` đơn không còn tạo được thanh toán (PLAN §5), nên không chặn đơn mới; trước đây kiểm theo `holdUntil` khiến người dùng không đặt lại được trong 5 phút chờ thanh toán. Ghế của đơn cũ vẫn `HELD` tới `holdUntil` (đón IPN trễ), nên đơn mới không lấy được các ghế đó (`409 SEAT_UNAVAILABLE`) nhưng lấy được ghế khác. Bị chặn → `409 BOOKING_ALREADY_PENDING` với `details.existingBookingId` và `details.expiresAt`
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
- [x] **2.14** Kịch bản A: 500 request song song giữ 1 ghế (pool đủ lớn, dùng client riêng). Kỳ vọng đúng 1 thành công, không có 5xx. `test/scenarios/scenario-a-single-seat.spec.ts`: 500 user khác nhau, 10 lần liên tiếp, mỗi lần một suất mới; `DATABASE_POOL_MAX` 40; client `node:http` một agent keep-alive, `maxSockets` 500 (Linux) / 200 (Windows); `pg_stat_activity` lấy mẫu mỗi 50 ms. **Kết quả CI** ([run](https://github.com/viethung82nd/ticketify/actions/runs/40743857260), ubuntu-latest, Postgres 16.15, Redis 7.4.12): 10/10 lần đúng 1 × `201`, 499 × `409` (`SEAT_LOCKED` 369–372, `SEAT_UNAVAILABLE` 127–130), 0 `5xx`, 0 lỗi kết nối; mỗi lần 1,29–1,76 s, p50 0,66–1,02 s, p95 1,23–1,69 s, p99 1,28–1,74 s; pool bận tối đa 13/40 (`active` ≤ 2), không lần lấy mẫu nào chạm 40. Trên Windows (Postgres trong Docker Desktop) pool chạm 40/40, phần lớn là `idle in transaction` (`active` ≤ 6): ghi trong README, nghiệm thu lấy trên Linux. Chủ dự án chốt (29/10/2026): kịch bản A bỏ qua trên Windows (`process.platform !== 'win32'`, như suite shutdown); kịch bản B vẫn chạy trên Windows
- [x] **2.15** Kịch bản B: các nhóm ghế giao nhau, chạy nhiều vòng ngẫu nhiên. Kỳ vọng all-or-nothing, không deadlock. `test/scenarios/scenario-b-overlapping-groups.spec.ts`: phòng 10×12, mỗi vòng 40–60 request đồng thời, mỗi request 1–6 ghế từ cùng 24 ghế (A5–A12, B5–B12, C5–C12, 3 cặp ghế đôi chọn đủ cặp), seed cố định theo vòng; kiểm bằng SQL sau mỗi vòng. **Kết quả CI** ([run](https://github.com/viethung82nd/ticketify/actions/runs/40743857260)): 50/50 vòng pass, 2512 request, 401 × `201`, 2111 × `409`, 888 ghế được giữ, 0 vi phạm, 0 `5xx`. `deadlock detected` trong log Postgres: 0 (số liệu chính); `pg_stat_database.deadlocks`: 0 (tham khảo). Thử làm hỏng code tạm thời (không commit): bỏ một ghế khỏi UPDATE → 19 vi phạm all-or-nothing; bỏ kiểm tra ghế đã bị giữ → 48 vi phạm ghế thuộc hai đơn. Workflow `Booking scenarios` chạy cho PR đụng bookings/rooms/showtimes/realtime/queue/shared/scenarios, push lên `main` và chạy tay
- [x] **2.16** Sửa lỗi phát sinh; vẽ sequence diagram luồng giữ ghế (Mermaid) vào `docs/`. Kịch bản A và B không phát hiện lỗi nào trong code giữ ghế (không có commit sửa). `docs/sequence-hold.md`: giữ ghế, hết hạn, hủy, kèm bảng thứ tự khóa; kiểm tra bằng `mmdc` 12.0.0. Kèm `DELETE /bookings/:id` (đã duyệt, xem "Đã chốt"); test `booking-cancel.int-spec.ts` gồm 20 vòng đua với `expireBooking` và `hold()` của người khác

**DoD:** kịch bản A và B pass trong CI. ✅ Đạt 29/10/2026: workflow `Booking scenarios` trên PR #24, [run 40743857260](https://github.com/viethung82nd/ticketify/actions/runs/40743857260) (A 10/10, B 50/50, 0 deadlock trong log Postgres).

---

## Giai đoạn 3 — Thanh toán (tuần 11–13)

### Tuần 11: Tạo thanh toán
- [x] **3.1** `VnpayService`: sắp xếp tham số, ký và xác minh HMAC-SHA512. Unit test với dữ liệu mẫu trong tài liệu VNPay. `apps/api/src/modules/payment/vnpay/`: mã hóa giống `urlencode` của PHP mẫu (khoảng trắng `+`, chỉ giữ `A–Z a–z 0–9 - _ .`; `encodeURIComponent` khác ở khoảng trắng và `! ' ( ) * ~`), hash hex thường, `vnp_SecureHash` nối cuối. Fixture `testing/vnpay-sample.json` (lấy 29/10/2026 từ `pay.html`): **tài liệu không công bố `vnp_HashSecret` của chữ ký mẫu**, nên test kiểm byte-theo-byte phần trước chữ ký của URL mẫu (tạo thanh toán và ReturnUrl); bước HMAC được đối chiếu với chính vòng lặp PHP mẫu của VNPay, chạy bằng PHP 8.4.27 với secret giả (`testing/vnpay-reference.php`, chạy tay). Chữ ký thật chỉ kiểm được ở 3.6 (sandbox)
- [x] **3.2** `POST /payments/vnpay`: chỉ cho phép khi booking `PENDING` và `now < expiresAt`; tạo `Payment`; đặt `vnp_ExpireDate`. Khóa `bookings` `FOR KEY SHARE` (nhiều lần tạo chạy song song; xung đột với `FOR UPDATE` của hủy và hết hạn), `txnRef` 20 ký tự chữ-số, chèn `ON CONFLICT DO NOTHING` rồi sinh lại nếu trùng. `vnp_CreateDate`/`vnp_ExpireDate` theo GMT+7, kiểm ngay trong transaction (cùng một `now`) rằng `vnp_ExpireDate > vnp_CreateDate` tính theo giây, nên không bao giờ để lại `Payment` khi trả `422`. Mã lỗi: `409 BOOKING_NOT_PAYABLE`, `422 BOOKING_EXPIRED`, `409 BOOKING_ALREADY_PAID`, `503 PAYMENT_NOT_CONFIGURED`, `429 TOO_MANY_ATTEMPTS` (env `PAYMENT_RATE_LIMIT_MAX` 10 / `PAYMENT_RATE_LIMIT_WINDOW_SECONDS` 60). Test `payment-create.int-spec.ts`, gồm 20 vòng đua hủy và tạo thanh toán
- [x] **3.3** `GET /payments/vnpay/return`; FE trang kết quả, polling trạng thái booking cho tới khi có kết quả cuối. API chỉ xác minh và đọc, không ghi gì; `@Public()`, rate limit theo IP (`PAYMENT_RETURN_RATE_LIMIT_MAX` 30). Web: nút "Thanh toán qua VNPay" ở `/bookings/:id`, trang `/payment/result` (sau đăng nhập) gửi nguyên query cho API, mã `00` thì đọc lại đơn mỗi 3 giây, tối đa 2 phút. Tới khi có IPN (3.4), đơn vẫn `PENDING`. Test `payment-return.int-spec.ts`

### Tuần 12: IPN
- [x] **3.4** `confirmPayment()` theo bảng IPN trong PLAN: thứ tự khóa `Payment → Booking → Seats`, chuyển trạng thái, tạo `Ticket`, ghi outbox. `GET /payments/vnpay/ipn` (`@Public`, không rate limit): luôn HTTP 200 `{ RspCode, Message }` — `97` sai chữ ký, `01` thiếu `vnp_TxnRef`/không có `Payment`, `04` sai số tiền, `02` `Payment` đã `SUCCESS`, `FAILED` hoặc `REFUND_REQUIRED`, `00` đã ghi kết quả; lỗi không lường trước → HTTP 500 `99`, không ghi gì. `confirmPayment(tx, …)` (`modules/payment/confirm-payment.ts`) chạy trong **một** transaction (`IPN_TX` 5 s / 10 s): `payments` `FOR UPDATE` theo `txn_ref` → (đã trả) `bookings` `FOR UPDATE` → `Payment` `SUCCESS` → ghế của đơn theo `booking_seats` `FOR UPDATE ORDER BY seat_id` → đọc `showtimes` (không khóa). Nhánh A: ghế `SOLD`, đơn `CONFIRMED` + `confirmed_at`, mỗi ghế một `Ticket` `ISSUED` (mã 12 ký tự, `TicketCodes`), outbox `booking.confirmed`; nhánh C: đơn `NEEDS_REVIEW`, outbox `booking.needs_review` (lý do và ghế), không vé; ghế `HELD` của chính đơn được nhả ngay (outbox `seats.released`, xem "Đã chốt"), ghế `SOLD` và ghế của đơn khác không đổi. Mọi số dòng bị đổi đều được kiểm, lệch là ném lỗi để rollback cả IPN; không dùng `skipDuplicates` cho vé vì `ON CONFLICT DO NOTHING` nuốt cả vi phạm partial unique. Đã trả = `vnp_ResponseCode` **và** `vnp_TransactionStatus` đều `00`; thất bại không lưu `vnp_TransactionNo` (có thể là `0`, cột `UNIQUE`). Sau commit phát `seat:sold`. Đối chiếu tài liệu VNPay: PLAN §5 "Làm rõ 29/10/2026". Test: unit `confirm-payment.spec.ts`, `payment-ipn.spec.ts`, `seat-settlement.spec.ts`, `vnpay-ipn.spec.ts`; integration `payment-ipn.int-spec.ts` (mỗi dòng của bảng, 10 IPN trùng đồng thời, lỗi giữa transaction, đua 20 vòng với hủy / hết hạn / giữ ghế của người khác; sau mỗi test và mỗi vòng kiểm toàn DB: một vé sống mỗi ghế, đơn `CONFIRMED` sở hữu đủ ghế `SOLD`, ghế `SOLD` thuộc đơn `CONFIRMED`/`NEEDS_REVIEW`, một outbox mỗi đơn đã chốt). **Kết quả** (29/10/2026, bản cuối: nhả ghế của đơn `NEEDS_REVIEW`, test log, `REFUND_REQUIRED`, suất đã kết thúc; Linux: container `node:24` v24.22.1, Postgres 16.15, Redis 7.4.12; 3 lần liên tiếp): mỗi lần 20 suite pass, 405 test pass (suite shutdown bỏ qua như mặc định); unit 603 test pass; mỗi cuộc đua 3 lần × 20 vòng = 60 vòng, 0 `5xx`, 0 deadlock. Đua với hủy: 36 vòng IPN thành công, đơn luôn `CONFIRMED`, hủy luôn bị từ chối (27 vòng `409 BOOKING_HAS_PAYMENT_IN_PROGRESS`, 9 vòng `409 BOOKING_NOT_CANCELLABLE`); 24 vòng IPN thất bại (6 vòng hủy thành công `204`, 18 vòng hủy bị từ chối `409 BOOKING_HAS_PAYMENT_IN_PROGRESS`), không vòng nào có vé. Đua với `expireBooking`: đơn luôn `CONFIRMED`; 30 vòng quá hạn (26 vòng hết hạn chạy trước rồi IPN giành lại ghế, 4 vòng hết hạn `skipped`); 30 vòng còn hạn (20 vòng `early`, 8 vòng `skipped`, 2 vòng `noop`). Đua với giữ ghế của người khác: 24 vòng có ghế đã bán cho đơn khác, đơn luôn `NEEDS_REVIEW`, ghế và vé của đơn kia không đổi; 21 vòng đơn đã hết hạn (2 vòng `CONFIRMED`, 19 vòng `NEEDS_REVIEW`); 15 vòng đơn `PENDING` quá hạn (9 vòng `CONFIRMED`, 6 vòng `NEEDS_REVIEW`). Sau mỗi vòng không đơn `NEEDS_REVIEW` nào còn ghế `HELD` của chính nó
- [x] **3.5** Nhánh đơn `EXPIRED`: giành lại ghế nếu tất cả còn trống, ngược lại chuyển `NEEDS_REVIEW`. `reclaimSeatsForExpiredBooking(tx, bookingId, now)` (`modules/payment/reclaim-seats.ts`): khóa ghế của đơn theo `booking_seats` `FOR UPDATE ORDER BY seat_id`, rồi đọc suất; ghế giành lại được khi `AVAILABLE`, `HELD` của chính đơn, hoặc `HELD` của đơn khác đã quá `held_until` (hết hạn lười, PLAN §4 nguyên tắc 3). Tất cả hoặc không: một ghế `SOLD` hay bị đơn khác giữ còn hạn, hoặc suất `CANCELLED` → giành lại không đổi ghế nào, IPN chuyển đơn sang `NEEDS_REVIEW` và nhả ghế `HELD` của chính đơn nếu còn (như nhánh C; đơn đã hết hạn thường không còn ghế nào). Giành được → `UPDATE` có điều kiện về `HELD` cho đơn rồi bán như nhánh A (outbox `reclaimed: true`)
- [ ] **3.6** *(Hoãn theo chủ dự án, 05/11/2026: thanh toán thật trên sandbox chưa làm, chờ URL tunnel cố định và bộ kịch bản SIT. Phần đối chiếu tài liệu đã xong.)* Cấu hình cloudflared tunnel; thanh toán thật trên sandbox bằng thẻ test; đối chiếu mã phản hồi và hành vi retry IPN với tài liệu, cập nhật PLAN nếu khác. **Một phần (29/10/2026)**: đã đối chiếu tài liệu `pay.html` (PLAN §5 "Làm rõ 29/10/2026": mã khớp; thêm `99` + HTTP 500, chính sách retry 10 lần × 5 phút, điều kiện `vnp_TransactionStatus`); tunnel nhanh cloudflared 2026.10.5 tới API chạy được, IPN qua HTTPS trả `97` cho request không chữ ký, log request đã che `vnp_SecureHash` (kiểm qua tunnel). **Dừng trước khi thanh toán thật**: tunnel nhanh (`trycloudflare.com`) mang tên ngẫu nhiên mới mỗi lần chạy và máy này không có named tunnel, nên địa chỉ không thể khớp URL IPN đã gửi VNPay; theo brief, chờ chủ dự án gửi lại URL IPN (hoặc chọn URL cố định: named tunnel / domain tĩnh ngrok). Còn lại: thanh toán thẻ test NCB trên sandbox và ghi IPN đến (giờ nhận, `RspCode` trả, trạng thái đơn); kiểm retry khi IPN trả 500 có chủ đích (cờ dev, không commit) so với "10 lần, cách 5 phút"; hủy trên trang VNPay (đơn `PENDING`, `Payment` `FAILED`, ghế giữ tới `holdUntil`), kèm giá trị `vnp_TransactionNo` của giao dịch bị hủy. Chi tiết: [docs/vnpay-sandbox-check.md](docs/vnpay-sandbox-check.md). **Đang chờ chủ dự án** (cập nhật 29/10/2026): (1) một địa chỉ tunnel cố định (named tunnel cloudflared hoặc domain tĩnh ngrok) và gửi URL IPN đó cho VNPay; (2) bộ kịch bản IPN chính thức trên trang SIT của VNPay (`https://sandbox.vnpayment.vn/vnpaygw-sit-testing/user/login`): trang có, bắt đăng nhập bằng email và mật khẩu merchant; Claude không đăng nhập, chủ dự án tự đăng nhập và chạy các kịch bản. Không chạy thanh toán thật và không mở tunnel mới cho tới khi có hai việc trên. **Thử thêm 29/10/2026 (tối)**: để không phải chờ URL IPN, Claude định thanh toán bằng thẻ test NCB rồi gửi lại nguyên bộ tham số VNPay đã ký (trang return nhận đúng bộ tham số của IPN) vào IPN local; đã dò được các trang sandbox (chọn NCB, form thẻ) nhưng bước nhập thẻ bị chính sách quyền của phiên chặn ("giao dịch thực tế"), nên không có kết quả thanh toán thật. Script để chủ dự án tự chạy nằm ngoài repo, ở `C:/NestJsProject/ticketify-week12/`; chi tiết ở [docs/vnpay-sandbox-check.md](docs/vnpay-sandbox-check.md)

### Tuần 13: querydr, ngoại lệ, kịch bản C
- [x] **3.7** Tích hợp querydr vào `expireBooking()` (gọi HTTP ngoài transaction, rồi kiểm tra lại điều kiện). `BookingExpiryService.expire()` đọc các `Payment` `PENDING` của đơn **không khóa**, gọi querydr **ngoài** transaction, rồi mở transaction và `expireBooking` kiểm tra lại toàn bộ dưới khóa. Tài liệu đọc 06/11/2026 (`apis/docs/truy-van-hoan-tien/querydr&refund.html`): `POST https://sandbox.vnpayment.vn/merchant_webapi/api/transaction`, JSON; **chuỗi ký khác IPN** — nối `|` theo thứ tự cố định, không sort, không urlencode, nên không dùng được `buildSignedQuery` (`vnpay-querydr.ts` riêng). `vnp_TransactionDate` = `vnp_CreateDate` của yêu cầu thanh toán; `vnp_IpAddr` = `0.0.0.0` (worker không có request); `vnp_RequestId` 32 hex. **Đã trả** = `vnp_ResponseCode` `00` **và** `vnp_TransactionStatus` `00` → ghi bằng chính `confirmPayment()`, đi đúng nhánh A/B/C (PLAN §5), `raw_payload` là nguyên phản hồi querydr, đơn **không** hết hạn. **Không trả** (`91`, status `02`/`09`) và **không xác định** (lỗi mạng, timeout, HTTP lỗi, body không JSON, chữ ký phản hồi sai, `vnp_TxnRef` khác, status `01`/`04`/`05`/`06`/`07`, code `02`/`03`/`94`/`97`/`99`) → hết hạn như trước 3.7 + log `warn`; `VnpayQuerydrClient` không bao giờ ném lỗi. **Thứ tự khóa đổi**: `expireBooking` khóa `payments` `FOR UPDATE` **trước** `bookings` `FOR UPDATE SKIP LOCKED` rồi ghế (đúng PLAN §4 `Payment → Booking → Seats`, cùng thứ tự với IPN, không có vòng chờ). Hết hạn nay cũng chuyển mọi `Payment` `PENDING` của đơn sang `EXPIRED` (PLAN §4 bước 4; `EXPIRED` không phải trạng thái cuối, IPN muộn vẫn ghi được). Env mới `VNPAY_API_URL`, `VNPAY_QUERYDR_TIMEOUT_MS` (5 s); thiếu credentials → không gọi HTTP, log `warn`. Nhiều lần `PENDING` → hỏi 5 lần mới nhất (`QUERYDR_MAX_ATTEMPTS`), dừng ở lần đầu được báo đã trả. **Kết quả** (06/11/2026, Windows, Postgres 16.15 + Redis 7.4.12 trong Docker Desktop): unit 652 test pass (46 suite; `vnpay-querydr.spec.ts` 31, `vnpay-querydr.client.spec.ts` 10, `expire-booking.spec.ts` 17); integration `payment-querydr.int-spec.ts` 21 test pass (querydr giả qua `fetch`, chữ ký thật, assert trạng thái cuối trong DB); toàn bộ integration 21 suite / 426 test pass, 1 suite skip (`worker-shutdown`, cần `RUN_SIGNAL_TESTS=1`)
- [x] **3.8** Admin: danh sách `NEEDS_REVIEW`, nút "Đã xử lý" kèm ghi chú, audit log. **API**: `GET /admin/bookings/needs-review` (phân trang, `filter=open|resolved|all`, `open` mặc định và cũ nhất trước — hàng đợi, khách chờ lâu nhất lên đầu; `pageSize` tối đa 100) và `POST /admin/bookings/:id/resolve-review` (`note` bắt buộc 1–1000 ký tự, trả `200`), cả hai `@Roles(Role.ADMIN)`. Mã lỗi: `404 BOOKING_NOT_FOUND`, `409 BOOKING_NOT_IN_REVIEW`, `409 REVIEW_ALREADY_RESOLVED` (`details.resolvedAt`). Danh sách trả đủ thứ cần để hoàn tay: khách (tên, email, điện thoại), suất + phòng + phim, ghế (từ `booking_seats`, giữ cả sau khi nhả ghế), `vnp_transaction_no`, `txn_ref`, và `reason` lấy từ outbox `booking.needs_review`. **Migration expand-only** `20261106093000_needs_review_audit`: bảng mới `audit_logs` (append-only: `actor_id`, `action`, `entity_type`, `entity_id`, `note`, `before`, `after`, `created_at`, 2 index) + 2 cột **nullable** `bookings.review_resolved_at` / `review_resolved_by`. Không đọc hay đổi dữ liệu cũ; kiểm trên DB sạch: `prisma migrate deploy` áp đủ 5 migration, `prisma migrate diff --from-config-datasource --to-schema` trả "empty migration" (không drift), và cả 7 constraint raw SQL của 0.8 vẫn còn. "Đã xử lý" **không hoàn tiền** và **không đổi `status`** (đơn vẫn `NEEDS_REVIEW`); chống đua bằng một `UPDATE ... WHERE status = 'NEEDS_REVIEW' AND review_resolved_at IS NULL` có điều kiện + audit row trong cùng transaction. **FE**: trang `/admin/review` (tab trong `AdminShell`, dùng `Pagination`, `AlertDialog`, `Textarea`, `Badge` có sẵn — không thêm dependency). **Ba truy vấn kiểm tra**: [docs/needs-review-queries.sql](docs/needs-review-queries.sql); test đọc chính file đó, tách theo `-- name:` và chạy từng câu trên dữ liệu thật nên SQL trong tài liệu không thể lệch khỏi thứ chạy được. **Kết quả** (06/11/2026, Windows, Postgres 16.15 trong Docker Desktop, `admin-review.int-spec.ts` 25 test pass): `refund-queue` trả 15 dòng, tất cả `booking_status = NEEDS_REVIEW` (ví dụ `txn_ref VDlx9EhzsTS30bMQDNzo`, `vnp_transaction_no 16440030`, `amount 90000`, `review_resolved_at null`; các đơn đã bấm "Đã xử lý" vẫn nằm trong truy vấn nhưng có `review_resolved_at`/`review_resolved_by`); `double-success` trả **0 dòng** và `INSERT` một `Payment` `SUCCESS` thứ hai bị `payments_booking_id_success_key` chặn; `refund-required` trả 1 dòng (`txn_ref 0cAmJv3rZqdsaSJDcHZA`, `vnp_transaction_no 16440034`, `booking_status CONFIRMED` — nên đơn trả hai lần **không** xuất hiện ở `refund-queue`, đúng lý do cần truy vấn thứ ba). Hoàn tiền vẫn làm tay, ghi rõ trong README và trong hộp thoại xác nhận của trang admin. Truy vấn nguyên văn:
  - `Payment` `SUCCESS` của đơn không ở `CONFIRMED` (hàng chờ hoàn tiền / xử lý tay; mọi đơn `NEEDS_REVIEW` đều nằm ở đây):
    ```sql
    SELECT p.id AS payment_id, p.txn_ref, p.vnp_transaction_no, p.amount, p.processed_at,
           b.id AS booking_id, b.code, b.status AS booking_status, b.user_id
    FROM payments p JOIN bookings b ON b.id = p.booking_id
    WHERE p.status = 'SUCCESS' AND b.status <> 'CONFIRMED'
    ORDER BY p.processed_at;
    ```
  - Đơn có nhiều hơn một `Payment` `SUCCESS` (partial unique `payments_booking_id_success_key` không cho phép, nên kết quả phải rỗng; khác rỗng là lỗi dữ liệu):
    ```sql
    SELECT booking_id, count(*) AS success_count, array_agg(id) AS payment_ids
    FROM payments WHERE status = 'SUCCESS'
    GROUP BY booking_id HAVING count(*) > 1;
    ```
  - `Payment` `REFUND_REQUIRED` (một đơn được trả hai lần; tiền của lần sau phải hoàn):
    ```sql
    SELECT p.id AS payment_id, p.txn_ref, p.vnp_transaction_no, p.amount, p.processed_at,
           b.id AS booking_id, b.code, b.user_id
    FROM payments p JOIN bookings b ON b.id = p.booking_id
    WHERE p.status = 'REFUND_REQUIRED'
    ORDER BY p.processed_at;
    ```
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
- [ ] **6.2** Chạy test, ghi đầy đủ cấu hình máy và DB; sau mỗi lần chạy query SQL xác nhận 0 ghế/vé trùng. Số liệu load test phải ghi rõ `DATABASE_POOL_MAX` đang dùng; không lấy số liệu với pool 40 (chỉ dùng cho kịch bản A, 2.14) làm kết quả production, mặc định production là 10
- [ ] **6.3** Tối ưu: `EXPLAIN ANALYZE` các truy vấn nóng, thêm index, chỉnh pool size; cache danh sách phim (tùy chọn)

### Tuần 21: Chất lượng & bảo mật
- [ ] **6.4** Bổ sung test để đạt coverage: tổng ≥ 80%, module lõi ≥ 90%
- [ ] **6.5** Rà soát bảo mật:
  - IDOR: user chỉ xem/tải được đơn và vé của mình
  - cấu hình cookie, CORS, helmet
  - rate limit
  - `pnpm audit`
- [ ] **6.6** Viết `docs/LOAD_TEST.md` với số liệu đo thực tế. Số liệu load test phải ghi rõ `DATABASE_POOL_MAX` đang dùng; không lấy số liệu với pool 40 (chỉ dùng cho kịch bản A, 2.14) làm kết quả production, mặc định production là 10

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
| Khóa khi hết hạn đơn | `expireBooking` khóa đơn `FOR UPDATE SKIP LOCKED`; câu SELECT của cron không khóa (28/10/2026). Lý do ở ghi chú 2.7. **Từ 3.7** (06/11/2026): trước đó khóa các `Payment` `PENDING` của đơn `FOR UPDATE` (không `SKIP LOCKED`), vì bước 4 đổi chúng sang `EXPIRED` và PLAN §4 cố định thứ tự `Payment → Booking → Seats`. Khóa `payments` luôn được lấy, kể cả khi sau đó đơn hóa ra không cần hết hạn: thứ tự khóa không được phụ thuộc vào dữ liệu đọc ra. Không có vòng chờ — IPN cũng khóa `Payment` trước; tạo thanh toán khóa `bookings` `FOR KEY SHARE` rồi chỉ `INSERT` vào `payments` (không khóa dòng cũ) nên `expireBooking` gặp nó sẽ trả `skipped` ngay; hủy khóa `bookings` rồi chỉ **đọc** `payments` (MVCC, không chờ). Chờ khóa `payments` bị chặn bởi `WORKER_LOCK_TIMEOUT_MS` 3 s như trước (quá hạn → `busy`, lần quét sau) |
| Outbox `seats.released` | Hoãn sang 4.1 (28/10/2026); `expireBooking` hiện chưa ghi outbox |
| Đặt lại cùng suất trong thời gian chờ thanh toán | Kiểm "một đơn `PENDING` mỗi user mỗi suất" theo `expiresAt`, không theo `holdUntil` (chủ dự án chốt 29/10/2026). Hết `expiresAt` là đặt lại được ngay (ghế khác); ghế của đơn cũ vẫn giữ tới `holdUntil`. Chi tiết ở 2.2 |
| Hủy giữ ghế `DELETE /bookings/:id` | Có (chủ dự án duyệt 29/10/2026, tuần 10). Chỉ chủ đơn; `PENDING` → `EXPIRED`, nhả ghế, phát `seat:released` sau commit, `204`; `EXPIRED` → `204`, không đổi gì; `CONFIRMED`/`NEEDS_REVIEW` → `409 BOOKING_NOT_CANCELLABLE`; không tồn tại hoặc của người khác → `404 BOOKING_NOT_FOUND`. Không đổi schema. Khóa `bookings` `FOR UPDATE` rồi ghế của đơn `ORDER BY seat_id`, như `expireBooking` |
| Hủy khi đơn đã có `Payment` | Chủ dự án chốt 29/10/2026: đơn `PENDING` có `Payment` `PENDING` → `409 BOOKING_HAS_PAYMENT_IN_PROGRESS`; có `Payment` `SUCCESS` → `409 BOOKING_NOT_CANCELLABLE`; `FAILED`/`EXPIRED` không chặn; không đổi gì khi bị từ chối. `cancel()` đọc `SELECT status FROM payments WHERE booking_id = $1` trong cùng transaction, sau khi khóa `bookings` và trước khi khóa ghế, chưa khóa `Payment` vì chưa luồng nào khóa nó. Khi IPN (3.4) khóa `Payment → Booking → Seats`, `cancel()` cần khóa `Payment` thì phải khóa theo đúng thứ tự đó. Từ tuần 12 IPN khóa `Payment` rồi `Booking`; `cancel()` vẫn chỉ đọc `payments` (không khóa) sau khi khóa `Booking`, nên không chờ khóa của IPN và không có vòng chờ: hủy giữ dòng đơn thì IPN chờ, và hủy thấy `Payment` còn `PENDING` (→ `409`); IPN đã commit thì hủy thấy `SUCCESS` (→ `409`). Kiểm bằng 20 vòng đua trong `payment-ipn.int-spec.ts` |
| Ghế của đơn `NEEDS_REVIEW` | Chủ dự án chốt 29/10/2026 (tuần 12): khi IPN chuyển đơn sang `NEEDS_REVIEW` (nhánh C, hoặc nhánh B không giành lại đủ ghế), các ghế `HELD` có `booking_id` của chính đơn được nhả ngay trong cùng transaction (`AVAILABLE`, `booking_id`/`held_until` = `NULL`), ghi outbox `seats.released` một lần (chỉ khi có ghế được nhả) và phát `seat:released` sau commit. Ghế `SOLD` và ghế của đơn khác không đổi. Thứ tự khóa không đổi. Làm rõ PLAN §5 bước 4, không đổi thiết kế |
| Log của trang return và IPN | Chủ dự án chốt 29/10/2026: log không bao giờ chứa chữ ký hay secret. Log request (pino-http) bỏ hẳn `vnp_SecureHash`, cả tên lẫn giá trị, khỏi `url` và `query` (`src/config/log-redaction.ts`); test `payment-logs.int-spec.ts` chụp log thật với chữ ký thật và giả |
| Suất đã bắt đầu khi IPN thành công | Chốt 29/10/2026 theo ủy quyền của chủ dự án ("giải quyết theo cách tốt nhất"): suất đã bắt đầu nhưng chưa kết thúc → vẫn xác nhận (nhánh A/B, phát hành vé) kèm log `warn`, vì khách vào muộn vẫn dùng được vé; suất đã kết thúc (`endsAt <= now`) → `NEEDS_REVIEW` lý do `SHOWTIME_ENDED`, nhả ghế, hoàn tiền tay; suất `CANCELLED` → `NEEDS_REVIEW` như trước |
| Một đơn được trả hai lần | Chốt 29/10/2026 theo ủy quyền của chủ dự án; **thay đổi schema** (migration `payment_refund_required` chỉ thêm giá trị enum). Lần trả sau thành `Payment.REFUND_REQUIRED` trong transaction IPN (lưu `vnp_TransactionNo`, mã ngân hàng, `raw_payload`), ghi outbox `payment.refund_required`, trả `00`; IPN lặp lại → `02`. Đơn, ghế và vé không đổi; partial unique vẫn chỉ cho một `SUCCESS` mỗi đơn. Hoàn tiền làm tay (3.8). Không chặn từ đầu bằng "một `Payment` `PENDING` mỗi đơn": URL VNPay cũ vẫn trả được tới `vnp_ExpireDate`, nên chặn tạo mới không ngăn được trả hai lần |
| Lưu "đã xử lý" của đơn `NEEDS_REVIEW` (3.8) | Chốt 06/11/2026, chờ chủ dự án duyệt. Bảng mới `audit_logs` (generic: `actor_id`, `action`, `entity_type`, `entity_id`, `note`, `before`, `after`) + 2 cột nullable `bookings.review_resolved_at` / `review_resolved_by`, migration expand-only `needs_review_audit`. **Không thêm giá trị mới vào `BookingStatus`**: đơn vẫn `NEEDS_REVIEW` sau khi bấm "Đã xử lý", vì thêm giá trị enum là việc nằm trong "Quyết định chờ" (xem dòng "Phân biệt người dùng hủy với hết hạn"). Hệ quả: `audit_logs.before.status` và `after.status` đều là `NEEDS_REVIEW`, chỉ cờ thay đổi — đã ghi rõ trong code. Bảng là append-only, 2 cột là trạng thái hiện tại. **Chỉ cho đánh dấu một lần**: lần hai trả `409 REVIEW_ALREADY_RESOLVED`, không ghi đè ghi chú đầu (ghi chú đó là bản tường trình việc đã làm). Nếu chủ dự án muốn ghi thêm nhiều lần cho một đơn thì bỏ điều kiện `review_resolved_at IS NULL` và lấy bản ghi mới nhất; bảng audit đã sẵn cho việc đó |
| Hai chỗ mơ hồ trong tài liệu querydr (3.7) | Chốt 06/11/2026, chờ chủ dự án duyệt; đọc theo cách an toàn. (1) Chuỗi ký **phản hồi** trong tài liệu viết `+ "|" vnp_BankCode`, thiếu dấu `+` trước `vnp_BankCode` → đọc là cùng dấu phân cách `\|` như mọi field khác (cách đọc duy nhất nhất quán). (2) Tài liệu không nói dùng gì khi `vnp_PayDate`, `vnp_PromotionCode`, `vnp_PromotionAmount` vắng → dùng chuỗi rỗng (đúng với phép nối). Nếu một trong hai sai thì phản hồi chỉ **không xác minh được** → verdict `unknown` → hết hạn như trước 3.7; không bao giờ xác nhận sai một đơn. Kiểm lại khi làm 3.6 trên sandbox thật |
| URL querydr và `vnp_IpAddr` (3.7) | Chốt 06/11/2026, chờ chủ dự án duyệt. Env `VNPAY_API_URL` mặc định URL sandbox trong tài liệu; **tài liệu không công bố URL production**, chủ dự án phải điền khi lên prod. `vnp_IpAddr` = `0.0.0.0`: tài liệu đòi "IP của server gọi API", nhưng worker không có request để lấy IP và không biết địa chỉ ra ngoài của chính nó; `0.0.0.0` đúng 7 ký tự tối thiểu của field và trùng cách `vnpayIpAddr` xử lý request không còn socket. Kiểm lại ở 3.6 (VNPay có thể từ chối) |
| Thanh toán thật trên sandbox (3.6) | Hoãn theo chủ dự án (05/11/2026). Chưa thanh toán thẻ thật hay đăng ký URL IPN với VNPay; các mục 3.7–3.9 vẫn kiểm bằng IPN giả lập có chữ ký. Giai đoạn 3 chưa đạt DoD "thanh toán sandbox chạy được end-to-end" cho đến khi làm lại 3.6 |

## Quyết định chờ

| Hạng mục | Ghi chú |
|---|---|
| Tên ngày lễ (`Holiday.name`, nullable) | Chưa thêm cột. Khi cần, gom vào **một** migration chỉ thêm cột nullable (expand-only, như migration `movie_synopsis`), không đổi dữ liệu cũ |
| Phân biệt "người dùng hủy" với "hết hạn" | `DELETE /bookings/:id` (tuần 10) lưu đơn bị hủy là `EXPIRED`, không đổi schema, nên hiện không phân biệt được đơn người dùng tự hủy với đơn hết giờ. Muốn phân biệt cần thêm giá trị mới vào enum `BookingStatus` (ví dụ `CANCELLED`, migration chỉ thêm giá trị) và cập nhật enum dùng chung. Chờ chủ dự án quyết định |
| Thời gian grace so với cửa sổ retry của VNPay (khoảng 45 phút) | **Giữ `PAYMENT_GRACE` 5 phút**; đánh giá lại sau khi có dữ liệu sandbox và số đơn `NEEDS_REVIEW` thực tế. VNPay gọi lại IPN tối đa 10 lần, cách nhau 5 phút (khi nhận `01`, `04`, `97`, `99` hoặc quá thời gian), nên một IPN bị lỗi tạm thời có thể đến sau `holdUntil` tới khoảng 45 phút; khi đó đơn thường đã `EXPIRED`: giành lại ghế nếu còn trống, ngược lại `NEEDS_REVIEW` (hoàn tiền tay). Grace dài hơn giảm `NEEDS_REVIEW` nhưng giữ ghế lâu hơn cho đơn có thể không bao giờ trả; querydr (3.7) thu hẹp khoảng này |

---

## Đường găng và rủi ro

| Rủi ro | Ảnh hưởng | Cách giảm |
|---|---|---|
| Chưa có tài khoản VNPay sandbox khi tới tuần 11 | Chặn giai đoạn 3 | Đăng ký từ tuần 1; trong lúc chờ, test bằng IPN giả lập có chữ ký |
| Giai đoạn 2 trễ | Kéo trễ mọi giai đoạn sau | Đây là phần ưu tiên số 1; nếu trễ thì cắt bớt giai đoạn 5 (dashboard, voucher) trước |
| Prisma khó dùng cho SQL khóa | Chậm tuần 7 | Dùng `$queryRaw` trong interactive transaction ngay từ đầu, không cố ép qua Prisma API |
| Test concurrency không ổn định trên CI | CI lúc xanh lúc đỏ | Chạy trên Testcontainers riêng, cố định pool size, assert dựa trên trạng thái cuối trong DB |

**Thứ tự cắt giảm nếu thiếu thời gian:** dashboard admin → voucher → Playwright → API instance thứ hai. **Không cắt:** kịch bản A–D, IPN, outbox.
