# Ticketify — Kế hoạch dự án (v2)

Web đặt vé xem phim thời gian thực cho **một rạp**. Project portfolio, thời gian 5–6 tháng (~24 tuần).

> **Thay đổi so với v1**
> - Bỏ Redis khỏi luồng giữ ghế: **PostgreSQL là nơi duy nhất quyết định ai giữ ghế**. Redis chỉ còn dùng cho BullMQ, Socket.IO adapter và rate limit.
> - Tách riêng 3 loại trạng thái: thanh toán (`Payment`), đơn (`Booking`), vé (`Ticket`). Thêm bảng `Ticket` cho từng ghế.
> - Định nghĩa chặt các luồng hết hạn, IPN đến muộn và thứ tự khóa.
> - Voucher dời sang giai đoạn 5, sau khi luồng thanh toán đã ổn định.
> - Tiêu chí test viết lại theo 4 kịch bản A–D. Hạ tầng bắt đầu với 1 API + 1 worker.
> - **(10/2026)** Object storage: MinIO → **RustFS** (S3-compatible) vì MinIO ngừng phát hành Docker image; code dùng S3 API chuẩn. Node 24 LTS thay Node 22.

## 1. Tóm tắt yêu cầu

| Hạng mục | Quyết định |
|---|---|
| Frontend | React (Vite + TypeScript), gồm trang user, admin (CRUD), staff (soát vé) |
| Backend | NestJS, modular monolith + 1 worker process riêng cho queue |
| DB | PostgreSQL + Prisma (raw SQL cho các truy vấn khóa và constraint đặc biệt) |
| Redis | BullMQ, Socket.IO adapter, rate limit. **Không** dùng để giữ ghế |
| Auth | Email/password + JWT (access + refresh), role: `USER`, `ADMIN`, `STAFF`. Bắt buộc đăng nhập để đặt vé |
| Đặt vé | Tối đa 6 ghế / đơn, giữ ghế `HOLD_TTL` (mặc định 10 phút, cấu hình được), chặn tuyệt đối bán trùng ghế |
| Hủy / hoàn tiền | Không tự động. Ca `NEEDS_REVIEW` được xử lý thủ công (xem mục 5) |
| Giá vé | Loại ghế (Thường/VIP/Đôi) × loại ngày (Ngày thường/Cuối tuần/Lễ), tính theo múi giờ rạp `Asia/Ho_Chi_Minh` |
| Bán thêm | Combo (giai đoạn 1); voucher (giai đoạn 5) |
| Thanh toán | VNPay (sandbox) |
| Sau thanh toán | PDF vé (QR từng ghế) lưu object storage S3 (RustFS), email (Nodemailer + SMTP qua BullMQ), thông báo realtime qua WebSocket |
| Testing | Unit, integration, e2e, kịch bản A–D, load test k6. Coverage tổng ≥ 80%, module lõi ≥ 90% |
| DevOps | Docker Compose, GitHub Actions CI/CD, deploy lên VPS (môi trường demo) |

## 2. Kiến trúc tổng thể

```
                    ┌──────────────┐
  Browser (React) ──┤    Caddy     │── HTTPS, static web, reverse proxy
   HTTP + Socket.IO └──────┬───────┘
                    ┌──────▼───────┐
                    │  API (NestJS)│  REST + Socket.IO gateway
                    └──┬────────┬──┘
                       │        │
               ┌───────▼──┐ ┌───▼──────┐     ┌────────────────┐
               │ Postgres │ │  Redis   │◄───►│ Worker (NestJS)│
               │ (nguồn   │ │ BullMQ / │     │ outbox relay,  │
               │ sự thật) │ │ WS / rate│     │ expire, PDF,   │
               └──────────┘ └──────────┘     │ email, notify  │
                                             └───┬────────┬───┘
                                           ┌─────▼──┐  ┌──▼───┐
                                           │ RustFS │  │ SMTP │
                                           └────────┘  └──────┘
       VNPay ── redirect user / IPN server-to-server ──► API
```

- **Một codebase NestJS, hai entrypoint**: `main.ts` (API) và `main.worker.ts` (worker).
- Socket.IO dùng Redis adapter. Worker phát sự kiện qua `@socket.io/redis-emitter`. Nhờ vậy về sau có thể thêm API instance thứ hai mà không phải sửa code.

