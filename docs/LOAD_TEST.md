# Load test — kết quả đo thật

Báo cáo của ROADMAP 6.6. **Mọi con số ở đây đã đo thật** ngày 24/11/2026 bằng k6, trên một máy;
mỗi số trỏ về thư mục kết quả thô (`summary.json` của k6, CPU, kiểm SQL). Cách chạy lại:
[load-tests/README.md](../load-tests/README.md).

## Tóm tắt

- **Không bán trùng.** Sau **mọi** lần chạy (40 lần, kể cả 13 lần thăm dò), kiểm SQL
  [`verify-no-duplicates.sql`](../load-tests/sql/verify-no-duplicates.sql) ra 0 vi phạm: không vé
  sống trùng ghế, không ghế thuộc hai đơn sống, không giữ ghế dở dang. Postgres ghi 0 deadlock, log
  API không có response 5xx nào.
- Với `DATABASE_POOL_MAX=10` (mặc định production), 1 API + 1 worker, trên máy 4 lõi chung với k6
  và Postgres:
  - traffic hỗn hợp **150 lượt/s (khoảng 243 req/s), 0 % lỗi**; p95 của các GET 131–357 ms, giữ ghế
    712 ms (sau 6.3);
  - suất hot: đến **150 lượt/s (151 req/s) 0 % lỗi**; trần khoảng **188 req/s** ở 200 lượt/s
    (sau 6.3), vẫn 0 % lỗi HTTP nhưng k6 phải bỏ lượt.
- Nút thắt là **CPU của tiến trình Node**, không phải Postgres hay pool: mọi truy vấn công khai chạy
  dưới 1 ms trong Postgres. Viết lại sơ đồ ghế bằng một câu SQL (6.3) nâng trần endpoint đó từ khoảng
  175 lên khoảng 206–213 req/s; pool 20 không giúp, ở traffic hỗn hợp còn tệ hơn.

## Cấu hình

| Thành phần | Giá trị |
|---|---|
| Máy (duy nhất) | Intel Core i5-11320H (4 lõi, 8 luồng, 3,2 GHz), RAM 19,7 GB, Windows 11 Home 10.0.26300 |
| Docker | Docker Desktop, engine 28.1.1, VM WSL2 8 CPU / 9,6 GiB |
| Postgres | 16.15 trong Docker, `max_connections` 100, `shared_buffers` 128 MB, `work_mem` 4 MB; DB tạm khoảng 414 MB |
| Redis | 7.4.12 trong Docker |
| API + worker | 1 + 1 tiến trình Node v24.14.0 trên Windows, bản build, `NODE_ENV=production`, `LOG_LEVEL=info`, **`DATABASE_POOL_MAX=10`** |
| Máy phát tải | k6 2.4.0 (`grafana/k6:2.4.0`) trong Docker, **cùng máy**, gọi API qua `host.docker.internal` |
| Dữ liệu | 3 000 suất, 576 000 `showtime_seats`, 5 003 user, 167 328 booking, 223 104 vé, 111 552 payment |
| Executor | `constant-arrival-rate` (tải đặt ra không giảm khi server chậm; lượt k6 không kịp bắt đầu là `dropped_iterations`) |

## Giới hạn (đọc trước khi dùng số)

- **Máy phát tải và máy chủ là một máy 4 lõi.** k6, API, worker, Postgres và Redis tranh nhau CPU;
  số đo vì vậy thấp hơn khi tách máy, và độ trễ không gồm mạng thật. PLAN muốn tách máy phát tải;
  chưa làm được. CPU của k6 được đo ở mọi lần chạy hợp lệ: tối đa khoảng 0,9 lõi.
- Hai lỗi của script k6 từng làm chính k6 thành nút thắt (5–6 lõi). 13 lần chạy khi đó nằm ở
  [results/exploratory/](../load-tests/results/exploratory/README.md) và **không** dùng ở đây.
- Mỗi mức tải chạy một lần (riêng suất hot 150 lượt/s sau 6.3 chạy ba lần và không đồng nhất, ghi
  cả ba). Không có khoảng tin cậy.
- Token ký sẵn: không đo login. Không đo thanh toán, IPN, PDF, email (cần cổng thật và SMTP).
- Không lần nào dùng pool 40. Các lần pool 20 ghi rõ là thử nghiệm.

## Kịch bản

| Kịch bản | Một lượt (iteration) |
|---|---|
| [`hot-showtime.js`](../load-tests/hot-showtime.js) | Một khách vào **một** suất 192 ghế: xem sơ đồ ghế, nếu còn ghế thì giữ 1–4 ghế liền nhau. Suất kín sau vài giây; phần lớn lượt sau đó là tải lại sơ đồ ghế. `409` (thua cuộc đua) không tính là lỗi |
| [`mixed-traffic.js`](../load-tests/mixed-traffic.js) | Một khách làm một việc trên mọi suất tương lai: 35 % danh sách/tìm phim, 20 % chi tiết + ngày chiếu, 25 % lịch chiếu + sơ đồ ghế, 5 % "vé của tôi", 15 % giữ ghế (1/3 trong số đó hủy). Trung bình khoảng 1,6 request mỗi lượt |
| [`seat-map.js`](../load-tests/seat-map.js) | Chỉ `GET /showtimes/:id/seats`, dùng để so trước/sau ở 6.3 |

## Kết quả 6.2 (trước tối ưu)

Thô: [load-tests/results/](../load-tests/results/README.md). CPU là trung bình / đỉnh, % **một** lõi.

**Suất hot**

