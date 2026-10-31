-- | Server.RoomManager
-- Quản lý vòng đời phòng đấu: tạo, tham gia, rời, tìm kiếm, bắt đầu trận.
-- Xử lý Room ID, mật khẩu, và khởi tạo trạng thái trận đấu.
module Server.RoomManager
  ( handleCreateRoom
  , handleJoinRoom
  , handleLeaveRoom
  , handleStartGame
  , handleListRooms
  , generateRoomId
  , generateMaze
  , assignTankColor
  , shuffleList
  ) where

import Control.Concurrent.STM
import Data.Map.Strict         (Map)
import qualified Data.Map.Strict as Map
import Data.Text               (Text, pack, unpack)
import Data.Time.Clock         (getCurrentTime)
import Data.Time.Format        (formatTime, defaultTimeLocale)
import System.Random           (randomRIO)
import Control.Monad           (when, unless)

import Common.Types
import Common.Config
import Common.Protocol
import Server.State

--------------------------------------------------------------------------------
-- Tạo phòng mới
--------------------------------------------------------------------------------

-- | Xử lý yêu cầu tạo phòng mới.
handleCreateRoom :: ServerState -> Text -> Text -> Int -> Maybe Text -> IO ()
handleCreateRoom ss username roomName maxP password = do
  -- Kiểm tra client đã trong phòng chưa
  currentRoom <- atomically $ getClientRoom ss username
  case currentRoom of
    Just _  -> sendToClient ss username (SRoomError "Bạn đang ở trong phòng khác!")
    Nothing -> do
      -- Sinh Room ID duy nhất
      rid <- generateUniqueRoomId ss
      now <- getCurrentTime
      let startTime = pack $ formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%SZ" now
          clampedMax = max minPlayersToStart (min maxPlayersPerRoom maxP)

      -- Tạo mê cung
      maze <- generateMaze

      -- Tạo xe tăng cho người tạo phòng (vị trí ngẫu nhiên trên map)
      let spawnPts = mazeSpawnPts maze
      pickIdx <- randomRIO (0, max 0 (length spawnPts - 1))
      let spawnPt = if null spawnPts then Vec2 100 100 else spawnPts !! pickIdx
          tank = mkTank username spawnPt TankRed

      -- Tạo phòng mới
      let room = RoomState
            { rsRoomId       = rid
            , rsRoomName     = roomName
            , rsPassword     = password
            , rsMaxPlayers   = clampedMax
            , rsHostPlayer   = username
            , rsPlayerIds    = [username]
            , rsPhase        = LobbyPhase
            , rsTanks        = Map.singleton username tank
            , rsBullets      = []
            , rsLasers       = []
            , rsMysteryBoxes = []
            , rsMaze         = maze
            , rsInputs       = Map.singleton username emptyInput
            , rsRoundNumber  = 0
            , rsStartTime    = startTime
            , rsBoxTimer     = 0
            }

      atomically $ do
        addRoom ss room
        setClientRoom ss username rid

      let info = roomToInfo room
      sendToClient ss username (SRoomCreated info)
      sendToClient ss username (SRoomRoster [(username, TankRed)])
      putStrLn $ "[Room] Phòng " ++ show rid ++ " được tạo bởi " ++ show username

--------------------------------------------------------------------------------
-- Tham gia phòng
--------------------------------------------------------------------------------

-- | Xử lý yêu cầu tham gia phòng.
handleJoinRoom :: ServerState -> Text -> Text -> Maybe Text -> IO ()
handleJoinRoom ss username roomId password = do
  -- Kiểm tra client đã trong phòng chưa
  currentRoom <- atomically $ getClientRoom ss username
  case currentRoom of
    Just _  -> sendToClient ss username (SRoomError "Bạn đang ở trong phòng khác!")
    Nothing -> do
      maybeRoom <- atomically $ getRoom ss roomId
      case maybeRoom of
        Nothing -> sendToClient ss username (SRoomError "Phòng không tồn tại!")
        Just room -> do
          -- Kiểm tra mật khẩu
          case rsPassword room of
            Just pw | password /= Just pw ->
              sendToClient ss username (SRoomError "Sai mật khẩu!")
            _ -> do
              -- Kiểm tra phòng đầy
              if length (rsPlayerIds room) >= rsMaxPlayers room
                then sendToClient ss username (SRoomError "Phòng đã đầy!")
                else do
                  -- Kiểm tra đang trong trận
                  case rsPhase room of
                    LobbyPhase -> doJoin ss username room
                    _          -> sendToClient ss username
                                   (SRoomError "Trận đấu đã bắt đầu, không thể vào!")

