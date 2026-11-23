# Tối ưu truy vấn — ROADMAP 6.3 (24/11/2026)

Cùng máy, cùng DB tạm `ticketify_load01` và cùng cấu hình như 6.2 ([../README.md](../README.md));
`DATABASE_POOL_MAX=10` trừ các lần ghi rõ `pool20`. Mọi lần chạy đều kiểm SQL sau khi chạy: 0 vi
phạm, 0 deadlock.

## 1. Truy vấn nóng trong Postgres: `EXPLAIN (ANALYZE, BUFFERS)`

File thô: [explain-hot-queries.txt](explain-hot-queries.txt) (script
[../../sql/explain-hot-queries.sql](../../sql/explain-hot-queries.sql), chạy khi không có tải).

| # | Truy vấn | Thời gian thực thi |
|---|---|---|
| 1a | Sơ đồ ghế **trước**: 5 câu Prisma (suất, phim, phòng, ghế, `showtime_seats` với 192 tham số) | 0,08 + 0,05 + 0,01 + 0,21 + 0,58 ms |
| 1b | Sơ đồ ghế **sau**: 1 câu JOIN | 0,70 ms |
| 2 | Lịch chiếu một phim trong ngày, kèm số ghế trống/tổng | 0,90 ms |
| 3 | Các ngày có suất của một phim | 0,09 ms |
| 4 | Danh sách phim (đếm + trang) | 0,03 + 0,09 ms |
| 5 | Tìm theo tên (không dấu, quét tuần tự theo thiết kế) | 0,11 ms |
| 6 | "Vé của tôi", user nhiều đơn nhất (đếm + trang) | 0,11 + 0,11 ms |
| 7 | Giữ ghế: khóa ghế `FOR UPDATE NOWAIT` | 0,12 ms |
| 8 | Quét hết hạn: đơn `PENDING` quá `hold_until` | 0,09 ms |
| 9 | Admin: doanh thu 30 ngày (167 328 booking, quét tuần tự) | 221 ms |

**Kết luận:** mọi truy vấn công khai chạy dưới 1 ms trong Postgres, với index sẵn có. Chi phí mỗi
request nằm ở tiến trình Node (Prisma, ánh xạ kết quả, JSON, log), khớp với 6.2: Node chạm một lõi
trước khi Postgres bão hòa. Vì vậy không thêm index nào cho đường công khai.

**Báo cáo doanh thu:** thử partial index `bookings (confirmed_at) WHERE status = 'CONFIRMED'`
([explain-revenue-index-trial.txt](explain-revenue-index-trial.txt), hai lần đo): 30 ngày vẫn
188–228 ms (so với 216–221 ms không index), vì phần đắt là gộp khoảng 53 000 dòng và đếm ghế từng
đơn chứ không phải tìm dòng; 7 ngày 36 ms so với 46–59 ms. Lợi ít, trong khi index thêm chi phí ghi
cho mọi lần đổi trạng thái booking, nên **không thêm migration**. Viết lại phần đếm ghế bằng một
JOIN gộp cũng chỉ còn 191–216 ms. Màn hình này chỉ admin dùng, vài lần mỗi ngày.

**Theo dõi thêm (chưa làm gì):** `pg_stat_user_tables` cho `showtime_seats` ghi 278 999 UPDATE
nhưng chỉ 339 là HOT update, vì mỗi lần giữ/nhả ghế đổi `booking_id`, cột có index
(`showtime_seats_booking_id_idx`). Mỗi lần đổi ghế vì vậy thêm một mục mới vào cả hai index. Sau
khoảng 25 lần chạy suất hot, sơ đồ ghế của suất hot đọc 81 trang heap so với 17 của một suất bình
thường (vẫn 0,44 ms). Ghi trong ROADMAP "Quyết định chờ".

## 2. Sơ đồ ghế viết lại bằng một câu SQL

`ScheduleService.seatMap`: 5 câu Prisma → 1 câu `$queryRaw` (suất JOIN phim JOIN phòng, LEFT JOIN
mọi ghế của phòng, LEFT JOIN `showtime_seats` của suất). Response giữ nguyên (integration
`catalog/showtimes`, `catalog/rooms`, `booking/booking-hold`: 110 test pass). Đo bằng
[../../seat-map.js](../../seat-map.js): mỗi request một suất tương lai ngẫu nhiên, mỗi mức 1 phút.

