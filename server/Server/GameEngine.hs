-- | Server.GameEngine
-- Vòng lặp game chính (Authoritative Game Loop) chạy 60 Hz trên Server.
-- Xử lý: di chuyển xe tăng, vật lý đạn nảy, cooldown (thường 0.5s, box 1.0s), mystery box 15s,
-- Gatling burst 3 viên, va chạm, xác định thắng thua.
module Server.GameEngine
  ( startRoomGameLoop
  , tickRoom
  ) where

import Control.Concurrent       (threadDelay, forkIO)
import Control.Concurrent.STM
import Control.Monad            (forM_, when, unless, void, forever)
import Data.Map.Strict          (Map)
import qualified Data.Map.Strict as Map
import Data.Text                (Text, pack)
import Data.Time.Clock          (getCurrentTime)
import Data.Time.Format         (formatTime, defaultTimeLocale)
import System.Random            (randomRIO)
import Data.List                (find)
import Data.Maybe               (mapMaybe, isJust, fromMaybe)

import Common.Types
import Common.Config
import Common.Protocol
import Server.State
import Server.RoomManager         (generateMaze, shuffleList)
import Server.Database.Connection (MongoPool)
import Server.Database.PlayerRepo (addKill, addDeath, addWin, updatePlayerStats)
import Server.Database.MatchRepo  (saveMatchResult)

--------------------------------------------------------------------------------
-- Khởi chạy Game Loop cho một phòng
--------------------------------------------------------------------------------

-- | Fork thread game loop cho phòng đã bắt đầu trận.
-- Thread chạy liên tục 60Hz cho đến khi trận kết thúc.
startRoomGameLoop :: ServerState -> MongoPool -> Text -> IO ()
startRoomGameLoop ss db roomId = void $ forkIO $ do
  putStrLn $ "[GameLoop] Bắt đầu game loop cho phòng " ++ show roomId
  gameLoopForever ss db roomId
  putStrLn $ "[GameLoop] Kết thúc game loop phòng " ++ show roomId

-- | Vòng lặp chính: tick → broadcast → delay → repeat.
gameLoopForever :: ServerState -> MongoPool -> Text -> IO ()
gameLoopForever ss db roomId = do
  maybeRoom <- atomically $ getRoom ss roomId
  case maybeRoom of
    Nothing -> return ()  -- Phòng đã bị xoá
    Just room -> do
      case rsPhase room of
        MatchOverPhase _ -> return ()  -- Trận kết thúc, dừng loop
        _ -> do
          -- Thực hiện một tick
          tickRoom ss db roomId
          -- Broadcast world snapshot
          broadcastSnapshot ss roomId
          -- Delay đúng tick rate (60 Hz ≈ 16667 μs)
          threadDelay (1000000 `div` tickRate)
          -- Tiếp tục
          gameLoopForever ss db roomId

--------------------------------------------------------------------------------
-- Một Tick (≈ 16.67ms)
--------------------------------------------------------------------------------

