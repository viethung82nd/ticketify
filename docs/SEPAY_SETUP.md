# Thanh toán chuyển khoản SePay (VietQR + webhook) — cài đặt, Test mode, kiểm thử

Ticketify nhận thanh toán qua **VNPay**, **ví MoMo** và từ 11/2026 **chuyển khoản ngân hàng qua SePay**. Cả ba cổng ghi kết quả bằng cùng một lõi (`settlePayment`): cùng thứ tự khóa, cùng nhánh A/B/C, cùng outbox. Vì vậy đơn, ghế, vé, PDF, email và thông báo hoạt động như nhau dù tiền vào qua cổng nào. Tài liệu này chỉ nói về SePay.

> **Trạng thái kiểm chứng (23/11/2026).** Code đã được kiểm bằng unit test, integration test (Postgres + Redis thật, webhook ký HMAC gửi qua HTTP) và **webhook thật từ SePay Test mode** (3 giao dịch mô phỏng qua ngrok: 2 `SETTLED`, 1 `AMOUNT_MISMATCH`, đơn xác nhận, PDF và email gửi đi) — xem [sepay-sandbox-check.md](sepay-sandbox-check.md). Chưa kiểm: phát lại từ dashboard, giao dịch thật trên Live.

## 1. Tích hợp nào được dùng, và vì sao không dùng Merchant ID / Secret Key

SePay có **hai sản phẩm khác nhau**, giao thức khác hẳn nhau:

| | **SePay Webhooks** (Ticketify dùng) | **Cổng thanh toán SePay** (không dùng) |
|---|---|---|
| Khách thấy gì | QR VietQR **trên trang Ticketify** | Trang thanh toán của SePay (`pay-sandbox.sepay.vn`) |
| Thông tin đăng nhập | Secret Key **của webhook** (HMAC) | Merchant ID + Secret Key (`spsk_test_…`) |
| Báo kết quả | Webhook biến động số dư, ký `X-SePay-Signature` | IPN chỉ có header `X-Secret-Key` tĩnh, không chữ ký |
| Tài liệu | đầy đủ: payload, `id` không đổi khi gửi lại, lịch retry | thiếu enum trạng thái, retry policy, API tra cứu đơn |

Chủ dự án chọn **Webhooks + VietQR** (23/11/2026) vì sản phẩm này khớp luồng QR-trong-app, có chữ ký HMAC kèm chống replay và có tài liệu đầy đủ. **Merchant ID và Secret Key của cổng thanh toán không được dùng ở đâu cả**, đừng đặt chúng vào `.env`.

Nguồn (đọc ngày 23/11/2026, `developer.sepay.vn/vi`): `sepay-webhooks/tich-hop-webhook`, `sepay-webhooks/xac-thuc`, `sepay-webhooks/xu-ly-loi`, `sepay-webhooks/bao-mat`, `sepay-webhooks/tao-webhook`, `sepay-webhooks/cau-hinh-ma-thanh-toan`, `tien-ich-khac/tao-qr-code`, `tien-ich-khac/test-mode` (+ `mo-phong-giao-dich`, `tao-webhook`, `cau-hinh`, `tao-va`), `dia-chi-ip`, mẫu Node.js `lap-trinh-webhooks/lap-trinh-webhook-nodejs`.

### Giao thức (theo tài liệu)

- **QR**: `https://vietqr.app/img?acc=<STK>&bank=<ngân hàng>&amount=<số tiền>&des=<nội dung>&template=compact[&holder=<chủ TK>]`. `bank` là short name, code hoặc BIN trong `vietqr.app/banks.json`.
- **Webhook**: `POST` JSON tới URL đã cấu hình, mỗi giao dịch một lần:
  ```json
  { "id": 92704, "gateway": "Vietcombank", "transactionDate": "2024-07-02 11:08:33",
    "accountNumber": "1017588888", "subAccount": "", "code": "TKF04817263",
    "content": "TKF04817263 chuyen tien", "transferType": "in", "description": "…",
    "transferAmount": 180000, "accumulated": 105000000, "referenceCode": "FT24012345678" }
  ```
  `id` là mã giao dịch SePay, **giữ nguyên qua mọi lần gửi lại và phát lại**: tài liệu khuyên dùng nó làm khóa chống trùng. `code` là mã thanh toán SePay tự tách từ `content` theo "Cấu trúc mã thanh toán", bằng `null` khi không khớp. `transferType` là `in` hoặc `out`.