### Cấu trúc monorepo (pnpm workspaces)

```
ticketify/
├── apps/
│   ├── api/                 # NestJS (API + worker)
│   │   ├── prisma/          # schema.prisma, migrations (kèm raw SQL), seed
│   │   ├── src/
│   │   │   ├── main.ts / main.worker.ts
│   │   │   ├── common/      # guards, interceptors, filters, decorators
│   │   │   ├── infra/       # prisma, redis, queue, storage(S3 — RustFS), mail, clock
│   │   │   └── modules/
│   │   │       ├── auth/  users/
│   │   │       ├── movies/  rooms/  showtimes/  pricing/  combos/
│   │   │       ├── booking/        # giữ ghế, hết hạn
│   │   │       ├── payment/        # VNPay: URL, IPN, querydr
│   │   │       ├── tickets/        # phát hành, PDF, QR, check-in
│   │   │       ├── outbox/         # relay sự kiện
│   │   │       ├── notifications/  # lưu DB + emit WS
│   │   │       ├── realtime/       # Socket.IO gateway
│   │   │       ├── vouchers/       # giai đoạn 5
│   │   │       └── health/
│   │   └── test/            # integration, e2e, scenarios A–D
│   └── web/                 # React + Vite
├── packages/shared/         # types / zod schema / enum dùng chung
├── load-tests/              # kịch bản k6 + báo cáo
├── docker/                  # Dockerfile, Caddyfile
├── docker-compose.yml       # dev: postgres, redis, rustfs (S3), mailpit
├── docker-compose.prod.yml
└── .github/workflows/
```

## 3. Thiết kế cơ sở dữ liệu

Mọi thời điểm lưu kiểu `timestamptz` (UTC). Logic nghiệp vụ theo ngày (giá cuối tuần/lễ) tính theo `CINEMA_TZ=Asia/Ho_Chi_Minh`. Tiền là `Int` (VND).

### Mô hình trạng thái

```
ShowtimeSeat : AVAILABLE ──hold──► HELD ──confirm──► SOLD
                   ▲                 │
                   └────release──────┘   (chỉ khi booking_id khớp)

Booking      : PENDING ──► CONFIRMED            (đã trả tiền + đã phát hành vé)
                  │   └──► NEEDS_REVIEW         (đã trả tiền nhưng không giữ được ghế)
                  └──────► EXPIRED

Payment      : PENDING ──► SUCCESS | FAILED | EXPIRED   (mỗi lần thử thanh toán là 1 bản ghi)

Ticket       : ISSUED ──► CHECKED_IN
                  └────► VOID                   (dành cho xử lý thủ công)
```

**`PAID` ≠ vé đã phát hành**: `Payment.SUCCESS` chỉ ghi nhận đã nhận tiền. Vé chỉ tồn tại khi đã có bản ghi `Ticket`, và các bản ghi này được tạo trong cùng transaction chuyển booking sang `CONFIRMED`.

### Bảng

