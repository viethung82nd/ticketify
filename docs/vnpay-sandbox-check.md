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