- **Xác thực HMAC-SHA256**: header `X-SePay-Signature: sha256=<hex>` và `X-SePay-Timestamp: <Unix giây>`; `<hex>` = HMAC-SHA256(Secret Key, `"{timestamp}.{raw body}"`), tính trên **byte body nhận được**, không phải JSON serialize lại. Lệch quá 300 s thì từ chối (chống replay).
- **Phản hồi thành công**: HTTP 200/201 **và** body `{"success": true}` trong vòng 30 s. Mọi phản hồi khác là lỗi.
- **Gửi lại**: lỗi kết nối luôn được gửi lại; HTTP lỗi chỉ được gửi lại khi bật **"Tự động gửi lại khi server trả lỗi"**. Tổng 8 lần trong khoảng 33 phút (cách nhau 0, 1, 1, 2, 3, 5, 8, 13 phút). Thứ tự giao **không** được đảm bảo, và giao dịch trùng có thể đến từ retry, từ "Phát lại" trong dashboard hoặc từ nhiều webhook cùng trỏ một URL.

### Điểm từng chưa chắc — kết quả kiểm bằng webhook thật (23/11/2026)

Ba điểm đầu **đã được xác nhận** bằng webhook thật (docs/sepay-sandbox-check.md); điểm 4 không còn quan trọng.

1. Tài liệu **không có test vector** cho HMAC. Unit test cố định cách đọc ở trên bằng một HMAC tính độc lập bằng `openssl` (`sepay/testing/sepay-sample.ts`). **Đã xác nhận**: webhook thật của Test mode qua bước kiểm (header `sha256=` + 64 hex, chuỗi `timestamp.body`).
2. Trang Test mode (`tao-webhook`) ghi "Secret key không rời khỏi máy chủ SePay". **Đã xác nhận**: Secret Key chép được về server và dùng được.
3. Tài khoản đăng ký theo luồng **cổng thanh toán** có dùng được **Test mode của Webhooks** hay không. **Đã xác nhận**: dùng được. Với tài khoản ảo có VA, SePay gửi `accountNumber` = số tài khoản gốc (ví dụ `0000000001`) và `subAccount` = VA: đặt `SEPAY_BANK_ACCOUNT_NUMBER` = VA.
4. Trang `test-mode/tai-khoan-ngan-hang` chưa đọc được. Chưa rõ số tài khoản ảo trong Test mode có tạo ra một QR VietQR quét được hay không. Với Test mode điều đó không quan trọng: giao dịch được **mô phỏng**, không quét QR.

## 2. Luồng trong Ticketify

```
Khách bấm "Chuyển khoản ngân hàng (VietQR)"
  → POST /payments/sepay {bookingId}             (JWT, rate limit như VNPay/MoMo)
      khóa booking FOR NO KEY UPDATE, kiểm tra chung (lockPayableBooking)
      lần thử SePay PENDING đang mở → trả lại; nếu chưa có → Payment(PENDING, SEPAY, txn_ref = TKF########)
  ← { paymentId, provider:"SEPAY", amount, transferContent, qrCodeUrl, bankCode, accountNumber, accountHolder, expiresAt, reused }
Web hiện QR + số tiền + nội dung + đếm ngược, đọc lại GET /bookings/:id mỗi 3 s
Khách chuyển khoản → ngân hàng → SePay
  → POST /payments/sepay/webhook                 (công khai, HMAC)
      1. chưa cấu hình → 503        2. chữ ký/timestamp sai → 401
      3. không phải JSON / thiếu trường → 400
      4. phân loại: tiền ra | tài khoản khác | không có mã | có mã
      5. 1 transaction: INSERT sepay_transactions ON CONFLICT (sepay_id) DO NOTHING
           đã có → "duplicate", dừng
           có mã → settlePayment(SEPAY, mã) → SETTLED | UNKNOWN_REFERENCE | AMOUNT_MISMATCH | DUPLICATE_TRANSFER
  ← 200 {"success": true}
settlePayment: Payment SUCCESS → booking CONFIRMED, vé, outbox booking.confirmed → PDF, email, thông báo
```

