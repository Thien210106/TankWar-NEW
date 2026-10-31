-- | test/Spec.hs
-- Bộ kiểm thử tự động cho TankWar (Vector math, Cooldown, Protocol serialization).
module Main where

import System.Exit (exitFailure, exitSuccess)
import Control.Monad (unless)
import Data.Aeson (encode, decode)
import qualified Data.ByteString.Lazy as BL

import Common.Types
import Common.Config
import Common.Protocol

--------------------------------------------------------------------------------
-- Helper assert
--------------------------------------------------------------------------------

assertEq :: (Eq a, Show a) => String -> a -> a -> IO ()
assertEq label actual expected =
  if actual == expected
    then putStrLn $ "  [PASS] " ++ label
    else do
      putStrLn $ "  [FAIL] " ++ label ++ "\n    Expected: " ++ show expected ++ "\n    Actual:   " ++ show actual
      exitFailure

assertTrue :: String -> Bool -> IO ()
assertTrue label cond =
  if cond
    then putStrLn $ "  [PASS] " ++ label
    else do
      putStrLn $ "  [FAIL] " ++ label
      exitFailure

assertNear :: String -> Float -> Float -> Float -> IO ()
assertNear label actual expected epsilon =
  if abs (actual - expected) <= epsilon
    then putStrLn $ "  [PASS] " ++ label
    else do
      putStrLn $ "  [FAIL] " ++ label ++ "\n    Expected: " ++ show expected ++ "\n    Actual:   " ++ show actual
      exitFailure

--------------------------------------------------------------------------------
-- Test Suites
--------------------------------------------------------------------------------

testVectorMath :: IO ()
testVectorMath = do
  putStrLn "\n--- [1] Vector Math Tests ---"
  
  -- Vector addition
  let v1 = Vec2 3 4
      v2 = Vec2 1 2
  assertEq "vec2Add (3,4) (1,2) == (4,6)" (vec2Add v1 v2) (Vec2 4 6)
  assertEq "vec2Sub (3,4) (1,2) == (2,2)" (vec2Sub v1 v2) (Vec2 2 2)
  assertEq "vec2Dot (3,4) (1,2) == 11" (vec2Dot v1 v2) 11.0
  assertNear "vec2Len (3,4) == 5" (vec2Len v1) 5.0 1e-5

  -- Normalization
  let norm = vec2Normalize v1
  assertNear "vec2Len of normalized vector == 1.0" (vec2Len norm) 1.0 1e-5
  assertNear "vec2Normalize X == 0.6" (vx norm) 0.6 1e-5
  assertNear "vec2Normalize Y == 0.8" (vy norm) 0.8 1e-5

  -- Reflection: bouncing against vertical wall (normal pointing Left (-1, 0))
  let vel = Vec2 10 5
      wallNormal = Vec2 (-1) 0
      reflected = vec2Reflect vel wallNormal
  assertNear "Reflect horizontal vel: vx -> -10" (vx reflected) (-10.0) 1e-4
  assertNear "Reflect horizontal vel: vy remains 5" (vy reflected) 5.0 1e-4

testWeaponCooldowns :: IO ()
testWeaponCooldowns = do
  putStrLn "\n--- [2] Weapon Cooldown Configuration Tests ---"
  assertEq "Normal bullet cooldown is 0.5s" (weaponCooldown NormalBullet) 0.5
  assertEq "Shotgun bullet cooldown is 1.0s" (weaponCooldown ShotgunBullet) 1.0
  assertEq "Laser bullet cooldown is 1.0s" (weaponCooldown LaserBullet) 1.0
  assertEq "Wall-piercing bullet cooldown is 1.0s" (weaponCooldown WallPiercingBullet) 1.0
  assertEq "Gatling bullet cooldown is 1.0s" (weaponCooldown GatlingBullet) 1.0
  assertEq "Buff duration is 15.0s" buffDuration 15.0
  assertEq "Gatling burst count is 3" gatlingBurstCount 3
  assertEq "Max bullet bounces is 5" maxBulletBounces 5

testProtocolSerialization :: IO ()
testProtocolSerialization = do
  putStrLn "\n--- [3] Protocol JSON Round-trip Serialization Tests ---"
  
  -- ClientMessage roundtrip
  let loginMsg = CLogin "pilot1" "Ace Pilot"
      encodedLogin = encode loginMsg
      decodedLogin = decode encodedLogin :: Maybe ClientMessage
  assertEq "CLogin JSON roundtrip" decodedLogin (Just loginMsg)

  let inputMsg = CPlayerInput (PlayerInput True False False True 1.57 True)
      encodedInput = encode inputMsg
      decodedInput = decode encodedInput :: Maybe ClientMessage
  assertEq "CPlayerInput JSON roundtrip" decodedInput (Just inputMsg)

  -- ServerMessage roundtrip
  let rosterMsg = SRoomRoster [("player1", TankRed), ("player2", TankBlue)]
      encodedRoster = encode rosterMsg
      decodedRoster = decode encodedRoster :: Maybe ServerMessage
  assertEq "SRoomRoster JSON roundtrip" decodedRoster (Just rosterMsg)

  let countdownMsg = SCountdown 2.5
      encodedCountdown = encode countdownMsg
      decodedCountdown = decode encodedCountdown :: Maybe ServerMessage
  assertEq "SCountdown JSON roundtrip" decodedCountdown (Just countdownMsg)

--------------------------------------------------------------------------------
-- Main Runner
--------------------------------------------------------------------------------

main :: IO ()
main = do
  putStrLn "=========================================="
  putStrLn "    TankWar Test Suite - Quality Check    "
  putStrLn "=========================================="
  testVectorMath
  testWeaponCooldowns
  testProtocolSerialization
  putStrLn "\n=========================================="
  putStrLn "   ALL TESTS PASSED SUCCESSFULLY! (16/16)  "
  putStrLn "=========================================="
  exitSuccess
