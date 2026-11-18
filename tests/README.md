# Thư mục tests

Đây là kiểm thử trên máy tính, **không phải code cần nạp vào ESP32**. Arduino IDE chỉ mở sketch ở Arduino/ESP32S3_Telematics hoặc Arduino/NODE_ECU. Không cần chạy tests để sử dụng hệ thống.

| Tệp | Kiểm tra |
| --- | --- |
| can_isolation_test.cpp / can_isolation_test.mjs | Biên dịch/chạy hai sketch CAN-only thật với TWAI giả: đúng pin, NORMAL500k, single-shot, không báo echo sai, ACK khác queued, phục hồi có giới hạn; chạy node can_isolation_test.mjs đường-dẫn-zig.exe. Không chứng minh CAN điện thật |
| direct_route_request_test.mjs | V11.5.2: timeout/cancel tải lộ trình, không khóa telemetry, chặn phản hồi cũ khi đổi nguồn/phiên/lượt/dừng, quyền sở hữu yêu cầu chồng nhau; chạy npm run test:routes |
| direct_realtime_policy_test.cpp | Slot mới nhất cố định, tuổi dữ liệu/CAN, millis wrap, cổng audio, lọc biến trở; chạy run_direct_realtime_tests.ps1 -ZigPath ... |
| direct_realtime_contract_test.mjs | Tích hợp luồng nhanh vào mạng/audio thật, giữ PCM100%, telemetry1s và capture_ms |
| direct_realtime_server_test.mjs | HTTP/SSE thật, DB tạm: auth, thứ tự/TTL/lượt/boot, backpressure, không tăng dữ liệu bền vững |
| direct_realtime_ui_test.mjs | UI thật qua adapter: fast/stale, không rollback/fetch nặng mỗi frame; không thay kiểm tra browser |
| direct_demo_engine_test.cpp / direct_demo_mailbox_test.cpp | 100 kiểm tra engine/parser và 53 kiểm tra mailbox thật: CAN mới/cũ, dừng/chạy lại, bán kính hiện hành, TTL, lệnh lặp, timeout, cảnh báo pending, snapshot audio và công bố phạm vi cùng ACK trước khi log nhường tác vụ. Chạy run_direct_demo_tests.ps1 -ZigPath ... |
| direct_demo_server_test.mjs | Server/SQLite thật trên cổng tạm: ACK/timeout, tách nguồn, sự kiện chỉ từ ESP, resend giữ tọa độ, chạy lại tách lượt, hủy lệnh chưa áp dụng và không trộn danh mục SD. ESP được giả lập. |
| direct_demo_ui_test.mjs | Hình học xoay tuyến, nội suy dọc đường đã xác nhận, không chạy quá dữ liệu nhận, reset lượt, SSE và nhãn nguồn; DOM adapter, không thay kiểm tra trình duyệt. |
| direct_session_order_test.mjs | V11.5.3: chạy hàm UI thật với phản hồi GET cũ sau Chạy lại/Kết thúc, lỗi cũ, đổi view bất đồng bộ và đổi phiên; SQLite migration/revision đơn điệu qua restart với timestamp trùng. Được gọi bởi npm run test:direct. |
| can_recovery_test.cpp / can_mock | Gọi trực tiếp can_bus.cpp thật qua TWAI giả lập: phục hồi, tuổi khung/tác vụ, không reset bus yên lặng, lỗi API, race và wrap đồng hồ; chạy bằng run_can_tests.ps1 -ZigPath ... |
| node_can_policy_test.cpp / node_can_integration_test.cpp / node_can_mock | Chính sách TX và sketch NODE_ECU.ino thật qua phần cứng giả lập: ACK trễ, một khung đang truyền, thăm dò có giới hạn, đủ 4 ID, lấy mẫu khi mất CAN; chạy node_can_tests.ps1 -ZigPath ... |
| audio_startup_sequence_test.cpp | Biên dịch C++11 và chạy helper production: mute trước DMA, toàn PCM0, vượt vòng DMA, lỗi clear/ghi từng đoạn, đầu vào tràn/sai; không phải đo GPIO/loa thật |
| audio_admission_test.mjs | V11.5.3: trích đúng hàm hàng đợi/tuổi/phạm vi từ alerts.cpp và biên dịch harness C++ với RTOS giả; kiểm tra từ chối/nhận hàng đợi, hủy lệnh cũ, chờ direct tối đa 150 ms và giữ chờ normal. Chạy node tests/audio_admission_test.mjs đường-dẫn-zig.exe từ gốc project. Không thay kiểm thử loa/SD thật. |
| run_audio_startup_test.ps1 | Chạy test trên bằng `-ZigPath 'đường-dẫn/zig.exe'`; build trong Temp, không cần để nạp Arduino |
| audio_boot_contract_test.mjs | Kiểm tra nối helper vào setup/alerts thật, lỗi giữ mute, enable sau prime và kiểm tra tuổi lệnh; không in cấu hình riêng trong lỗi test |
| select_demo_pothole_sample.mjs | Quét cửa sổ CSV liên tiếp qua classifier host thật; chọn mẫu theo confidence, không sửa CSV và không phải đánh giá accuracy |
| web_v11_4_1_demo.mjs | Cấu hình 10/30m, ACK và snapshot mới; vị trí hiển thị ngoài vòng không phát; lệnh hủy/đổi ngưỡng không được cấp quyền loa; polling nhanh đúng thiết bị |
| ui_v11_4_1_demo.mjs | Hàm giao diện thật với DOM/Leaflet mock: vòng theo cấu hình đã xác nhận, giữ form đang nhập, tọa độ marker và báo vị trí 5Hz, chuyển nguồn |
| can_recovery_test.cpp / run_can_tests.ps1 | Chạy can_bus.cpp thật với TWAI giả: retry/recovery, heartbeat, payload, loại khung sai và dữ liệu hết hạn; không chứng minh dây CAN |
| remote_command_policy_test.cpp | Chính sách C++11 cấp quyền phát loa và chu kỳ hỏi lệnh; chặn HTTP200 nhưng lệnh hủy hoặc trùng |
| web_v11_4_0_demo.mjs | Lệnh mẫu thô, tọa độ chốt, phiên/TTL/ACK trùng, threshold, geofence/voice và cách ly dữ liệu; ACK mock, không chạy ESP |
| ui_v11_4_0_demo.mjs | Ready gate, nút gửi, capture trước async, nhãn ACK không ép theo mẫu; DOM/transport mock |
| demo_samples_test.mjs | Hash model/mẫu, 200 dòng liền kề và 600 giá trị; thêm DEMO_ORIGINAL_CSV_DIR để đối chiếu file thu gốc |
| demo_tinyml_contract_test.mjs | Hợp đồng metadata/đơn vị/label/scores thật của giao thức |
| run_demo_parser_tests.ps1 | Biên dịch/chạy parser C++11 bounded thật, không phải test phần cứng |
| run_demo_samples_host.ps1 | Tùy chọn chạy EON model trên PC; cần model src và Zig, không phải đánh giá accuracy thực địa |
| gnss_position_filter_test.cpp | Chạy trực tiếp thuật toán lọc C++ với fix giả: đứng yên, outlier, đi chậm, nhiều tần số, stale, epoch, geofence khi mở giữ |
| run_gnss_filter_tests.ps1 | Biên dịch và chạy test trên Windows bằng compiler native; không nhầm compiler Xtensa với chương trình chạy trên PC |
| web_v11_3_9_gnss.mjs | SQLite migration, metadata raw/filtered, HTTP/SSE, tách đoạn map/PDF và tương thích cũ |
| verify_policies.ps1 | Dùng compiler S3 kiểm tra constexpr chính sách hàng đợi SD/audio; không chạy mô phỏng phần cứng |
| check_assets.mjs | Kiểm tra định dạng file giọng nói, PCM100%, SD1MHz, phiên bản config |
| configure_helpers_test.ps1 | Kiểm tra công cụ cấu hình bằng chuỗi giả; không thay thông tin Wi-Fi thật |

