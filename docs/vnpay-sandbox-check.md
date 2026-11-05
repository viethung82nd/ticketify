# Kiểm tra chữ ký VNPay trên sandbox

Tài liệu VNPay không công bố secret của các chữ ký mẫu, nên test trong repo chỉ khóa được chuỗi đã ký (đối chiếu với đoạn PHP mẫu, `testing/vnpay-reference.php`). Bản ghi này xác nhận chữ ký trên chính sandbox VNPay, dùng cấu hình merchant sandbox thật trong `.env`.

Cách làm: API chạy với `.env` thật (`VNPAY_PAYMENT_URL` = `sandbox.vnpayment.vn`), một user test mới giữ một ghế (đơn `PENDING` mới), gọi `POST /payments/vnpay`, rồi mở `paymentUrl` một lần bằng Chromium (Playwright) và chỉ xem trang đầu tiên VNPay hiển thị. Không chọn phương thức, không nhập thẻ, không OTP. URL và chữ ký không được lưu ở đây.

## Kết quả — 29/10/2026

| Giờ (GMT+7) | `txnRef`               | Đơn          | Số tiền                    | URL     | Kết quả                                                                                                                    |
| ----------- | ---------------------- | ------------ | -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 16:03:55    | `0z6EXnrTPDXaTi3ujoW5` | `DYQAMCFUKD` | 75 000 đ (`vnp_Amount` 7 500 000) | 534 ký tự | **Chấp nhận**: chuyển tới `paymentv2/Transaction/PaymentMethod.html`, "Chọn phương thức thanh toán (Test)"                 |
| 16:04:14    | `Bq2qmIzmEDBQ2nWyKR55` | `5X8BN3XXMH` | 75 000 đ (`vnp_Amount` 7 500 000) | 534 ký tự | **Chấp nhận** (chờ thêm 10 giây sau khi tải, trang vẫn như trên, không có thông báo lỗi)                                 |
| 16:04:40    | `b9l3j9dpGlv51bV8GSkV` | `DURCPWNU5E` | đối chứng                  | 534 ký tự | Đối chứng âm: tăng `vnp_Amount` thêm 100 **sau khi ký** → `paymentv2/Payment/Error.html`, "Sai chữ ký" (mã tra cứu `OD42pBcGHd`) |

Kết luận: sandbox chấp nhận chữ ký do API tạo ra, và từ chối cùng URL đó khi một tham số bị sửa sau khi ký, nên trang chọn phương thức ở hai lần đầu đúng là kết quả của bước kiểm chữ ký.

Ghi chú:

- Trang đầu tiên của VNPay hiện tại là trang chọn phương thức thanh toán; số tiền và mã đơn chỉ hiện ở bước sau (sau khi chọn phương thức), nên không được xem ở đây. Số tiền được kiểm ở phía API: `vnp_Amount` = `total × 100`.
- Ba đơn trên là dữ liệu test (user `pw11-sbx-*` / `pw11-sbxneg-*@test.local`), không được thanh toán và đã được dọn khỏi DB dev sau khi kiểm tra.
- IPN chưa có (tuần 12): kể cả khi thanh toán thành công, đơn vẫn `PENDING` cho tới khi IPN ghi kết quả.

## IPN qua tunnel — 29/10/2026 (tuần 12, chưa hoàn tất)

Mục tiêu (ROADMAP 3.6): VNPay sandbox gọi IPN thật của API qua một tunnel HTTPS, sau một lần thanh toán bằng thẻ test NCB.

| Giờ (UTC)      | Bước                                                                   | Kết quả                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 12:55          | API (`node dist/main.js`, `.env` thật, cổng 3000) + `cloudflared tunnel --url http://localhost:3000` (2026.10.5) | Tunnel nhanh được cấp một tên `*.trycloudflare.com` ngẫu nhiên; lần gọi đầu `530` (DNS của tên mới chưa sẵn sàng)                                      |
| 12:56:11       | `GET https://<tunnel>/payments/vnpay/ipn` không tham số               | HTTP 200 `{"RspCode":"97","Message":"Invalid signature"}`                                                                                        |
| 12:58:00       | Cùng URL với `vnp_SecureHash` giả (128 ký tự)                         | `97`; log request của API ghi `vnp_SecureHash=[redacted]` ở cả `url` và `query`, chuỗi hash không xuất hiện trong log                             |
| —              | Thanh toán thật bằng thẻ test                                          | **Không làm.** URL IPN do VNPay lưu theo merchant; tên tunnel mới không thể khớp URL đã gửi VNPay trước đó (tunnel nhanh đổi tên mỗi lần chạy, máy này không có named tunnel). Theo brief: dừng, chờ chủ dự án cập nhật URL IPN với VNPay |

