KHÔNG CẦN CHÉP FILE ÂM THANH VÀO MICROSD.

Hai giọng cảnh báo ổ gà và gờ giảm tốc đã được nhúng trực tiếp trong Flash
của ESP32-S3, vì vậy vẫn phát qua MAX98357A khi thẻ MicroSD bị lỗi hoặc bị tháo.
V10.2 chỉ dùng loa MAX98357A; GPIO21 để trống. Nếu I2S/MAX98357A
không hoạt động, Serial báo [AUDIO] FAIL/SKIP và không có âm dự phòng.

Lần TinyML phát hiện điểm mới chỉ ghi event và tọa độ, không phát âm thanh.
Sau khi xe đã ra xa điểm từ 20 m trở lên, lần tiếp cận sau vào/cắt qua
vòng 10 m mới phát đúng một giọng. Đứng trong vùng không phát lặp.
Quy tắc này áp dụng cho cả ổ gà và gờ giảm tốc.

MicroSD nên format FAT32. Firmware tự tạo telemetry.ndjson,
pending.ndjson, potholes.csv và speed_bumps.csv khi cần.
