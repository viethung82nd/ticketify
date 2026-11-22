# Thanh toán MoMo — cài đặt, sandbox, kiểm thử

Ticketify nhận thanh toán qua **VNPay** (giai đoạn 3) và **ví MoMo** (11/2026). Hai cổng dùng chung một lõi ghi kết quả (`settlePayment`), cùng thứ tự khóa, cùng outbox, nên đơn, ghế, vé, PDF, email và thông báo hoạt động y hệt dù tiền đi qua cổng nào. Tài liệu này chỉ nói về MoMo.

## 1. Tích hợp nào được dùng

| | |
|---|---|
| API | Payment gateway **API v2** của MoMo (tài liệu **v3** tại `developers.momo.vn`) |
| Luồng | **One-time payment** bằng ví MoMo: `requestType = captureWallet`, `autoCapture` mặc định (`true`) |
| Tạo thanh toán | `POST {MOMO_ENDPOINT}/v2/gateway/api/create` (JSON) |
| Kết quả | **IPN**: MoMo `POST` JSON tới `ipnUrl`; trình duyệt được đưa về `redirectUrl` với cùng các trường |
| Đối soát | `POST {MOMO_ENDPOINT}/v2/gateway/api/query` (worker hỏi trước khi cho đơn hết hạn) |
| Chữ ký | HMAC-SHA256, khóa là secret key, hex chữ thường, trên `key=value` nối bằng `&` theo **danh sách trường cố định** của từng loại thông điệp, giá trị giữ nguyên (không urlencode) |

**Nguồn và mức độ kiểm chứng (22/11/2026).** Trang `developers.momo.vn` chặn công cụ tải tự động (HTTP 403), nên không đọc được nguyên văn. Những gì code dựa vào:

- **Chuỗi ký** create, IPN/redirect và query: lấy từ **repo mẫu chính thức của MoMo** `github.com/momo-wallet/payment` (`php/PayMoMo/init_payment.php`, `php/PayMoMo/ipn_momo.php`, `php/atm/query_transaction.php`, `nodejs/MoMo.js`), khớp với các trích đoạn tài liệu v3 tìm được. Test unit so chữ ký của code với giá trị do **chính đoạn nối chuỗi PHP của MoMo** tính ra (`apps/api/src/modules/payment/momo/testing/momo-reference.php`), không phải do code tự kiểm chính nó.
- **Phản hồi IPN** "HTTP 204 (No Content) trong 15 giây", **timeout tối thiểu 30 s** cho create/query, **amount 1.000 – 50.000.000 VND**, `orderId` tối đa 200 ký tự theo regex chữ-số, `requestId` tối đa 50 ký tự và là khóa idempotency, mã `1000`/`7000`/`7002` chưa phải trạng thái cuối, `9000` = đã ủy quyền: từ trích đoạn tài liệu v3 qua công cụ tìm kiếm.
- **Không xác minh được nguyên văn**: chữ ký của *phản hồi* create và *phản hồi* query. Code **không** dựa vào hai chữ ký này (xem §8). Khi có quyền đọc trang tài liệu, nên đối chiếu lại các mục ở bảng cuối trang.

## 2. Đăng ký sandbox và lấy credentials

> Các bước dưới là quy trình chung; trang "Onboarding"/"Test instructions" của `developers.momo.vn` không đọc được bằng công cụ tự động ngày 22/11/2026, nên hãy đối chiếu với trang đó khi làm.

1. Đăng ký tài khoản doanh nghiệp MoMo (M4B — **MoMo Business**, `business.momo.vn`) và mở môi trường **test/sandbox** cho cửa hàng của bạn theo hướng dẫn "Onboarding" trên `developers.momo.vn`.
2. Trong trang quản trị M4B, mục thông tin tích hợp của môi trường test có ba giá trị: **Partner Code**, **Access Key**, **Secret Key**. Đó là `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`, `MOMO_SECRET_KEY`.
3. Repo mẫu chính thức của MoMo có kèm bộ khóa demo cho môi trường test. Repo Ticketify **không** chép lại các khóa đó; nếu muốn dùng, tự đọc ở repo của MoMo và chỉ đặt trong `.env` cục bộ.
4. Cài app **MoMo bản test** (link tải trong mục hướng dẫn test của tài liệu MoMo) và tạo ví test để quét QR / xác nhận thanh toán. Thông tin thẻ/ví test lấy đúng từ trang hướng dẫn của MoMo.

> Không bao giờ commit credentials. `.env` đã nằm trong `.gitignore`; `.env.example` chỉ có chỗ trống.