| Request/s | p95 trước | p95 sau | req/s đạt được trước → sau | CPU API trước → sau (TB, % một lõi) |
|---|---|---|---|---|
| 50 | 53,6 ms | 12,7 ms | 50,0 → 50,0 | 26 → 15 % |
| 100 | 26,2 ms | 16,7 ms | 100,0 → 100,0 | 42 → 36 % |
| 150 | 235,6 ms | 23,8 ms | 149,6 → 147,0 | 72 → 51 % |
| 200 | 1,90 s | 85,8 ms | 175,3 → 199,9 | 93 → 74 % |
| 250 | – | 1,60 s | – → 206,0 | – → 94 % |
| 300 | – | 1,57 s | – → 213,2 | – → 97 % |

Trần của endpoint tăng từ khoảng 175 lên khoảng 206–213 req/s. Ở trần mới **Postgres cũng chạm
khoảng một lõi** (trung bình 94–98 %): câu JOIN chuyển một phần việc từ Node sang Postgres, và hai
bên cùng chia 4 lõi với k6.

## 3. Đầu-cuối sau khi sửa

| Kịch bản, lượt/s | Trước (6.2) | Sau |
|---|---|---|
| Hỗn hợp 150 | 242,3 req/s; p95 sơ đồ ghế 587 ms, giữ ghế 823 ms, danh sách phim 193 ms | 243,3 req/s; p95 sơ đồ ghế **139 ms**, giữ ghế 712 ms, danh sách phim 174 ms |
| Suất hot 200 | 156,5 req/s (5 072 lượt bị bỏ); p95 sơ đồ ghế 3,44 s | **187,5 req/s** (1 413 lượt bị bỏ); p95 sơ đồ ghế 2,82 s |
| Suất hot 150 (3 lần) | 151,0 req/s; p95 sơ đồ ghế 221 ms, giữ ghế 824 ms | lần 1: 139,2 req/s, p95 sơ đồ ghế 4,62 s, giữ ghế 6,07 s; lần 2–3: 151,4–151,8 req/s, p95 sơ đồ ghế 52–137 ms, giữ ghế 1,42–3,07 s |

Ở 150 lượt/s suất hot nằm sát điểm gãy: lần 1 sau khi sửa dồn hàng (k6 lên tới 500 VU) và không
hồi lại trong 2 phút; hai lần lặp lại thì không. Không tìm thấy nguyên nhân ngoài (không autovacuum,
worker gần như rảnh), nên ghi cả ba lần như đo được. **p95 giữ ghế của suất hot dao động mạnh
(0,8–6 s)** vì cả khoảng 300 request giữ ghế của một lần chạy dồn vào vài giây đầu, khi khoảng 150
khách cùng thấy ghế trống; chúng xếp hàng chờ 10 kết nối của pool. Số này mô tả "đợt mở bán", không
phải độ trễ giữ ghế lúc bình thường (hỗn hợp 100 lượt/s: p95 96 ms ở 6.2).

## 4. Pool 20 (thử nghiệm, không phải kết quả)

| Kịch bản 150 lượt/s | Pool 10 | Pool 20 |
|---|---|---|
| Suất hot | 2 lần lặp: p95 sơ đồ ghế 52–137 ms, giữ ghế 1,42–3,07 s | 2 lần: p95 sơ đồ ghế 56–755 ms, giữ ghế 1,49–4,03 s |
| Hỗn hợp | p95 giữ ghế 712 ms, sơ đồ ghế 139 ms, danh sách phim 174 ms; Postgres TB 79 % | p95 giữ ghế **1,28 s**, sơ đồ ghế 232 ms, danh sách phim 315 ms; Postgres TB **103 %** (đỉnh 144 %) |

Pool lớn hơn không giúp, và ở traffic hỗn hợp còn tệ hơn: nhiều câu chạy song song hơn trên một
Postgres đang chung CPU. **Giữ `DATABASE_POOL_MAX=10`.**

## 5. Cache danh sách phim: không làm

Danh sách phim tốn 0,03 + 0,09 ms trong Postgres, và p95 của nó dưới 30 ms đến 100 lượt/s hỗn hợp.
Cache sẽ bớt CPU Node, nhưng cần thiết kế invalidation (sửa phim, đổi trạng thái, poster) và chưa
có số đo nào cho thấy đây là chỗ nghẽn. Đề xuất cho sau này nằm trong báo cáo đêm.