| Bảng | Trường chính | Ràng buộc |
|---|---|---|
| `User` | email, passwordHash (argon2), fullName, phone, role | unique(email) |
| `RefreshToken` | userId, tokenHash, expiresAt, revokedAt, replacedBy | Rotation, phát hiện token bị dùng lại |
| `Movie`, `Genre`, `MovieGenre` | title, slug, duration, posterKey, ageRating, releaseDate, status | unique(slug) |
| `Room` | name, rows, cols | |
| `Seat` | roomId, row, number, type (`STANDARD/VIP/COUPLE`), coupleGroup, isActive | unique(roomId,row,number) |
| `Showtime` | movieId, roomId, startsAt, endsAt, status (`SCHEDULED/CANCELLED`) | **Exclusion constraint** (btree_gist): không có 2 suất chồng giờ trong một phòng, `WHERE status <> 'CANCELLED'` |
| `SeatPrice` | seatType, dayType, price | unique(seatType, dayType) |
| `Holiday` | date | unique(date) |
| `ShowtimeSeat` | showtimeId, seatId, status, bookingId, heldUntil, price | **PK(showtimeId, seatId)**. CHECK: `HELD` ⇒ bookingId và heldUntil không null; `AVAILABLE` ⇒ bookingId null. `price` được chốt khi tạo suất chiếu |
| `Booking` | code, userId, showtimeId, status, subtotal, discount, total, expiresAt, holdUntil, idempotencyKey, requestHash, confirmedAt, emailSentAt | unique(code), unique(userId, idempotencyKey) |
| `BookingSeat` | bookingId, showtimeId, seatId, price | unique(bookingId, seatId). Lưu lịch sử ghế của đơn, kể cả khi ghế đã được nhả |
| `Combo` | name, description, price, imageKey, isActive | Bổ sung 10/2026: bảng gốc cho `BookingCombo.comboId` (CRUD ở 1.16) |
| `BookingCombo` | bookingId, comboId, comboName, unitPrice, quantity | Snapshot tên và giá |
| `Ticket` | bookingId, showtimeId, seatId, code, status, checkedInAt, checkedInBy | **Partial unique (showtimeId, seatId) WHERE status <> 'VOID'**. Đây là lớp chặn cuối cùng chống vé trùng |
| `Payment` | bookingId, txnRef, amount, status, vnpTransactionNo, bankCode, responseCode, rawPayload, processedAt | unique(txnRef), unique(vnpTransactionNo); **partial unique(bookingId) WHERE status='SUCCESS'** |
| `OutboxEvent` | type, aggregateId, payload, status, attempts, nextRetryAt, lockedAt, lockedBy, lastError | Index (status, nextRetryAt) |
| `Notification` | userId, type, title, body, data, readAt | |
| `Voucher`, `VoucherUsage` | *(giai đoạn 5, xem mục 6)* | |

**Idempotency khi đặt vé**: client gửi header `Idempotency-Key`, server lưu kèm `requestHash` (hash của payload đã chuẩn hóa).
- Cùng key, cùng hash → trả lại booking đã tạo.
- Cùng key, khác hash → `422`.

## 4. Giữ ghế và hết hạn (lõi của dự án)

### Nguyên tắc

1. **PostgreSQL là nơi duy nhất quyết định.** Không có trạng thái giữ ghế nào nằm ngoài DB.
2. **Thứ tự khóa cố định** cho mọi luồng: `Payment → Booking → ShowtimeSeat (ORDER BY seat_id)`. Mục đích là tránh deadlock giữa các luồng giữ ghế, IPN và hết hạn.
3. **`heldUntil` trong DB là thời điểm hết hạn chuẩn.** Job và cron chỉ là cơ chế kích hoạt việc dọn dẹp. Luồng giữ ghế tự coi ghế `HELD` có `heldUntil <= now()` là ghế trống (hết hạn lười), không cần chờ job.
4. Mọi thao tác nhả ghế đều có điều kiện `booking_id = <booking của mình>` nên chạy lại bao nhiêu lần cũng cho cùng kết quả (idempotent).

### Hai mốc thời gian

- `Booking.expiresAt = createdAt + HOLD_TTL`: hạn hiển thị cho user (đồng hồ đếm ngược), và là hạn cuối để tạo URL thanh toán.
- `Booking.holdUntil = ShowtimeSeat.heldUntil = expiresAt + PAYMENT_GRACE` (mặc định 5 phút): ghế vẫn được giữ thêm để đón IPN đến trễ. Cách này giảm mạnh khả năng phát sinh `NEEDS_REVIEW`.

### Luồng giữ ghế — `POST /bookings`

```sql
BEGIN;
-- 1. Khóa đúng các ghế yêu cầu theo thứ tự cố định; NOWAIT để fail-fast
SELECT seat_id, status, held_until, booking_id
FROM showtime_seats
WHERE showtime_id = $1 AND seat_id = ANY($2)
ORDER BY seat_id
FOR UPDATE NOWAIT;          -- ghế đang bị transaction khác khóa → lỗi 55P03 → trả 409

-- 2. Ứng dụng kiểm tra: đủ số ghế, đúng suất chiếu, ghế đôi theo cặp,
--    mọi ghế đều AVAILABLE hoặc (HELD AND held_until <= now()). Sai → ROLLBACK, 409.

-- 3. INSERT booking, booking_seats, booking_combos (giá tính ở server)

-- 4. Cập nhật có điều kiện (phòng thủ thêm một lớp)
UPDATE showtime_seats
SET status='HELD', booking_id=$3, held_until=$4
WHERE showtime_id=$1 AND seat_id = ANY($2)
  AND (status='AVAILABLE' OR (status='HELD' AND held_until <= now()));
-- rowCount phải bằng số ghế yêu cầu, nếu không → ROLLBACK
COMMIT;
```