## 3. Biến môi trường

Điền vào `.env` ở gốc repo (API đọc file này; biến môi trường thật luôn thắng):

| Biến | Ví dụ / mặc định | Ghi chú |
|---|---|---|
| `MOMO_PARTNER_CODE` | *(của bạn)* | bắt buộc để dùng MoMo |
| `MOMO_ACCESS_KEY` | *(của bạn)* | nằm trong chuỗi ký, **không** gửi trong body |
| `MOMO_SECRET_KEY` | *(của bạn)* | chỉ dùng để tính HMAC; không bao giờ được log |
| `MOMO_ENDPOINT` | `https://test-payment.momo.vn` | production: `https://payment.momo.vn` |
| `MOMO_REDIRECT_URL` | `http://localhost:5173/payment/result/momo` | trang kết quả của web (trình duyệt tự mở, localhost dùng được) |
| `MOMO_IPN_URL` | `https://<tên>.ngrok-free.app/payments/momo/ipn` | **phải công khai**: MoMo gọi từ máy chủ của họ |
| `MOMO_REQUEST_TIMEOUT_MS` | `30000` | tài liệu yêu cầu ≥ 30 s cho create |
| `MOMO_QUERY_TIMEOUT_MS` | `5000` | query của worker hết hạn; quá thời gian = "không rõ" → hết hạn như thường |

Thiếu partner code / access key / secret key / redirect / IPN URL thì API vẫn khởi động; `POST /payments/momo` trả `503 PAYMENT_NOT_CONFIGURED`. Thiếu ba khóa thì IPN trả HTTP 500 (không ghi gì).

Ghi chú: brief ban đầu đề xuất `MOMO_REQUEST_TIMEOUT_MS=10000`; mặc định là `30000` vì tài liệu MoMo yêu cầu timeout tối thiểu 30 s cho API create.

## 4. Chạy dự án

```bash
docker compose up -d                     # Postgres, Redis, RustFS, Mailpit
pnpm install
pnpm db:deploy                           # áp migration, gồm 20261122120000_payment_provider_momo
pnpm dev                                 # API :3000, web :5173 (cần thêm worker cho PDF/email)
pnpm --filter @ticketify/api dev:worker  # worker: outbox → PDF, email, thông báo; hết hạn đơn
```

## 5. Mở API ra Internet bằng ngrok (cho IPN)

MoMo phải gọi được `MOMO_IPN_URL` qua HTTPS công khai. Localhost thì không.

```bash
ngrok http 3000 --url=https://<ten-mien-tinh>.ngrok-free.app
# → MOMO_IPN_URL=https://<ten-mien-tinh>.ngrok-free.app/payments/momo/ipn
```

- **URL IPN phải trỏ đúng endpoint callback của API: `/payments/momo/ipn`** (không phải trang web, không phải `/payments/vnpay/ipn`).
- Với MoMo, `ipnUrl` được gửi **trong từng request create** (và nằm trong chữ ký), nên đổi tunnel chỉ cần đổi `.env` rồi khởi động lại API — không phải báo MoMo như VNPay. Lần thử đang mở (đã có `payUrl`) vẫn mang URL cũ: hãy tạo đơn mới sau khi đổi.
- Nếu dùng traffic policy chỉ mở đường IPN (như `ngrok-ipn-policy.yml` của tuần 12, chỉ cho `/payments/vnpay/ipn`), phải thêm `/payments/momo/ipn`, nếu không ngrok trả 404 cho MoMo.
- Kiểm tra trước khi thanh toán:

  ```bash
  curl -i -X POST https://<ten-mien-tinh>.ngrok-free.app/payments/momo/ipn \
       -H 'Content-Type: application/json' -d '{}'
  # → HTTP/1.1 400 {"message":"a required field is missing or malformed"}
  ```

  `400` ở đây là **đúng**: endpoint tới được, và từ chối dữ liệu không có chữ ký hợp lệ. (Tương tự, `GET /payments/vnpay/ipn` không tham số trả `RspCode 97 Invalid signature` — đó là câu trả lời đúng cho request không ký, không phải lỗi.)

## 6. Thực hiện một thanh toán sandbox

