'use strict';

/**
 * TankWar Dedicated Server & Web Server in Node.js
 * - Zero dependencies (pure Node.js http, crypto, fs, path).
 * - Full RFC 6455 WebSocket implementation on port 8080.
 * - Supports CLogin, CListRooms, CCreateRoom, CJoinRoom, CLeaveRoom, CStartGame.
 * - 60 Hz Authoritative Game Loop with tanks, bouncing bullets, collision, scoring.
 * - Also serves the web/ folder as static files on http://localhost:8080/
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const WEB_ROOT = path.join(__dirname, 'web');

// -----------------------------------------------------------------------------
// HTTP Static File Server
// -----------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(urlObj.pathname);
  if (pathname === '/' || pathname === '/web' || pathname === '/web/') pathname = '/index.html';
  if (pathname.startsWith('/web/')) pathname = pathname.slice(4);

  const filePath = path.resolve(WEB_ROOT, pathname.replace(/^[/\\]+/, ''));
  if (path.relative(WEB_ROOT, filePath).startsWith('..')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// -----------------------------------------------------------------------------
// RFC 6455 WebSocket Server (Zero-Dependency)
// -----------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class SimpleWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.readyState = 1; // 1 = OPEN
    this.listeners = { message: [], close: [], error: [] };

    socket.on('data', chunk => this._handleData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', err => this._onError(err));
  }

  on(event, handler) {
    if (this.listeners[event]) this.listeners[event].push(handler);
  }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const length = payload.length;
    let header;

    if (length <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = length;
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {
      this.close();
    }
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 2; // CLOSING
    try {
      const closeFrame = Buffer.from([0x88, 0x00]);
      this.socket.write(closeFrame);
      this.socket.end();
    } catch (_) {}
    this._onClose();
  }

  _onClose() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.listeners.close.forEach(fn => fn());
  }

  _onError(err) {
    this.listeners.error.forEach(fn => fn(err));
    this.close();
  }

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (isMasked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLength) return; // Wait for full frame

      const payload = this.buffer.slice(offset, offset + payloadLength);
      this.buffer = this.buffer.slice(offset + payloadLength);

      if (isMasked && maskKey) {
        for (let i = 0; i < payloadLength; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x08) { // CLOSE
        this.close();
        return;
      } else if (opcode === 0x09) { // PING -> reply PONG
        const pong = Buffer.alloc(2 + payload.length);
        pong[0] = 0x8a;
        pong[1] = payload.length;
        payload.copy(pong, 2);
        try { this.socket.write(pong); } catch (_) {}
      } else if (opcode === 0x01) { // TEXT
        const text = payload.toString('utf8');
        this.listeners.message.forEach(fn => fn(text));
      }
    }
  }
}

httpServer.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`
  ];
  socket.write(headers.join('\r\n') + '\r\n\r\n');

  const ws = new SimpleWebSocket(socket);
  handleNewClient(ws);
});

// -----------------------------------------------------------------------------
// Game Constants & Maze Layouts
// -----------------------------------------------------------------------------
const WORLD_W = 1344;
const WORLD_H = 704;
const CELL_SIZE = 64;
const TANK_SPEED = 160;
const TANK_RADIUS = 24;
const BULLET_SPEED = 420;
const BULLET_MAX_LIFETIME = 5.0;
const BULLET_MAX_BOUNCES = 5;

// Border walls
const BORDER_WALLS = [
  { wallStart: { vx: 0, vy: 0 }, wallEnd: { vx: WORLD_W, vy: 0 } },
  { wallStart: { vx: WORLD_W, vy: 0 }, wallEnd: { vx: WORLD_W, vy: WORLD_H } },
  { wallStart: { vx: WORLD_W, vy: WORLD_H }, wallEnd: { vx: 0, vy: WORLD_H } },
  { wallStart: { vx: 0, vy: WORLD_H }, wallEnd: { vx: 0, vy: 0 } }
];

function createWallH(x1, x2, y) {
  return { wallStart: { vx: x1 * CELL_SIZE, vy: y * CELL_SIZE }, wallEnd: { vx: x2 * CELL_SIZE, vy: y * CELL_SIZE } };
}
function createWallV(x, y1, y2) {
  return { wallStart: { vx: x * CELL_SIZE, vy: y1 * CELL_SIZE }, wallEnd: { vx: x * CELL_SIZE, vy: y2 * CELL_SIZE } };
}

// Tactical Arena Walls
const ARENA_WALLS = [
  ...BORDER_WALLS,
  createWallH(3, 9, 2), createWallH(12, 18, 2),
  createWallH(5, 10, 4), createWallH(11, 16, 4),
  createWallH(3, 8, 7), createWallH(13, 18, 7),
  createWallH(5, 11, 9), createWallH(12, 16, 9),
  createWallV(4, 3, 6), createWallV(17, 3, 6),
  createWallV(7, 4, 7), createWallV(14, 4, 7),
  createWallV(10, 2, 4), createWallV(11, 7, 9)
];

const SPAWN_POINTS = [
  { vx: 128, vy: 128 },
  { vx: WORLD_W - 128, vy: WORLD_H - 128 },
  { vx: WORLD_W - 128, vy: 128 },
  { vx: 128, vy: WORLD_H - 128 }
];

const BOX_SPAWN_POINTS = [
  { vx: WORLD_W / 2, vy: WORLD_H / 2 },
  { vx: 384, vy: 352 },
  { vx: WORLD_W - 384, vy: 352 }
];

const TANK_COLORS = ['TankRed', 'TankBlue', 'TankGreen', 'TankYellow'];

// -----------------------------------------------------------------------------
// State Management
// -----------------------------------------------------------------------------
const clients = new Map(); // ws -> { username, displayName, roomId }
const rooms = new Map();   // roomId -> RoomState

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? generateRoomId() : id;
}

function sendTo(ws, tag, contents) {
  if (!ws || ws.readyState !== 1) return;
  const msg = contents !== undefined ? { tag, contents } : { tag };
  ws.send(JSON.stringify(msg));
}

function broadcastToLobby(tag, contents) {
  const msg = JSON.stringify(contents !== undefined ? { tag, contents } : { tag });
  clients.forEach((client, ws) => {
    if (!client.roomId && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function getRoomListPayload() {
  const list = [];
  rooms.forEach(r => {
    list.push({
      riRoomId: r.id,
      riRoomName: r.name,
      riHostPlayer: r.host,
      riCurrentPlayers: r.players.length,
      riMaxPlayers: r.maxPlayers,
      riHasPassword: !!r.password,
      riPhase: { tag: r.phase }
    });
  });
  return list;
}

function broadcastRoomList() {
  broadcastToLobby('SRoomList', getRoomListPayload());
}

// -----------------------------------------------------------------------------
// Client Connection & Message Handling
// -----------------------------------------------------------------------------
function handleNewClient(ws) {
  clients.set(ws, { username: '', displayName: '', roomId: null });

  ws.on('message', text => {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }

    const tag = msg.tag || (typeof msg === 'string' ? msg : Object.keys(msg)[0]);
    const data = msg.contents !== undefined ? msg.contents : msg;

    handleClientMessage(ws, tag, data);
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;
    if (client.roomId) leaveRoom(ws, client.roomId);
    clients.delete(ws);
    console.log(`[WS] Client ngắt kết nối: ${client.username || 'Anonymous'}`);
  });
}

function handleClientMessage(ws, tag, data) {
  const client = clients.get(ws);
  if (!client) return;

  switch (tag) {
    case 'CLogin': {
      const username = (data.clUsername || data.username || 'Player').trim();
      const displayName = (data.clDisplayName || data.displayName || username).trim();

      // Check if username is already in use
      let inUse = false;
      clients.forEach(c => { if (c.username && c.username.toLowerCase() === username.toLowerCase()) inUse = true; });
      if (inUse) {
        sendTo(ws, 'SLoginError', `Tên '${username}' đang online. Vui lòng chọn tên khác.`);
        return;
      }

      client.username = username;
      client.displayName = displayName;

      const profile = {
        ppUsername: username,
        ppDisplayName: displayName,
        ppCreatedAt: new Date().toISOString(),
        ppStats: { psKills: 0, psDeaths: 0, psWins: 0, psBoxesCollected: 0, psScore: 0 }
      };

      sendTo(ws, 'SLoginSuccess', { slsUsername: username, slsProfile: profile });
      sendTo(ws, 'SRoomList', getRoomListPayload());
      console.log(`[Auth] '${username}' đã đăng nhập.`);
      break;
    }

    case 'CListRooms': {
      sendTo(ws, 'SRoomList', getRoomListPayload());
      break;
    }

    case 'CCreateRoom': {
      if (!client.username) return;
      if (client.roomId) { sendTo(ws, 'SRoomError', 'Bạn đang ở trong phòng khác!'); return; }

      const roomId = generateRoomId();
      const roomName = (data.ccrRoomName || `${client.username}’s Room`).slice(0, 32);
      const maxPlayers = Math.max(2, Math.min(10, Number(data.ccrMaxPlayers || 4)));
      const password = data.ccrPassword || null;

      const room = {
        id: roomId,
        name: roomName,
        maxPlayers,
        password,
        host: client.username,
        players: [{ ws, username: client.username, color: 'TankRed' }],
        phase: 'LobbyPhase',
        countdown: 0,
        tanks: new Map(),
        bullets: [],
        lasers: [],
        boxes: [],
        maze: {
          mazeWalls: ARENA_WALLS,
          mazeWidth: WORLD_W,
          mazeHeight: WORLD_H,
          mazeSpawnPts: SPAWN_POINTS,
          mazeBoxSpawnPts: BOX_SPAWN_POINTS
        },
        inputs: new Map(),
        gameLoopInterval: null,
        boxTimer: 15,
        // The pre-match draft is separate from the authoritative combat
        // phase. It lets the room agree on map and teams before countdown.
        draft: { stage: 'lobby', mode: 'teams', votes: {}, teams: {}, ready: {} },
        selectedMap: 'random'
      };

      rooms.set(roomId, room);
      client.roomId = roomId;

      const info = {
        riRoomId: roomId,
        riRoomName: roomName,
        riHostPlayer: client.username,
        riCurrentPlayers: 1,
        riMaxPlayers: maxPlayers,
        riHasPassword: !!password,
        riPhase: { tag: 'LobbyPhase' }
      };

      sendTo(ws, 'SRoomCreated', info);
      sendTo(ws, 'SRoomRoster', [[client.username, 'TankRed']]);
      broadcastDraft(room);
      broadcastRoomList();
      console.log(`[Room] Phòng ${roomId} ('${roomName}') đã tạo bởi '${client.username}'.`);
      break;
    }

    case 'CJoinRoom': {
      if (!client.username) return;
      if (client.roomId) { sendTo(ws, 'SRoomError', 'Bạn đang ở trong phòng khác!'); return; }

      const roomId = (data.cjrRoomId || data.roomId || '').toUpperCase();
      const password = data.cjrPassword || null;
      const room = rooms.get(roomId);

      if (!room) { sendTo(ws, 'SRoomError', 'Mã phòng không tồn tại!'); return; }
      if (room.players.length >= room.maxPlayers) { sendTo(ws, 'SRoomError', 'Phòng đã đủ người chơi!'); return; }
      if (room.password && room.password !== password) { sendTo(ws, 'SRoomError', 'Mật khẩu phòng không đúng!'); return; }
      if (room.phase !== 'LobbyPhase') { sendTo(ws, 'SRoomError', 'Trận đấu đang diễn ra!'); return; }

      const color = TANK_COLORS[room.players.length % TANK_COLORS.length];
      room.players.push({ ws, username: client.username, color });
      client.roomId = roomId;

      const info = {
        riRoomId: room.id,
        riRoomName: room.name,
        riHostPlayer: room.host,
        riCurrentPlayers: room.players.length,
        riMaxPlayers: room.maxPlayers,
        riHasPassword: !!room.password,
        riPhase: { tag: room.phase }
      };

      sendTo(ws, 'SRoomJoined', info);

      // Notify other players in the room
      const roster = room.players.map(p => [p.username, p.color]);
      room.players.forEach(p => {
        if (p.ws !== ws) sendTo(p.ws, 'SPlayerJoined', [client.username, color]);
        sendTo(p.ws, 'SRoomRoster', roster);
      });
      broadcastDraft(room);

      broadcastRoomList();
      console.log(`[Room] '${client.username}' đã vào phòng ${roomId}.`);
      break;
    }

    case 'CLeaveRoom': {
      if (!client.roomId) return;
      leaveRoom(ws, client.roomId);
      break;
    }

    case 'CStartGame': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      if (room.host !== client.username) {
        sendTo(ws, 'SRoomError', 'Chỉ chủ phòng mới có thể bắt đầu!');
        return;
      }

      const draft = ensureDraft(room);
      const everyoneReady = room.players.length > 0 && room.players.every(player => {
        const name = player.username;
        return draft.votes[name] && (draft.teams[name] === 'blue' || draft.teams[name] === 'red');
      });
      if (draft.stage !== 'map' || !everyoneReady) {
        sendTo(ws, 'SRoomError', 'CÁC NGƯỜI CHƠI CHƯA SẴN SÀNG. Mỗi người phải chọn đội và bản đồ.');
        return;
      }
      room.selectedMap = resolveDraftMap(draft.votes);
      broadcastToRoom(room, 'SSelectedMap', room.selectedMap);
      startRoomCountdown(room);
      break;
    }

    case 'COpenDraft': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.phase !== 'LobbyPhase') return;
      if (room.host !== client.username) {
        sendTo(ws, 'SRoomError', 'Chỉ chủ phòng mới có thể mở phần chuẩn bị trận.');
        return;
      }
      room.draft = { stage: 'tank', mode: 'teams', votes: {}, teams: {}, ready: {} };
      broadcastDraft(room);
      broadcastToRoom(room, 'SDraftOpened');
      break;
    }

    case 'CTankReady': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.phase !== 'LobbyPhase') return;
      const draft = ensureDraft(room);
      draft.ready[client.username] = true;
      draft.stage = 'map';
      broadcastDraft(room);
      break;
    }

    case 'CMapVote': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.phase !== 'LobbyPhase') return;
      const map = String(data.cmvMapId || data.mapId || '').toLowerCase();
      if (!['forest', 'ruins', 'depot', 'random'].includes(map)) {
        sendTo(ws, 'SRoomError', 'Bản đồ không hợp lệ.');
        return;
      }
      const draft = ensureDraft(room);
      draft.stage = 'map';
      draft.votes[client.username] = map;
      broadcastDraft(room);
      break;
    }

    case 'CSetMatchMode': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.phase !== 'LobbyPhase') return;
      if (room.host !== client.username) {
        sendTo(ws, 'SRoomError', 'Chỉ chủ phòng mới đổi được chế độ đội.');
        return;
      }
      // Kept for clients from an earlier build.  Rooms now consistently use
      // the two-team picker, rather than exposing a separate 5V5 toggle.
      const draft = ensureDraft(room);
      draft.mode = 'teams';
      broadcastDraft(room);
      break;
    }

    case 'CChooseTeam': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.phase !== 'LobbyPhase') return;
      const team = String(data.cctTeam || data.team || '').toLowerCase();
      const draft = ensureDraft(room);
      if (draft.mode !== 'teams' || !['blue', 'red'].includes(team)) return;
      const members = room.players.filter(player => draft.teams[player.username] === team && player.username !== client.username);
      const teamCapacity = Math.max(1, Math.min(5, Math.ceil(room.maxPlayers / 2)));
      if (members.length >= teamCapacity) {
        sendTo(ws, 'SRoomError', `Đội ${team === 'blue' ? 'xanh' : 'đỏ'} đã đủ ${teamCapacity} người.`);
        return;
      }
      draft.teams[client.username] = team;
      broadcastDraft(room);
      break;
    }

    case 'CPlayerInput': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.phase !== 'InGamePhase') return;
      const inp = data.contents || data;
      room.inputs.set(client.username, {
        up: !!(inp.piMoveUp || inp.up),
        down: !!(inp.piMoveDown || inp.down),
        left: !!(inp.piMoveLeft || inp.left),
        right: !!(inp.piMoveRight || inp.right),
        angle: Number(inp.piMouseAngle || inp.angle || 0),
        fire: !!(inp.piFire || inp.fire)
      });
      break;
    }

    case 'CPing': {
      sendTo(ws, 'SPong');
      break;
    }
  }
}

function leaveRoom(ws, roomId) {
  const room = rooms.get(roomId);
  const client = clients.get(ws);
  if (client) client.roomId = null;

  sendTo(ws, 'SRoomLeft');

  if (!room) return;

  room.players = room.players.filter(p => p.ws !== ws);

  if (room.players.length === 0) {
    if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
    rooms.delete(roomId);
    console.log(`[Room] Phòng ${roomId} đã giải tán.`);
  } else {
    // If host left, promote first player
    if (room.host === client.username) {
      room.host = room.players[0].username;
    }
    const roster = room.players.map(p => [p.username, p.color]);
    room.players.forEach(p => {
      sendTo(p.ws, 'SPlayerLeft', client.username);
      sendTo(p.ws, 'SRoomRoster', roster);
    });
    const draft = ensureDraft(room);
    delete draft.votes[client.username];
    delete draft.teams[client.username];
    delete draft.ready[client.username];
    broadcastDraft(room);
  }

  broadcastRoomList();
}

// -----------------------------------------------------------------------------
// Authoritative Game Loop (60 Hz)
// -----------------------------------------------------------------------------
function startRoomCountdown(room) {
  room.phase = 'CountdownPhase';
  broadcastRoomList();

  let count = 3;
  broadcastToRoom(room, 'SCountdown', count);

  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      broadcastToRoom(room, 'SCountdown', count);
    } else {
      clearInterval(timer);
      broadcastToRoom(room, 'SCountdown', 0);
      initGameMatch(room);
    }
  }, 1000);
}

function broadcastToRoom(room, tag, contents) {
  const msg = JSON.stringify(contents !== undefined ? { tag, contents } : { tag });
  room.players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(msg);
  });
}

function ensureDraft(room) {
  if (!room.draft) room.draft = { stage: 'lobby', mode: 'teams', votes: {}, teams: {}, ready: {} };
  room.draft.votes ||= {};
  room.draft.teams ||= {};
  room.draft.ready ||= {};
  room.draft.mode = 'teams';
  return room.draft;
}

function broadcastDraft(room) {
  const draft = ensureDraft(room);
  broadcastToRoom(room, 'SRoomDraft', {
    stage: draft.stage,
    mode: draft.mode,
    votes: draft.votes,
    teams: draft.teams,
    ready: draft.ready,
    maxPlayers: room.maxPlayers,
    players: room.players.map(player => ({ username: player.username, color: player.color }))
  });
}

function resolveDraftMap(votes) {
  const values = Object.values(votes).filter(map => ['forest', 'ruins', 'depot', 'random'].includes(map));
  if (!values.length) return 'random';
  const counts = values.reduce((all, map) => { all[map] = (all[map] || 0) + 1; return all; }, {});
  const high = Math.max(...Object.values(counts));
  const winners = Object.keys(counts).filter(map => counts[map] === high);
  const voted = winners[Math.floor(Math.random() * winners.length)];
  if (voted === 'random') {
    const maps = ['forest', 'ruins', 'depot'];
    return maps[Math.floor(Math.random() * maps.length)];
  }
  return voted;
}

function initGameMatch(room) {
  room.phase = 'InGamePhase';
  room.bullets = [];
  room.boxes = [{ mbPos: { vx: WORLD_W / 2, vy: WORLD_H / 2 }, mbActive: true, mbRespawnIn: 0 }];
  room.tanks.clear();
  room.inputs.clear();

  room.players.forEach((p, idx) => {
    const spawn = SPAWN_POINTS[idx % SPAWN_POINTS.length];
    room.tanks.set(p.username, {
      tankId: p.username,
      tankPos: { vx: spawn.vx, vy: spawn.vy },
      tankVel: { vx: 0, vy: 0 },
      tankBodyAngle: 0,
      tankTurretAngle: 0,
      tankColor: p.color,
      tankWeapon: { wsCurrentWeapon: 'NormalBullet', wsBuffTimeLeft: 0, wsCooldownState: 'Ready' },
      tankAlive: true,
      tankScore: 0,
      tankKills: 0,
      tankDeaths: 0,
      tankAssists: 0,
      tankPoints: 0,
      tankKillStreak: 0,
      tankMultiKillCount: 0,
      tankMultiKillTimer: 0,
      tankRespawnTimer: 0,
      tankInvulnerabilityLeft: 2.0,
      tankAmmo: 6,
      tankMaxAmmo: 6,
      tankReloadTimer: 0,
      lastFireTime: 0
    });
  });

  const TICK_MS = Math.floor(1000 / 60); // ~16.67 ms
  const dt = 1 / 60;

  if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
  room.gameLoopInterval = setInterval(() => {
    tickGame(room, dt);
  }, TICK_MS);

  console.log(`[Game] Trận đấu phòng ${room.id} bắt đầu! (${room.players.length} người chơi)`);
}

function tickGame(room, dt) {
  const now = Date.now();

  // 1. Process tank movements & inputs
  room.tanks.forEach(tank => {
    if (!tank.tankAlive) {
      tank.tankRespawnTimer -= dt;
      if (tank.tankRespawnTimer <= 0) {
        tank.tankAlive = true;
        tank.tankInvulnerabilityLeft = 2.0;
        const spawn = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
        tank.tankPos = { vx: spawn.vx, vy: spawn.vy };
        tank.tankAmmo = 6;
      }
      return;
    }

    if (tank.tankInvulnerabilityLeft > 0) tank.tankInvulnerabilityLeft -= dt;

    const inp = room.inputs.get(tank.tankId) || { up: false, down: false, left: false, right: false, angle: 0, fire: false };
    let moveX = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let moveY = (inp.up ? 1 : 0) - (inp.down ? 1 : 0); // In web client coordinate, check up/down

    if (moveX !== 0 || moveY !== 0) {
      const len = Math.hypot(moveX, moveY);
      moveX /= len;
      moveY /= len;
      tank.tankBodyAngle = Math.atan2(moveY, moveX);
      const nextX = tank.tankPos.vx + moveX * TANK_SPEED * dt;
      const nextY = tank.tankPos.vy + moveY * TANK_SPEED * dt;

      // Wall collision check
      if (!collidesWalls({ vx: nextX, vy: tank.tankPos.vy }, TANK_RADIUS, ARENA_WALLS)) {
        tank.tankPos.vx = Math.max(TANK_RADIUS, Math.min(WORLD_W - TANK_RADIUS, nextX));
      }
      if (!collidesWalls({ vx: tank.tankPos.vx, vy: nextY }, TANK_RADIUS, ARENA_WALLS)) {
        tank.tankPos.vy = Math.max(TANK_RADIUS, Math.min(WORLD_H - TANK_RADIUS, nextY));
      }
    }

    tank.tankTurretAngle = inp.angle;

    // Firing
    if (inp.fire && now - tank.lastFireTime > 500) { // 500ms cooldown
      tank.lastFireTime = now;
      const dirX = Math.cos(tank.tankTurretAngle);
      const dirY = Math.sin(tank.tankTurretAngle);
      room.bullets.push({
        bulPos: { vx: tank.tankPos.vx + dirX * 32, vy: tank.tankPos.vy + dirY * 32 },
        bulVel: { vx: dirX * BULLET_SPEED, vy: dirY * BULLET_SPEED },
        bulType: 'NormalBullet',
        bulOwnerId: tank.tankId,
        bulBounces: 0,
        bulLifetime: BULLET_MAX_LIFETIME
      });
    }
  });

  // 2. Process bullets
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.bulLifetime -= dt;
    if (b.bulLifetime <= 0 || b.bulBounces >= BULLET_MAX_BOUNCES) {
      room.bullets.splice(i, 1);
      continue;
    }

    const nextX = b.bulPos.vx + b.bulVel.vx * dt;
    const nextY = b.bulPos.vy + b.bulVel.vy * dt;

    // Bounce on boundary
    if (nextX <= 8 || nextX >= WORLD_W - 8) {
      b.bulVel.vx = -b.bulVel.vx;
      b.bulBounces++;
    }
    if (nextY <= 8 || nextY >= WORLD_H - 8) {
      b.bulVel.vy = -b.bulVel.vy;
      b.bulBounces++;
    }

    // Bounce on walls
    for (const wall of ARENA_WALLS) {
      if (segmentIntersectsCircle(wall.wallStart, wall.wallEnd, { vx: nextX, vy: nextY }, 6)) {
        // Reflect velocity
        const isHorizontal = Math.abs(wall.wallStart.vy - wall.wallEnd.vy) < 1;
        if (isHorizontal) b.bulVel.vy = -b.bulVel.vy;
        else b.bulVel.vx = -b.bulVel.vx;
        b.bulBounces++;
        break;
      }
    }

    b.bulPos.vx += b.bulVel.vx * dt;
    b.bulPos.vy += b.bulVel.vy * dt;

    // Bullet vs Tank collision
    let hit = false;
    room.tanks.forEach(tank => {
      if (hit || !tank.tankAlive || tank.tankInvulnerabilityLeft > 0) return;
      const dist = Math.hypot(b.bulPos.vx - tank.tankPos.vx, b.bulPos.vy - tank.tankPos.vy);
      if (dist < TANK_RADIUS) {
        hit = true;
        tank.tankAlive = false;
        tank.tankRespawnTimer = 4.0;
        tank.tankDeaths++;

        const killer = room.tanks.get(b.bulOwnerId);
        if (killer && killer.tankId !== tank.tankId) {
          killer.tankKills++;
          killer.tankPoints += 10;
        }

        broadcastToRoom(room, 'SKillEvent', [b.bulOwnerId, tank.tankId]);
      }
    });

    if (hit) {
      room.bullets.splice(i, 1);
    }
  }

  // 3. Broadcast Snapshot
  const snapshot = {
    wsTanks: Array.from(room.tanks.values()),
    wsBullets: room.bullets,
    wsLasers: [],
    wsMysteryBoxes: room.boxes,
    wsMaze: room.maze,
    wsPhase: { tag: 'InGamePhase' },
    wsScores: Array.from(room.tanks.values()).map(t => [t.tankId, t.tankPoints])
  };

  broadcastToRoom(room, 'SGameSnapshot', snapshot);
}

// -----------------------------------------------------------------------------
// Math & Collision Helpers
// -----------------------------------------------------------------------------
function distToSegmentSquared(p, v, w) {
  const l2 = (v.vx - w.vx) ** 2 + (v.vy - w.vy) ** 2;
  if (l2 === 0) return (p.vx - v.vx) ** 2 + (p.vy - v.vy) ** 2;
  let t = ((p.vx - v.vx) * (w.vx - v.vx) + (p.vy - v.vy) * (w.vy - v.vy)) / l2;
  t = Math.max(0, Math.min(1, t));
  return (p.vx - (v.vx + t * (w.vx - v.vx))) ** 2 + (p.vy - (v.vy + t * (w.vy - v.vy))) ** 2;
}

function segmentIntersectsCircle(v, w, p, radius) {
  return distToSegmentSquared(p, v, w) <= radius * radius;
}

function collidesWalls(pos, radius, walls) {
  for (const wall of walls) {
    if (segmentIntersectsCircle(wall.wallStart, wall.wallEnd, pos, radius)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        🎮  TankWar Dedicated Multiplayer Server v1.0  🎮     ║');
  console.log(`║  HTTP Web:      http://localhost:${PORT}/web/                     ║`);
  console.log(`║  WebSocket:     ws://localhost:${PORT}/                           ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`[Server] Sẵn sàng nhận kết nối online và tạo phòng!`);
});