- **Vì sao dùng `NOWAIT`**: khi 500 request cùng tranh một ghế, `FOR UPDATE` thông thường bắt các request xếp hàng chờ khóa. Trong lúc chờ, mỗi request vẫn giữ một connection trong pool, dễ làm cạn pool. Với `NOWAIT`, request thua nhận `409` ngay lập tức.
- Sau khi commit: enqueue job `expire-booking` với delay = `holdUntil − now`, rồi emit `seat:held`.
- Rate limit `POST /bookings` theo user. Mỗi user tối đa 1 đơn `PENDING` cho mỗi suất chiếu.
- Combo: chỉ lấy combo đang `isActive` và lưu snapshot giá. Từ đó giá combo thay đổi sau này không ảnh hưởng đơn đã tạo.

### Luồng hết hạn — `expireBooking(bookingId)` (dùng chung cho job và cron)

```
BEGIN
  SELECT booking FOR UPDATE
  nếu status ≠ PENDING                    → COMMIT, kết thúc (idempotent)
  nếu now < holdUntil                     → COMMIT, hẹn lại job
  nếu có Payment PENDING                  → gọi VNPay querydr (ngoài transaction, xem bên dưới)
       giao dịch thành công               → chạy confirmPayment() như IPN
       còn lại                            → Payment = EXPIRED
  Booking = EXPIRED
  UPDATE showtime_seats SET status='AVAILABLE', booking_id=NULL, held_until=NULL
    WHERE booking_id = $id AND status = 'HELD'
  (giai đoạn 5) VoucherUsage RESERVED → RELEASED
  INSERT outbox(seats.released)
COMMIT
```

- Lời gọi HTTP querydr nằm **ngoài** transaction: trước tiên đọc trạng thái, gọi querydr, rồi mở transaction mới và kiểm tra lại điều kiện.
- **Cron mỗi phút** là lưới an toàn khi job bị mất: `SELECT id FROM bookings WHERE status='PENDING' AND hold_until <= now() ORDER BY hold_until LIMIT 100 FOR UPDATE SKIP LOCKED`, sau đó gọi `expireBooking` cho từng id.

### Realtime

Sự kiện WebSocket (`seat:held/released/sold`) chỉ là **best-effort**. Nguồn sự thật luôn là `GET /showtimes/:id/seats`. Client tải lại sơ đồ ghế khi reconnect hoặc khi nhận `409`.

## 5. Thanh toán VNPay

### Tạo thanh toán — `POST /payments/vnpay`

- Chỉ cho phép khi booking `PENDING` và `now < expiresAt`.
- Tạo `Payment(PENDING)` với `txnRef` duy nhất. `vnp_ExpireDate = expiresAt`. Ký HMAC-SHA512.
- `GET /payments/vnpay/return` chỉ dùng để **hiển thị** kết quả. Không dùng để cập nhật trạng thái.

### IPN — `GET /payments/vnpay/ipn` → `confirmPayment()`

| Bước | Kiểm tra | Phản hồi |
|---|---|---|
| 1 | Chữ ký sai | `97` |
| 2 | Không có `txnRef` | `01` |
| 3 | `vnp_Amount` ≠ `Payment.amount × 100` | `04` |
| 4 | `SELECT payment FOR UPDATE`; payment đã ở trạng thái cuối (`SUCCESS/FAILED`) | `02` (đã xử lý) |
| 5 | `vnp_ResponseCode ≠ 00` → `Payment = FAILED`. Booking vẫn `PENDING`, user được thử lại trong hạn | `00` |
| 6 | Thanh toán thành công → xử lý tiếp như dưới đây | `00` |

Bước 6, trong cùng transaction và theo thứ tự khóa `Payment → Booking → Seats`:

1. `Payment = SUCCESS`, lưu `vnpTransactionNo` và `rawPayload`.
2. Nếu mọi ghế của booking vẫn ở `HELD` **và** `booking_id` trùng booking này (kể cả khi `heldUntil` đã qua, vì chưa ai lấy ghế): chuyển ghế sang `SOLD`, `Booking = CONFIRMED`, tạo `Ticket` cho từng ghế, ghi outbox `booking.confirmed`.
3. Nếu booking đã `EXPIRED` nhưng **tất cả** ghế đều đang trống: giành lại ghế (khóa rồi cập nhật có điều kiện như luồng giữ ghế), sau đó xử lý như bước 2.
4. Ngược lại: `Booking = NEEDS_REVIEW`, **không tạo Ticket**, ghi outbox `booking.needs_review`. Sự kiện này gửi email xin lỗi cho user và thông báo admin.

Lớp chặn cuối: partial unique index trên `Ticket(showtimeId, seatId)`. Nếu có lỗi logic thì transaction sẽ fail thay vì sinh ra hai vé cho cùng một ghế.

### Xử lý `NEEDS_REVIEW` (ngoại lệ vận hành, chưa tự động)

- Trang admin liệt kê các đơn `NEEDS_REVIEW` (thông tin user, số tiền, `vnpTransactionNo`).
- Admin xử lý ngoài hệ thống (hoàn tiền qua cổng VNPay hoặc liên hệ khách), rồi bấm "Đã xử lý" kèm ghi chú. Hệ thống lưu audit log.
- Ghi rõ trong README: hoàn tiền tự động nằm ngoài phạm vi. Cơ chế grace period + querydr được thiết kế để ca này rất hiếm.

### Lưu ý

- Ý nghĩa các mã phản hồi và chính sách VNPay retry IPN cần **xác minh lại với tài liệu sandbox** khi có tài khoản.
- Dev local dùng cloudflared/ngrok tunnel để VNPay gọi được IPN.
- **Việc cần làm sớm**: đăng ký sandbox tại `sandbox.vnpayment.vn` để lấy `TMN_CODE` và `HASH_SECRET`.

## 6. Voucher (giai đoạn 5)

- `VoucherUsage(voucherId, userId, bookingId, status: RESERVED/CONSUMED/RELEASED)`, unique(bookingId).
- **Giữ lượt** trong transaction giữ ghế: `SELECT voucher FOR UPDATE`, đếm số usage `RESERVED + CONSUMED` để kiểm tra `usageLimit` và `perUserLimit`, rồi INSERT `RESERVED`. Không có `usedCount` cập nhật riêng lẻ: số lượt được tính ra từ bảng usage.
- Đơn `CONFIRMED` → usage `CONSUMED`. Đơn `EXPIRED` → usage `RELEASED`. Cả hai cập nhật nằm trong cùng transaction với việc đổi trạng thái booking.
- Server luôn tự tính giảm giá. Client chỉ gửi mã voucher.

## 7. Sau thanh toán: giao vé

```
OutboxEvent ─► Relay (claim theo lô: FOR UPDATE SKIP LOCKED, set lockedAt/lockedBy,
               retry với nextRetryAt + backoff, ghi lastError) ─► BullMQ

booking.confirmed     ─► generate-pdf  : pdfkit + qrcode, 1 trang / vé
                                         → S3 key cố định tickets/{bookingId}.pdf (ghi đè an toàn)
                      ─► send-email    : bỏ qua nếu emailSentAt đã có; gửi xong thì cập nhật emailSentAt
                      ─► notify        : Notification + emit WS user:{id}
booking.needs_review  ─► email xin lỗi user + notify admin
seats.released        ─► emit WS showtime:{id}
```

- **Phát hành vé** (tạo `Ticket`) diễn ra trong transaction thanh toán. Worker chỉ lo **giao vé**, vì vậy worker chạy lại không bao giờ tạo vé trùng.
- Email đảm bảo *at-least-once*: nếu crash đúng lúc giữa SMTP gửi xong và lúc cập nhật `emailSentAt`, user có thể nhận 2 email. Đây là giới hạn được chấp nhận và ghi rõ trong tài liệu.
- Job ID của BullMQ = `{eventId}:{action}` để chống enqueue trùng.
- **Check-in theo từng vé**: QR chứa token ký HMAC của `ticketCode`. Staff quét → `UPDATE tickets SET status='CHECKED_IN' WHERE code=$1 AND status='ISSUED'`. Kết quả cho biết vé hợp lệ, đã dùng, sai suất chiếu hay không tồn tại.