## Bảng sinh tự động

### Sơ đồ ghế (thư mục này)

| Lần chạy | Rate (lượt/s) | Thời gian | Request (req/s) | Lỗi | Lượt bị bỏ | VU tối đa | CPU API | CPU Postgres | CPU k6 | Kiểm trùng |
|---|---|---|---|---|---|---|---|---|---|---|
| 20261123T192556Z-seat-map-before-r50 | 50 | 1m | 3001 (50.0) | 0.00 % | 0 | 30 | 26 / 54 % | 19 / 36 % | 11 / 18 % | mọi quy tắc 0 |
| 20261123T192733Z-seat-map-before-r100 | 100 | 1m | 6001 (100.0) | 0.00 % | 0 | 30 | 42 / 68 % | 30 / 44 % | 17 / 20 % | mọi quy tắc 0 |
| 20261123T192909Z-seat-map-before-r150 | 150 | 1m | 8980 (149.6) | 0.00 % | 21 | 50 | 72 / 118 % | 63 / 88 % | 35 / 46 % | mọi quy tắc 0 |
| 20261123T193046Z-seat-map-before-r200 | 200 | 1m | 10761 (175.3) | 0.00 % | 1240 | 300 | 93 / 125 % | 75 / 89 % | 42 / 56 % | mọi quy tắc 0 |
| 20261123T193528Z-seat-map-after-r50 | 50 | 1m | 3001 (50.0) | 0.00 % | 0 | 30 | 15 / 29 % | 11 / 25 % | 8 / 17 % | mọi quy tắc 0 |
| 20261123T193704Z-seat-map-after-r100 | 100 | 1m | 6001 (100.0) | 0.00 % | 0 | 30 | 36 / 55 % | 26 / 53 % | 17 / 31 % | mọi quy tắc 0 |
| 20261123T193841Z-seat-map-after-r150 | 150 | 1m | 9000 (147.0) | 0.00 % | 0 | 30 | 51 / 77 % | 52 / 90 % | 28 / 37 % | mọi quy tắc 0 |
| 20261123T194019Z-seat-map-after-r200 | 200 | 1m | 11995 (199.9) | 0.00 % | 6 | 35 | 74 / 106 % | 75 / 110 % | 42 / 50 % | mọi quy tắc 0 |
| 20261123T194155Z-seat-map-after-r250 | 250 | 1m | 12652 (206.0) | 0.00 % | 2349 | 300 | 94 / 123 % | 94 / 108 % | 48 / 62 % | mọi quy tắc 0 |
| 20261123T194332Z-seat-map-after-r300 | 300 | 1m | 13088 (213.2) | 0.00 % | 4913 | 300 | 97 / 123 % | 98 / 130 % | 52 / 62 % | mọi quy tắc 0 |

| Lần chạy | Endpoint | Số request | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 20261123T192556Z-seat-map-before-r50 | seat_map | 3001 | 11.4 ms | 53.6 ms | 186.4 ms | 448.0 ms |
| 20261123T192733Z-seat-map-before-r100 | seat_map | 6001 | 9.8 ms | 26.2 ms | 50.7 ms | 149.4 ms |
| 20261123T192909Z-seat-map-before-r150 | seat_map | 8980 | 18.9 ms | 235.6 ms | 313.0 ms | 387.4 ms |
| 20261123T193046Z-seat-map-before-r200 | seat_map | 10761 | 1.58 s | 1.90 s | 1.97 s | 2.00 s |
| 20261123T193528Z-seat-map-after-r50 | seat_map | 3001 | 6.5 ms | 12.7 ms | 29.2 ms | 127.1 ms |
| 20261123T193704Z-seat-map-after-r100 | seat_map | 6001 | 7.2 ms | 16.7 ms | 31.5 ms | 147.9 ms |
| 20261123T193841Z-seat-map-after-r150 | seat_map | 9000 | 8.5 ms | 23.8 ms | 63.2 ms | 1.23 s |
| 20261123T194019Z-seat-map-after-r200 | seat_map | 11995 | 15.3 ms | 85.8 ms | 130.8 ms | 460.5 ms |
| 20261123T194155Z-seat-map-after-r250 | seat_map | 12652 | 1.44 s | 1.60 s | 1.65 s | 1.71 s |
| 20261123T194332Z-seat-map-after-r300 | seat_map | 13088 | 1.45 s | 1.57 s | 1.65 s | 1.69 s |