-- | Xử lý một tick hoàn chỉnh cho phòng.
tickRoom :: ServerState -> MongoPool -> Text -> IO ()
tickRoom ss db roomId = do
  maybeRoom <- atomically $ getRoom ss roomId
  case maybeRoom of
    Nothing   -> return ()
    Just room -> case rsPhase room of

      -- 1) COUNTDOWN: Đếm ngược 3 giây
      CountdownPhase t -> do
        let t' = t - dt
        if t' <= 0
          then do
            -- Chuyển sang InGame, spawn mystery box timer
            boxDelay <- randomRIO (boxSpawnIntervalMin, boxSpawnIntervalMax)
            atomically $ modifyRoom ss roomId $ \r -> r
              { rsPhase    = InGamePhase
              , rsBoxTimer = boxDelay
              }
            broadcastToRoom ss roomId (SCountdown 0)
          else do
            atomically $ modifyRoom ss roomId $ \r -> r
              { rsPhase = CountdownPhase t' }
            -- Gửi countdown cho client mỗi giây
            when (floor t' /= (floor (t' + dt) :: Int)) $
              broadcastToRoom ss roomId (SCountdown t')

      -- 2) IN GAME: Vòng lặp chính
      InGamePhase -> do
        tickInGame ss db roomId room

      -- 3) ROUND END: Chờ trước khi bắt đầu round mới
      RoundEndPhase t winner -> do
        let t' = t - dt
        if t' <= 0
          then startNewRound ss roomId
          else atomically $ modifyRoom ss roomId $ \r -> r
                 { rsPhase = RoundEndPhase t' winner }

      -- Các phase khác: không tick
      _ -> return ()

--------------------------------------------------------------------------------
-- Tick In-Game (Phase chính)
--------------------------------------------------------------------------------

tickInGame :: ServerState -> MongoPool -> Text -> RoomState -> IO ()
tickInGame ss db roomId room = do
  let tanks    = rsTanks room
      bullets  = rsBullets room
      maze     = rsMaze room
      inputs   = rsInputs room

  -- Bước 1: Cập nhật vũ khí & cooldown
  let tanks1 = Map.mapWithKey (updateWeaponCooldown dt) tanks

  -- Bước 2: Xử lý bắn (spawn đạn mới)
  (tanks2, newBullets) <- processFireInputs inputs tanks1 maze

  -- Bước 3: Di chuyển xe tăng + va chạm tường
  let tanks3 = Map.mapWithKey (\pid t ->
        case Map.lookup pid inputs of
          Just inp -> moveTank dt inp maze t
          Nothing  -> t
        ) tanks2

  -- Bước 4: Di chuyển đạn + nảy tường
  let allBullets = bullets ++ newBullets
      bullets1   = map (moveBullet dt maze) allBullets
      -- Loại đạn hết lifetime hoặc vượt quá bounces
      bullets2   = filter bulletAlive bullets1

  -- Bước 5: Va chạm đạn - xe tăng
  (tanks4, bullets3, killEvents) <- processBulletTankCollisions tanks3 bullets2

  -- Bước 6: Va chạm đạn - Mystery Box
  (boxes1, bullets4, boxEvents) <-
    processBulletBoxCollisions (rsMysteryBoxes room) bullets3 tanks4

  -- Bước 7: Cập nhật Mystery Box timer & spawn
  (boxes2, boxTimer') <- updateMysteryBoxTimer dt (rsBoxTimer room) boxes1 maze

  -- Bước 8: Xoá laser cũ (chỉ tồn tại 1 tick)
  let lasers = []  -- Laser được sinh mới mỗi tick khi bắn

  -- Bước 9: Ghi nhận kill events vào DB & broadcast
  forM_ killEvents $ \(killer, victim) -> do
    broadcastToRoom ss roomId (SKillEvent killer victim)
    addKill db killer
    addDeath db victim

  -- Bước 10: Ghi nhận box pickup events
  forM_ boxEvents $ \(picker, btype) ->
    broadcastToRoom ss roomId (SMysteryBoxPickup picker btype)

  -- Bước 11: Kiểm tra round kết thúc
  let aliveTanks = Map.filter tankAlive tanks4
      aliveCount = Map.size aliveTanks

  -- Cập nhật state
  atomically $ modifyRoom ss roomId $ \r -> r
    { rsTanks        = tanks4
    , rsBullets      = bullets4
    , rsLasers       = lasers
    , rsMysteryBoxes = boxes2
    , rsBoxTimer     = boxTimer'
    }

  -- Kiểm tra kết thúc round (chỉ 1 người sống sót)
  when (Map.size tanks4 > 1 && aliveCount <= 1) $ do
    let winner = case Map.elems aliveTanks of
                   [t] -> tankId t
                   _   -> "Draw"

    -- Cộng điểm cho winner
    atomically $ modifyRoom ss roomId $ \r -> r
      { rsTanks = Map.adjust (\t -> t { tankScore = tankScore t + 1 })
                    winner (rsTanks r)
      }

    -- Kiểm tra match over
    updatedRoom <- atomically $ getRoom ss roomId
    case updatedRoom of
      Nothing -> return ()
      Just r' -> do
        let updatedTanks = rsTanks r'
            scores = [(tankId t, tankScore t) | t <- Map.elems updatedTanks]
            maxScore = maximum $ map snd scores

        if maxScore >= winningScore
          then handleMatchOver ss db roomId winner scores r'
          else do
            -- Chuyển sang RoundEnd phase
            atomically $ modifyRoom ss roomId $ \r -> r
              { rsPhase = RoundEndPhase roundEndDelay winner }
            broadcastToRoom ss roomId (SRoundEnd winner scores)

--------------------------------------------------------------------------------
-- Di chuyển Xe tăng + Va chạm tường (Sliding Collision)
--------------------------------------------------------------------------------

moveTank :: Float -> PlayerInput -> Maze -> Tank -> Tank
moveTank deltaT input maze tank
  | not (tankAlive tank) = tank
  | otherwise =
    let -- Tính vận tốc từ input WASD
        moveX = (if piMoveRight input then 1 else 0)
              - (if piMoveLeft  input then 1 else 0)
        moveY = (if piMoveUp    input then 1 else 0)
              - (if piMoveDown  input then 1 else 0)
        moveDir = vec2Normalize (Vec2 moveX moveY)
        vel     = vec2Scale tankSpeed moveDir

        -- Vị trí mới dự kiến
        newPos  = vec2Add (tankPos tank) (vec2Scale deltaT vel)

        -- Sliding collision với tường mê cung
        clampedPos = clampToMaze maze (tankPos tank) newPos

        -- Cập nhật góc thân xe (chỉ khi đang di chuyển)
        bodyAngle = if vec2Len vel > 0.1
                    then vec2Angle moveDir
                    else tankBodyAngle tank

        -- Góc nòng pháo = góc chuột từ client
        turretAng = piMouseAngle input

    in tank
      { tankPos         = clampedPos
      , tankVel         = vel
      , tankBodyAngle   = bodyAngle
      , tankTurretAngle = turretAng
      }

-- | Khoảng cách từ điểm p tới đoạn thẳng nối v1 và v2
pointSegmentDist :: Vec2 -> Vec2 -> Vec2 -> Float
pointSegmentDist p v1 v2 =
  let d = vec2Dist v1 v2
      l2 = d * d
  in if l2 < 0.0001
     then vec2Dist p v1
     else let t = max 0 (min 1 (vec2Dot (vec2Sub p v1) (vec2Sub v2 v1) / l2))
              proj = vec2Add v1 (vec2Scale t (vec2Sub v2 v1))
          in vec2Dist p proj

-- | Giữ xe tăng trong giới hạn mê cung và trượt theo tường nội bộ
clampToMaze :: Maze -> Vec2 -> Vec2 -> Vec2
clampToMaze maze oldPos newPos =
  let w = mazeWidth maze
      h = mazeHeight maze
      r = tankRadius + 1
      cx = max r (min (w - r) (vx newPos))
      cy = max r (min (h - r) (vy newPos))
      boundedPos = Vec2 cx cy
      innerWalls = drop 4 (mazeWalls maze)

      collidesWithAny pos = any (\(Wall p1 p2) -> pointSegmentDist pos p1 p2 < r) innerWalls

  in if not (collidesWithAny boundedPos)
       then boundedPos
       else let posX = Vec2 cx (vy oldPos)
            in if not (collidesWithAny posX)
                 then posX
                 else let posY = Vec2 (vx oldPos) cy
                      in if not (collidesWithAny posY)
                           then posY
                           else oldPos

--------------------------------------------------------------------------------
-- Di chuyển Đạn + Phản xạ tường (Tối đa 5 lần)
--------------------------------------------------------------------------------

moveBullet :: Float -> Maze -> Bullet -> Bullet
moveBullet deltaT maze bul =
  case bulType bul of
    WallPiercingBullet ->
      -- Đạn xuyên tường: chỉ cập nhật vị trí, không nảy
      bul { bulPos      = vec2Add (bulPos bul) (vec2Scale deltaT (bulVel bul))
          , bulLifetime = bulLifetime bul - deltaT
          }
    _ ->
      -- Đạn thường: nảy tường biên & tường nội bộ
      let newPos = vec2Add (bulPos bul) (vec2Scale deltaT (bulVel bul))
          (finalPos, finalVel, bounceCount) =
            reflectBullet maze (bulPos bul) newPos (bulVel bul) (bulBounces bul)
      in bul
        { bulPos      = finalPos
        , bulVel      = finalVel
        , bulBounces  = bounceCount
        , bulLifetime = bulLifetime bul - deltaT
        }

-- | Kiểm tra và phản xạ đạn qua tường biên và các vách ngăn mê cung
reflectBullet :: Maze -> Vec2 -> Vec2 -> Vec2 -> Int -> (Vec2, Vec2, Int)
reflectBullet maze (Vec2 ox oy) (Vec2 nx ny) (Vec2 vvx vvy) bounces =
  let w = mazeWidth maze
      h = mazeHeight maze
      r = bulletRadius
      innerWalls = drop 4 (mazeWalls maze)

      -- 1) Phản xạ biên
      (nx1, vvx1, b1) =
        if nx < r
          then (r + (r - nx), abs vvx, bounces + 1)
        else if nx > w - r
          then (w - r - (nx - (w - r)), -(abs vvx), bounces + 1)
        else (nx, vvx, bounces)

      (ny1, vvy1, b2) =
        if ny < r
          then (r + (r - ny), abs vvy, b1 + 1)
        else if ny > h - r
          then (h - r - (ny - (h - r)), -(abs vvy), b1 + 1)
        else (ny, vvy, b1)

      -- 2) Phản xạ qua tường nội bộ
      checkWall (pos@(Vec2 cx cy), vel@(Vec2 cvx cvy), curB) (Wall (Vec2 x1 y1) (Vec2 x2 y2))
        -- Tường ngang
        | abs (y1 - y2) < 0.1 =
            let wy   = y1
                minX = min x1 x2 - r
                maxX = max x1 x2 + r
                crossed = (oy <= wy && cy >= wy) || (oy >= wy && cy <= wy)
            in if crossed && cx >= minX && cx <= maxX
                 then let newVy = if oy < wy then -abs cvy else abs cvy
                          newCy = wy + (if oy < wy then -r else r)
                      in (Vec2 cx newCy, Vec2 cvx newVy, curB + 1)
                 else (pos, vel, curB)
        -- Tường dọc
        | abs (x1 - x2) < 0.1 =
            let wx   = x1
                minY = min y1 y2 - r
                maxY = max y1 y2 + r
                crossed = (ox <= wx && cx >= wx) || (ox >= wx && cx <= wx)
            in if crossed && cy >= minY && cy <= maxY
                 then let newVx = if ox < wx then -abs cvx else abs cvx
                          newCx = wx + (if ox < wx then -r else r)
                      in (Vec2 newCx cy, Vec2 newVx cvy, curB + 1)
                 else (pos, vel, curB)
        | otherwise = (pos, vel, curB)

      (finalPos, finalVel, finalBounces) =
        foldl checkWall (Vec2 nx1 ny1, Vec2 vvx1 vvy1, b2) innerWalls

  in (finalPos, finalVel, finalBounces)