Kiểm thử web hiện có và mới: mở terminal trong WebDashboard_Online, chạy `npm run verify` (Node22.16+; đã chạy với Node26.7.0). Các test tạo SQLite tạm/cổng loopback riêng, không gửi lệnh tới board. Không nhầm với TEST_DASHBOARD.bat: file BAT đó gửi dữ liệu mẫu vào server đang dùng.

Kiểm thử bộ lọc: ở thư mục tests, chạy `./run_gnss_filter_tests.ps1 -Compiler 'duong-dan-toi-compiler-native'`. Hỗ trợ g++, clang++, Zig hoặc cl của Visual Studio. Compiler native không được đóng kèm gói; người dùng Arduino không cần cài thêm để nạp firmware. Các build tạm do runner in ra nằm trong thư mục Temp, không trong project.

Kết quả test tổng hợp ở ../VALIDATION.md. Dữ liệu giả không chứng minh độ chính xác anten/GNSS thật, độ ổn định nguồn SD, tiếng loa hay cảnh báo thực địa.

Test classifier PC dùng cửa sổ CSV thực địa, nhưng các file có thể thuộc tập train. Kết quả không được dùng thay ACK ESP32-S3 trong sản phẩm. Xem ../WebDashboard_Online/demo_samples/README.md. Kết quả biên dịch Arduino đầy đủ của đúng phiên bản được ghi riêng trong VALIDATION.md, không thay bằng các test PC.
