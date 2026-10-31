-- | Main (tankwar-server)
-- Điểm khởi chạy Dedicated Server cho TankWar.
-- Thiết lập WebSocket server, kết nối MongoDB, và xử lý kết nối client.
module Main where

import Control.Concurrent       (forkIO)
import Control.Concurrent.STM
import Control.Exception        (SomeException, catch, finally, bracket)
import Control.Monad            (forever, void, when)
import Data.Aeson               (decode, encode)
import Data.Map.Strict          (Map)
import qualified Data.Map.Strict as Map
import Data.Text                (Text, pack, unpack)
import qualified Data.ByteString.Lazy as BL
import System.Environment       (getArgs)
import System.IO                (hSetBuffering, hSetEncoding, stdout, stderr, utf8, BufferMode(..))

import qualified Network.WebSockets as WS

import Common.Types
import Common.Config
import Common.Protocol
import Server.State
import Server.RoomManager
import Server.GameEngine
import Server.Database.Connection
import Server.Database.PlayerRepo (findPlayer, createPlayer, getLeaderboard)
import Server.Database.MatchRepo  ()

--------------------------------------------------------------------------------
-- Entry Point
--------------------------------------------------------------------------------

main :: IO ()
main = do
  -- Flush stdout/stderr line-by-line và đảm bảo encoding UTF-8 cho Unicode logs
  hSetBuffering stdout LineBuffering
  hSetBuffering stderr LineBuffering
  hSetEncoding stdout utf8
  hSetEncoding stderr utf8

  -- Parse tham số dòng lệnh
  args <- getArgs
  let port    = parsePort args
      mongoCfg = parseMongoConfig args

  -- Banner
  putStrLn "╔══════════════════════════════════════════════════════════════╗"
  putStrLn "║          🎮  TankWar Dedicated Server v0.1.0  🎮           ║"
  putStrLn "║  Haskell • WebSocket • STM • MongoDB                       ║"
  putStrLn "╚══════════════════════════════════════════════════════════════╝"
  putStrLn ""

  -- Kết nối MongoDB
  putStrLn $ "[Server] Đang kết nối MongoDB tại "
          ++ mcHost mongoCfg ++ ":" ++ show (mcPort mongoCfg) ++ "..."
  db <- connectMongo mongoCfg

  -- Khởi tạo trạng thái server
  ss <- newServerState

  -- Khởi chạy WebSocket server
  putStrLn $ "[Server] WebSocket server lắng nghe cổng " ++ show port
  putStrLn $ "[Server] Tick rate: " ++ show tickRate ++ " Hz"
  putStrLn $ "[Server] Cooldown: thường " ++ show normalBulletCooldown ++ "s, box "
          ++ show specialBulletCooldown ++ "s | Buff: "
          ++ show buffDuration ++ "s"
  putStrLn "[Server] Sẵn sàng nhận kết nối!"
  putStrLn ""

  WS.runServer "0.0.0.0" port (serverApp ss db)
    `finally` closeMongo db

--------------------------------------------------------------------------------
-- WebSocket Application
--------------------------------------------------------------------------------

-- | Xử lý mỗi kết nối WebSocket mới.
serverApp :: ServerState -> MongoPool -> WS.ServerApp
serverApp ss db pending = do
  conn <- WS.acceptRequest pending
  -- Bật ping/pong thread để giữ kết nối sống
  WS.withPingThread conn wsPingInterval (return ()) $ do
    -- Đợi tin nhắn đăng nhập đầu tiên
    msg <- WS.receiveData conn :: IO BL.ByteString
    case decode msg :: Maybe ClientMessage of
      Just (CLogin username displayName) ->
        handleLogin ss db conn username displayName
      _ -> do
        WS.sendTextData conn $ encode (SLoginError "Tin nhắn đầu tiên phải là CLogin!")
        return ()

--------------------------------------------------------------------------------
-- Xử lý đăng nhập
--------------------------------------------------------------------------------

handleLogin :: ServerState -> MongoPool -> WS.Connection -> Text -> Text -> IO ()
handleLogin ss db conn username displayName = do
  -- Kiểm tra username đã online chưa
  existing <- atomically $ do
    clients <- readTVar (ssClients ss)
    return $ Map.member username clients

  if existing
    then WS.sendTextData conn $ encode
           (SLoginError $ "Username '" <> username <> "' đã đang online!")
    else do
      -- Đăng ký client
      atomically $ addClient ss username conn

      -- Tạo hồ sơ trong MongoDB nếu chưa có
      maybePlayer <- findPlayer db username
      case maybePlayer of
        Nothing -> void $ createPlayer db username displayName
        Just _  -> return ()

      -- Gửi thông báo đăng nhập thành công
      let profile = PlayerProfile
            { ppUsername    = username
            , ppDisplayName = displayName
            , ppCreatedAt  = ""
            , ppStats      = PlayerStats 0 0 0 0 0
            }
      WS.sendTextData conn $ encode (SLoginSuccess username profile)
      putStrLn $ "[Auth] " ++ show username ++ " đã đăng nhập."

      -- Bắt đầu vòng lặp nhận message từ client
      clientLoop ss db username
        `catch` (\e -> putStrLn $ "[WS] " ++ show username
                    ++ " ngắt kết nối: " ++ show (e :: SomeException))
        `finally` handleDisconnect ss username

