# Kết quả load test — ROADMAP 6.2 (24/11/2026)

Số đo thật, chạy bằng `load-tests/run.sh` theo [load-tests/README.md](../README.md). Mỗi thư mục
`<thời điểm UTC>-<kịch bản>-r<rate>/` là một lần chạy, gồm `meta.json`, `summary.json` (summary thô
của k6), `k6-stdout.txt`, `verify.txt`, `docker-stats.csv`, `processes.csv`. Bảng dưới được sinh từ
các file đó bằng `node load-tests/tools/summarize.mjs` và có thể sinh lại bất cứ lúc nào.

Thư mục `exploratory/` chứa các lần chạy khi script k6 còn lỗi và **k6 là nút thắt**: không dùng làm
kết quả hiệu năng (giải thích trong [exploratory/README.md](exploratory/README.md)).

## Cấu hình (giống nhau ở mọi lần chạy)

| Thành phần | Giá trị |
|---|---|
| Máy (duy nhất) | Intel Core i5-11320H (4 lõi, 8 luồng, 3,2 GHz), RAM 19,7 GB, Windows 11 Home 10.0.26300 |
| Docker | Docker Desktop, engine 28.1.1, VM WSL2 8 CPU / 9,6 GiB |
| Postgres | 16.15 (container docker-compose), `max_connections` 100, `shared_buffers` 128 MB, `work_mem` 4 MB (mặc định của image); DB tạm `ticketify_load01`, khoảng 414 MB |
| Redis | 7.4.12 (container docker-compose), DB 14 |
| API + worker | 1 API + 1 worker, Node v24.14.0 chạy trực tiếp trên Windows, bản build `tsc`, `NODE_ENV=production`, `LOG_LEVEL=info` (pino ghi mỗi request ra file); **`DATABASE_POOL_MAX=10`** (mặc định production) |
| Máy phát tải | k6 2.4.0 (`grafana/k6:2.4.0`) trong Docker trên **cùng máy**, gọi API qua `host.docker.internal:3100` |
| Dữ liệu | seed `loadtest:seed` mặc định: 3 000 suất, 576 000 `showtime_seats`, 5 003 user, 167 328 booking, 223 104 vé, 111 552 payment |
| Thời lượng | suất hot 2 phút mỗi mức, hỗn hợp 3 phút mỗi mức, nghỉ khoảng 20 giây giữa hai lần |

`HOLD_TTL_SECONDS` 600, `BOOKING_RATE_LIMIT_MAX` 10 mỗi 60 giây: 5 000 user được dùng xoay vòng nên
không request nào bị `429`. Không số nào ở đây đo với pool 40.

## Giới hạn (đọc trước khi dùng số)

- **k6, API, worker, Postgres và Redis cùng một máy 4 lõi.** Số đo vì vậy thấp hơn khi tách máy phát
  tải, và độ trễ không gồm mạng thật. CPU của k6 được ghi ở cột "CPU k6": trong các lần chạy dưới
  đây k6 dùng tối đa khoảng 0,7 lõi.
- CPU API/Postgres/k6 trong bảng là **trung bình / đỉnh**, tính theo % **một** lõi (100 % = một lõi
  bận hẳn); API và worker lấy mẫu mỗi 2 giây, container mỗi khoảng 5 giây.
- Token ký sẵn (không đo login). Không đo thanh toán, IPN, PDF, email.
- Một lần chạy mỗi mức tải, không lặp lại để lấy khoảng tin cậy.

## Kết luận

1. **Không bán trùng.** Sau cả 9 lần chạy (và 13 lần thăm dò), `sql/verify-no-duplicates.sql` cho 0
   ở mọi quy tắc: không vé sống trùng ghế, không ghế thuộc hai đơn sống, không giữ ghế dở dang, không
   ghế `HELD` của đơn đã kết thúc. Postgres báo 0 deadlock (`pg_stat_database.deadlocks`) trên DB tạm
   suốt đợt đo. Log API không có response 5xx nào.
2. **Suất hot:** đến 150 lượt/s (151 req/s) không lỗi, p95 sơ đồ ghế 221 ms, p95 giữ ghế 824 ms. Ở
   200 lượt/s API chỉ phục vụ được khoảng 156 req/s: tiến trình Node dùng trung bình 106 % một lõi
   (đỉnh 129 %) trong khi Postgres trung bình 69 %, nên **nút thắt là CPU của tiến trình Node**, không
   phải database hay pool. k6 phải bỏ 5 072 lượt, p95 sơ đồ ghế 3,4 s; vẫn 0 lỗi HTTP.