- **Mã thanh toán** = `SEPAY_PAYMENT_CODE_PREFIX` + 8 chữ số ngẫu nhiên (ví dụ `TKF04817263`). Mã này chính là `payments.txn_ref` (duy nhất trên mọi cổng) và là **toàn bộ** nội dung chuyển khoản. Chỉ có chữ số sau prefix nên khớp cả hai kiểu hậu tố của SePay; dài 8 nên nằm trong mặc định Live (6–8) và Test (3–10).
- **Đọc mã**: ưu tiên `code` của SePay. Nếu `code` trống hoặc khác định dạng, tìm trong `content` đúng `prefix + 8 chữ số` không dính chữ/số khác, không phân biệt hoa thường (ngân hàng hay chèn thêm chữ, ví dụ `MBVCB.123.TKF04817263.CT tu …`). Nếu `content` chứa hai mã khác nhau thì coi là không có mã.
- **Chỉ tiền vào, đúng tài khoản**: `transferType` phải là `in`; `accountNumber` (hoặc `subAccount`, khi dùng VA) phải bằng `SEPAY_BANK_ACCOUNT_NUMBER`.
- **Đúng số tiền** (chủ dự án quyết định 23/11/2026): `transferAmount` phải **bằng đúng** số tiền của payment. Thiếu hoặc thừa thì không xác nhận; giao dịch được ghi `AMOUNT_MISMATCH` và log `error` để đối soát/hoàn tiền tay. Khách vẫn có thể chuyển lại đúng số tiền trước khi đơn hết hạn.
- **Không có tin "thất bại"**: một lần thử SePay chưa nhận tiền chỉ `EXPIRED` cùng đơn.

### Chống trùng và tranh chấp

- `sepay_transactions.sepay_id` là **UNIQUE**. Nhiều lần giao cùng một `id` chạy song song thì lần thứ hai chờ trên unique index cho tới khi transaction đầu kết thúc, rồi không chèn gì và trả `duplicate`. Nếu transaction đầu rollback thì lần sau tự làm việc đó. Test: 10 lần giao song song + 1 retry → 1 dòng sổ, 1 lần xác nhận, 1 sự kiện outbox.
- Sau đó `settlePayment` khóa `payments` → `bookings` → `showtime_seats`, đúng thứ tự mọi luồng đang dùng. Payment đã `SUCCESS` thì không ghi lại. Partial unique `payments_booking_id_success_key`, `tickets_showtime_id_seat_id_live_key` và `UNIQUE(provider, provider_transaction_id)` là lớp chặn cuối.
- Không có luồng nào khác chạm `sepay_transactions`, và dòng sổ được chèn trước mọi khóa payment, nên không tạo vòng chờ mới.

## 3. Đơn hết hạn, chuyển khoản muộn, đối soát và hoàn tiền

Worker hết hạn **bỏ qua** lần thử SePay khi hỏi các cổng (SePay Webhooks không có API tra cứu trong tích hợp này; trước bản sửa, lần thử SePay sẽ bị gửi nhầm sang querydr của VNPay). Đơn hết hạn như bình thường; Payment SePay thành `EXPIRED`, mà `EXPIRED` **không phải** trạng thái cuối. Khi tiền đến muộn, `settlePayment` áp dụng đúng chính sách hiện có:

| Tình huống khi webhook đến | Kết quả |
|---|---|
| Đơn còn `PENDING`, ghế còn giữ (A) | `SUCCESS`, đơn `CONFIRMED`, vé |
| Đơn `EXPIRED`, mọi ghế còn trống (B) | lấy lại ghế, `SUCCESS`, `CONFIRMED`, vé |
| Đơn `EXPIRED`, ghế đã có người khác, hoặc suất đã hủy/đã chiếu xong (C) | `SUCCESS`, đơn `NEEDS_REVIEW`, **không** vé, outbox `booking.needs_review` → hàng chờ admin |
| Đơn đã được trả bằng cổng khác (VNPay/MoMo) | Payment SePay `REFUND_REQUIRED`, outbox `payment.refund_required` (provider `SEPAY`) |
| Chuyển lần hai cho cùng mã (khác `id`) | sổ `DUPLICATE_TRANSFER`, không đổi gì khác |
| Sai số tiền / mã không tồn tại / không có mã / tài khoản khác | sổ `AMOUNT_MISMATCH` / `UNKNOWN_REFERENCE` / `NO_REFERENCE` / `WRONG_ACCOUNT` |

Mọi khoản **tiền vào** mà không được áp vào đơn đều có dòng trong `sepay_transactions` và một log `error` có `event: "sepay.transfer_unapplied"` (riêng `NO_REFERENCE`/`WRONG_ACCOUNT` là `warn`, vì đó có thể là giao dịch thường của tài khoản).

### Đối soát (việc làm tay)

```sql
-- Tiền vào chưa được áp vào đơn nào: hoàn tiền hoặc liên hệ khách
SELECT received_at, sepay_id, outcome, transfer_amount, reference, content, reference_code, payment_id
FROM sepay_transactions
WHERE transfer_type = 'in' AND outcome <> 'SETTLED'
ORDER BY received_at DESC;

-- Đã thu nhưng phải hoàn (đơn đã trả bằng cổng khác)
SELECT id, txn_ref, amount, provider_transaction_id FROM payments
WHERE provider = 'SEPAY' AND status = 'REFUND_REQUIRED';
```

Đơn `NEEDS_REVIEW` hiện trong trang admin "Đơn cần xử lý" (cột cổng ghi "SePay (chuyển khoản)", mã GD = `id` SePay, "nội dung CK" = mã thanh toán).

**Hoàn tiền**: SePay Webhooks không có API hoàn tiền. Admin chuyển khoản trả từ tài khoản nhận, đối chiếu bằng `reference_code` (mã giao dịch ngân hàng) và `description`/`content` (thường có tên người chuyển). Payload **không** có số tài khoản người chuyển, nên thường phải liên hệ khách qua email của đơn. Hoàn tiền tự động nằm ngoài phạm vi dự án, giống VNPay và MoMo.

**Webhook bị mất** (server tắt lâu hơn ~33 phút retry): vào SePay → lịch sử webhook → **Phát lại**. Việc phát lại an toàn vì `id` giữ nguyên. SePay khuyên đối soát định kỳ 15–30 phút bằng API giao dịch; Ticketify **chưa** làm việc này (xem §11).

## 4. Đăng ký và vào Test mode

1. Đăng nhập `my.sepay.vn`. Bật **Test mode** ở thanh bên (hoặc `Ctrl/Cmd + K` → "Test mode"); khi bật sẽ có banner vàng. Tài khoản SuperAdmin/Admin có sẵn quyền này; user thường cần quyền "Cho phép truy cập Test mode". Dữ liệu Test mode tách biệt khỏi Live.
2. Trong Test mode, tạo **tài khoản ngân hàng ảo** (và VA nếu ngân hàng yêu cầu: OCB, KienLongBank, MSB, BIDV cá nhân/hộ kinh doanh). Ghi lại **số tài khoản** (hoặc số VA, dạng `SBSEPAY…`) và **ngân hàng**: đó là `SEPAY_BANK_ACCOUNT_NUMBER` và `SEPAY_BANK_CODE`.
3. **Test mode → Cấu hình → Cấu trúc mã thanh toán**: thêm (hoặc sửa mẫu mặc định) với **tiền tố** = `SEPAY_PAYMENT_CODE_PREFIX` (mặc định `TKF`), **hậu tố dài 8–8** (hoặc khoảng bất kỳ chứa 8), kiểu "Số nguyên" hoặc "Số và chữ". Bật "Nhận diện mã thanh toán". (Code vẫn tự tìm mã trong `content` nếu SePay không tách được, nhưng cấu hình đúng giúp lọc webhook theo mã.)