1. Đăng nhập web, chọn suất, giữ ghế → trang đơn → **"Thanh toán qua ví MoMo"**.
2. Web gọi `POST /payments/momo { bookingId }` (chỉ id; số tiền luôn lấy từ đơn trong DB) và chuyển trình duyệt sang `payUrl` của MoMo.
3. Trên trang MoMo test: quét QR bằng app MoMo test (hoặc phương thức test mà trang hiển thị) và xác nhận.
4. MoMo gọi IPN → API ghi `Payment` `SUCCESS`, đơn `CONFIRMED`, ghế `SOLD`, vé `ISSUED`, outbox `booking.confirmed`; worker tạo PDF, gửi email (xem ở Mailpit `http://localhost:8025`) và thông báo.
5. MoMo đưa trình duyệt về `/payment/result/momo?...`. Trang kết quả gửi nguyên query cho `GET /payments/momo/return` (chỉ hiển thị) rồi **đọc trạng thái đơn từ API** mỗi 3 giây tới khi có kết quả cuối; quá 2 phút thì hiện "Đang chờ xác nhận" với nút **Kiểm tra lại**. `resultCode=0` trên URL **không bao giờ** làm đơn thành đã trả.

Thử thêm: bấm hủy trên trang MoMo (→ IPN mã lỗi, `Payment` `FAILED`, đơn vẫn `PENDING`, thanh toán lại được), và bỏ trang không trả (→ worker hỏi MoMo khi đơn quá `holdUntil`, rồi cho hết hạn).

## 7. Xem IPN đến

- **ngrok inspector**: `http://127.0.0.1:4040` — thấy từng request MoMo gửi, body JSON, mã trả (`204` / `400` / `500`), và có nút *Replay*.
- **Log API** (pino): mỗi IPN một dòng `MoMo IPN: MoMo orderId … (transId …, resultCode …): payment … SUCCESS, booking … CONFIRMED, 2 ticket(s)`; từ chối thì `MoMo IPN 400: invalid signature (orderId …)`. Log **không** chứa secret key, access key, chữ ký hay nguyên payload.
- **DB**:

  ```sql
  SELECT id, status, txn_ref AS order_id, provider_request_id, provider_transaction_id,
         response_code, pay_url IS NOT NULL AS has_page, processed_at
  FROM payments WHERE provider = 'MOMO' ORDER BY created_at DESC LIMIT 10;
  -- raw_payload giữ nguyên body IPN (hoặc phản hồi query) đã xử lý.
  ```

## 8. Xử lý sự cố chữ ký

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Create trả `resultCode 13` (xác thực doanh nghiệp thất bại) | sai `MOMO_ACCESS_KEY`/`MOMO_SECRET_KEY`, khóa của môi trường khác (production vs test), thừa khoảng trắng/xuống dòng trong `.env` |
| Create trả `11` | merchant chưa được mở quyền cho API/luồng này trong M4B |
| IPN bị trả `400 invalid signature` | API đang chạy với khóa khác khóa đã tạo thanh toán; IPN của môi trường khác dùng chung tài khoản sandbox; proxy/tunnel sửa body |
| IPN `400 a required field is missing or malformed` | body không phải JSON object, hoặc thiếu một trong các trường được ký |
| IPN `204` nhưng đơn không đổi | log sẽ nói: `no MoMo payment has this orderId` (IPN của DB khác), `requestId … is not the one…`, `not final yet`, hoặc `expects amount …` (số tiền lệch) |

Quy tắc ký (để tự kiểm bằng tay):

- create: `accessKey, amount, extraData, ipnUrl, orderId, orderInfo, partnerCode, redirectUrl, requestId, requestType`
- IPN và redirect: `accessKey, amount, extraData, message, orderId, orderInfo, orderType, partnerCode, payType, requestId, responseTime, resultCode, transId`
- query: `accessKey, orderId, partnerCode, requestId`

Mỗi trường viết `tên=giá trị`, nối bằng `&`, đúng thứ tự trên; số nguyên viết dạng thập phân; **không** urlencode, **không** trim; `extraData` rỗng vẫn có mặt (`extraData=&`). Trường không có trong danh sách (`signature`, `lang`, `partnerUserId`…) không được ký. Tính lại bằng chính mẫu của MoMo:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/apps/api/src/modules/payment/momo/testing:/f:ro" \
  php:8.4-cli-alpine php /f/momo-reference.php