-- | Thực hiện join: thêm người chơi vào phòng.
doJoin :: ServerState -> Text -> RoomState -> IO ()
doJoin ss username room = do
  let rid       = rsRoomId room
      playerIdx = length (rsPlayerIds room)
      color     = assignTankColor playerIdx
      spawnPts  = mazeSpawnPts (rsMaze room)
      existingPositions = map tankPos (Map.elems (rsTanks room))
      freeSpawns = filter (\pt -> all (\ep -> vec2Dist pt ep > 60) existingPositions) spawnPts
      availSpawns = if null freeSpawns then spawnPts else freeSpawns
  pickIdx <- randomRIO (0, max 0 (length availSpawns - 1))
  let spawnPt   = if null availSpawns then Vec2 100 100 else availSpawns !! pickIdx
      tank      = mkTank username spawnPt color

  atomically $ do
    modifyRoom ss rid $ \r -> r
      { rsPlayerIds = rsPlayerIds r ++ [username]
      , rsTanks     = Map.insert username tank (rsTanks r)
      , rsInputs    = Map.insert username emptyInput (rsInputs r)
      }
    setClientRoom ss username rid

  updatedRoom <- atomically $ getRoom ss rid
  case updatedRoom of
    Nothing -> return ()
    Just r  -> do
      let info = roomToInfo r
      sendToClient ss username (SRoomJoined info)
      let roster = [(pid, maybe TankBlue tankColor (Map.lookup pid (rsTanks r))) | pid <- rsPlayerIds r]
      sendToClient ss username (SRoomRoster roster)
      -- Thông báo cho người chơi khác
      broadcastToRoom ss rid (SPlayerJoined username color)
      putStrLn $ "[Room] " ++ show username ++ " vào phòng " ++ show rid

--------------------------------------------------------------------------------
-- Rời phòng
--------------------------------------------------------------------------------

-- | Xử lý yêu cầu rời phòng.
handleLeaveRoom :: ServerState -> Text -> IO ()
handleLeaveRoom ss username = do
  maybeRoomId <- atomically $ getClientRoom ss username
  case maybeRoomId of
    Nothing  -> sendToClient ss username (SRoomError "Bạn không ở trong phòng nào!")
    Just rid -> do
      atomically $ do
        modifyRoom ss rid $ \r -> r
          { rsPlayerIds = filter (/= username) (rsPlayerIds r)
          , rsTanks     = Map.delete username (rsTanks r)
          , rsInputs    = Map.delete username (rsInputs r)
          }
        clearClientRoom ss username

      -- Kiểm tra phòng trống -> xoá phòng
      maybeRoom <- atomically $ getRoom ss rid
      case maybeRoom of
        Nothing -> return ()
        Just r  ->
          if null (rsPlayerIds r)
            then do
              atomically $ removeRoom ss rid
              putStrLn $ "[Room] Phòng " ++ show rid ++ " đã bị xoá (trống)"
            else do
              -- Nếu host rời, chuyển host
              when (rsHostPlayer r == username) $ do
                let newHost = head (rsPlayerIds r)
                atomically $ modifyRoom ss rid $ \r' ->
                  r' { rsHostPlayer = newHost }
                putStrLn $ "[Room] Chuyển host phòng " ++ show rid
                        ++ " sang " ++ show newHost

              broadcastToRoom ss rid (SPlayerLeft username)

      sendToClient ss username SRoomLeft
      putStrLn $ "[Room] " ++ show username ++ " rời phòng " ++ show rid