> Merchant ID và Secret Key của **cổng thanh toán** không cần cho tích hợp này (§1).

## 5. Biến môi trường

Điền vào `.env` ở gốc repo (biến môi trường thật luôn thắng `.env`):

| Biến | Ví dụ / mặc định | Ghi chú |
|---|---|---|
| `SEPAY_WEBHOOK_SECRET` | *(của bạn, ≥ 16 ký tự)* | Secret Key ở bước **Bảo mật → HMAC-SHA256** của webhook. Chỉ dùng để tính HMAC; không bao giờ log, không trả về API |
| `SEPAY_BANK_ACCOUNT_NUMBER` | `0071000888999` hoặc `SBSEPAY…` | tài khoản/VA nhận tiền, in trong QR; webhook của tài khoản khác không xác nhận gì |
| `SEPAY_BANK_CODE` | `MBBank` | tên VietQR: short name, code hoặc BIN (`vietqr.app/banks.json`) |
| `SEPAY_ACCOUNT_HOLDER` | `CONG TY TICKETIFY` | tùy chọn, không dấu; hiện trên trang và QR |
| `SEPAY_PAYMENT_CODE_PREFIX` | `TKF` | 2–5 chữ in hoa (giới hạn Live); phải trùng cấu hình §4.3 |

Thiếu secret, số tài khoản hoặc ngân hàng thì SePay **tắt hẳn**: API vẫn khởi động; `POST /payments/sepay` trả `503 PAYMENT_NOT_CONFIGURED` (không phát QR nào mà về sau không kiểm chứng được); webhook trả `503 {"success": false}` và không ghi gì. Giá trị sai định dạng thì API **không khởi động** và báo tên biến (không in giá trị secret).

Brief ban đầu gợi ý `SEPAY_MERCHANT_ID`, `SEPAY_SECRET_KEY`, `SEPAY_WEBHOOK_URL`, `SEPAY_ENV`. Không biến nào trong số đó được thêm: hai biến đầu thuộc cổng thanh toán (không dùng), URL webhook chỉ khai báo trong dashboard SePay (API không cần biết), còn môi trường Test/Live do webhook nào gọi tới quyết định, code không phân biệt được.

## 6. Mở API ra Internet và tạo webhook

SePay từ chối URL `localhost`/IP nội bộ, kể cả trong Test mode (Test mode chấp nhận HTTP và chứng chỉ tự ký).

```bash
docker compose up -d
pnpm install && pnpm db:deploy             # áp migration 20261123100000_payment_provider_sepay
pnpm dev                                   # API :3000, web :5173
pnpm --filter @ticketify/api dev:worker    # PDF, email, thông báo, hết hạn đơn

# một trong hai:
ngrok http 3000                            # → https://<tên>.ngrok-free.app
cloudflared tunnel --url http://localhost:3000   # → https://<ngẫu nhiên>.trycloudflare.com
```

Quick tunnel của Cloudflare đổi URL mỗi lần chạy. Mỗi lần URL đổi thì sửa URL webhook trong SePay (khác MoMo, URL webhook không nằm trong request). Muốn URL cố định thì dùng ngrok static domain hoặc named tunnel.

**Test mode → Webhooks → Tạo webhook:**