3. **Hỗn hợp:** 100 lượt/s (162 req/s) mọi endpoint p95 dưới 100 ms; 150 lượt/s (242 req/s) vẫn 0 %
   lỗi nhưng API bão hòa (trung bình 89 %, đỉnh 112 %), Postgres trung bình 82 %, p95 giữ ghế 823 ms,
   sơ đồ ghế 587 ms.
4. Sơ đồ ghế (`GET /showtimes/:id/seats`, 192 ghế, khoảng 31 KB) là endpoint đắt nhất về CPU của
   Node: thử riêng endpoint này (không parse body ở k6) đạt trần khoảng 155–158 req/s. Đây là điểm
   đầu tiên cần xem ở 6.3.

## Suất hot (`hot-showtime.js`)

Mỗi lượt = 1 request sơ đồ ghế, cộng 1 request giữ ghế nếu còn ghế trống. Suất có 192 ghế nên chỉ
vài giây đầu có request giữ ghế; phần còn lại là khách tải lại sơ đồ ghế của một suất đã kín.
`holds_lost_race` = `409 SEAT_LOCKED`/`SEAT_UNAVAILABLE` (thua cuộc đua), không phải lỗi.

| Lần chạy | Rate (lượt/s) | Thời gian | Request (req/s) | Lỗi | Lượt bị bỏ | VU tối đa | CPU API | CPU Postgres | CPU k6 | Kiểm trùng |
|---|---|---|---|---|---|---|---|---|---|---|
| 20261123T184328Z-hot-showtime-r25 | 25 | 2m | 3113 (25.9) | 0.00 % | 0 | 50 | 11 / 29 % | 7 / 20 % | 7 / 12 % | mọi quy tắc 0 |
| 20261123T184605Z-hot-showtime-r50 | 50 | 2m | 6124 (51.0) | 0.00 % | 0 | 50 | 22 / 60 % | 16 / 77 % | 11 / 38 % | mọi quy tắc 0 |
| 20261123T184843Z-hot-showtime-r100 | 100 | 2m | 12186 (101.5) | 0.00 % | 17 | 67 | 49 / 88 % | 33 / 86 % | 23 / 41 % | mọi quy tắc 0 |
| 20261123T185120Z-hot-showtime-r150 | 150 | 2m | 18130 (151.0) | 0.00 % | 63 | 113 | 84 / 110 % | 64 / 86 % | 41 / 53 % | mọi quy tắc 0 |
| 20261123T185356Z-hot-showtime-r200 | 200 | 2m | 19169 (156.5) | 0.00 % | 5072 | 500 | 106 / 129 % | 69 / 86 % | 49 / 69 % | mọi quy tắc 0 |

| Lần chạy | Endpoint | Số request | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 20261123T184328Z-hot-showtime-r25 | seat_map | 3001 | 9.1 ms | 13.3 ms | 21.7 ms | 104.9 ms |
| 20261123T184328Z-hot-showtime-r25 | hold | 112 | 18.8 ms | 31.7 ms | 60.6 ms | 66.0 ms |
| 20261123T184605Z-hot-showtime-r50 | seat_map | 6001 | 8.4 ms | 15.5 ms | 24.2 ms | 133.7 ms |
| 20261123T184605Z-hot-showtime-r50 | hold | 123 | 22.6 ms | 72.4 ms | 89.6 ms | 105.9 ms |
| 20261123T184843Z-hot-showtime-r100 | seat_map | 11984 | 10.3 ms | 35.4 ms | 286.0 ms | 441.1 ms |
| 20261123T184843Z-hot-showtime-r100 | hold | 202 | 231.8 ms | 558.3 ms | 581.6 ms | 595.9 ms |
| 20261123T185120Z-hot-showtime-r150 | hold | 193 | 402.6 ms | 823.8 ms | 841.9 ms | 846.2 ms |
| 20261123T185120Z-hot-showtime-r150 | seat_map | 17937 | 25.7 ms | 220.8 ms | 353.0 ms | 672.4 ms |
| 20261123T185356Z-hot-showtime-r200 | seat_map | 18928 | 3.19 s | 3.44 s | 3.50 s | 3.64 s |
| 20261123T185356Z-hot-showtime-r200 | hold | 241 | 349.9 ms | 1.36 s | 1.42 s | 1.44 s |

