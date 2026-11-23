# Lần chạy thăm dò (24/11/2026) — không dùng làm kết quả

Các lần chạy này là số đo thật, nhưng **máy phát tải (k6) là nút thắt**, không phải Ticketify:
k6 chạy cùng máy với API, worker và Postgres, nên khi k6 tốn CPU thì nó vừa không giữ nổi tải đặt
ra (`dropped_iterations` lớn) vừa giành CPU của server. Giữ lại vì chúng cho thấy vì sao script được
sửa, và để ai đo lại có thể so sánh.

| Thư mục | Lỗi trong script k6 lúc đó | Dấu hiệu trong số đo |
|---|---|---|
| `1-k6-parsed-full-json/` | (a) mỗi lượt parse toàn bộ sơ đồ ghế 31 KB bằng `res.json('seats')` trong JS engine của k6; (b) như dòng dưới. Bốn lần đầu (180147Z–181006Z) chưa lấy mẫu CPU của k6 | 100 lượt/s: k6 dùng trung bình 587 % CPU (gần 6 lõi), API 57 %, Postgres 50 %; thông lượng dừng ở khoảng 78 req/s; 2 307 lượt bị bỏ |
| `2-k6-decoded-whole-data-file/` | đã lọc ghế trống bằng GJSON (trong Go), nhưng `loadData()` đọc `SharedArray[0]` chứa **cả file dữ liệu** (≈ 1,5 MB, 5 000 token); k6 giải mã lại phần tử SharedArray ở mỗi lần đọc, tức mỗi lượt | 100–200 lượt/s: k6 dùng khoảng 470–500 % CPU, thông lượng dừng ở 65–71 req/s, p95 sơ đồ ghế 1,3–1,6 s trong khi phía server (log pino) p95 chỉ khoảng 160 ms |

Cả hai lỗi đã sửa trong `lib/common.js` (GJSON cho ghế trống; mỗi danh sách một SharedArray, đọc
từng phần tử). Ở mọi lần chạy trong thư mục này, kiểm SQL sau khi chạy đều ra 0 vi phạm và 0
deadlock: kết luận về tính đúng đắn vẫn đứng, chỉ số hiệu năng thì không.