1. *Cơ bản*: Tên tùy ý; "Gửi tới URL của tôi"; URL = `https://<tunnel>/payments/sepay/webhook`; **Loại giao dịch: Tiền vào**; **Định dạng: JSON** (bắt buộc: form-encoded bị trả `400`); **bật** gửi lại khi server lỗi.
2. *Tài khoản*: chọn tài khoản ảo ở §4.2; nên bật "Dùng để xác thực thanh toán" + "Chỉ gửi khi có mã thanh toán" (+ lọc prefix `TKF`).
3. *Bảo mật*: **HMAC-SHA256**, bấm tạo (hoặc nhập) Secret Key, chép ngay vào `SEPAY_WEBHOOK_SECRET` (SePay chỉ hiện đầy đủ một lần), khởi động lại API.

Có thể dùng **SePay CLI** (`sepay webhook listen --webhook <xid> --forward localhost:3000`) thay tunnel, nhưng chưa được kiểm: chưa biết CLI có giữ nguyên header chữ ký và byte body khi chuyển tiếp hay không.

## 7. Kiểm thử đầu-cuối trong Test mode

1. Đăng nhập web, chọn ghế, sang trang đơn, bấm **Chuyển khoản ngân hàng (VietQR)**. Ghi lại **số tiền** và **nội dung** (ví dụ `TKF04817263`).
2. SePay → Test mode → **Mô phỏng giao dịch**: chọn tài khoản ở §4.2 (+ VA nếu có), **Tiền vào**, số tiền **đúng bằng** số tiền trên trang (tối thiểu 1.000, tối đa 499.000.000), nội dung = mã ở trên. Giới hạn 500 giao dịch mô phỏng/ngày.
3. Trong ≤ 3 s trang đơn chuyển sang **Đã xác nhận** và có nút **Tải vé PDF**. Mailpit (`http://localhost:8025`) nhận email vé khi worker chạy.
4. Kiểm:
   ```sql
   SELECT sepay_id, outcome, payment_id, transfer_amount, reference FROM sepay_transactions ORDER BY received_at DESC LIMIT 5;
   SELECT status, provider, txn_ref, provider_transaction_id FROM payments WHERE provider = 'SEPAY' ORDER BY created_at DESC LIMIT 5;
   ```
   Kết quả mong đợi: `SETTLED`, Payment `SUCCESS`, `provider_transaction_id` = `id` SePay.
5. Thử thêm các ca: chuyển sai số tiền (→ `AMOUNT_MISMATCH`, đơn vẫn chờ); "Phát lại" chính webhook đó trong lịch sử SePay (→ `200`, không có gì đổi, log "already received"); bấm "Gửi thử" của SePay (payload giả, `id` thường là 0 → `400 Invalid payload`, chuyện bình thường).
6. Ghi kết quả (ngày, `sepay_id`, ảnh chụp **không** có secret) vào một file `docs/sepay-sandbox-check.md` giống `docs/vnpay-sandbox-check.md`. **Chỉ sau bước này** mới coi tích hợp SePay thật là đã kiểm chứng.

Có thể tự giả lập webhook mà không cần SePay, ví dụ để kiểm tunnel:

```bash
BODY='{"id":1,"gateway":"MBBank","transactionDate":"2026-11-23 10:00:00","accountNumber":"<STK>","subAccount":"","code":"TKF04817263","content":"TKF04817263","transferType":"in","transferAmount":180000,"accumulated":0,"referenceCode":"SB1","description":""}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SEPAY_WEBHOOK_SECRET" -hex | sed 's/^.*= //')
curl -sS -X POST https://<tunnel>/payments/sepay/webhook -H 'Content-Type: application/json' \
  -H "X-SePay-Timestamp: $TS" -H "X-SePay-Signature: sha256=$SIG" --data-raw "$BODY"
```

(Lệnh này chỉ chứng minh code đúng với *cách đọc tài liệu của chúng ta*, không chứng minh SePay ký giống vậy. Đừng chạy lệnh trên một máy có shell history được đồng bộ ra ngoài, vì `$SEPAY_WEBHOOK_SECRET` có trong môi trường.)

## 8. Xem log webhook an toàn

