# Rà soát bảo mật — ROADMAP 6.5 (24/11/2026)

Phạm vi: API NestJS (`apps/api`) và các dependency của monorepo. Rà bằng cách đọc code, chạy test
hiện có và `pnpm audit`; không có kiểm thử xâm nhập từ bên ngoài. Kết quả: **không còn lỗ hổng mức
high/critical** trong `pnpm audit`; đã thêm `helmet` (PLAN mục 11 có, code chưa có). Những việc
còn mở ở cuối trang là **đề xuất**, chưa làm.

## 1. IDOR: user chỉ xem/tải/thao tác được tài nguyên của mình

Quy tắc chung: điều kiện chủ sở hữu nằm **trong câu truy vấn** (`user_id = <user của token>`),
không kiểm sau khi đọc; tài nguyên của người khác trả **404**, không bao giờ 403, nên không lộ việc
id đó có tồn tại. Id luôn là UUID (sai dạng → 400).

| Endpoint | Điều kiện trong truy vấn | Test cho trường hợp người khác |
|---|---|---|
| `GET /bookings/:id` | `BookingViews.ofUser`: `findFirst({ id, userId })` | `booking/booking-expiry.int-spec.ts` › "404 BOOKING_NOT_FOUND for another user's booking…" |
| `GET /me/bookings` | `listOfUser`: `where { userId }` | cùng file, "only the user's bookings…" |
| `DELETE /bookings/:id` | `BookingService.cancel`: `WHERE id = … AND user_id = …` (khóa hàng) | `booking/booking-cancel.int-spec.ts` › "404 … another user's booking…; nothing changes" |
| `GET /bookings/:id/ticket-pdf` (link PDF ký tạm) | `TicketsController.pdf`: `findFirst({ id, userId })` trước khi ký link | `delivery/tickets.int-spec.ts` › "404 BOOKING_NOT_FOUND for another user's booking, never 403" |
| `POST /payments/vnpay`, `/payments/momo`, `/payments/sepay` | `payable-booking.ts`: `WHERE id = … AND user_id = …` | `payment/payment-create.int-spec.ts`, `payment-momo.int-spec.ts`, `payment-sepay.int-spec.ts` (404, không ghi gì, không gọi cổng) |
| `GET /me/notifications`, `POST /me/notifications/:id/read` | `user_id = …` trong cả đọc và cập nhật | `delivery/notifications.int-spec.ts` › "never shows another user's…", "404 NOTIFICATION_NOT_FOUND…" |
| Giữ ghế: `Idempotency-Key` | khóa duy nhất `(user_id, idempotency_key)` | `booking/booking-hold.int-spec.ts` › "a key is per user: another user may use the same key" |
| Realtime (Socket.IO) | token kiểm khi bắt tay; chỉ phát trạng thái ghế công khai của suất, không có dữ liệu user | `realtime` suites |

Endpoint của nhân viên và admin (`/tickets/check-in*`, `/admin/*`) có `@Roles(STAFF, ADMIN)` /
`@Roles(ADMIN)` trên cả controller; `RolesGuard` là guard toàn cục sau `JwtAuthGuard`. Return URL và
IPN/webhook của cổng thanh toán là `@Public` nhưng chỉ chấp nhận dữ liệu có chữ ký của cổng (VNPay
HMAC-SHA512, MoMo HMAC-SHA256, SePay HMAC-SHA256 trên raw body).

**Không tìm thấy IDOR.** Không cần sửa code; bảng trên chỉ ra test giữ cho điều đó đúng.

## 2. Cookie, CORS, header