Tunnel và API đã tắt sau khi kiểm. Phát hiện kèm theo: trước bản sửa, log request của pino-http ghi nguyên `req.url` và `req.query`, tức là cả `vnp_SecureHash` của trang return (từ tuần 11) và của IPN; đã sửa bằng serializer `src/config/log-redaction.ts`. Bản sửa lúc đó thay giá trị bằng `[redacted]` (dòng 12:58:00 ở trên); sau đó serializer bỏ hẳn tham số, cả tên lẫn giá trị, và có test chụp log thật (`test/integration/payment-logs.int-spec.ts`).

Còn lại khi có URL IPN đúng: thanh toán thẻ test NCB → ghi giờ IPN đến, `RspCode` API trả, trạng thái đơn; bật tạm một cờ dev (không commit) để IPN trả 500 và đếm số lần, khoảng cách VNPay gọi lại (tài liệu: tối đa 10 lần, cách 5 phút); hủy trên trang VNPay → đơn `PENDING`, `Payment` `FAILED`, ghế giữ tới `holdUntil`, ghi lại `vnp_TransactionNo` VNPay gửi cho giao dịch bị hủy.

**Bộ kịch bản IPN chính thức của VNPay (trang SIT).** Trang `https://sandbox.vnpayment.vn/vnpaygw-sit-testing/user/login` tồn tại (HTTP 200 ngày 29/10/2026) và chỉ cho xem kịch bản sau khi đăng nhập bằng email và mật khẩu merchant. Claude không đăng nhập; **đang chờ chủ dự án** tự đăng nhập và chạy các kịch bản IPN ở đó, cùng với việc gửi URL IPN cố định cho VNPay.

## Mã phản hồi IPN và test — 29/10/2026

Mỗi dòng là một mã phản hồi (hoặc một nhóm kiểm tra không gắn với một mã) trong một file test. Các cột:

- **`RspCode`**: mã API trả cho VNPay; `99` đi kèm HTTP 500, mọi mã khác đi kèm HTTP 200. `—` là nhóm kiểm tra không gắn với một mã.
- **Trường hợp**: điều API kiểm. Nhánh A: đơn `PENDING`, mọi ghế còn `HELD` cho đơn. Nhánh B: đơn `EXPIRED`, giành lại được mọi ghế. Nhánh C: không giữ được ghế (hoặc suất đã hủy hay đã kết thúc), đơn `NEEDS_REVIEW` (PLAN §5).
- **File test**: đường dẫn trong `apps/api`; `*.spec.ts` là unit test (transaction giả), `*.int-spec.ts` là integration test (Postgres và Redis thật).
- **Số test pass**: số test của dòng đó, trong file đó, đã pass ở lần chạy ngày 29/10/2026 (Windows, và 3 lần liên tiếp trên Linux).
- **Tổng số test**: số test của dòng đó trong file đó.
- **Sandbox**: kết quả trên sandbox VNPay thật. "Chưa chạy" nghĩa là chưa có IPN thật nào (xem mục "Thanh toán thật bằng thẻ test" bên dưới).