--------------------------------------------------------------------------------
-- Bắt đầu trận đấu
--------------------------------------------------------------------------------

-- | Chủ phòng nhấn Start.
handleStartGame :: ServerState -> Text -> IO ()
handleStartGame ss username = do
  maybeRoomId <- atomically $ getClientRoom ss username
  case maybeRoomId of
    Nothing  -> sendToClient ss username (SRoomError "Bạn không ở trong phòng!")
    Just rid -> do
      maybeRoom <- atomically $ getRoom ss rid
      case maybeRoom of
        Nothing -> return ()
        Just room -> do
          -- Chỉ host mới được bắt đầu
          unless (rsHostPlayer room == username) $ do
            sendToClient ss username (SRoomError "Chỉ chủ phòng mới được bắt đầu!")
            return ()

          when (rsHostPlayer room == username) $ do
            -- Cần ít nhất 2 người
            if length (rsPlayerIds room) < minPlayersToStart
              then sendToClient ss username
                     (SRoomError $ "Cần ít nhất " <> pack (show minPlayersToStart)
                                <> " người chơi!")
              else do
                -- Sinh mê cung ngẫu nhiên cho trận đấu mới và xáo trộn vị trí spawn
                newMaze <- generateMaze
                let spawns = mazeSpawnPts newMaze
                    pids   = rsPlayerIds room
                shuffledSpawns <- shuffleList spawns
                let tanks' = Map.fromList
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
                -- Chuyển sang Countdown với mê cung và vị trí mới
                atomically $ modifyRoom ss rid $ \r -> r
                  { rsMaze  = newMaze
                  , rsTanks = tanks'
                  , rsPhase = CountdownPhase countdownDuration
                  }
                broadcastToRoom ss rid (SCountdown countdownDuration)
                putStrLn $ "[Game] Phòng " ++ show rid ++ " bắt đầu countdown với mê cung mới!"

--------------------------------------------------------------------------------
-- Liệt kê phòng
--------------------------------------------------------------------------------

-- | Gửi danh sách phòng cho client.
handleListRooms :: ServerState -> Text -> IO ()
handleListRooms ss username = do
  rooms <- atomically $ getAllRooms ss
  let infos = map roomToInfo rooms
  sendToClient ss username (SRoomList infos)

--------------------------------------------------------------------------------
-- Sinh Room ID duy nhất
--------------------------------------------------------------------------------

-- | Sinh Room ID 6 ký tự ngẫu nhiên, đảm bảo duy nhất.
generateUniqueRoomId :: ServerState -> IO Text
generateUniqueRoomId ss = do
  rid <- generateRoomId
  exists <- atomically $ do
    rooms <- readTVar (ssRooms ss)
    return $ Map.member rid rooms
  if exists
    then generateUniqueRoomId ss  -- thử lại
    else return rid

-- | Sinh Room ID 6 ký tự ngẫu nhiên.
generateRoomId :: IO Text
generateRoomId = do
  let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  cs <- mapM (\_ -> do
    idx <- randomRIO (0, length chars - 1)
    return $ chars !! idx
    ) [1..roomIdLength]
  return $ pack cs

--------------------------------------------------------------------------------
-- Gán màu xe tăng
--------------------------------------------------------------------------------

-- | Gán màu xe tăng theo thứ tự tham gia (index 0-3).
assignTankColor :: Int -> TankColor
assignTankColor idx = case idx `mod` 4 of
  0 -> TankRed
  1 -> TankBlue
  2 -> TankGreen
  _ -> TankYellow

--------------------------------------------------------------------------------
-- Chuyển đổi RoomState -> RoomInfo (thông tin hiển thị)
--------------------------------------------------------------------------------

roomToInfo :: RoomState -> RoomInfo
roomToInfo r = RoomInfo
  { riRoomId         = rsRoomId r
  , riRoomName       = rsRoomName r
  , riMaxPlayers     = rsMaxPlayers r
  , riCurrentPlayers = length (rsPlayerIds r)
  , riHasPassword    = case rsPassword r of
                         Just _  -> True
                         Nothing -> False
  , riPhase          = rsPhase r
  }

