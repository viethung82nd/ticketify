# Kiểm tra SePay Test mode bằng webhook thật

Tài liệu SePay không có test vector cho chữ ký HMAC-SHA256 của webhook, nên test trong repo chỉ khóa được **cách đọc** tài liệu (HMAC tính độc lập bằng `openssl`, `apps/api/src/modules/payment/sepay/testing/sepay-sample.ts`). Bản ghi này xác nhận code trên webhook do chính SePay Test mode gửi.

Cách làm: chủ dự án bật Test mode trên `my.sepay.vn`, dùng một tài khoản ngân hàng ảo có VA (`SBSEPAY…`), cấu hình mã thanh toán tiền tố `TKF`, tạo webhook (Tiền vào, JSON, HMAC-SHA256) trỏ tới API dev qua ngrok (domain tĩnh `*.ngrok-free.dev`), điền `SEPAY_*` vào `.env`. Trên web: tạo đơn, chọn "Chuyển khoản ngân hàng (VietQR)", rồi dùng **Mô phỏng giao dịch** của SePay với nội dung là mã thanh toán. Claude đọc kết quả qua giao diện inspect của ngrok (cổng 4040, chỉ đọc header, không ghi giá trị chữ ký), DB dev và Mailpit. Không secret, token hay chữ ký nào được lưu ở đây.

## Kết quả — 23/11/2026

| Giờ (GMT+7) | `sepay_id` | Số tiền | Mã (`code` SePay tách) | HTTP | `outcome` | Đơn |
| ----------- | ---------- | ------- | ---------------------- | ---- | --------- | --- |
| 23:10:34 | 53242 | 5 000 đ | `TKF39260563` | 200 | `SETTLED` | `H7UWHGZ444` → `CONFIRMED`, 1 vé |
| 23:12:20 | 53243 | 9 000 đ (đơn 10 000 đ) | `TKF25527839` | 200 | `AMOUNT_MISMATCH` | `ZZPVLGUQNL` vẫn `PENDING`, Payment vẫn `PENDING` |
| 23:13:43 | 53244 | 10 000 đ | `TKF25527839` | 200 | `SETTLED` | `ZZPVLGUQNL` → `CONFIRMED`, 2 vé |

Đối chứng trước đó, cùng URL ngrok (curl): không cấu hình → `503 {"success":false,"message":"SePay is not configured"}`; đã cấu hình nhưng không có chữ ký → `401 {"success":false,"message":"Invalid signature"}`.

Sau khi worker chạy (16:16:52 UTC): cả hai sự kiện `booking.confirmed` thành `PUBLISHED`, `bookings.email_sent_at` được đặt, Mailpit có một email "Vé của bạn — … (đơn …)" cho mỗi đơn, mỗi email có 1 tệp đính kèm (PDF vé).

## Điều đã xác nhận

- **Chữ ký**: cả ba request thật đều qua bước kiểm HMAC (nếu sai thì đã là `401`). Header thật là `X-Sepay-Signature` (71 ký tự = `sha256=` + 64 hex) và `X-Sepay-Timestamp` (Unix giây); User-Agent `SePay-Testmode-Webhook/1.0`; `Content-Type: application/json`. Cách đọc `HMAC-SHA256(secret, "{timestamp}.{raw body}")`, hex, là đúng.
- **Secret Key** của webhook HMAC chép được về server (băn khoăn về câu "không rời khỏi máy chủ SePay" không còn).
- **Tài khoản có VA**: SePay gửi `accountNumber` là số tài khoản gốc của tài khoản ảo (`0000000001`) và `subAccount` là VA; `SEPAY_BANK_ACCOUNT_NUMBER` = VA khớp qua `subAccount`.
- **`code`**: SePay tự tách đúng mã `TKF` + 8 chữ số theo cấu hình.
- **Sai số tiền** không xác nhận; chuyển lại đúng số tiền thì xác nhận (một đơn có hai giao dịch: một `AMOUNT_MISMATCH`, một `SETTLED`).
- Tài khoản SePay đăng ký theo luồng cổng thanh toán **dùng được** Test mode của Webhooks.

## Chưa kiểm

- **Phát lại** (replay) từ lịch sử webhook của SePay: ngrok không ghi request nào sau 23:13:43, nên chưa thấy lần phát lại thật. Trường hợp giao lặp cùng `id` đã được kiểm trong `payment-sepay.int-spec.ts` (10 lần đồng thời + 1 lần gửi lại → 1 dòng sổ, 1 lần xác nhận).
- Lịch gửi lại khi server lỗi, và giao dịch thật trên Live (chưa làm, xem `docs/SEPAY_SETUP.md` §11).

Ghi chú: hai đơn và hai Payment SePay ở trên là dữ liệu test trong DB dev (Payment `SUCCESS`, vé `ISSUED`). Khi cần dọn, xóa theo mã đơn; `sepay_transactions` tham chiếu `payments` bằng FK `RESTRICT`, nên phải xóa các dòng sổ trước.

Phát hiện phụ (có từ trước, không do SePay): `nest-cli.json` có `deleteOutDir: true`, nên khởi động lại `pnpm dev` (API, watch) sẽ xóa `dist` dưới chân worker đang chạy (`dev:worker`, cũng build vào `dist`); worker dừng và outbox chờ tới khi worker được khởi động lại. Khi đó các sự kiện đang chờ được gửi bình thường (không mất, không gửi trùng).