## 8. Realtime (Socket.IO)

| Room | Sự kiện |
|---|---|
| `showtime:{id}` | `seat:held`, `seat:released`, `seat:sold` |
| `user:{id}` | `notification:new`, `booking:confirmed`, `booking:expired` |

Xác thực JWT khi handshake.

## 9. Frontend (React)

- **Stack**: Vite + TypeScript, React Router, TanStack Query, Zustand, socket.io-client, Tailwind + shadcn/ui, react-hook-form + zod.
- **User**: danh sách phim, chi tiết + lịch chiếu, **sơ đồ ghế realtime** (đếm ngược theo `expiresAt`), chọn combo, thanh toán, kết quả, lịch sử vé + tải PDF, chuông thông báo.
- **Admin**: CRUD phim, phòng + sơ đồ ghế, suất chiếu, bảng giá, ngày lễ, combo, (voucher); danh sách đơn; **danh sách `NEEDS_REVIEW`**; Bull Board.
- **Staff**: trang quét QR (`html5-qrcode`) + nhập mã thủ công, check-in từng vé.

## 10. Testing

Tiêu chí chính là **tính đúng đắn**: state machine, tranh chấp, idempotency, phục hồi sau lỗi. Coverage là chỉ số phụ: tổng ≥ 80%, các module `booking`, `payment`, `tickets`, `outbox` ≥ 90%.

| Loại | Công cụ | Nội dung |
|---|---|---|
| Unit | Jest | Tính giá (gồm múi giờ, ngày lễ), chữ ký VNPay, chuyển trạng thái, guard |
| Integration | Jest + Testcontainers (Postgres, Redis) | SQL khóa, constraint, outbox relay, processor |
| E2E API | Supertest + Mailpit | Đăng ký → giữ ghế → IPN giả lập có chữ ký → CONFIRMED → PDF/email |
| Frontend | Vitest + RTL, Playwright | Sơ đồ ghế, form; 1–2 luồng e2e chính |

### Kịch bản bắt buộc (acceptance)

| | Kịch bản | Kỳ vọng |
|---|---|---|
| **A** | 500 request đồng thời giữ cùng 1 ghế | Đúng 1 thành công, còn lại `409`. Không lỗi 5xx, không cạn connection pool |
| **B** | Nhiều request chọn các nhóm ghế giao nhau | Không có ghế nào thuộc 2 booking; không giữ thiếu ghế (all-or-nothing); không deadlock |
| **C** | IPN trùng, sai chữ ký, sai số tiền, đến trong grace period, đến sau khi ghế đã bán cho người khác; IPN chạy song song với expire job | Trạng thái Payment/Booking/Seat/Ticket cuối cùng nhất quán; không bao giờ có 2 Ticket cho 1 ghế; đơn `NEEDS_REVIEW` không có Ticket |
| **D** | Kill worker sau khi DB commit; SMTP lỗi; object storage (RustFS) tạm thời không truy cập được; khởi động lại | Mọi sự kiện cuối cùng đều được xử lý; không phát hành vé trùng; PDF/email được retry |

Thời gian được inject qua `ClockService` để test hết hạn và grace period mà không phải chờ thật.

### Load test (k6)

- Kịch bản: (1) dồn dập vào 1 suất chiếu hot; (2) traffic hỗn hợp (xem phim, xem sơ đồ ghế, giữ ghế).
- Báo cáo bắt buộc ghi: số VU, arrival rate (dùng executor `constant-arrival-rate`), thời gian chạy, p95/p99, throughput, error rate, cấu hình máy chủ và máy phát tải, cấu hình Postgres (pool size, `max_connections`). Sau mỗi lần chạy, query SQL xác nhận 0 ghế/vé trùng.
- Máy phát tải tách khỏi máy chủ. **Chỉ công bố số liệu đã đo thực tế.**
- Chỉ cân nhắc thêm Redis làm lớp lọc trước DB nếu benchmark cho thấy DB là nút thắt. Khi đó phải có thiết kế tường minh cho đồng bộ và phục hồi khi Redis lệch DB.

## 11. DevOps

