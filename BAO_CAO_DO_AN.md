# Báo cáo đồ án TankWar

## 1. Giới thiệu và mục tiêu
TankWar là game xe tăng đối kháng nhiều người, gồm backend Haskell, giao thức WebSocket và frontend HTML5 Canvas. Máy chủ là phía có thẩm quyền (authoritative server), tính toán trạng thái trận đấu, va chạm và vật lý đạn ở tần số 60 Hz.

## 2. Kiến trúc hệ thống
- `src/Common`: kiểu dữ liệu dùng chung, cấu hình và giao thức JSON.
- `server/Server`: trạng thái STM, quản lý phòng, game engine và truy cập MongoDB.
- `server/Main.hs`: khởi tạo server WebSocket và điều phối kết nối.
- `web`: giao diện Canvas, chế độ offline và client WebSocket.
- `test/Spec.hs`: kiểm thử vector, cooldown và tuần tự hóa giao thức.

## 3. Kỹ thuật lập trình hàm đã sử dụng

### Kiểu dữ liệu và máy trạng thái
Dự án sử dụng ADT cho xe tăng, đạn, loại đạn, pha trận đấu và thông điệp giao thức. Các kiểu rời rạc giúp game engine xác định trạng thái bằng chuyển mẫu thay vì điều kiện chuỗi phức tạp.

### Hàm bậc cao, đệ quy và danh sách
Vòng lặp game được mô hình hóa bằng hàm đệ quy. Dữ liệu xe tăng và đạn được xử lý bằng `map`, `filter`, `Map.mapWithKey`, `fold`, danh sách comprehension và các hàm xử lý va chạm.

### Monad và xử lý I/O
Máy chủ dùng `IO` cho mạng, WebSocket, MongoDB và hẹn giờ. STM dùng `STM`/`atomically` để cập nhật trạng thái phòng và danh sách client. Các lỗi ngoại lệ được bắt bằng `try`/`catch`; kết nối MongoDB không khả dụng được trả về dưới dạng `Either` thay vì làm crash toàn bộ server.

### Đồng bộ hóa
Trạng thái toàn cục được lưu trong TVar. Mỗi thao tác đọc hoặc cập nhật phòng/client nằm trong transaction STM, và các vòng lặp phòng được chạy bằng thread riêng bằng `forkIO`. Tệp cấu hình server bật `-threaded`, `-with-rtsopts=-N` để hỗ trợ nhiều capability Haskell runtime.

## 4. Tính eager/lazy và đánh giá hiệu năng
Haskell mặc định dùng lazy evaluation. Trong dự án, danh sách/map có thể được trì hoãn cho đến khi render hoặc broadcast; điều này tránh tính toán không cần thiết một phần. Tuy nhiên, trạng thái game tick và broadcast là dữ liệu nhạy cảm về thời gian nên đã dùng strict fields (`!`) cho các trường thường xuyên truy cập, đồng thời dùng strict Map operations trong trạng thái và thao tác atomic bằng STM.

Các hàm quản lý snapshot tạo dữ liệu hợp lý mỗi tick; Strict fields và bang patterns trong các module cấu hình/state giảm việc giữ nhiều thunk và giúp duy trì 60 Hz. Cần tránh gom danh sách đạn/quả cầu trong một vòng đệ quy dài mà không buộc dữ liệu, vì lazy list có thể tích tụ thunk và làm latency không ổn định. Khi benchmark cần chạy với `+RTS -s -N`, đo số tick, độ trễ WebSocket và bộ nhớ để xác nhận.

## 5. Lưu trữ và mạng
Backend hỗ trợ WebSocket cho trò chuyện hai chiều và MongoDB cho hồ sơ, kết quả trận và bảng xếp hạng. Các thông điệp được tuần tự hóa bằng Aeson JSON, có kiểm thử round-trip.

## 6. Kiểm thử
`cabal test` kiểm tra:
- phép tính vector và reflection;
- cooldown của các loại đạn;
- độ dài buff và số đạn Gatling/bounces;
- mã hóa/giải mã JSON của `ClientMessage` và `ServerMessage`.

## 7. Đường dẫn chứng minh
| Nội dung | Chứng minh |
|---|---|
| ADT, JSON, strict fields | `src/Common/Types.hs`, `src/Common/Protocol.hs` |
| STM/TVar | `server/Server/State.hs` |
| Game loop/thread 60 Hz | `server/Server/GameEngine.hs`, `tankwar.cabal` |
| Quản lý phòng | `server/Server/RoomManager.hs` |
| WebSocket/MongoDB | `server/Main.hs`, `server/Server/Database/` |
| GUI | `web/index.html`, `web/app.js`, `web/style.css` |
| Kiểm thử | `test/Spec.hs` |

## 8. Phân công trách nhiệm
- Backend Haskell, game engine và STM: phát triển vòng đời game, cập nhật vật lý, đồng bộ và broadcast.
- Mô hình dữ liệu/protocol: khai báo ADT, JSON và cấu hình dùng chung.
- Quản lý phòng/MongoDB: lobby, kết nối, lưu trữ hồ sơ và kết quả trận.
- Web frontend: Canvas renderer, điều khiển, offline practice và client WebSocket.
- Kiểm thử: vector, cooldown, JSON round-trip và biên dịch Haskell.

## 9. Hạn chế và hướng hoàn thiện
- Parser cần được đánh giá riêng theo đề bài; phần dữ liệu nhập chủ yếu hiện dùng JSON/Aeson.
- Bảng xếp hạng MongoDB và một số luồng database chưa hoàn thiện đầy đủ để demo production.
- Cần chạy tích hợp nhiều client cùng lúc để kiểm tra desync, sức chịu tải và kết thúc thread khi phòng trống.
- Chưa có Docker compose trong repository hiện tại dù README vẫn mô tả lệnh triển khai.