| Lần chạy | Bộ đếm |
|---|---|
| 20261123T184328Z-hot-showtime-r25 | holds_created 112, sold_out_views 2889 |
| 20261123T184605Z-hot-showtime-r50 | holds_created 119, holds_lost_race 4, sold_out_views 5878 |
| 20261123T184843Z-hot-showtime-r100 | sold_out_views 11782, holds_lost_race 81, holds_created 121 |
| 20261123T185120Z-hot-showtime-r150 | holds_lost_race 77, holds_created 116, sold_out_views 17744 |
| 20261123T185356Z-hot-showtime-r200 | holds_created 116, sold_out_views 18687, holds_lost_race 125 |

## Traffic hỗn hợp (`mixed-traffic.js`)

Mỗi lượt là một khách làm một việc (35 % danh sách/tìm phim, 20 % chi tiết + ngày chiếu, 25 % lịch
chiếu + sơ đồ ghế, 5 % "vé của tôi", 15 % giữ ghế, 1/3 số lần giữ thành công thì hủy), trên mọi suất
tương lai, nên một lượt trung bình khoảng 1,6 request. `holds_refused` là `409` (ghế vừa bị người
khác giữ).

| Lần chạy | Rate (lượt/s) | Thời gian | Request (req/s) | Lỗi | Lượt bị bỏ | VU tối đa | CPU API | CPU Postgres | CPU k6 | Kiểm trùng |
|---|---|---|---|---|---|---|---|---|---|---|
| 20261123T185643Z-mixed-traffic-r25 | 25 | 3m | 7389 (41.1) | 0.00 % | 0 | 30 | 14 / 28 % | 10 / 18 % | 7 / 11 % | mọi quy tắc 0 |
| 20261123T190019Z-mixed-traffic-r50 | 50 | 3m | 14635 (81.3) | 0.00 % | 0 | 30 | 24 / 44 % | 18 / 26 % | 10 / 14 % | mọi quy tắc 0 |
| 20261123T190355Z-mixed-traffic-r100 | 100 | 3m | 29252 (162.5) | 0.00 % | 0 | 30 | 53 / 76 % | 44 / 66 % | 23 / 30 % | mọi quy tắc 0 |
| 20261123T190732Z-mixed-traffic-r150 | 150 | 3m | 43621 (242.3) | 0.00 % | 90 | 113 | 89 / 112 % | 82 / 102 % | 42 / 50 % | mọi quy tắc 0 |