| Mục | Trạng thái |
|---|---|
| Refresh token | Cookie `refresh_token`: `httpOnly`, `SameSite=Strict`, `Secure` khi `NODE_ENV=production`, `Path=/auth` (chỉ gửi tới refresh/logout), sống `REFRESH_TOKEN_TTL_SECONDS`; xoay vòng mỗi lần refresh, lưu dạng hash. Access token chỉ ở bộ nhớ của web, không vào cookie hay localStorage |
| CORS | Chỉ các origin trong `CORS_ORIGINS`, `credentials: true`, lộ thêm header `Date`. Origin khác không nhận `Access-Control-Allow-Origin`. Socket.IO dùng cùng danh sách |
| Header bảo mật | **Đã sửa ở 6.5**: trước đây không có `helmet`, mọi response có `X-Powered-By: Express`. Giờ `configureHttp` (`src/http-setup.ts`) bật `helmet()` mặc định: bỏ `X-Powered-By`, `X-Content-Type-Options: nosniff`, CSP `default-src 'self'`, `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, HSTS, `Referrer-Policy: no-referrer`. Swagger UI (`/docs`) chỉ nạp script của chính nó và style inline, CSP mặc định cho phép (đã kiểm HTML của `/docs`, chưa kiểm bằng trình duyệt). Test: `security/http-headers.int-spec.ts` |
| Log | pino che header `Authorization`, `Cookie`, `Set-Cookie`, `X-SePay-Signature` (`config/logger.module.ts`) và bỏ `vnp_SecureHash`, `signature` (MoMo) khỏi URL được log (`config/log-redaction.ts`); test `payment-logs.int-spec.ts` |

## 3. Rate limit

| Hành động | Giới hạn | Ghi chú |
|---|---|---|
| `POST /auth/login` | `LOGIN_RATE_LIMIT_MAX` (5) mỗi email và ×4 (20) mỗi IP, cửa sổ 15 phút | Fail-open khi Redis lỗi (đã chốt ở giai đoạn 1) |
| `POST /bookings` (giữ ghế) | `BOOKING_RATE_LIMIT_MAX` (10) mỗi user mỗi 60 giây | Trước transaction: request bị chặn không tốn DB |
| Tạo thanh toán VNPay/MoMo/SePay | `PAYMENT_RATE_LIMIT_MAX` (10) mỗi user mỗi cửa sổ | |
| Return URL VNPay/MoMo | `PAYMENT_RETURN_RATE_LIMIT_MAX` (30) mỗi IP | |
| Socket.IO: tham gia phòng suất | `REALTIME_LIMITS.joinsMax` mỗi cửa sổ, tối đa `subscriptionsMax` phòng mỗi socket | |
| IPN/webhook cổng thanh toán | Không giới hạn (đúng thiết kế) | Cổng gọi theo lịch riêng; request không chữ ký chỉ tốn một HMAC |
| `POST /auth/refresh` | Không giới hạn | Token ngẫu nhiên 256 bit, không đoán được |
| `POST /auth/register` | **Không giới hạn** | Xem đề xuất 1 |
| Check-in nhập mã tay (nhân viên) | **Không giới hạn** | Dòng "Rate limit cho …" trong ROADMAP "Quyết định chờ": chủ dự án quyết, xem đề xuất 2 |

## 4. `pnpm audit`

Trước 6.5: 2 high, 8 moderate, 1 low. Sau 6.5: **0 high, 0 critical**, 8 moderate, 1 low.

| Gói | Mức | Đường vào | Xử lý |
|---|---|---|---|
| `multer` 2.4.0 | high (DoS khi `fileFilter` còn treo sau khi request bị hủy) | `@nestjs/platform-express` 12.2.0 ghim cứng | `overrides` → 2.5.0 (minor) |
| `effect` 3.20.0 | high (ReDoS trong regex `Schema.TemplateLiteral`) | `@prisma/config` 7.10.1 ghim cứng | `overrides` → 3.22.5 (minor) |
| `hono`, `@hono/node-server` (7 mục) | moderate/low | `shadcn` → `@modelcontextprotocol/sdk` | Không sửa: chỉ có trong CLI `shadcn` (thêm component lúc dev), không nằm trong bản build web hay API. Xem đề xuất 3 |
| `glob` (AbortSignal), `minimatch` (DoS) | moderate | `testcontainers`, `jest`, `eslint`, `shadcn` | Không sửa: công cụ dev/test, không chạy với dữ liệu từ ngoài |

Hai `overrides` nằm trong `pnpm-workspace.yaml`, kèm ghi chú bỏ đi khi gói cha tự dùng bản đã vá.
Không nâng major nào.

## 5. Đề xuất (chưa làm, chủ dự án quyết)

1. **Rate limit cho `POST /auth/register`**: mỗi lần đăng ký chạy argon2 (tốn CPU) và tạo một
   user; hiện không giới hạn nên một IP có thể làm nghẽn CPU hoặc tạo hàng loạt tài khoản. Đề xuất:
   giới hạn theo IP như login (ví dụ 5 lần mỗi giờ), dùng lại `RateLimitService`, fail-open như
   login; cần thêm biến môi trường nên để chủ dự án chốt con số.
2. **Check-in nhập mã tay** (dòng "Rate limit cho …" trong "Quyết định chờ"): mã vé 12 ký tự trong
   bảng 32 ký tự (khoảng 10¹⁸ giá trị) nên dò mù không thực tế, nhưng endpoint không giới hạn. Hai
   hướng: (a) giới hạn theo **nhân viên** (ví dụ 60 lần mỗi phút, đủ cho cửa soát vé đông); (b) chỉ
   giới hạn số lần **sai** liên tiếp theo nhân viên. Hướng (b) không làm chậm cửa soát vé khi mọi mã
   đúng.
3. **Chuyển `shadcn` sang `devDependencies`** của `apps/web`: nó là CLI, không được import trong
   code; chuyển đi thì `pnpm audit --prod` không còn báo các mục `hono`.
4. Khi deploy (giai đoạn 7): đặt CSP cho trang web tĩnh ở Caddy (helmet chỉ bảo vệ response của
   API), bật `TRUST_PROXY=1` sau Caddy để giới hạn theo IP dùng IP thật, và kiểm lại cookie
   `Secure` qua HTTPS.