- **Local**: `docker-compose.yml` gồm postgres, redis, rustfs (S3), mailpit.
- **CI (mọi PR)**: lint → typecheck → unit → integration/e2e (Testcontainers) → build → coverage gate.
- **CD (push `main`)**: build image → push GHCR → SSH vào VPS → chạy `prisma migrate deploy` như **một bước riêng** → `docker compose up -d`.
- **Migration**: theo kiểu expand/contract, nghĩa là mỗi migration phải tương thích ngược với phiên bản app đang chạy.
- **VPS (môi trường demo)**: Caddy, **1 API + 1 worker**, postgres, redis, rustfs (S3). API instance thứ hai chỉ bật khi thử nghiệm phân phối tải.
- **Backup**: pg_dump hằng ngày ra nơi lưu trữ ngoài VPS. Có script khôi phục và **chạy thử khôi phục** ít nhất 1 lần, ghi lại kết quả.
- **Vận hành**: Swagger (`/docs`), log JSON bằng pino, health check (`@nestjs/terminus`). Bull Board đặt sau guard xác thực admin.
- **Bảo mật**: helmet, CORS, validate DTO, argon2, refresh token rotation, rate limit cho login và đặt vé.
- README ghi rõ: đây là môi trường demo trên 1 máy, **không phải high availability**.

## 12. Lộ trình (24 tuần)

Danh sách task chi tiết theo tuần: xem [ROADMAP.md](ROADMAP.md).

| Giai đoạn | Tuần | Nội dung | Kết quả nghiệm thu |
|---|---|---|---|
| **0. Nền tảng** | 1–2 | Monorepo, NestJS + React skeleton, Prisma schema + raw SQL constraint, docker-compose, CI cơ bản, `ClockService` | Chạy local; **đăng ký VNPay sandbox** |
| **1. Auth & danh mục** | 3–6 | Auth + roles; CRUD phim, phòng/ghế, suất chiếu (sinh `ShowtimeSeat` + chốt giá), bảng giá, ngày lễ, combo; FE danh sách/chi tiết phim, admin CRUD | Admin quản lý được dữ liệu; test tính giá theo múi giờ |
| **2. Giữ ghế** ⭐ | 7–10 | Luồng giữ ghế, idempotency, rate limit, hết hạn (job + cron), WebSocket; FE sơ đồ ghế realtime | **Kịch bản A, B pass** |
| **3. Thanh toán** | 11–13 | VNPay URL/return/IPN, querydr, grace period, `NEEDS_REVIEW` + trang admin | **Kịch bản C pass** |
| **4. Giao vé** | 14–16 | Outbox relay, PDF + S3 (RustFS), email, notification, check-in từng vé; FE lịch sử vé, thông báo, trang staff | **Kịch bản D pass** |
| **5. Voucher & hoàn thiện** | 17–19 | Voucher (mục 6), FE polish, Playwright | Test tranh chấp lượt voucher cuối cùng |
| **6. Hiệu năng & chất lượng** | 20–21 | k6 + báo cáo, tối ưu index/query, bổ sung coverage, rà soát bảo mật | Báo cáo load test có số liệu thật |
| **7. Deploy & tài liệu** | 22–24 | CD lên VPS, HTTPS, backup + chạy thử khôi phục, README, sơ đồ kiến trúc + sequence, video demo | Bản demo public; còn ~1 tuần dự phòng |

## 13. Điểm nhấn cho portfolio

- Chống bán trùng chỉ bằng PostgreSQL: khóa hàng có thứ tự + `NOWAIT`, cập nhật có điều kiện, partial unique index cho vé, exclusion constraint cho suất chiếu.
- Xử lý thanh toán đúng nghiệp vụ: IPN idempotent, grace period, querydr, tách trạng thái thanh toán / đơn / vé, ngoại lệ `NEEDS_REVIEW` minh bạch.
- Transactional outbox + worker có khả năng phục hồi, được chứng minh bằng kịch bản test D.
- Báo cáo load test trung thực, mô tả đầy đủ cấu hình và giới hạn.

## 14. Giả định (cần xác nhận)

1. `HOLD_TTL` = 10 phút (lựa chọn ban đầu), có thể đổi sang 5 phút. `PAYMENT_GRACE` = 5 phút.
2. Deploy lên **VPS** bằng Docker Compose.
3. Dùng **pnpm workspaces** và **pdfkit**.