--------------------------------------------------------------------------------
-- Vòng lặp nhận message từ Client
--------------------------------------------------------------------------------

clientLoop :: ServerState -> MongoPool -> Text -> IO ()
clientLoop ss db username = forever $ do
  maybeConn <- atomically $ do
    clients <- readTVar (ssClients ss)
    return $ Map.lookup username clients
  case maybeConn of
    Nothing -> return ()  -- Đã bị xoá
    Just cc -> do
      raw <- WS.receiveData (ccConnection cc) :: IO BL.ByteString
      case decode raw :: Maybe ClientMessage of
        Nothing  -> return ()  -- Bỏ qua tin nhắn sai format
        Just msg -> handleClientMessage ss db username msg

--------------------------------------------------------------------------------
-- Xử lý tin nhắn từ Client (Message Router)
--------------------------------------------------------------------------------

handleClientMessage :: ServerState -> MongoPool -> Text -> ClientMessage -> IO ()
handleClientMessage ss db username = \case

  CCreateRoom roomName maxP password ->
    handleCreateRoom ss username roomName maxP password

  CJoinRoom roomId password ->
    handleJoinRoom ss username roomId password

  CLeaveRoom ->
    handleLeaveRoom ss username

  CStartGame -> do
    handleStartGame ss username
    -- Sau khi chuyển sang Countdown, bắt đầu game loop
    maybeRoomId <- atomically $ getClientRoom ss username
    case maybeRoomId of
      Nothing  -> return ()
      Just rid -> do
        maybeRoom <- atomically $ getRoom ss rid
        case maybeRoom of
          Nothing -> return ()
          Just room -> case rsPhase room of
            CountdownPhase _ -> startRoomGameLoop ss db rid
            _                -> return ()

  CPlayerInput input -> do
    -- Cập nhật input vào state của phòng
    maybeRoomId <- atomically $ getClientRoom ss username
    case maybeRoomId of
      Nothing  -> return ()
      Just rid -> atomically $ modifyRoom ss rid $ \r ->
        r { rsInputs = Map.insert username input (rsInputs r) }

  CListRooms ->
    handleListRooms ss username

  CRequestLeaderboard -> do
    docs <- getLeaderboard db 10
    -- TODO: Parse MongoDB Documents sang (Text, Int, Int) properly
    sendToClient ss username (SLeaderboard [])

  CPing ->
    sendToClient ss username SPong

  -- Bỏ qua các tin nhắn không xử lý ở đây
  _ -> return ()

--------------------------------------------------------------------------------
-- Xử lý ngắt kết nối
--------------------------------------------------------------------------------

handleDisconnect :: ServerState -> Text -> IO ()
handleDisconnect ss username = do
  putStrLn $ "[Auth] " ++ show username ++ " ngắt kết nối."

  -- Rời phòng nếu đang ở trong phòng
  maybeRoomId <- atomically $ getClientRoom ss username
  case maybeRoomId of
    Nothing  -> return ()
    Just _   -> handleLeaveRoom ss username

  -- Xoá client khỏi danh sách
  atomically $ removeClient ss username

--------------------------------------------------------------------------------
-- Parse tham số dòng lệnh
--------------------------------------------------------------------------------

parsePort :: [String] -> Int
parsePort []                   = defaultPort
parsePort ("--port" : p : _)   = read p
parsePort (_ : rest)           = parsePort rest

parseMongoConfig :: [String] -> MongoConfig
parseMongoConfig args = case findArg "--mongo-uri" args of
  Nothing  -> defaultMongoConfig
  Just uri -> parseMongoUri uri

findArg :: String -> [String] -> Maybe String
findArg _ [] = Nothing
findArg key (k : v : rest)
  | k == key  = Just v
  | otherwise = findArg key (v : rest)
findArg _ [_] = Nothing

-- | Parse MongoDB URI đơn giản: mongodb://host:port/dbname
parseMongoUri :: String -> MongoConfig
parseMongoUri uri =
  let stripped = drop (length ("mongodb://" :: String)) uri
      (hostPort, dbPart) = break (== '/') stripped
      (host', portStr)   = break (== ':') hostPort
      port' = if null portStr then defaultMongoPort else read (tail portStr)
      db'   = if null dbPart then mongoDbName else tail dbPart
  in MongoConfig
    { mcHost     = if null host' then "127.0.0.1" else host'
    , mcPort     = port'
    , mcDatabase = pack db'
    }