| Lượt/s | req/s | Lỗi | Lượt bị bỏ | p95 sơ đồ ghế | p99 sơ đồ ghế | p95 giữ ghế | CPU API | CPU Postgres |
|---|---|---|---|---|---|---|---|---|
| 25 | 25,9 | 0 % | 0 | 13,3 ms | 21,7 ms | 31,7 ms | 11 / 29 % | 7 / 20 % |
| 50 | 51,0 | 0 % | 0 | 15,5 ms | 24,2 ms | 72,4 ms | 22 / 60 % | 16 / 77 % |
| 100 | 101,5 | 0 % | 17 | 35,4 ms | 286 ms | 558 ms | 49 / 88 % | 33 / 86 % |
| 150 | 151,0 | 0 % | 63 | 221 ms | 353 ms | 824 ms | 84 / 110 % | 64 / 86 % |
| 200 | 156,5 | 0 % | 5 072 | 3,44 s | 3,50 s | 1,36 s | 106 / 129 % | 69 / 86 % |

**Traffic hỗn hợp** (p95 theo endpoint)

| Lượt/s | req/s | Lỗi | Danh sách phim | Tìm phim | Chi tiết phim | Lịch chiếu | Sơ đồ ghế | Vé của tôi | Giữ ghế | Hủy | CPU API | CPU Postgres |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 25 | 41,1 | 0 % | 13,6 ms | 16,7 ms | 9,1 ms | 8,4 ms | 17,9 ms | 36,6 ms | 47,2 ms | 22,0 ms | 14 / 28 % | 10 / 18 % |
| 50 | 81,3 | 0 % | 12,7 ms | 14,4 ms | 7,7 ms | 7,3 ms | 16,3 ms | 25,1 ms | 47,2 ms | 25,3 ms | 24 / 44 % | 18 / 26 % |
| 100 | 162,5 | 0 % | 28,8 ms | 33,3 ms | 17,2 ms | 13,6 ms | 30,8 ms | 59,6 ms | 96,1 ms | 52,0 ms | 53 / 76 % | 44 / 66 % |
| 150 | 242,3 | 0 % | 193 ms | 336 ms | 442 ms | 160 ms | 587 ms | 246 ms | 823 ms | 215 ms | 89 / 112 % | 82 / 102 % |

## Tối ưu 6.3

Chi tiết và file thô: [results/6.3-seat-map/README.md](../load-tests/results/6.3-seat-map/README.md).

- `EXPLAIN (ANALYZE, BUFFERS)` 9 nhóm truy vấn nóng
  ([explain-hot-queries.txt](../load-tests/results/6.3-seat-map/explain-hot-queries.txt)): mọi truy
  vấn công khai 0,01–0,9 ms. Báo cáo doanh thu admin 30 ngày 221 ms; partial index thử nghiệm
  ([explain-revenue-index-trial.txt](../load-tests/results/6.3-seat-map/explain-revenue-index-trial.txt))
  không cải thiện (188–228 ms), nên **không thêm index**.
- Sơ đồ ghế: 5 câu Prisma → 1 câu SQL.

| Sơ đồ ghế, req/s | p95 trước | p95 sau | Đạt được trước → sau | CPU API trước → sau |
|---|---|---|---|---|
| 50 | 53,6 ms | 12,7 ms | 50,0 → 50,0 | 26 → 15 % |
| 100 | 26,2 ms | 16,7 ms | 100,0 → 100,0 | 42 → 36 % |
| 150 | 235,6 ms | 23,8 ms | 149,6 → 147,0 | 72 → 51 % |
| 200 | 1,90 s | 85,8 ms | 175,3 → 199,9 | 93 → 74 % |
| 250 / 300 | – | 1,60 s / 1,57 s | – → 206,0 / 213,2 | – → 94 / 97 % |

- Đầu-cuối sau 6.3: hỗn hợp 150 lượt/s 243,3 req/s, p95 sơ đồ ghế **587 → 139 ms**, giữ ghế 823 →
  712 ms, danh sách phim 193 → 174 ms; suất hot 200 lượt/s **156,5 → 187,5 req/s**. Suất hot 150
  lượt/s sau 6.3: một lần dồn hàng (p95 sơ đồ ghế 4,62 s), hai lần sạch (p95 52–137 ms).
- Pool 20 (thử nghiệm): hỗn hợp 150 lượt/s tệ hơn pool 10 (p95 giữ ghế 712 ms → 1,28 s, Postgres
  trung bình 79 → 103 %); suất hot không đổi đáng kể. Giữ **pool 10**.

## Đọc số

- **p95 giữ ghế của suất hot** (0,6–6 s tùy lần) mô tả **đợt mở bán**: khoảng 110–430 request giữ
  ghế của một lần chạy dồn vào vài giây đầu, khi khoảng 150 khách cùng thấy ghế trống, và xếp hàng
  chờ 10 kết nối. Giữ ghế lúc bình thường: p95 47–96 ms ở hỗn hợp 25–100 lượt/s.
- Gần trần, độ trễ tăng vọt thay vì tăng dần (suất hot 150 → 200 lượt/s: p95 sơ đồ ghế 221 ms →
  3,44 s), vì `constant-arrival-rate` tiếp tục dồn tải khi server đã bão hòa. Hệ thống không trả
  lỗi, chỉ chậm; số lượt k6 bỏ cho biết phần tải không được phục vụ.
- Muốn số đo cao hơn và đáng tin hơn: tách máy phát tải, chạy API nhiều tiến trình (PLAN mục 11 chỉ
  bật API thứ hai khi thử phân phối tải), và lặp mỗi mức vài lần.