```

Phản hồi của create và của query **không** được kiểm chữ ký (định dạng chưa đọc được nguyên văn): `payUrl` chỉ để chuyển trình duyệt, còn câu trả lời query chỉ được tin khi đến qua HTTPS từ `MOMO_ENDPOINT`, đúng `orderId`, đúng `partnerCode`, đúng `requestId` của chính lần hỏi, `resultCode 0` và có `transId`; số tiền còn được kiểm lại dưới khóa dòng `payments`. Trạng thái tiền chỉ đổi bởi IPN có chữ ký hợp lệ hoặc câu trả lời query như trên.

## 9. Lên production an toàn

1. Lấy bộ khóa **production** trong M4B (khác khóa test); đặt bằng biến môi trường/secret manager của máy chủ, không qua file commit.
2. `MOMO_ENDPOINT=https://payment.momo.vn`. Giữ HTTPS: câu trả lời query được tin dựa trên TLS tới endpoint này.
3. `MOMO_IPN_URL` = domain production cố định (HTTPS), trỏ thẳng tới `/payments/momo/ipn`; `MOMO_REDIRECT_URL` = `https://<web>/payment/result/momo`.
4. Nếu đặt sau reverse proxy, cấu hình `TRUST_PROXY` và đảm bảo proxy chuyển nguyên body JSON. Không đặt rate limit hay xác thực JWT trước IPN (đã `@Public`, chữ ký là lớp bảo vệ).
5. Kiểm tra bằng một giao dịch nhỏ trước, đối chiếu `provider_transaction_id` với lịch sử giao dịch trên M4B.
6. Hoàn tiền (đơn `NEEDS_REVIEW`, `Payment` `REFUND_REQUIRED`) **làm tay** trên M4B bằng `transId` (`provider_transaction_id`, hiện ở trang admin "Cần xử lý"). Không có API hoàn tiền trong dự án.

## 10. Hành vi đã chốt (tự quyết, chờ duyệt — xem ROADMAP "Đã chốt")

- **Một lần thử MoMo đang mở cho mỗi đơn**: gọi lại khi `Payment` MoMo còn `PENDING` thì nhận lại đúng lần đó (`reused: true`, cùng `orderId`, cùng `payUrl`), không mở order MoMo thứ hai; các lần tạo MoMo của cùng đơn xếp hàng trên khóa `FOR NO KEY UPDATE` của dòng đơn. Một lần VNPay và một lần MoMo có thể cùng mở (khách đổi cổng); trả cả hai → lần sau `REFUND_REQUIRED` như VNPay.
- **Timeout khi create**: lần thử giữ `PENDING`, `503 PAYMENT_PROVIDER_UNAVAILABLE`; lần bấm sau gửi lại **y nguyên** request (cùng `requestId`) — MoMo trả lời idempotent theo `requestId`, nên không bao giờ tạo order thứ hai.
- **MoMo từ chối create** (mã lỗi cuối): lần thử `FAILED` (nó chưa từng có trang thanh toán), `502 PAYMENT_PROVIDER_ERROR`; lần sau mở lần thử mới.
- **IPN**: `204` khi đã xử lý (ghi nhận, lặp lại, chưa cuối, hoặc order không có ở đây); `400` khi không xác minh được (body sai, chữ ký sai, `partnerCode` khác); `500` khi lỗi bất ngờ (không ghi gì). Mã chưa cuối (`1000`, `7000`, `7002`, `8000`, `9000`) không ghi gì.
- **Số tiền**: `amount` (đồng) phải bằng đúng `payments.amount`; lệch → không ghi gì, log `error`, `204`.
- **Ngoài hạn mức ví** (< 1.000 hoặc > 50.000.000 đ): `422 PAYMENT_AMOUNT_NOT_SUPPORTED`, web gợi ý VNPay.
- **Worker hết hạn** hỏi MoMo (query) cho lần thử MoMo `PENDING`, VNPay (querydr) cho lần thử VNPay; chỉ `resultCode 0` đúng order mới ghi tiền thay vì cho hết hạn.
- Không có cột `currency`: mọi số tiền là VND nguyên đồng (PLAN §3), cả hai cổng chỉ nhận VND.

## 11. Đã kiểm gì, chưa kiểm gì (22/11/2026)

| Mức | Trạng thái |
|---|---|
| Unit test (chữ ký theo mẫu PHP của MoMo, client, service) | **pass** |
| Integration test với MoMo giả qua HTTP thật (Postgres + Redis thật) | **pass** |
| Gọi API create của **sandbox MoMo thật** | **chưa chạy** — repo chưa có credentials sandbox của chủ dự án |
| IPN thật từ sandbox MoMo qua ngrok | **chưa chạy** |
| Thanh toán sandbox end-to-end tới PDF/email | **chưa chạy** |

Việc còn lại cho chủ dự án: đăng ký M4B test, điền ba khóa vào `.env`, chạy ngrok, làm §6, ghi kết quả vào bảng trên (giờ, `orderId`, `transId`, mã IPN API trả, trạng thái đơn).