--------------------------------------------------------------------------------
-- Tạo xe tăng mới
--------------------------------------------------------------------------------

mkTank :: Text -> Vec2 -> TankColor -> Tank
mkTank pid spawnPos color = Tank
  { tankId          = pid
  , tankPos         = spawnPos
  , tankVel         = vec2Zero
  , tankBodyAngle   = 0
  , tankTurretAngle = 0
  , tankColor       = color
  , tankWeapon      = defaultWeaponState
  , tankAlive       = True
  , tankScore       = 0
  , tankKills       = 0
  }

--------------------------------------------------------------------------------
-- Sinh mê cung (Maze Generation)
--------------------------------------------------------------------------------

-- | Xáo trộn ngẫu nhiên một danh sách
shuffleList :: [a] -> IO [a]
shuffleList [] = return []
shuffleList xs = do
  idx <- randomRIO (0, length xs - 1)
  let (before, x:after) = splitAt idx xs
  rest <- shuffleList (before ++ after)
  return (x : rest)

-- | Tạo mê cung ngẫu nhiên với tường dày đặc phong phú (Labyrinth)
-- và các điểm spawn ngẫu nhiên trên toàn bộ bản đồ.
generateMaze :: IO Maze
generateMaze = do
  let w  = defaultMazeWidth
      h  = defaultMazeHeight
      cs = cellSize

      -- Tường bao quanh (4 cạnh)
      borderWalls =
        [ Wall (Vec2 0 0) (Vec2 w 0)     -- Đáy
        , Wall (Vec2 w 0) (Vec2 w h)     -- Phải
        , Wall (Vec2 w h) (Vec2 0 h)     -- Đỉnh
        , Wall (Vec2 0 h) (Vec2 0 0)     -- Trái
        ]

      wH x1 x2 y = Wall (Vec2 (x1*cs) (y*cs)) (Vec2 (x2*cs) (y*cs))
      wV x y1 y2 = Wall (Vec2 (x*cs) (y1*cs)) (Vec2 (x*cs) (y2*cs))

      -- 4 Mẫu Mê Cung Rối Chiến Thuật: Tường cả dọc lẫn ngang, không song song, luôn có khe hở thoát hiểm
      -- Mẫu 1: The Tangled Labyrinth
      layout1 =
        [ wH 3 11 1, wH 13 20 1, wH 1 3 2, wH 11 17 2, wH 17 20 3
        , wH 7 12 4, wH 13 17 4, wH 3 6 5, wH 17 19 5, wH 5 12 6
        , wH 15 17 6, wH 1 6 7, wH 9 13 8, wH 1 11 10, wH 15 20 10
        , wV 1 3 9, wV 2 1 3, wV 3 3 9, wV 4 1 4, wV 6 1 5
        , wV 6 7 10, wV 7 5 9, wV 8 1 3, wV 8 7 10, wV 9 5 9
        , wV 10 1 4, wV 11 7 9, wV 12 1 7, wV 13 3 10, wV 14 5 10
        , wV 15 3 10, wV 17 5 9, wV 18 1 3, wV 18 7 10, wV 19 3 9
        , wV 20 5 9
        ]

      -- Mẫu 2: The Complex Grid Matrix
      layout2 =
        [ wH 1 9 1, wH 11 13 1, wH 15 20 1, wH 7 13 2, wH 5 8 3
        , wH 11 20 3, wH 7 12 4, wH 13 15 5, wH 5 10 6, wH 11 20 6
        , wH 1 3 8, wH 5 8 8, wH 9 18 8, wH 5 9 9, wH 17 20 9
        , wH 5 15 10, wV 1 1 5, wV 1 7 10, wV 2 3 5, wV 3 1 10
        , wV 4 3 10, wV 5 1 4, wV 6 5 8, wV 9 3 9, wV 10 1 3
        , wV 12 5 9, wV 14 1 5, wV 15 7 10, wV 16 5 7, wV 17 1 3
        , wV 19 3 10
        ]

      -- Mẫu 3: The Intertwined Stronghold
      layout3 =
        [ wH 7 9 1, wH 15 20 1, wH 1 5 2, wH 13 20 2, wH 5 11 3
        , wH 15 20 3, wH 9 14 4, wH 17 19 4, wH 9 11 5, wH 17 20 6
        , wH 9 12 7, wH 13 15 8, wH 17 19 8, wH 5 7 9, wH 17 20 9
        , wH 1 6 10, wH 7 20 10, wV 1 1 10, wV 2 3 9, wV 3 1 9
        , wV 4 3 10, wV 5 1 9, wV 6 5 7, wV 7 5 10, wV 8 1 9
        , wV 10 1 3, wV 10 5 9, wV 12 1 10, wV 13 1 3, wV 13 5 9
        , wV 14 3 5, wV 15 5 9, wV 16 3 10, wV 17 5 8, wV 20 3 9
        ]

      -- Mẫu 4: Crossfire Maze
      layout4 =
        [ wH 3 9 1, wH 13 15 1, wH 1 5 2, wH 11 13 2, wH 1 7 4
        , wH 17 20 4, wH 11 18 5, wH 1 3 6, wH 5 9 6, wH 9 13 7
        , wH 15 20 7, wH 1 3 8, wH 9 11 8, wH 13 16 8, wH 9 12 9
        , wH 13 18 9, wH 1 20 10, wV 1 1 5, wV 1 7 9, wV 3 3 10
        , wV 4 5 9, wV 5 5 10, wV 7 1 5, wV 7 7 10, wV 8 3 9
        , wV 9 1 5, wV 10 1 7, wV 11 1 5, wV 12 5 9, wV 13 1 4
        , wV 14 3 8, wV 15 1 3, wV 16 1 6, wV 17 1 4, wV 17 7 9
        , wV 18 1 3, wV 18 5 7, wV 19 1 3, wV 20 1 10
        ]

  layoutIdx <- randomRIO (1 :: Int, 4)
  let allInnerWalls = case layoutIdx of
        1 -> layout1
        2 -> layout2
        3 -> layout3
        _ -> layout4

  -- Các điểm spawn thoáng rộng tại chính giữa các hành lang (y = (r + 0.5) * cs)
  let allSpawns =
        [ Vec2 (1.5 * cs) (0.5 * cs)
        , Vec2 (19.5 * cs) (0.5 * cs)
        , Vec2 (1.5 * cs) (10.5 * cs)
        , Vec2 (19.5 * cs) (10.5 * cs)
        , Vec2 (10.5 * cs) (0.5 * cs)
        , Vec2 (10.5 * cs) (10.5 * cs)
        , Vec2 (4.5 * cs) (2.5 * cs)
        , Vec2 (16.5 * cs) (2.5 * cs)
        , Vec2 (4.5 * cs) (8.5 * cs)
        , Vec2 (16.5 * cs) (8.5 * cs)
        , Vec2 (10.5 * cs) (4.5 * cs)
        , Vec2 (10.5 * cs) (6.5 * cs)
        ]

  -- Vị trí spawn hộp bí ẩn ở các giao lộ
  let boxSpawns =
        [ Vec2 (10.5 * cs) (5.5 * cs)
        , Vec2 (6.5 * cs) (3.5 * cs)
        , Vec2 (14.5 * cs) (3.5 * cs)
        , Vec2 (6.5 * cs) (7.5 * cs)
        , Vec2 (14.5 * cs) (7.5 * cs)
        ]

  -- Xáo trộn điểm spawn để mỗi lần sinh là hoàn toàn ngẫu nhiên
  randomSpawns <- shuffleList allSpawns

  return Maze
    { mazeWalls       = borderWalls ++ allInnerWalls
    , mazeWidth       = w
    , mazeHeight      = h
    , mazeSpawnPts    = randomSpawns
    , mazeBoxSpawnPts = boxSpawns
    }