| Lần chạy | Endpoint | Số request | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 20261123T185643Z-mixed-traffic-r25 | my_bookings | 212 | 14.6 ms | 36.6 ms | 60.0 ms | 68.4 ms |
| 20261123T185643Z-mixed-traffic-r25 | movies_list | 1365 | 7.6 ms | 13.6 ms | 25.0 ms | 58.9 ms |
| 20261123T185643Z-mixed-traffic-r25 | showtime_dates | 928 | 2.9 ms | 5.5 ms | 8.9 ms | 19.2 ms |
| 20261123T185643Z-mixed-traffic-r25 | showtime_list | 1123 | 5.0 ms | 8.4 ms | 13.7 ms | 46.1 ms |
| 20261123T185643Z-mixed-traffic-r25 | movie_detail | 928 | 5.2 ms | 9.1 ms | 21.0 ms | 43.2 ms |
| 20261123T185643Z-mixed-traffic-r25 | seat_map | 1826 | 9.3 ms | 17.9 ms | 31.3 ms | 112.1 ms |
| 20261123T185643Z-mixed-traffic-r25 | cancel | 214 | 11.2 ms | 22.0 ms | 31.1 ms | 77.9 ms |
| 20261123T185643Z-mixed-traffic-r25 | hold | 624 | 23.4 ms | 47.2 ms | 77.1 ms | 134.6 ms |
| 20261123T185643Z-mixed-traffic-r25 | movies_search | 169 | 8.0 ms | 16.7 ms | 26.8 ms | 41.3 ms |
| 20261123T190019Z-mixed-traffic-r50 | my_bookings | 437 | 11.9 ms | 25.1 ms | 41.2 ms | 70.0 ms |
| 20261123T190019Z-mixed-traffic-r50 | cancel | 403 | 11.1 ms | 25.3 ms | 34.8 ms | 65.4 ms |
| 20261123T190019Z-mixed-traffic-r50 | movies_list | 2879 | 6.4 ms | 12.7 ms | 21.6 ms | 68.7 ms |
| 20261123T190019Z-mixed-traffic-r50 | movies_search | 317 | 7.0 ms | 14.4 ms | 22.8 ms | 57.5 ms |
| 20261123T190019Z-mixed-traffic-r50 | hold | 1228 | 23.6 ms | 47.2 ms | 75.0 ms | 175.8 ms |
| 20261123T190019Z-mixed-traffic-r50 | seat_map | 3589 | 8.2 ms | 16.3 ms | 28.7 ms | 92.1 ms |
| 20261123T190019Z-mixed-traffic-r50 | showtime_list | 2226 | 4.1 ms | 7.3 ms | 15.6 ms | 58.6 ms |
| 20261123T190019Z-mixed-traffic-r50 | movie_detail | 1778 | 4.1 ms | 7.7 ms | 18.5 ms | 72.0 ms |
| 20261123T190019Z-mixed-traffic-r50 | showtime_dates | 1778 | 2.7 ms | 4.8 ms | 9.0 ms | 41.9 ms |
| 20261123T190355Z-mixed-traffic-r100 | cancel | 797 | 16.8 ms | 52.0 ms | 74.3 ms | 166.8 ms |
| 20261123T190355Z-mixed-traffic-r100 | my_bookings | 913 | 16.5 ms | 59.6 ms | 101.5 ms | 177.4 ms |
| 20261123T190355Z-mixed-traffic-r100 | showtime_dates | 3535 | 3.2 ms | 9.7 ms | 22.1 ms | 60.1 ms |
| 20261123T190355Z-mixed-traffic-r100 | movies_list | 5703 | 8.3 ms | 28.8 ms | 51.4 ms | 144.9 ms |
| 20261123T190355Z-mixed-traffic-r100 | movies_search | 651 | 8.9 ms | 33.3 ms | 57.2 ms | 109.1 ms |
| 20261123T190355Z-mixed-traffic-r100 | movie_detail | 3535 | 5.4 ms | 17.2 ms | 42.5 ms | 99.6 ms |
| 20261123T190355Z-mixed-traffic-r100 | showtime_list | 4503 | 5.0 ms | 13.6 ms | 27.2 ms | 135.8 ms |
| 20261123T190355Z-mixed-traffic-r100 | seat_map | 7199 | 10.6 ms | 30.8 ms | 57.5 ms | 199.8 ms |
| 20261123T190355Z-mixed-traffic-r100 | hold | 2416 | 33.2 ms | 96.1 ms | 158.5 ms | 230.8 ms |
| 20261123T190732Z-mixed-traffic-r150 | movies_search | 970 | 92.4 ms | 336.4 ms | 412.2 ms | 521.8 ms |
| 20261123T190732Z-mixed-traffic-r150 | movies_list | 8470 | 67.3 ms | 193.3 ms | 245.9 ms | 312.4 ms |
| 20261123T190732Z-mixed-traffic-r150 | seat_map | 10693 | 108.0 ms | 586.9 ms | 693.4 ms | 855.5 ms |
| 20261123T190732Z-mixed-traffic-r150 | movie_detail | 5368 | 78.7 ms | 441.6 ms | 560.4 ms | 663.2 ms |
| 20261123T190732Z-mixed-traffic-r150 | my_bookings | 1410 | 119.2 ms | 246.3 ms | 304.1 ms | 374.5 ms |
| 20261123T190732Z-mixed-traffic-r150 | showtime_list | 6736 | 35.5 ms | 160.2 ms | 208.2 ms | 262.9 ms |
| 20261123T190732Z-mixed-traffic-r150 | cancel | 1118 | 87.5 ms | 215.4 ms | 281.5 ms | 331.9 ms |
| 20261123T190732Z-mixed-traffic-r150 | hold | 3488 | 241.6 ms | 822.5 ms | 955.2 ms | 1.13 s |
| 20261123T190732Z-mixed-traffic-r150 | showtime_dates | 5368 | 32.1 ms | 150.7 ms | 200.4 ms | 258.6 ms |

| Lần chạy | Bộ đếm |
|---|---|
| 20261123T185643Z-mixed-traffic-r25 | bookings_cancelled 214, holds_created 624 |
| 20261123T190019Z-mixed-traffic-r50 | bookings_cancelled 403, holds_created 1228 |
| 20261123T190355Z-mixed-traffic-r100 | holds_created 2413, holds_refused 3, bookings_cancelled 797 |
| 20261123T190732Z-mixed-traffic-r150 | holds_refused 5, bookings_cancelled 1118, holds_created 3483 |