| `RspCode` | Trường hợp | File test | Số test pass | Tổng số test | Sandbox |
| --- | --- | --- | --- | --- | --- |
| `97` | Sai chữ ký, kiểm trước mọi thứ, không ghi gì | `src/modules/payment/payment-ipn.spec.ts` | 3 | 3 | Qua tunnel HTTPS: `97` cho request không có chữ ký (12:56:11 UTC) và cho chữ ký giả (12:58:00 UTC) |
| `97` | Sai chữ ký, kiểm trước mọi thứ, không ghi gì | `test/integration/payment-ipn.int-spec.ts` | 3 | 3 | Như dòng trên |
| `01` | Không có `vnp_TxnRef`, hoặc không có `Payment` nào khớp | `src/modules/payment/payment-ipn.spec.ts` | 2 | 2 | Chưa chạy |
| `01` | Không có `Payment` nào khớp | `src/modules/payment/confirm-payment.spec.ts` | 1 | 1 | Chưa chạy |
| `01` | Không có `vnp_TxnRef`, hoặc không có `Payment` nào khớp | `test/integration/payment-ipn.int-spec.ts` | 2 | 2 | Chưa chạy |
| `04` | `vnp_Amount` khác `amount × 100` (kiểm trước trạng thái) | `src/modules/payment/confirm-payment.spec.ts` | 6 | 6 | Chưa chạy |
| `04` | `vnp_Amount` khác `amount × 100` | `test/integration/payment-ipn.int-spec.ts` | 2 | 2 | Chưa chạy |
| `04` và `02` | Một test kiểm cả hai mã, lấy từ `confirmPayment` | `src/modules/payment/payment-ipn.spec.ts` | 1 | 1 | Chưa chạy |
| `02` | `Payment` đã `SUCCESS`, `FAILED` hoặc `REFUND_REQUIRED` | `src/modules/payment/confirm-payment.spec.ts` | 3 | 3 | Chưa chạy |
| `02` | IPN lặp lại (2 lần nối tiếp, 10 lần đồng thời), thành công sau thất bại | `test/integration/payment-ipn.int-spec.ts` | 3 | 3 | Chưa chạy |
| `00` | Chưa trả: `Payment` `FAILED`, đơn giữ nguyên | `src/modules/payment/confirm-payment.spec.ts` | 3 | 3 | Chưa chạy |
| `00` | Chưa trả: `Payment` `FAILED`, không phát sự kiện ghế | `src/modules/payment/payment-ipn.spec.ts` | 1 | 1 | Chưa chạy |
| `00` | Chưa trả: `Payment` `FAILED`, đơn `PENDING`, thanh toán lại được | `test/integration/payment-ipn.int-spec.ts` | 3 | 3 | Chưa chạy |
| `00` | Trả hai lần: `Payment` thứ hai `REFUND_REQUIRED`, outbox `payment.refund_required`, đơn không đổi | `src/modules/payment/confirm-payment.spec.ts` | 2 | 2 | Chưa chạy |
| `00` | Trả hai lần: như trên, IPN lặp lại của `Payment` đó trả `02` | `test/integration/payment-ipn.int-spec.ts` | 1 | 1 | Chưa chạy |
| `00` | Đã trả, nhánh A hoặc B: `CONFIRMED`, ghế `SOLD`, vé `ISSUED` (kể cả suất đã bắt đầu, chưa kết thúc) | `src/modules/payment/confirm-payment.spec.ts` | 5 | 5 | Chưa chạy |
| `00` | Đã trả, nhánh A: `seat:sold` sau commit | `src/modules/payment/payment-ipn.spec.ts` | 1 | 1 | Chưa chạy |
| `00` | Đã trả, nhánh A hoặc B (kể cả suất đã bắt đầu, chưa kết thúc) | `test/integration/payment-ipn.int-spec.ts` | 5 | 5 | Chưa chạy |
| `00` | Đã trả, nhánh C: `NEEDS_REVIEW`, nhả ghế `HELD` của chính đơn; gồm suất đã kết thúc (`SHOWTIME_ENDED`) | `src/modules/payment/confirm-payment.spec.ts` | 6 | 6 | Chưa chạy |
| `00` | Đã trả, nhánh C: `seat:released` sau commit | `src/modules/payment/payment-ipn.spec.ts` | 1 | 1 | Chưa chạy |
| `00` | Đã trả, nhánh C, gồm một ghế `SOLD` cho đơn khác (ghế còn lại của đơn về `AVAILABLE`, ghế `SOLD` không đổi) và suất đã kết thúc | `test/integration/payment-ipn.int-spec.ts` | 6 | 6 | Chưa chạy |
| `99` | Lỗi không lường trước (dữ liệu sai lệch, đổi ít dòng hơn dự kiến): rollback | `src/modules/payment/confirm-payment.spec.ts` | 3 | 3 | Chưa chạy |
| `99` | Thiếu `VNPAY_HASH_SECRET`; controller trả HTTP 500 khi service ném lỗi | `src/modules/payment/payment-ipn.spec.ts` | 2 | 2 | Chưa chạy |
| `99` | Mã vé trùng, vé sống có sẵn (partial unique), thiếu secret: không ghi gì | `test/integration/payment-ipn.int-spec.ts` | 3 | 3 | Chưa chạy |
| — | Khóa `payments` `FOR UPDATE` theo `txn_ref` trước mọi thứ | `src/modules/payment/confirm-payment.spec.ts` | 1 | 1 | — |
| — | Controller luôn trả HTTP 200 với câu trả lời của service | `src/modules/payment/payment-ipn.spec.ts` | 1 | 1 | — |
| — | `reclaimSeatsForExpiredBooking` gọi trực tiếp (3.5), tất cả hoặc không, gồm suất đã kết thúc | `src/modules/payment/reclaim-seats.spec.ts` | 10 | 10 | — |
| — | `reclaimSeatsForExpiredBooking` gọi trực tiếp (3.5), tất cả hoặc không | `test/integration/payment-ipn.int-spec.ts` | 4 | 4 | — |
| — | Đua 20 vòng: IPN với hủy, với hết hạn, với giữ ghế của người khác | `test/integration/payment-ipn.int-spec.ts` | 3 | 3 | — |
| — | Quy tắc ghế của nhánh A, B, C, kiểm tra suất (hủy, đã kết thúc) và mã vé | `src/modules/payment/seat-settlement.spec.ts` | 22 | 22 | — |
| — | Cặp `RspCode` và `Message`; điều kiện "đã trả" (`vnp_ResponseCode` và `vnp_TransactionStatus` đều `00`) | `src/modules/payment/vnpay/vnpay-ipn.spec.ts` | 10 | 10 | — |
| — | Log của trang return và IPN (qua `97`, `04`, `00`, `02`, `99`) không chứa chữ ký, `vnp_SecureHash`, `HashSecret` hay secret | `test/integration/payment-logs.int-spec.ts` | 1 | 1 | — |
| — | Bỏ `vnp_SecureHash` khỏi `url` và `query` của log request | `src/config/log-redaction.spec.ts` | 5 | 5 | — |

