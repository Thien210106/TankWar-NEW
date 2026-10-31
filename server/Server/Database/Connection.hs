-- | Server.Database.Connection
-- Thiết lập và quản lý connection pool tới MongoDB.
module Server.Database.Connection
  ( MongoConfig(..)
  , MongoPool
  , defaultMongoConfig
  , connectMongo
  , withMongo
  , closeMongo
  ) where

import Database.MongoDB   ( Pipe, Host(..), PortID(..), connect, close, access
                          , master, Action )
import Data.Text          (Text, pack)
import Data.IORef         (IORef, newIORef, readIORef, writeIORef)
import Control.Exception  (bracket, SomeException, try)
import Control.Monad      (when, void)

import qualified Common.Config as Cfg

--------------------------------------------------------------------------------
-- Cấu hình MongoDB
--------------------------------------------------------------------------------

data MongoConfig = MongoConfig
  { mcHost     :: !String
  , mcPort     :: !Int
  , mcDatabase :: !Text
  } deriving (Show, Eq)

defaultMongoConfig :: MongoConfig
defaultMongoConfig = MongoConfig
  { mcHost     = "127.0.0.1"
  , mcPort     = Cfg.defaultMongoPort
  , mcDatabase = pack Cfg.mongoDbName
  }

--------------------------------------------------------------------------------
-- Connection Pool (đơn giản: một pipe duy trì, tự động reconnect)
--------------------------------------------------------------------------------

-- | Pool kết nối MongoDB đơn giản.
-- Trong production nên dùng resource-pool, nhưng đủ cho prototype.
data MongoPool = MongoPool
  { mpConfig :: !MongoConfig
  , mpPipe   :: !(IORef (Maybe Pipe))
  }

-- | Tạo connection pool và kết nối lần đầu.
connectMongo :: MongoConfig -> IO MongoPool
connectMongo cfg = do
  pipe <- tryConnect cfg
  ref  <- newIORef pipe
  let pool = MongoPool cfg ref
  putStrLn $ "[MongoDB] Kết nối thành công tới "
           ++ mcHost cfg ++ ":" ++ show (mcPort cfg)
           ++ "/" ++ show (mcDatabase cfg)
  return pool

-- | Thực thi một MongoDB Action trên pool.
-- Tự động reconnect nếu pipe bị đứt.
withMongo :: MongoPool -> Action IO a -> IO (Either SomeException a)
withMongo pool act = do
  maybePipe <- readIORef (mpPipe pool)
  pipe <- case maybePipe of
    Just p  -> return p
    Nothing -> do
      mp <- tryConnect (mpConfig pool)
      case mp of
        Just p  -> writeIORef (mpPipe pool) (Just p) >> return p
        Nothing -> error "[MongoDB] Không thể kết nối lại database!"
  result <- try $ access pipe master (mcDatabase (mpConfig pool)) act
  case result of
    Left err -> do
      putStrLn $ "[MongoDB] Lỗi truy vấn, đóng pipe cũ: " ++ show (err :: SomeException)
      writeIORef (mpPipe pool) Nothing
      void $ try @SomeException (close pipe)
      return (Left err)
    Right val -> return (Right val)

-- | Đóng kết nối MongoDB.
closeMongo :: MongoPool -> IO ()
closeMongo pool = do
  maybePipe <- readIORef (mpPipe pool)
  case maybePipe of
    Just p  -> close p >> putStrLn "[MongoDB] Đã đóng kết nối."
    Nothing -> return ()

--------------------------------------------------------------------------------
-- Nội bộ
--------------------------------------------------------------------------------

tryConnect :: MongoConfig -> IO (Maybe Pipe)
tryConnect cfg = do
  result <- try @SomeException $
    connect (Host (mcHost cfg) (PortNumber (fromIntegral (mcPort cfg))))
  case result of
    Left err -> do
      putStrLn $ "[MongoDB] Không thể kết nối: " ++ show err
      return Nothing
    Right pipe -> return (Just pipe)