| Lần chạy | Bộ đếm |
|---|---|
| 20261123T192556Z-seat-map-before-r50 | – |
| 20261123T192733Z-seat-map-before-r100 | – |
| 20261123T192909Z-seat-map-before-r150 | – |
| 20261123T193046Z-seat-map-before-r200 | – |
| 20261123T193528Z-seat-map-after-r50 | – |
| 20261123T193704Z-seat-map-after-r100 | – |
| 20261123T193841Z-seat-map-after-r150 | – |
| 20261123T194019Z-seat-map-after-r200 | – |
| 20261123T194155Z-seat-map-after-r250 | – |
| 20261123T194332Z-seat-map-after-r300 | – |

### Đầu-cuối sau khi sửa và pool 20 ([../6.3-after/](../6.3-after/))

| Lần chạy | Rate (lượt/s) | Thời gian | Request (req/s) | Lỗi | Lượt bị bỏ | VU tối đa | CPU API | CPU Postgres | CPU k6 | Kiểm trùng |
|---|---|---|---|---|---|---|---|---|---|---|
| 20261123T194526Z-hot-showtime-r150 | 150 | 2m | 16701 (139.2) | 0.00 % | 1657 | 500 | 77 / 118 % | 77 / 138 % | 46 / 62 % | mọi quy tắc 0 |
| 20261123T194802Z-hot-showtime-r200 | 200 | 2m | 22951 (187.5) | 0.00 % | 1413 | 500 | 107 / 125 % | 88 / 105 % | 60 / 92 % | mọi quy tắc 0 |
| 20261123T195038Z-mixed-traffic-r150 | 150 | 3m | 43825 (243.3) | 0.00 % | 55 | 85 | 87 / 116 % | 79 / 119 % | 42 / 52 % | mọi quy tắc 0 |
| 20261123T195439Z-hot-showtime-repeat-r150 | 150 | 2m | 18168 (151.4) | 0.00 % | 157 | 206 | 69 / 108 % | 61 / 108 % | 41 / 62 % | mọi quy tắc 0 |
| 20261123T195715Z-hot-showtime-repeat-r150 | 150 | 2m | 18215 (151.8) | 0.00 % | 70 | 118 | 64 / 96 % | 53 / 115 % | 40 / 69 % | mọi quy tắc 0 |
| 20261123T200028Z-hot-showtime-pool20-r150 | 150 | 2m | 18206 (151.7) | 0.00 % | 221 | 267 | 74 / 116 % | 62 / 127 % | 43 / 90 % | mọi quy tắc 0 |
| 20261123T200304Z-hot-showtime-pool20-r150 | 150 | 2m | 18209 (151.7) | 0.00 % | 77 | 127 | 65 / 111 % | 56 / 113 % | 39 / 54 % | mọi quy tắc 0 |
| 20261123T200540Z-mixed-traffic-pool20-r150 | 150 | 3m | 43728 (242.6) | 0.00 % | 103 | 130 | 92 / 111 % | 103 / 144 % | 46 / 54 % | mọi quy tắc 0 |