- Log request (pino-http) **che** `Authorization`, `Cookie` và `X-SePay-Signature`. Body POST không bao giờ được log. Secret không xuất hiện ở đâu (`payment-sepay.int-spec.ts` kiểm điều này).
- Mỗi webhook ghi một dòng: `SePay webhook 401: <lý do>` / `400: <trường>: <lỗi>` (chỉ tên trường, không giá trị) / `SePay transaction <id> (in <số tiền> VND, code <mã>): …`.
- Tìm tiền chưa áp vào đơn: `grep '"event":"sepay.transfer_unapplied"'` trong log JSON, hoặc dùng truy vấn SQL ở §3.
- Phía SePay: Webhooks → lịch sử gửi (mỗi lần retry một dòng, có HTTP status và body phản hồi).
- Không chia sẻ ảnh chụp màn hình bước "Bảo mật" của webhook hay file `.env`.

## 9. API

- `POST /payments/sepay` (JWT, chủ đơn), body `{ bookingId }`; trường khác (kể cả `amount`) → `400 VALIDATION_FAILED`. Trả `201 { paymentId, provider: "SEPAY", amount, transferContent, qrCodeUrl, bankCode, accountNumber, accountHolder, expiresAt, reused }`. Lỗi giống VNPay/MoMo: `404 BOOKING_NOT_FOUND` (cả đơn của người khác), `409 BOOKING_NOT_PAYABLE` / `BOOKING_ALREADY_PAID`, `422 BOOKING_EXPIRED`, `429 TOO_MANY_ATTEMPTS` (chung ngân sách), `503 PAYMENT_NOT_CONFIGURED`.
- `POST /payments/sepay/webhook` (công khai, SePay gọi): `200 {"success": true}` khi đã xử lý (đã áp, đã ghi mà không áp, hoặc trùng); `401 {"success": false, "message": "Invalid signature"}`; `400 … "Invalid payload"`; `503` khi chưa cấu hình; `500 … "Internal error"` khi lỗi bất ngờ (không ghi gì, SePay gửi lại nếu bật retry).

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| `POST /payments/sepay` → 503 | thiếu `SEPAY_WEBHOOK_SECRET` / `SEPAY_BANK_ACCOUNT_NUMBER` / `SEPAY_BANK_CODE`, hoặc chưa khởi động lại API |
| QR không hiện / app ngân hàng báo sai ngân hàng | `SEPAY_BANK_CODE` không có trong `vietqr.app/banks.json` |
| Webhook 401 | secret khác với SePay (tạo lại thì phải chép lại); webhook không ở chế độ HMAC-SHA256; đồng hồ server lệch > 300 s; proxy/tunnel sửa body (nén lại, đổi xuống dòng) |
| Webhook 400 | Định dạng dữ liệu không phải JSON; "Gửi thử" của SePay (`id` 0) |
| Webhook 503 | API thiếu biến SePay |
| 200 nhưng đơn không xác nhận | xem `sepay_transactions.outcome`: `NO_REFERENCE` (prefix/cấu trúc mã sai, khách gõ sai nội dung), `WRONG_ACCOUNT` (`SEPAY_BANK_ACCOUNT_NUMBER` khác tài khoản/VA nhận), `AMOUNT_MISMATCH`, `UNKNOWN_REFERENCE` (mã của môi trường/DB khác), `DUPLICATE_TRANSFER` |
| SePay không gọi tới | URL tunnel đổi; URL là localhost; webhook lọc "chỉ khi có mã" mà SePay không tách được mã; sai tài khoản ở bước 2 |
| Đơn đã `Đã hết hạn` rồi mới nhận tiền | đúng chính sách: nhánh B (lấy lại ghế) hoặc C (`NEEDS_REVIEW`), xem §3 |

## 11. Chuyển từ Test sang Production