Theo file: `confirm-payment.spec.ts` 30 test, `payment-ipn.spec.ts` 12, `reclaim-seats.spec.ts` 10, `seat-settlement.spec.ts` 22, `vnpay-ipn.spec.ts` 10, `log-redaction.spec.ts` 5, `payment-ipn.int-spec.ts` 35, `payment-logs.int-spec.ts` 1; tất cả đều pass.

## Thanh toán thật bằng thẻ test — 29/10/2026 (không thực hiện được)

Cách làm được chọn để tiến mà không cần URL IPN cố định: thanh toán (và hủy) một đơn `PENDING` thật bằng thẻ test NCB, chặn lần trình duyệt quay về `VNPAY_RETURN_URL` (tham số do VNPay ký, giống hệt tham số IPN theo `pay.html`), rồi gửi nguyên bộ tham số đó tới return và IPN của API local. Cách này kiểm được chữ ký và giá trị thật của VNPay với IPN của mình, không kiểm được việc VNPay tự gọi IPN và retry.

| Giờ (UTC) | Bước | Kết quả |
| --- | --- | --- |
| 14:19 | Mở URL thanh toán của 3 đơn thử (`pw12-explore-*`) bằng Chromium để dò trang | `PaymentMethod.html` → "Thẻ nội địa và tài khoản ngân hàng" → nút `#NCB` → `paymentv2/Ncb/Transaction/Index.html`: ô `#card_number_mask`, `#cardHolder`, `#cardDate`, nút `#btnContinue`, liên kết "Hủy thanh toán". Không nhập thẻ, không gửi gì |
| ~14:25 | Chạy bước nhập thẻ test và OTP | **Bị chặn** bởi chính sách quyền của phiên Claude (xếp vào "giao dịch thực tế"). Không lách; luồng hủy trên VNPay cũng không chạy |
| sau đó | Dọn dữ liệu | Xóa 3 user `pw12-explore-*`, 3 đơn, 3 `Payment` `PENDING` (chưa trả), trả 3 ghế về `AVAILABLE` |

Script và hướng dẫn để chủ dự án tự chạy (ngoài repo): `C:\NestJsProject\ticketify-week12\` (`sandbox-pay.cjs pay|cancel <showtimeId>`, `cleanup.sql`). Script không in URL thanh toán, chữ ký hay secret.