| Lần chạy | Endpoint | Số request | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 20261123T194526Z-hot-showtime-r150 | seat_map | 16344 | 859.1 ms | 4.62 s | 6.01 s | 8.14 s |
| 20261123T194526Z-hot-showtime-r150 | hold | 357 | 1.39 s | 6.07 s | 8.62 s | 10.12 s |
| 20261123T194802Z-hot-showtime-r200 | seat_map | 22588 | 2.56 s | 2.82 s | 2.89 s | 2.94 s |
| 20261123T194802Z-hot-showtime-r200 | hold | 363 | 778.9 ms | 3.21 s | 3.25 s | 3.27 s |
| 20261123T195038Z-mixed-traffic-r150 | showtime_dates | 5359 | 12.9 ms | 131.0 ms | 178.3 ms | 246.8 ms |
| 20261123T195038Z-mixed-traffic-r150 | cancel | 1170 | 61.1 ms | 202.0 ms | 249.7 ms | 309.4 ms |
| 20261123T195038Z-mixed-traffic-r150 | movies_list | 8439 | 39.1 ms | 174.1 ms | 226.0 ms | 291.9 ms |
| 20261123T195038Z-mixed-traffic-r150 | showtime_list | 6782 | 16.5 ms | 133.8 ms | 186.4 ms | 235.0 ms |
| 20261123T195038Z-mixed-traffic-r150 | my_bookings | 1408 | 75.5 ms | 239.2 ms | 293.0 ms | 376.6 ms |
| 20261123T195038Z-mixed-traffic-r150 | hold | 3568 | 134.1 ms | 711.9 ms | 957.2 ms | 1.11 s |
| 20261123T195038Z-mixed-traffic-r150 | movie_detail | 5359 | 25.1 ms | 357.0 ms | 503.2 ms | 625.2 ms |
| 20261123T195038Z-mixed-traffic-r150 | movies_search | 940 | 46.3 ms | 292.9 ms | 397.0 ms | 459.2 ms |
| 20261123T195038Z-mixed-traffic-r150 | seat_map | 10800 | 21.4 ms | 139.0 ms | 191.8 ms | 251.8 ms |
| 20261123T195439Z-hot-showtime-repeat-r150 | hold | 325 | 752.7 ms | 3.07 s | 3.15 s | 3.20 s |
| 20261123T195439Z-hot-showtime-repeat-r150 | seat_map | 17843 | 12.6 ms | 137.4 ms | 627.9 ms | 727.0 ms |
| 20261123T195715Z-hot-showtime-repeat-r150 | hold | 284 | 372.3 ms | 1.42 s | 1.52 s | 1.54 s |
| 20261123T195715Z-hot-showtime-repeat-r150 | seat_map | 17931 | 10.9 ms | 52.0 ms | 264.5 ms | 600.2 ms |
| 20261123T200028Z-hot-showtime-pool20-r150 | seat_map | 17779 | 13.2 ms | 755.2 ms | 883.5 ms | 1.02 s |
| 20261123T200028Z-hot-showtime-pool20-r150 | hold | 427 | 978.8 ms | 4.03 s | 4.08 s | 4.12 s |
| 20261123T200304Z-hot-showtime-pool20-r150 | seat_map | 17924 | 10.3 ms | 55.8 ms | 267.3 ms | 676.4 ms |
| 20261123T200304Z-hot-showtime-pool20-r150 | hold | 285 | 414.3 ms | 1.49 s | 1.58 s | 1.59 s |
| 20261123T200540Z-mixed-traffic-pool20-r150 | seat_map | 10674 | 55.4 ms | 231.9 ms | 295.2 ms | 425.3 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | showtime_list | 6674 | 49.7 ms | 225.2 ms | 286.8 ms | 363.4 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | showtime_dates | 5424 | 44.5 ms | 218.1 ms | 277.8 ms | 376.7 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | movies_list | 8584 | 130.8 ms | 314.8 ms | 389.2 ms | 504.8 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | my_bookings | 1328 | 257.6 ms | 444.5 ms | 533.8 ms | 633.7 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | cancel | 1201 | 165.8 ms | 339.2 ms | 412.2 ms | 507.5 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | movies_search | 888 | 156.5 ms | 498.0 ms | 648.8 ms | 697.7 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | movie_detail | 5424 | 92.7 ms | 619.9 ms | 772.6 ms | 889.2 ms |
| 20261123T200540Z-mixed-traffic-pool20-r150 | hold | 3531 | 390.8 ms | 1.28 s | 1.52 s | 1.68 s |

| Lần chạy | Bộ đếm |
|---|---|
| 20261123T194526Z-hot-showtime-r150 | holds_created 108, holds_lost_race 249, sold_out_views 15987 |
| 20261123T194802Z-hot-showtime-r200 | sold_out_views 22225, holds_lost_race 242, holds_created 121 |
| 20261123T195038Z-mixed-traffic-r150 | holds_refused 2, holds_created 3566, bookings_cancelled 1170 |
| 20261123T195439Z-hot-showtime-repeat-r150 | sold_out_views 17518, holds_lost_race 214, holds_created 111 |
| 20261123T195715Z-hot-showtime-repeat-r150 | holds_lost_race 175, holds_created 109, sold_out_views 17647 |
| 20261123T200028Z-hot-showtime-pool20-r150 | sold_out_views 17352, holds_created 121, holds_lost_race 306 |
| 20261123T200304Z-hot-showtime-pool20-r150 | sold_out_views 17639, holds_lost_race 180, holds_created 105 |
| 20261123T200540Z-mixed-traffic-pool20-r150 | bookings_cancelled 1201, holds_created 3530, holds_refused 1 |