-- | Kiểm tra đạn còn sống không (tối đa 5 lần nảy)
bulletAlive :: Bullet -> Bool
bulletAlive bul =
  bulLifetime bul > 0 && bulBounces bul <= maxBulletBounces

--------------------------------------------------------------------------------
-- Xử lý bắn đạn (Fire Input → Spawn Bullets)
--------------------------------------------------------------------------------

processFireInputs :: Map Text PlayerInput -> Map Text Tank -> Maze
                  -> IO (Map Text Tank, [Bullet])
processFireInputs inputs tanks _maze = do
  results <- mapM processOne (Map.toList tanks)
  let tanks'  = Map.fromList [(tankId t, t) | (t, _) <- results]
      newBuls = concatMap snd results
  return (tanks', newBuls)
  where
    processOne (pid, tank)
      | not (tankAlive tank) = return (tank, [])
      | otherwise =
        case Map.lookup pid inputs of
          Nothing  -> return (tank, [])
          Just inp -> handleFire inp tank

-- | Xử lý input bắn cho một xe tăng.
handleFire :: PlayerInput -> Tank -> IO (Tank, [Bullet])
handleFire input tank
  | not (piFire input) = return (tank, [])
  | otherwise = case wsCooldownState (tankWeapon tank) of
      Ready -> do
        let weapon = tankWeapon tank
            btype  = wsCurrentWeapon weapon
        buls <- spawnBullets tank btype
        let weapon' = case btype of
              GatlingBullet -> weapon
                { wsCooldownState = GatlingBurst (gatlingBurstCount - 1) gatlingBurstDelay }
              _ -> weapon
                { wsCooldownState = Reloading (weaponCooldown btype) }
        return (tank { tankWeapon = weapon' }, buls)

      -- Gatling burst: tự động bắn viên tiếp theo khi delay hết
      -- (xử lý trong updateWeaponCooldown)
      _ -> return (tank, [])

-- | Spawn đạn theo loại vũ khí.
spawnBullets :: Tank -> BulletType -> IO [Bullet]
spawnBullets tank btype = do
  let pos   = tankPos tank
      angle = tankTurretAngle tank
      dir   = Vec2 (cos angle) (sin angle)
      -- Offset an toàn trong bán kính thân xe (tankRadius = 15) để đạn không bao giờ xuyên qua tường khi đứng sát
      let spawnOffset = 12.0 :: Float
      let spawnPos = vec2Add pos (vec2Scale spawnOffset dir)
  case btype of
    NormalBullet -> return [mkBullet spawnPos dir bulletSpeed NormalBullet (tankId tank)]

    ShotgunBullet -> do
      -- 3 viên: thẳng + 2 bên mở rẻ quạt
      let dir1 = vec2Rotate (-shotgunSpreadAngle) dir
          dir2 = dir
          dir3 = vec2Rotate shotgunSpreadAngle dir
          sp1  = vec2Add pos (vec2Scale spawnOffset dir1)
          sp3  = vec2Add pos (vec2Scale spawnOffset dir3)
      return [ mkBullet sp1 dir1 bulletSpeed NormalBullet (tankId tank)
             , mkBullet spawnPos dir2 bulletSpeed NormalBullet (tankId tank)
             , mkBullet sp3 dir3 bulletSpeed NormalBullet (tankId tank)
             ]

    LaserBullet ->
      -- Laser xử lý đặc biệt: instant hit (trace ray), không spawn bullet bay
      -- TODO: Implement laser ray tracing
      return [mkBullet spawnPos dir (bulletSpeed * 3) LaserBullet (tankId tank)]

    WallPiercingBullet ->
      return [mkBullet spawnPos dir wallPiercingSpeed WallPiercingBullet (tankId tank)]

    GatlingBullet ->
      return [mkBullet spawnPos dir bulletSpeed NormalBullet (tankId tank)]

mkBullet :: Vec2 -> Vec2 -> Float -> BulletType -> Text -> Bullet
mkBullet pos dir speed btype ownerId = Bullet
  { bulPos      = pos
  , bulVel      = vec2Scale speed (vec2Normalize dir)
  , bulType     = btype
  , bulOwnerId  = ownerId
  , bulBounces  = 0
  , bulLifetime = bulletMaxLifetime
  }

--------------------------------------------------------------------------------
-- Cập nhật Weapon & Cooldown State Machine
--------------------------------------------------------------------------------

updateWeaponCooldown :: Float -> Text -> Tank -> Tank
updateWeaponCooldown deltaT _pid tank
  | not (tankAlive tank) = tank
  | otherwise =
    let weapon = tankWeapon tank
        weapon' = case wsCooldownState weapon of
          Ready -> weapon
          Reloading t ->
            let t' = t - deltaT
            in if t' <= 0
               then weapon { wsCooldownState = Ready }
               else weapon { wsCooldownState = Reloading t' }
          GatlingBurst remaining delay ->
            let delay' = delay - deltaT
            in if delay' <= 0
               then if remaining <= 0
                    -- Hết loạt burst → vào cooldown đạn sự kiện (2.0s)
                    then weapon { wsCooldownState = Reloading specialBulletCooldown }
                    -- Bắn viên tiếp theo (tự động)
                    else weapon { wsCooldownState = GatlingBurst (remaining - 1) gatlingBurstDelay }
               else weapon { wsCooldownState = GatlingBurst remaining delay' }

        -- Cập nhật buff timer (15 giây Mystery Box)
        weapon'' = if wsBuffTimeLeft weapon' > 0
                   then let t' = max 0 (wsBuffTimeLeft weapon' - deltaT)
                        in if t' <= 0
                           -- Hết buff → về đạn thường
                           then weapon' { wsCurrentWeapon = NormalBullet
                                        , wsBuffTimeLeft  = 0 }
                           else weapon' { wsBuffTimeLeft = t' }
                   else weapon'

    in tank { tankWeapon = weapon'' }

--------------------------------------------------------------------------------
-- Va chạm Đạn - Xe tăng
--------------------------------------------------------------------------------

processBulletTankCollisions :: Map Text Tank -> [Bullet]
                           -> IO (Map Text Tank, [Bullet], [(Text, Text)])
processBulletTankCollisions tanks bullets = do
  let (survivingBullets, hitTanks, killEvents) = foldl checkBullet ([], tanks, []) bullets
  return (hitTanks, survivingBullets, killEvents)
  where
    checkBullet (buls, tks, events) bul =
      case findHitTank bul tks of
        Nothing       -> (bul : buls, tks, events)
        Just (pid, _) ->
          -- Xe tăng bị trúng → đánh dấu chết
          let tks' = Map.adjust (\t -> t { tankAlive = False }) pid tks
              -- Cộng kill cho người bắn
              tks'' = Map.adjust (\t -> t { tankKills = tankKills t + 1 })
                        (bulOwnerId bul) tks'
              events' = events ++ [(bulOwnerId bul, pid)]
          in (buls, tks'', events')  -- Đạn bị tiêu huỷ

    findHitTank bul tks =
      find (\(pid, t) ->
        tankAlive t
        && pid /= bulOwnerId bul   -- Không tự bắn mình
        && vec2Dist (bulPos bul) (tankPos t) < (bulletRadius + tankRadius)
      ) (Map.toList tks)

--------------------------------------------------------------------------------
-- Va chạm Đạn - Mystery Box
--------------------------------------------------------------------------------

processBulletBoxCollisions :: [MysteryBox] -> [Bullet] -> Map Text Tank
                          -> IO ([MysteryBox], [Bullet], [(Text, BulletType)])
processBulletBoxCollisions boxes bullets tanks = do
  let (boxes', bullets', events) = foldl checkBulletBox (boxes, [], []) bullets
  return (boxes', bullets', events)
  where
    checkBulletBox (bxs, buls, evts) bul =
      case findHitBox bul bxs of
        Nothing -> (bxs, bul : buls, evts)
        Just idx -> do
          let -- Xoá box bị phá
              bxs' = removeAt idx bxs
              -- Chọn loại đạn ngẫu nhiên cho người bắn
              -- (Trong phiên bản đồng bộ, dùng deterministic random)
              btype = randomBulletType (floor $ vx (bulPos bul))
              evts' = evts ++ [(bulOwnerId bul, btype)]
          -- Lưu ý: Không thể dùng IO ở đây vì fold thuần
          -- Thay vào đó dùng pseudo-random từ vị trí đạn
          (bxs', buls, evts')

    findHitBox bul bxs =
      let hits = [ i | (i, box) <- zip [0..] bxs
                     , mbActive box
                     , vec2Dist (bulPos bul) (mbPos box) < (bulletRadius + boxRadius)
                 ]
      in case hits of
        (i:_) -> Just i
        []    -> Nothing

    removeAt idx xs = take idx xs ++ drop (idx + 1) xs

    -- Pseudo-random dựa trên hash vị trí (deterministic cho replay)
    randomBulletType seed =
      let btypes = [ShotgunBullet, LaserBullet, WallPiercingBullet, GatlingBullet]
      in btypes !! (abs seed `mod` length btypes)

--------------------------------------------------------------------------------
-- Mystery Box Timer & Spawn
--------------------------------------------------------------------------------

updateMysteryBoxTimer :: Float -> Float -> [MysteryBox] -> Maze
                      -> IO ([MysteryBox], Float)
updateMysteryBoxTimer deltaT timer boxes maze = do
  let timer' = timer - deltaT
  if timer' <= 0 && not (hasActiveBox boxes)
    then do
      -- Spawn hộp mới tại vị trí ngẫu nhiên
      let spawnPts = mazeBoxSpawnPts maze
      idx <- randomRIO (0, length spawnPts - 1)
      let pos = spawnPts !! idx
          newBox = MysteryBox
            { mbPos       = pos
            , mbActive    = True
            , mbRespawnIn = 0
            }
      newTimer <- randomRIO (boxSpawnIntervalMin, boxSpawnIntervalMax)
      return (newBox : boxes, newTimer)
    else
      return (boxes, timer')
  where
    hasActiveBox = any mbActive

--------------------------------------------------------------------------------
-- Bắt đầu Round mới
--------------------------------------------------------------------------------

startNewRound :: ServerState -> Text -> IO ()
startNewRound ss roomId = do
  maybeRoom <- atomically $ getRoom ss roomId
  case maybeRoom of
    Nothing -> return ()
    Just room -> do
      -- Sinh mê cung ngẫu nhiên hoàn toàn mới cho round này!
      newMaze <- generateMaze
      let spawns = mazeSpawnPts newMaze
          pids   = rsPlayerIds room
      -- Xáo trộn điểm spawn ngẫu nhiên trên toàn bản đồ
      shuffledSpawns <- shuffleList spawns
      let tanks'  = Map.fromList
            [ (pid, (rsTanks room Map.! pid)
                { tankPos    = if idx < length shuffledSpawns
                               then shuffledSpawns !! idx
                               else Vec2 100 100
                , tankVel    = vec2Zero
                , tankWeapon = defaultWeaponState
                , tankAlive  = True
                })
            | (idx, pid) <- zip [0..] pids
            ]

      boxDelay <- randomRIO (boxSpawnIntervalMin, boxSpawnIntervalMax)

      atomically $ modifyRoom ss roomId $ \r -> r
        { rsMaze         = newMaze
        , rsTanks        = tanks'
        , rsBullets      = []
        , rsLasers       = []
        , rsMysteryBoxes = []
        , rsPhase        = CountdownPhase countdownDuration
        , rsRoundNumber  = rsRoundNumber r + 1
        , rsBoxTimer     = boxDelay
        }

      broadcastToRoom ss roomId (SCountdown countdownDuration)
      putStrLn $ "[Game] Round mới phòng " ++ show roomId ++ " với mê cung ngẫu nhiên!"

--------------------------------------------------------------------------------
-- Kết thúc trận đấu (Match Over)
--------------------------------------------------------------------------------

handleMatchOver :: ServerState -> MongoPool -> Text -> Text
               -> [(Text, Int)] -> RoomState -> IO ()
handleMatchOver ss db roomId winner scores room = do
  atomically $ modifyRoom ss roomId $ \r -> r
    { rsPhase = MatchOverPhase winner }

  broadcastToRoom ss roomId (SMatchOver winner scores)

  -- Ghi kết quả vào MongoDB
  let playerRecords =
        [ (tankId t, tankScore t, tankKills t) | t <- Map.elems (rsTanks room) ]
  _ <- saveMatchResult db roomId (rsStartTime room) winner
         playerRecords (rsRoundNumber room)

  -- Cập nhật stats từng người chơi
  forM_ (Map.elems (rsTanks room)) $ \tank -> do
    let isWinner = tankId tank == winner
    when isWinner $ addWin db (tankId tank)
    updatePlayerStats db (tankId tank) 1
      (if isWinner then 1 else 0)
      (tankKills tank)
      0  -- deaths đã cập nhật realtime

  putStrLn $ "[Game] Trận đấu kết thúc phòng " ++ show roomId
          ++ " - Người thắng: " ++ show winner

  -- Sau 5 giây, chuyển phòng về Lobby
  void $ forkIO $ do
    threadDelay 5000000  -- 5 giây
    atomically $ modifyRoom ss roomId $ \r -> r
      { rsPhase = LobbyPhase }

--------------------------------------------------------------------------------
-- Broadcast World Snapshot
--------------------------------------------------------------------------------

broadcastSnapshot :: ServerState -> Text -> IO ()
broadcastSnapshot ss roomId = do
  maybeRoom <- atomically $ getRoom ss roomId
  case maybeRoom of
    Nothing   -> return ()
    Just room -> do
      let snapshot = WorldSnapshot
            { wsTanks        = Map.elems (rsTanks room)
            , wsBullets      = rsBullets room
            , wsLasers       = rsLasers room
            , wsMysteryBoxes = rsMysteryBoxes room
            , wsMaze         = rsMaze room
            , wsPhase        = rsPhase room
            , wsScores       = [(tankId t, tankScore t)
                               | t <- Map.elems (rsTanks room)]
            }
      broadcastToRoom ss roomId (SGameSnapshot snapshot)
