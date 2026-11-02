-- | Luật thuần có thể kiểm thử độc lập với WebSocket, STM và MongoDB.
module Common.GameRules
  ( WeaponTick(..)
  , stepWeapon
  , grantWeapon
  , traceLaser
  , retainActiveEntities
  ) where

import Data.List (minimumBy)
import qualified Data.Map.Strict as Map
import Data.Maybe (mapMaybe)
import Data.Ord (comparing)
import Data.Text (Text)

import Common.Config
  ( buffDuration
  , gatlingBurstDelay
  , laserMaxReflections
  , laserSegmentMaxLen
  , specialBulletCooldown
  )
import Common.Types
  ( BulletType(..)
  , Bullet(..)
  , CooldownState(..)
  , LaserSegment(..)
  , Maze(..)
  , Tank
  , Vec2(..)
  , Wall(..)
  , WeaponState(..)
  , defaultWeaponState
  , vec2Add
  , vec2Len
  , vec2Normalize
  , vec2Reflect
  , vec2Scale
  )

data WeaponTick = WeaponTick
  { wtWeapon :: !WeaponState
  , wtFireGatlingRound :: !Bool
  } deriving (Show, Eq)

-- | Tiến một trạng thái vũ khí. Cờ trả về cho biết Gatling cần sinh thêm một viên.
stepWeapon :: Float -> WeaponState -> WeaponTick
stepWeapon deltaT weapon =
  let (cooldown', fireRound) = case wsCooldownState weapon of
        Ready -> (Ready, False)
        Reloading remaining ->
          let remaining' = remaining - deltaT
          in (if remaining' <= 0 then Ready else Reloading remaining', False)
        GatlingBurst remaining delay ->
          let delay' = delay - deltaT
          in if delay' > 0
               then (GatlingBurst remaining delay', False)
               else if remaining <= 0
                 then (Reloading specialBulletCooldown, False)
                 else (GatlingBurst (remaining - 1) gatlingBurstDelay, True)
      afterCooldown = weapon { wsCooldownState = cooldown' }
      buffLeft = wsBuffTimeLeft afterCooldown - deltaT
      afterBuff
        | wsBuffTimeLeft afterCooldown <= 0 = afterCooldown
        | buffLeft <= 0 = afterCooldown
            { wsCurrentWeapon = NormalBullet
            , wsBuffTimeLeft = 0
            }
        | otherwise = afterCooldown { wsBuffTimeLeft = buffLeft }
  in WeaponTick afterBuff fireRound

-- | Nhận vũ khí từ Mystery Box. Đạn thường luôn trở về trạng thái mặc định.
grantWeapon :: BulletType -> WeaponState -> WeaponState
grantWeapon NormalBullet _ = defaultWeaponState
grantWeapon bulletType _ = WeaponState
  { wsCurrentWeapon = bulletType
  , wsBuffTimeLeft = buffDuration
  , wsCooldownState = Ready
  }

-- | Keep only entities whose owner is still a member of the room. A game tick
-- is calculated from a snapshot, while a disconnect may commit before that
-- tick is written back. Applying this pure reconciliation at commit time
-- prevents an old snapshot from bringing a departed tank or its bullets back.
-- Rooms contain at most four players, so list membership is sufficient at 60 Hz.
retainActiveEntities :: [Text] -> Map.Map Text Tank -> [Bullet] -> (Map.Map Text Tank, [Bullet])
retainActiveEntities playerIds tanks bullets =
  ( Map.filterWithKey (\playerId _ -> isActive playerId) tanks
  , filter (isActive . bulOwnerId) bullets
  )
  where
    isActive playerId = playerId `elem` playerIds

-- | Dò tia laser theo các tường axis-aligned của mê cung. Mỗi segment kết
-- thúc tại tường gần nhất, sau đó hướng đi được phản xạ. Không có IO hay state
-- ẩn nên cùng maze và hướng bắn luôn tạo ra cùng một đường đi.
traceLaser :: Maze -> Vec2 -> Vec2 -> [LaserSegment]
traceLaser maze origin direction = go laserMaxReflections origin (vec2Normalize direction)
  where
    epsilon = 0.01 :: Float

    go :: Int -> Vec2 -> Vec2 -> [LaserSegment]
    go remaining start ray
      | remaining <= 0 || vec2Len ray < epsilon = []
      | otherwise =
          case nearestWallHit start ray of
            Nothing -> [LaserSegment start (vec2Add start (vec2Scale laserSegmentMaxLen ray))]
            Just (distance, hitPoint, normal) ->
              let segment = LaserSegment start hitPoint
                  reflected = vec2Normalize (vec2Reflect ray normal)
                  nextStart = vec2Add hitPoint (vec2Scale epsilon reflected)
              in segment : go (remaining - 1) nextStart reflected
      where
        nearestWallHit :: Vec2 -> Vec2 -> Maybe (Float, Vec2, Vec2)
        nearestWallHit startPoint rayDirection =
          case mapMaybe (rayWallHit startPoint rayDirection) (mazeWalls maze) of
            [] -> Nothing
            hits -> Just (minimumBy (comparing hitDistance) hits)

        hitDistance (distance, _, _) = distance

    rayWallHit :: Vec2 -> Vec2 -> Wall -> Maybe (Float, Vec2, Vec2)
    rayWallHit (Vec2 ox oy) (Vec2 dx dy) (Wall (Vec2 x1 y1) (Vec2 x2 y2))
      | abs (x1 - x2) < epsilon && abs dx >= epsilon =
          let distance = (x1 - ox) / dx
              hitY = oy + distance * dy
              lowY = min y1 y2 - epsilon
              highY = max y1 y2 + epsilon
              normal = Vec2 (negate (signum dx)) 0
          in if distance > epsilon && distance <= laserSegmentMaxLen
                && hitY >= lowY && hitY <= highY
               then Just (distance, Vec2 x1 hitY, normal)
               else Nothing
      | abs (y1 - y2) < epsilon && abs dy >= epsilon =
          let distance = (y1 - oy) / dy
              hitX = ox + distance * dx
              lowX = min x1 x2 - epsilon
              highX = max x1 x2 + epsilon
              normal = Vec2 0 (negate (signum dy))
          in if distance > epsilon && distance <= laserSegmentMaxLen
                && hitX >= lowX && hitX <= highX
               then Just (distance, Vec2 hitX y1, normal)
               else Nothing
      | otherwise = Nothing
