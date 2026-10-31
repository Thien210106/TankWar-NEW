# TankWar Browser Edition

Đây là frontend web Canvas bổ sung cho dự án Haskell hiện có. Các file Haskell gốc không bị thay đổi. Giao diện Gloss không chạy trực tiếp trong trình duyệt, vì vậy `web/` cung cấp renderer Canvas mới dùng tài nguyên xe tăng/đạn của dự án và có thể gửi input đến Haskell WebSocket server.

## 1. Chạy nhanh ở chế độ offline

Cần một static web server. Từ thư mục gốc `LTH-TankWar-HaskellGame`, mở PowerShell/CMD và chạy:

```powershell
py -m http.server 5173
```

Mở trình duyệt tại:

```text
http://localhost:5173/web/
```

Nhập tên chiến binh rồi nhấn **TẠO PHÒNG THỬ**, chọn Forest, Ruins hoặc Depot, sau đó đặt tên/chọn xe. Chế độ này ghép bạn với 3 bot cục bộ để kiểm tra map, không cần MongoDB hay server Haskell. Điều khiển: `W/A/S/D` để di chuyển, chuột để ngắm, click trái hoặc `Space` để bắn. Gameplay không hiển thị menu hoặc nút Exit; báo cáo sau trận có nút trở về trang chủ.

> Nếu lệnh `py` không tồn tại trên máy, cài Python 3 hoặc dùng một static server khác. Nên chạy qua `http://localhost` thay vì mở trực tiếp file HTML.

Nếu đã có Node.js, project cũng kèm preview server không cần cài package. Đây là lệnh cho bản preview hiện tại:

```powershell
node web/preview-server.js 4173
```

