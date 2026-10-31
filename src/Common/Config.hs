-- | Common.Config
-- Tất cả hằng số cấu hình của trò chơi TankWar.
-- Được dùng chung giữa Client (render) và Server (game logic).
module Common.Config where

import Common.Types (BulletType(..))

--------------------------------------------------------------------------------
-- Tick Rate & Timing
--------------------------------------------------------------------------------

-- | Số lần cập nhật game loop mỗi giây (Server Authoritative).
tickRate :: Int
tickRate = 60

-- | Delta time mỗi tick (giây).
dt :: Float
dt = 1.0 / fromIntegral tickRate    -- ≈ 0.01667s

--------------------------------------------------------------------------------
-- Cooldown & Vũ khí
--------------------------------------------------------------------------------

-- | Thời gian hồi đạn thường sau mỗi phát bắn (giây).
normalBulletCooldown :: Float
normalBulletCooldown = 0.5

-- | Thời gian hồi đạn sự kiện / đạn đặc biệt từ Mystery Box (giây).
specialBulletCooldown :: Float
specialBulletCooldown = 1.0

-- | Hàm tính thời gian hồi đạn theo loại vũ khí:
-- Đạn thường 0.5 giây, đạn sự kiện Mystery Box 1.0 giây.
weaponCooldown :: BulletType -> Float
weaponCooldown NormalBullet = normalBulletCooldown
weaponCooldown _            = specialBulletCooldown

-- | Alias thời gian hồi đạn mặc định (tương thích ngược).
cooldownTime :: Float
cooldownTime = normalBulletCooldown

-- | Thời gian hiệu lực buff từ Mystery Box (giây).
buffDuration :: Float
buffDuration = 15.0

-- | Số viên đạn trong một loạt Gatling burst.
gatlingBurstCount :: Int
gatlingBurstCount = 3

-- | Khoảng cách thời gian giữa mỗi viên trong loạt Gatling (giây).
gatlingBurstDelay :: Float
gatlingBurstDelay = 0.12

-- | Góc mở tối đa (radian) mỗi bên cho Shotgun (tổng = 2x).
shotgunSpreadAngle :: Float
shotgunSpreadAngle = 0.25   -- ≈ 14.3°

--------------------------------------------------------------------------------
-- Đạn (Bullet)
--------------------------------------------------------------------------------

-- | Tốc độ đạn tiêu chuẩn (pixel/giây).
bulletSpeed :: Float
bulletSpeed = 400.0

-- | Tốc độ đạn xuyên tường (chậm hơn một chút để cân bằng).
wallPiercingSpeed :: Float
wallPiercingSpeed = 350.0

-- | Số lần đạn thường được phép nảy tường trước khi biến mất.
maxBulletBounces :: Int
maxBulletBounces = 5

-- | Thời gian sống tối đa của đạn (giây).
bulletMaxLifetime :: Float
bulletMaxLifetime = 5.0

-- | Bán kính va chạm của viên đạn.
bulletRadius :: Float
bulletRadius = 4.0

-- | Số phân đoạn phản xạ tối đa của laser.
laserMaxReflections :: Int
laserMaxReflections = 5

-- | Chiều dài tối đa mỗi phân đoạn laser (pixel).
laserSegmentMaxLen :: Float
laserSegmentMaxLen = 2000.0

--------------------------------------------------------------------------------
-- Xe tăng (Tank)
--------------------------------------------------------------------------------

-- | Tốc độ di chuyển của xe tăng (pixel/giây).
tankSpeed :: Float
tankSpeed = 150.0

-- | Kích thước nửa cạnh (half-size) của hitbox vuông xe tăng.
tankHalfSize :: Float
tankHalfSize = 16.0

-- | Bán kính va chạm của xe tăng (dùng circle collider cho đơn giản).
tankRadius :: Float
tankRadius = 18.0

--------------------------------------------------------------------------------
-- Mystery Box
--------------------------------------------------------------------------------

-- | Khoảng thời gian tối thiểu giữa các lần spawn hộp bí ẩn (giây).
boxSpawnIntervalMin :: Float
boxSpawnIntervalMin = 20.0

-- | Khoảng thời gian tối đa giữa các lần spawn (giây).
boxSpawnIntervalMax :: Float
boxSpawnIntervalMax = 30.0

-- | Bán kính va chạm của hộp bí ẩn.
boxRadius :: Float
boxRadius = 14.0

--------------------------------------------------------------------------------
-- Mê cung (Maze)
--------------------------------------------------------------------------------

-- | Kích thước ô lưới cơ bản của mê cung (pixel).
cellSize :: Float
cellSize = 64.0

-- | Chiều rộng bản đồ mê cung mặc định (pixel).
defaultMazeWidth :: Float
defaultMazeWidth = 1344.0   -- 21 ô * 64px

-- | Chiều cao bản đồ mê cung mặc định (pixel).
defaultMazeHeight :: Float
defaultMazeHeight = 704.0   -- 11 ô * 64px

-- | Độ dày tường (dùng cho render, collider dùng segment).
wallThickness :: Float
wallThickness = 4.0

--------------------------------------------------------------------------------
-- Phòng (Room)
--------------------------------------------------------------------------------

-- | Số người chơi tối thiểu để bắt đầu trận đấu.
minPlayersToStart :: Int
minPlayersToStart = 2

-- | Số người chơi tối đa mỗi phòng.
maxPlayersPerRoom :: Int
maxPlayersPerRoom = 4

-- | Độ dài Room ID tự sinh.
roomIdLength :: Int
roomIdLength = 6

-- | Số round cần thắng để kết thúc trận đấu (First to N).
winningScore :: Int
winningScore = 5

-- | Thời gian countdown trước round (giây).
countdownDuration :: Float
countdownDuration = 3.0

-- | Thời gian hiển thị kết quả kết thúc round trước khi reset (giây).
roundEndDelay :: Float
roundEndDelay = 3.0

--------------------------------------------------------------------------------
-- Mạng (Network)
--------------------------------------------------------------------------------

-- | Cổng WebSocket mặc định.
defaultPort :: Int
defaultPort = 8080

-- | Cổng MongoDB mặc định.
defaultMongoPort :: Int
defaultMongoPort = 27017

-- | Tên database MongoDB.
mongoDbName :: String
mongoDbName = "TankWar"

-- | Khoảng thời gian ping WebSocket (giây).
wsPingInterval :: Int
wsPingInterval = 30