1. Tắt Test mode; trên Live: liên kết tài khoản ngân hàng thật (VietinBank cá nhân/hộ KD: nội dung phải chứa `SEVQR`, **chưa hỗ trợ** trong code, hãy chọn ngân hàng khác hoặc mở việc bổ sung; OCB/KienLongBank/MSB/BIDV cá nhân: bắt buộc VA).
2. Live → Cấu trúc mã thanh toán: tiền tố `SEPAY_PAYMENT_CODE_PREFIX` (2–5 chữ), hậu tố 8 (mặc định Live 6–8 là được).
3. Tạo webhook **Live mới** trỏ tới domain HTTPS thật, JSON, Tiền vào, bật retry, bật cảnh báo (Telegram/Slack/Discord), **HMAC-SHA256 với secret mới**. Không dùng lại secret của Test mode.
4. Đặt biến môi trường production (secret manager, không đặt trong image hay `.env` commit), chạy `pnpm db:deploy`.
5. Tùy chọn: chỉ cho phép IP gửi của SePay tới `/payments/sepay/webhook` ở reverse proxy (danh sách tại `developer.sepay.vn/vi/dia-chi-ip`, có thể đổi): `172.236.138.20`, `172.233.83.68`, `171.244.35.2`, `151.158.108.68`, `151.158.109.79`, `103.255.238.139`, `45.57.137.67`, `2400:8905::2000:8cff:fe98:45cd`, `2600:3c15::2000:8aff:fedd:874b`. Nếu đặt sau proxy, cấu hình `TRUST_PROXY` cho đúng.
6. Làm một giao dịch thật nhỏ, đối chiếu §7.4, rồi hoàn tiền tay.
7. Theo dõi `sepay.transfer_unapplied` và truy vấn đối soát ở §3 hằng ngày.

## 12. Migration và rollback

Migration `20261123100000_payment_provider_sepay` chỉ **mở rộng**: thêm giá trị `SEPAY` cho enum `payment_provider`, enum mới `sepay_transaction_outcome`, bảng mới `sepay_transactions` (+ 2 CHECK viết tay: `sepay_transactions_transfer_check`, `sepay_transactions_settled_payment_check`). Bảng `payments` không đổi; dữ liệu VNPay/MoMo không bị đọc hay ghi. Bản app cũ vẫn chạy được trên schema mới.

Rollback, chỉ khi **chưa có** payment SePay nào (`SELECT count(*) FROM payments WHERE provider = 'SEPAY'` = 0):

```sql
DROP TABLE "sepay_transactions";
DROP TYPE "sepay_transaction_outcome";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261123100000_payment_provider_sepay';
```

PostgreSQL không xóa được giá trị enum. `SEPAY` còn lại trong `payment_provider` vô hại với bản app cũ (nó không bao giờ chèn hay đọc giá trị này). Khi đã có payment SePay thật thì **không rollback schema**: tắt SePay bằng cách bỏ các biến `SEPAY_*` (POST trả 503, webhook 503), giữ dữ liệu để đối soát.

## 13. Giới hạn còn lại

- Đã nhận webhook thật từ SePay **Test mode** (docs/sepay-sandbox-check.md); chưa kiểm phát lại từ dashboard và giao dịch Live.
- Không có đối soát tự động định kỳ với API giao dịch SePay (SePay khuyên 15–30 phút), và worker hết hạn không hỏi SePay trước khi cho đơn hết hạn: chuyển khoản muộn được xử lý theo nhánh B/C khi webhook đến.
- Chỉ hỗ trợ webhook JSON và xác thực HMAC-SHA256 (không hỗ trợ API Key, OAuth 2.0, "Không xác thực").
- Không có trang admin cho giao dịch chưa áp, chỉ có SQL + log; hoàn tiền làm tay.
- VietinBank cá nhân/hộ KD (yêu cầu `SEVQR` trong nội dung) và VA theo nội dung (`TKP…`) chưa hỗ trợ.
- Ảnh QR tải từ `vietqr.app` (dịch vụ ngoài); nếu dịch vụ đó lỗi, khách vẫn chuyển tay được bằng số tài khoản, số tiền và nội dung hiện trên trang.