Mở [http://127.0.0.1:4173/](http://127.0.0.1:4173/). Nhạc menu bắt đầu ở lần click đầu tiên vì trình duyệt không cho phép tự phát âm thanh trước một thao tác của người chơi. Khi xác nhận xe, trình duyệt sẽ yêu cầu fullscreen; nếu bị từ chối, khung game vẫn tự lấp toàn bộ viewport.

## 2. Kết nối online với Haskell server hiện có

Online mode cần chạy server và MongoDB. Ở thư mục gốc dự án:

1. Khởi động MongoDB. Nếu bạn đã cài Docker:

   ```powershell
   docker run -d -p 27017:27017 --name tankwar-mongo mongo:latest
   ```

   Nếu container đã được tạo trước đó, dùng `docker start tankwar-mongo` thay vì tạo lại.

2. Mở **một cửa sổ terminal khác** tại thư mục gốc dự án và khởi động Haskell server:

   ```powershell
   stack exec tankwar-server -- --port 8080 --mongo-uri "mongodb://localhost:27017/TankWar"
   ```

   Hoặc dùng Cabal:

   ```powershell
   cabal run tankwar-server -- --port 8080 --mongo-uri "mongodb://localhost:27017/TankWar"
   ```

3. Mở `http://localhost:5173/web/`, nhập tên người chơi. Để server mặc định là `ws://localhost:8080`, rồi nhấn **KẾT NỐI ONLINE**.
4. Một người tạo phòng; người còn lại kết nối vào cùng server và nhập Room ID 6 ký tự. Chủ phòng bắt đầu khi có ít nhất 2 người.

Frontend gửi/nhận thông điệp theo dạng JSON tagged của `Aeson` trong `src/Common/Protocol.hs`; game state và vật lý online vẫn do Haskell server xử lý. Địa chỉ mặc định `ws://localhost:8080` chỉ dùng được khi server ở cùng máy. Nếu server ở máy khác, nhập `ws://IP-MAY-CHU:8080` và mở cổng phù hợp.

### Khi triển khai website công khai

Frontend tĩnh có thể triển khai từ riêng thư mục `web/` lên hosting HTTPS. Tuy nhiên, website HTTPS cần kết nối WebSocket bảo mật (`wss://`). Server Haskell trong repo đang mở WebSocket thường (`ws://`) trên cổng 8080; hãy đặt reverse proxy TLS hỗ trợ WebSocket trước server và nhập URL `wss://...` vào giao diện. Không nên mở trực tiếp cổng game ra Internet nếu chưa cấu hình mạng và firewall an toàn.

## 3. Tính năng & Cải tiến mới

- Offline Practice là chế độ huấn luyện cục bộ để test giao diện và thao tác; bot/va chạm ở chế độ này là mô phỏng JavaScript, không phải game state authoritative của server.
- File `testgame.js` tập trung các thông số tạm cho bản test: zoom camera `0.2` (nhìn xa gấp 5), tank hiển thị `0.5` với hitbox test `60px`, 3 bot, hồi sinh 5 giây và mốc thắng 6 hạ gục để thử màn kết quả. Backend có thể bỏ file này cùng luồng test khi đã sẵn sàng; cơ chế random map online không bị frontend thay đổi.
- Online mode dùng Haskell backend hiện tại. Nếu backend hoặc MongoDB chưa chạy, đăng nhập online sẽ thất bại; bạn vẫn có thể chơi offline.
- Ba map luyện tập nằm tại `assets/maps/`. Frontend tải `*_layout.json` để dùng `wall_rectangles` và `blocked_cells` cho va chạm; `*_maze_4096.png` chỉ được dùng làm background đã bake sẵn. Vì vậy hãy chạy qua static HTTP server thay vì mở `index.html` trực tiếp.
- Mã nguồn server chỉ gửi tên người chơi khi họ tham gia sau khi bạn đã vào phòng. Với người chơi đã ở trong phòng trước đó, giao diện phòng chờ tạm hiển thị slot chờ đồng bộ đến khi snapshot trận đấu bắt đầu. Muốn có danh sách roster đầy đủ ngay trong lobby, cần bổ sung thông điệp roster ở backend.
- Phần server yêu cầu tối thiểu 2 người cho `CStartGame`; client hiện tuân thủ giới hạn này.
- **Đồng bộ danh sách phòng chờ (Lobby Roster Sync):** Đã bổ sung gói tin `SRoomRoster` ở cả Haskell Server và Web Client. Người chơi vào sau sẽ lập tức nhận danh sách đầy đủ tất cả chiến binh kèm màu xe và chủ phòng.
- **Hệ thống âm thanh Web Audio SoundFX:** Tổng hợp âm thanh procedural (tiếng súng riêng biệt cho 5 loại đạn, tiếng nảy tường, tiếng nổ xe tăng, tiếng nhặt hộp quà, âm thanh đếm ngược và nhạc chiến thắng), có nút bật/tắt tiện lợi `♫`.
- **Offline Practice:** Chế độ huấn luyện cục bộ chạy ngay trên Canvas/JS với bot di chuyển và né vật cản, không cần cài đặt server hay database.
- **Online Mode:** Kết nối WebSocket Authoritative tới Haskell Server (60 Tick/s), lưu trữ trận đấu trên MongoDB.

## 4. Ghi chú phát triển

- `index.html`: các màn hình menu, lobby, phòng chờ và trận đấu.
- `style.css`: giao diện responsive.
- `app.js`: Canvas renderer, chế độ offline 4096 có camera/tầm nhìn giới hạn, fullscreen và WebSocket protocol client.
- `testgame.js`: cấu hình/browser-only dành cho phòng thử với bot, tách khỏi protocol backend.
- `assets/maps/`: layout JSON và background 4096 gốc cho Forest, Ruins, Depot.
- `assets/menu/`: background, khung đặt tên, nút bắt đầu/thoát và bảng điểm từ folder Menu/MenuEnd.
- `assets/audio/`: nhạc menu/trận/kết quả và toàn bộ hiệu ứng âm thanh.
- `assets/img/`: sprite tank/mystery box dùng cho client độc lập.
