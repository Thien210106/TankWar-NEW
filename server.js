'use strict';

/**
 * TankWar Dedicated Server & Web Server in Node.js
 * - Zero dependencies (pure Node.js http, crypto, fs, path).
 * - Full RFC 6455 WebSocket implementation.
 * - Pure PvP (Player vs Player) multiplayer.
 * - Full 4096px map layouts (Forest, Ruins, Depot) loaded from web/assets/maps/.
 * - 60 Hz Authoritative Game Loop with tanks, bouncing bullets, mystery boxes.
 * - Serves web/ as static files on http://localhost:PORT/
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || process.argv[2] || 3000);
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

      if (this.buffer.length < offset + payloadLength) return;

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
      } else if (opcode === 0x09) { // PING -> PONG
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
// Map Layouts & Geometry
// -----------------------------------------------------------------------------
const MAP_LAYOUTS = {};
const MAP_NAMES = ['forest', 'ruins', 'depot'];

function circleIntersectsRect(pos, radius, rect) {
  const x = Math.max(rect.x, Math.min(pos.vx, rect.x + rect.width));
  const y = Math.max(rect.y, Math.min(pos.vy, rect.y + rect.height));
  return (pos.vx - x) ** 2 + (pos.vy - y) ** 2 < radius * radius;
}

function collidesMap(pos, radius, map) {
  if (!map) return false;
  if (pos.vx < radius || pos.vx > map.width - radius || pos.vy < radius || pos.vy > map.height - radius) return true;
  for (let i = 0; i < map.collisionRects.length; i++) {
    if (circleIntersectsRect(pos, radius, map.collisionRects[i])) return true;
  }
  return false;
}

function loadMapLayouts() {
  MAP_NAMES.forEach(id => {
    const filePath = path.join(WEB_ROOT, 'assets', 'maps', `${id}_layout.json`);
    if (!fs.existsSync(filePath)) {
      console.warn(`[Map] Missing map file: ${filePath}`);
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const width = Number(data.width) || 4096;
      const height = Number(data.height) || 4096;
      const cellSize = Number(data.cell_size) || 352;
      const gridOffset = Number(data.grid_offset) || 112;

      const wallRects = (data.wall_rectangles || []).map(r => ({
        x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height)
      }));
      const blockedRects = (data.blocked_cells || []).map(([col, row]) => ({
        x: gridOffset + col * cellSize, y: gridOffset + row * cellSize, width: cellSize, height: cellSize
      }));
      const collisionRects = wallRects.concat(blockedRects);

      const spawnCentres = (data.spawn_centres || []).map(([x, y]) => ({ vx: Number(x), vy: Number(y) }));
      const fallbackSpawns = [
        { vx: 704, vy: 704 }, { vx: width - 704, vy: height - 704 },
        { vx: width - 704, vy: 704 }, { vx: 704, vy: height - 704 },
        { vx: width / 2, vy: 704 }, { vx: width / 2, vy: height - 704 },
        { vx: 704, vy: height / 2 }, { vx: width - 704, vy: height / 2 }
      ];
      const spawns = spawnCentres.concat(fallbackSpawns).filter(p => !collidesMap(p, 36, { width, height, collisionRects }));

      MAP_LAYOUTS[id] = {
        id,
        width,
        height,
        cellSize,
        collisionRects,
        spawns: spawns.length > 0 ? spawns : fallbackSpawns
      };
      console.log(`[Map] Loaded ${id} (${width}x${height}), ${collisionRects.length} collision rects, ${spawns.length} spawns.`);
    } catch (e) {
      console.error(`[Map] Error reading ${id}:`, e);
    }
  });

  // Load Cấm Địa (Control Zone) map layout
  const camdiaScene = [
    ['tree', 830, 470, 270, 0], ['tree', 215, 1040, 250, 0],
    ['rocks', 1080, 1660, 250, 0], ['bushes', 510, 2500, 390, 0],
    ['container', 2170, 1290, 340, Math.PI / 2], ['bushes', 2080, 2020, 280, 0],
    ['rocks', 2350, 2810, 230, 0], ['container', 1480, 3250, 340, Math.PI / 2],
    ['ruin', 3650, 1570, 360, 0], ['ruin', 3310, 2260, 330, 0],
    ['bushes', 3430, 1120, 310, 0], ['container', 4260, 3500, 340, Math.PI / 2],
    ['bushes', 4720, 3750, 400, 0], ['rocks', 3580, 4030, 230, 0],
    ['ruin', 2030, 4450, 350, 0], ['ruin', 1420, 5050, 350, 0],
    ['bushes', 1900, 5200, 260, 0], ['container', 3390, 4950, 340, Math.PI / 2],
    ['rocks', 4600, 4680, 260, 0], ['tree', 5260, 5370, 250, 0], ['tree', 4870, 5480, 240, 0]
  ];
  const camdiaCollisionRects = camdiaScene.filter(([kind]) => !['tree'].includes(kind)).map(([, x, y, size]) => ({
    x: x - size * .35, y: y - size * .28, width: size * .7, height: size * .56
  }));
  MAP_LAYOUTS['camdia'] = {
    id: 'camdia',
    width: 5632,
    height: 5632,
    cellSize: 352,
    collisionRects: camdiaCollisionRects,
    spawns: [
      { vx: 500, vy: 500 }, { vx: 5132, vy: 5132 },
      { vx: 5132, vy: 500 }, { vx: 500, vy: 5132 },
      { vx: 2816, vy: 600 }, { vx: 2816, vy: 5032 },
      { vx: 600, vy: 2816 }, { vx: 5032, vy: 2816 },
      { vx: 1800, vy: 1800 }, { vx: 3800, vy: 3800 }
    ]
  };
  console.log(`[Map] Loaded camdia (5632x5632), ${camdiaCollisionRects.length} collision rects, 10 spawns.`);
}
loadMapLayouts();

function getMap(id) {
  return MAP_LAYOUTS[id] || MAP_LAYOUTS['forest'] || {
    id: 'forest', width: 4096, height: 4096, cellSize: 352, collisionRects: [],
    spawns: [{ vx: 704, vy: 704 }, { vx: 3392, vy: 3392 }]
  };
}

// -----------------------------------------------------------------------------
// Constants Matching Offline Play
// -----------------------------------------------------------------------------
const TANK_RADIUS = 36;
const TANK_SPEED = 457; // 150 * 4096 / 1344
const BULLET_SPEED = 1188; // 390 * 4096 / 1344
const BULLET_MAX_LIFETIME = 3.0;
const BULLET_MAX_RANGE = 1228; // 0.3 * 4096
const BULLET_MAX_BOUNCES = 4;
const MAGAZINE_SIZE = 6;
const RELOAD_TIME = 2.2;
const FIRE_COOLDOWN = 0.5;
const RESPAWN_TIME = 5.0;
const INVULN_TIME = 2.0;
const MATCH_DURATION = 300; // 5 minutes

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
  if (ws && ws.readyState === 1) {
    const msg = JSON.stringify(contents !== undefined ? { tag, contents } : { tag });
    ws.send(msg);
  }
}

function broadcastToRoom(room, tag, contents) {
  const msg = JSON.stringify(contents !== undefined ? { tag, contents } : { tag });
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
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
  const payload = getRoomListPayload();
  clients.forEach((client, ws) => {
    if (!client.roomId) {
      sendTo(ws, 'SRoomList', payload);
    }
  });
}

function ensureDraft(room) {
  if (!room.draft) {
    room.draft = { stage: 'lobby', mode: 'teams', votes: {}, teams: {}, ready: {} };
  }
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
  if (!values.length) return 'forest';
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

// -----------------------------------------------------------------------------
// Client Connection & Messages
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Online Matchmaking System (Tử chiến, Đấu đội 2v2..5v5, Cấm địa 2v2..5v5)
// -----------------------------------------------------------------------------
let matchmakingQueue = [];

function checkMatchmaking() {
  matchmakingQueue = matchmakingQueue.filter(entry => entry.ws && entry.ws.readyState === 1);

  // Group by mode key: deathmatch_0, team_2, team_3, team_4, team_5, zone_2, zone_3, zone_4, zone_5
  const groups = {};
  for (const entry of matchmakingQueue) {
    const key = `${entry.mode || 'deathmatch'}_${entry.teamSize || 0}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }

  const now = Date.now();
  for (const [key, list] of Object.entries(groups)) {
    const isZone = key.startsWith('zone_');
    const isTeam = key.startsWith('team_') || isZone;
    const size = parseInt(key.split('_')[1], 10) || 0;
    const needed = isTeam ? Math.max(2, size * 2) : 2;

    list.forEach(p => {
      sendTo(p.ws, 'SMatchmakingStatus', {
        status: 'searching',
        queueCount: list.length,
        neededCount: needed,
        mode: p.mode,
        teamSize: p.teamSize
      });
    });

    let canStart = false;
    let matchPlayerCount = needed;

    if (list.length >= needed) {
      canStart = true;
      matchPlayerCount = needed;
    } else if (isTeam && list.length >= 2 && (now - list[0].joinedAt >= 6000)) {
      // Auto-start quick team match with available even count for testing
      canStart = true;
      matchPlayerCount = Math.floor(list.length / 2) * 2;
    }

    if (canStart && matchPlayerCount >= 2) {
      const matchedPlayers = list.splice(0, matchPlayerCount);
      matchmakingQueue = matchmakingQueue.filter(p => !matchedPlayers.includes(p));
      startMatchedGame(key, matchedPlayers);
    }
  }
}

// Periodic queue check for quick matches
setInterval(checkMatchmaking, 1000);

function startMatchedGame(modeKey, matchedPlayers) {
  const isZone = modeKey.startsWith('zone_');
  const isTeam = modeKey.startsWith('team_') || isZone;
  const p1 = matchedPlayers[0];

  // Map selection
  let chosenMap = 'forest';
  if (isZone) {
    chosenMap = 'camdia';
  } else {
    const availableMaps = ['forest', 'ruins', 'depot'];
    const specificVotes = matchedPlayers.map(p => p.preferredMap).filter(m => m && m !== 'random' && availableMaps.includes(m));
    if (specificVotes.length > 0) {
      chosenMap = specificVotes[Math.floor(Math.random() * specificVotes.length)];
    } else {
      chosenMap = availableMaps[Math.floor(Math.random() * availableMaps.length)];
    }
  }

  const roomId = generateRoomId();
  const modeName = isZone ? 'Cấm Địa' : (isTeam ? 'Đấu Đội' : 'Tử Chiến');
  const roomName = `${modeName} #${roomId}`;

  const roomPlayers = matchedPlayers.map((p, idx) => {
    let color = 'TankGreen';
    let team = 'ffa';
    if (isTeam) {
      const isBlue = (idx % 2 === 0);
      color = isBlue ? 'TankBlue' : 'TankRed';
      team = isBlue ? 'blue' : 'red';
    } else {
      color = TANK_COLORS[idx % TANK_COLORS.length];
    }
    return {
      ws: p.ws,
      username: p.username,
      color,
      team,
      hull: p.hull || '05',
      gun: p.gun || '05'
    };
  });

  const room = {
    id: roomId,
    name: roomName,
    maxPlayers: matchedPlayers.length,
    password: null,
    host: p1.username,
    players: roomPlayers,
    phase: 'LobbyPhase',
    countdown: 0,
    tanks: new Map(),
    bullets: [],
    lasers: [],
    boxes: [],
    map: getMap(chosenMap),
    maze: { mazeWalls: [], mazeWidth: 4096, mazeHeight: 4096, mazeSpawnPts: [], mazeBoxSpawnPts: [] },
    inputs: new Map(),
    gameLoopInterval: null,
    boxTimer: 10,
    matchClock: 0,
    isTeamMode: isTeam,
    isZoneMode: isZone,
    teamScores: { blue: 0, red: 0 },
    draft: {
      stage: 'lobby',
      mode: isTeam ? 'teams' : 'freeforall',
      votes: {},
      teams: {},
      ready: {}
    },
    selectedMap: chosenMap
  };

  roomPlayers.forEach(p => {
    room.draft.teams[p.username] = p.team;
  });

  rooms.set(roomId, room);
  roomPlayers.forEach(p => {
    const c = clients.get(p.ws);
    if (c) c.roomId = roomId;
  });

  const info = {
    riRoomId: roomId,
    riRoomName: roomName,
    riHostPlayer: p1.username,
    riCurrentPlayers: roomPlayers.length,
    riMaxPlayers: roomPlayers.length,
    riHasPassword: false,
    riPhase: { tag: 'LobbyPhase' }
  };

  const roster = roomPlayers.map(p => [p.username, p.color]);

  roomPlayers.forEach(p => {
    const opponentNames = roomPlayers.filter(other => other.team !== p.team).map(o => o.username).join(', ');
    const teammateNames = roomPlayers.filter(other => other.team === p.team && other.username !== p.username).map(t => t.username).join(', ');
    sendTo(p.ws, 'SMatchFound', {
      mode: isZone ? 'zone' : (isTeam ? 'team' : 'deathmatch'),
      opponents: opponentNames,
      teammates: teammateNames,
      map: chosenMap,
      color: p.color
    });
    sendTo(p.ws, 'SRoomJoined', info);
    sendTo(p.ws, 'SRoomRoster', roster);
    sendTo(p.ws, 'SSelectedMap', chosenMap);
  });

  console.log(`[Matchmaking] Ghép phòng [${modeName}] thành công: ${roomPlayers.map(p => `${p.username}(${p.color})`).join(' vs ')} trên map '${chosenMap}' (${roomId})`);
  broadcastRoomList();
  startRoomCountdown(room);
}

function handleNewClient(ws) {
  const client = { username: null, displayName: null, roomId: null };
  clients.set(ws, client);

  ws.on('message', text => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }

    const tag = msg.tag;
    const data = msg.contents !== undefined ? msg.contents : msg;

    switch (tag) {
      case 'CStartMatchmaking': {
        const username = String(data.name || data.username || client.username || 'TankPilot').trim();
        client.username = username;
        client.displayName = username;

        if (client.roomId) {
          leaveRoom(ws, client.roomId);
        }

        matchmakingQueue = matchmakingQueue.filter(entry => entry.ws !== ws);

        const preferredMap = data.preferredMap || data.map || 'random';
        const mode = String(data.mode || 'deathmatch').toLowerCase();
        const teamSize = Number(data.teamSize || 0);

        matchmakingQueue.push({
          ws,
          username,
          mode,
          teamSize,
          preferredMap,
          hull: data.hull || '05',
          gun: data.gun || '05',
          joinedAt: Date.now()
        });

        console.log(`[Matchmaking] '${username}' vào hàng chờ [${mode}_${teamSize}]. Tổng: ${matchmakingQueue.length}`);
        checkMatchmaking();
        break;
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

      case 'CLogin': {
        const username = String(data.clUsername || data.username || '').trim();
        if (!username) {
          sendTo(ws, 'SLoginFailed', 'Tên người chơi không được để trống!');
          return;
        }
        client.username = username;
        client.displayName = username;
        sendTo(ws, 'SLoginSuccess', username);
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
        if (client.roomId) {
          sendTo(ws, 'SRoomError', 'Bạn đang ở trong phòng khác!');
          return;
        }
        const roomName = String(data.ccrRoomName || data.name || `${client.username}'s Room`).trim();
        const roomId = generateRoomId();
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
          map: getMap('forest'),
          maze: { mazeWalls: [], mazeWidth: 4096, mazeHeight: 4096, mazeSpawnPts: [], mazeBoxSpawnPts: [] },
          inputs: new Map(),
          gameLoopInterval: null,
          boxTimer: 10,
          matchClock: 0,
          draft: { stage: 'lobby', mode: 'teams', votes: {}, teams: {}, ready: {} },
          selectedMap: 'forest'
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

      case 'CChooseTeam': {
        if (!client.roomId) return;
        const room = rooms.get(client.roomId);
        if (!room || room.phase !== 'LobbyPhase') return;
        const team = String(data.cctTeam || data.team || '').toLowerCase();
        const draft = ensureDraft(room);
        if (draft.mode !== 'teams' || !['blue', 'red'].includes(team)) return;
        draft.teams[client.username] = team;
        broadcastDraft(room);
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
        room.selectedMap = resolveDraftMap(draft.votes);
        room.map = getMap(room.selectedMap);
        broadcastToRoom(room, 'SSelectedMap', room.selectedMap);
        startRoomCountdown(room);
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
          fire: !!(inp.piFire || inp.fire),
          reload: !!(inp.piReload || inp.reload)
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    matchmakingQueue = matchmakingQueue.filter(entry => entry.ws !== ws);
    if (client.roomId) {
      leaveRoom(ws, client.roomId);
    }
    clients.delete(ws);
  });
}

function leaveRoom(ws, roomId) {
  const room = rooms.get(roomId);
  const client = clients.get(ws);
  if (!room || !client) return;

  room.players = room.players.filter(p => p.ws !== ws);
  client.roomId = null;
  sendTo(ws, 'SRoomLeft', roomId);

  if (room.players.length === 0) {
    if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
    rooms.delete(roomId);
    console.log(`[Room] Phòng ${roomId} đã giải tán.`);
  } else {
    if (room.host === client.username) {
      room.host = room.players[0].username;
      sendTo(room.players[0].ws, 'SHostTransferred', room.host);
    }
    const roster = room.players.map(p => [p.username, p.color]);
    room.players.forEach(p => {
      sendTo(p.ws, 'SPlayerLeft', client.username);
      sendTo(p.ws, 'SRoomRoster', roster);
    });
    broadcastDraft(room);
  }
  broadcastRoomList();
}

// -----------------------------------------------------------------------------
// Authoritative Game Loop (60 Hz) - Pure PvP
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

function pickOpenPoint(map, radius = 36) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const pt = {
      vx: 200 + Math.random() * (map.width - 400),
      vy: 200 + Math.random() * (map.height - 400)
    };
    if (!collidesMap(pt, radius, map)) return pt;
  }
  return { vx: map.width / 2, vy: map.height / 2 };
}

function initGameMatch(room) {
  room.phase = 'InGamePhase';
  room.bullets = [];
  room.lasers = [];
  room.matchClock = 0;
  room.boxTimer = 10;
  room.tanks.clear();
  room.inputs.clear();

  const map = room.map;
  room.maze = {
    mazeWalls: [],
    mazeWidth: map.width,
    mazeHeight: map.height,
    mazeSpawnPts: map.spawns,
    mazeBoxSpawnPts: []
  };

  // Add initial mystery box
  const boxPt = pickOpenPoint(map, 36);
  room.boxes = [{ mbPos: boxPt, mbActive: true, mbRespawnIn: 0, mbSpawnedAt: 0 }];

  // Setup human players only (pure PvP, no bot AI)
  let spawnIdx = 0;
  room.players.forEach(p => {
    const spawn = map.spawns[spawnIdx % map.spawns.length] || { vx: 704, vy: 704 };
    spawnIdx++;
    const teamNum = room.isTeamMode ? (p.color === 'TankBlue' ? 0 : 1) : -1;
    room.tanks.set(p.username, createTankState(p.username, spawn, p.color, teamNum));
  });

  const dt = 1 / 60;
  if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
  room.gameLoopInterval = setInterval(() => {
    tickGame(room, dt);
  }, 1000 / 60);

  console.log(`[Game] Trận đấu PvP phòng ${room.id} (${room.selectedMap}) bắt đầu! (${room.players.length} người chơi)`);
}

function createTankState(id, spawn, color, teamNum = -1) {
  return {
    tankId: id,
    tankPos: { vx: spawn.vx, vy: spawn.vy },
    tankVel: { vx: 0, vy: 0 },
    tankBodyAngle: 0,
    tankTurretAngle: 0,
    tankColor: color,
    tankTeam: teamNum,
    tankWeapon: { wsCurrentWeapon: 'NormalBullet', wsBuffTimeLeft: 0, wsCooldownState: 'Ready' },
    tankAlive: true,
    tankScore: 0,
    tankKills: 0,
    tankDeaths: 0,
    tankPoints: 0,
    tankKillStreak: 0,
    tankMultiKillCount: 0,
    tankRespawnTimer: 0,
    tankInvulnerabilityLeft: INVULN_TIME,
    tankAmmo: MAGAZINE_SIZE,
    tankMaxAmmo: MAGAZINE_SIZE,
    tankReloadTimer: 0,
    lastFireTime: 0,
    lastKillTime: 0,
    _powerBuff: 0
  };
}

function tickGame(room, dt) {
  const now = Date.now();
  const map = room.map;
  room.matchClock += dt;

  // Check match time limit (300 seconds)
  if (room.matchClock >= MATCH_DURATION && room.phase === 'InGamePhase') {
    room.phase = 'GameOverPhase';
    broadcastToRoom(room, 'SGameOver', 'Trận đấu kết thúc!');
    clearInterval(room.gameLoopInterval);
    room.gameLoopInterval = null;
    return;
  }

  // 1. Mystery Box Spawning & Lifetime
  room.boxTimer -= dt;
  if (room.boxTimer <= 0 && room.boxes.length < 2) {
    const pt = pickOpenPoint(map, 36);
    room.boxes.push({ mbPos: pt, mbActive: true, mbRespawnIn: 0, mbSpawnedAt: room.matchClock });
    room.boxTimer = 20 + Math.random() * 8;
  }

  // 2. Process Tanks (Player controlled)
  room.tanks.forEach(tank => {
    // Respawn countdown
    if (!tank.tankAlive) {
      tank.tankRespawnTimer -= dt;
      if (tank.tankRespawnTimer <= 0) {
        tank.tankAlive = true;
        tank.tankInvulnerabilityLeft = INVULN_TIME;
        const spawn = map.spawns[Math.floor(Math.random() * map.spawns.length)] || pickOpenPoint(map, 36);
        tank.tankPos = { vx: spawn.vx, vy: spawn.vy };
        tank.tankAmmo = MAGAZINE_SIZE;
        tank.tankReloadTimer = 0;
        tank._powerBuff = 0;
      }
      return;
    }

    if (tank.tankInvulnerabilityLeft > 0) tank.tankInvulnerabilityLeft -= dt;
    if (tank._powerBuff > 0) tank._powerBuff -= dt;

    // Weapon buff expiration
    if (tank.tankWeapon.wsBuffTimeLeft > 0) {
      tank.tankWeapon.wsBuffTimeLeft -= dt;
      if (tank.tankWeapon.wsBuffTimeLeft <= 0) {
        tank.tankWeapon.wsCurrentWeapon = 'NormalBullet';
      }
    }

    // Reload timer
    if (tank.tankReloadTimer > 0) {
      tank.tankReloadTimer -= dt;
      if (tank.tankReloadTimer <= 0) {
        tank.tankAmmo = MAGAZINE_SIZE;
      }
    }

    // Update weapon cooldown state for HUD
    const fireCooldownLeft = Math.max(0, FIRE_COOLDOWN - (now - tank.lastFireTime) / 1000);
    tank.tankWeapon.wsCooldownState = tank.tankReloadTimer > 0 || fireCooldownLeft > 0
      ? { tag: 'Reloading', contents: Math.max(tank.tankReloadTimer, fireCooldownLeft) }
      : 'Ready';

    // Mystery Box collection
    for (let i = room.boxes.length - 1; i >= 0; i--) {
      const box = room.boxes[i];
      const dist = Math.hypot(box.mbPos.vx - tank.tankPos.vx, box.mbPos.vy - tank.tankPos.vy);
      if (dist < TANK_RADIUS + 56) {
        room.boxes.splice(i, 1);
        const rewards = ['ShotgunBullet', 'GatlingBullet', 'LaserBullet', 'WallPiercingBullet', 'PowerBuff', 'Shield'];
        const reward = rewards[Math.floor(Math.random() * rewards.length)];
        if (reward === 'PowerBuff') {
          tank._powerBuff = 4.0;
        } else if (reward === 'Shield') {
          tank.tankInvulnerabilityLeft = 5.0;
        } else {
          tank.tankWeapon.wsCurrentWeapon = reward;
          tank.tankWeapon.wsBuffTimeLeft = 14.0;
        }
        broadcastToRoom(room, 'SMysteryBoxPickup', [tank.tankId, reward]);
        break;
      }
    }

    // Player inputs
    const inp = room.inputs.get(tank.tankId) || { up: false, down: false, left: false, right: false, angle: 0, fire: false, reload: false };

    // Manual reload request
    if (inp.reload && tank.tankAmmo < MAGAZINE_SIZE && tank.tankReloadTimer <= 0) {
      tank.tankReloadTimer = RELOAD_TIME;
    }

    // Movement (dx, dy in canvas coords: down increases Y, up decreases Y)
    let moveX = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let moveY = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);

    if (moveX !== 0 || moveY !== 0) {
      const len = Math.hypot(moveX, moveY);
      moveX /= len;
      moveY /= len;
      tank.tankBodyAngle = Math.atan2(moveY, moveX);
      const speedMult = tank._powerBuff > 0 ? 1.55 : 1;
      const step = TANK_SPEED * speedMult * dt;
      const nextX = tank.tankPos.vx + moveX * step;
      const nextY = tank.tankPos.vy + moveY * step;

      // Sliding collision with walls
      if (!collidesMap({ vx: nextX, vy: tank.tankPos.vy }, TANK_RADIUS, map)) {
        tank.tankPos.vx = Math.max(TANK_RADIUS, Math.min(map.width - TANK_RADIUS, nextX));
      }
      if (!collidesMap({ vx: tank.tankPos.vx, vy: nextY }, TANK_RADIUS, map)) {
        tank.tankPos.vy = Math.max(TANK_RADIUS, Math.min(map.height - TANK_RADIUS, nextY));
      }
    }

    tank.tankTurretAngle = inp.angle;

    // Firing
    const effectiveCooldown = (tank._powerBuff > 0 ? 0.28 : FIRE_COOLDOWN) * 1000;
    if (inp.fire && tank.tankAmmo > 0 && tank.tankReloadTimer <= 0 && now - tank.lastFireTime > effectiveCooldown) {
      tank.lastFireTime = now;
      tank.tankAmmo--;
      if (tank.tankAmmo === 0) tank.tankReloadTimer = RELOAD_TIME;

      const angle = tank.tankTurretAngle;
      const muzzleOffset = 64;
      const ox = tank.tankPos.vx + Math.cos(angle) * muzzleOffset;
      const oy = tank.tankPos.vy + Math.sin(angle) * muzzleOffset;
      const wType = tank.tankWeapon.wsCurrentWeapon;

      const spawnBullet = (a, speed = BULLET_SPEED, type = wType) => {
        room.bullets.push({
          bulPos: { vx: ox, vy: oy },
          bulVel: { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed },
          bulType: type,
          bulOwnerId: tank.tankId,
          bulBounces: 0,
          bulLifetime: BULLET_MAX_LIFETIME,
          travelled: 0
        });
      };

      if (wType === 'ShotgunBullet') {
        spawnBullet(angle - 0.22, BULLET_SPEED * 0.9);
        spawnBullet(angle, BULLET_SPEED);
        spawnBullet(angle + 0.22, BULLET_SPEED * 0.9);
      } else if (wType === 'GatlingBullet') {
        spawnBullet(angle, BULLET_SPEED * 1.15);
        spawnBullet(angle + 0.04, BULLET_SPEED * 1.15);
      } else if (wType === 'LaserBullet') {
        spawnBullet(angle, BULLET_SPEED * 1.6);
      } else {
        spawnBullet(angle, BULLET_SPEED, wType);
      }
    }
  });

  // 3. Process Bullets
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.bulLifetime -= dt;
    const stepDist = Math.hypot(b.bulVel.vx * dt, b.bulVel.vy * dt);
    b.travelled += stepDist;

    if (b.bulLifetime <= 0 || b.travelled >= BULLET_MAX_RANGE) {
      room.bullets.splice(i, 1);
      continue;
    }

    const nextX = b.bulPos.vx + b.bulVel.vx * dt;
    const nextY = b.bulPos.vy + b.bulVel.vy * dt;

    // Boundary collision -> destroy bullet (no bouncing)
    if (nextX <= 16 || nextX >= map.width - 16 || nextY <= 16 || nextY >= map.height - 16) {
      room.bullets.splice(i, 1);
      continue;
    }

    // Map wall collision -> destroy bullet (WallPiercingBullet passes through walls)
    let hitWall = false;
    if (b.bulType !== 'WallPiercingBullet') {
      for (const rect of map.collisionRects) {
        if (circleIntersectsRect({ vx: nextX, vy: nextY }, 10, rect)) {
          hitWall = true;
          break;
        }
      }
    }

    if (hitWall) {
      room.bullets.splice(i, 1);
      continue;
    }

    b.bulPos.vx = nextX;
    b.bulPos.vy = nextY;

    // Bullet vs Tank collision
    let hit = false;
    room.tanks.forEach(tank => {
      if (hit || !tank.tankAlive || tank.tankInvulnerabilityLeft > 0 || tank.tankId === b.bulOwnerId) return;
      const killer = room.tanks.get(b.bulOwnerId);
      if (room.isTeamMode && killer && killer.tankColor === tank.tankColor) return;
      const dist = Math.hypot(b.bulPos.vx - tank.tankPos.vx, b.bulPos.vy - tank.tankPos.vy);
      if (dist < TANK_RADIUS + 14) {
        hit = true;
        tank.tankAlive = false;
        tank.tankRespawnTimer = RESPAWN_TIME;
        tank.tankDeaths++;

        const killer = room.tanks.get(b.bulOwnerId);
        let multiTier = 1;
        let shutdown = false;
        let streakTier = 0;

        if (killer && killer.tankId !== tank.tankId) {
          killer.tankKills++;
          killer.tankPoints += 10;

          // Streak
          killer.tankKillStreak++;
          if (killer.tankKillStreak >= 3) streakTier = Math.min(7, killer.tankKillStreak);

          // Multi-kill
          if (now - killer.lastKillTime <= 15000) {
            killer.tankMultiKillCount = Math.min(5, (killer.tankMultiKillCount || 1) + 1);
          } else {
            killer.tankMultiKillCount = 1;
          }
          multiTier = killer.tankMultiKillCount;
          killer.lastKillTime = now;
        }

        // Shutdown bonus
        if (tank.tankKillStreak >= 3) {
          shutdown = true;
          if (killer) killer.tankPoints += 20;
        }
        tank.tankKillStreak = 0;

        broadcastToRoom(room, 'SKillEvent', [b.bulOwnerId, tank.tankId, multiTier, shutdown, streakTier]);
      }
    });

    if (hit) {
      room.bullets.splice(i, 1);
    }
  }

  // 4. Broadcast Authoritative Snapshot
  const snapshot = {
    wsTanks: Array.from(room.tanks.values()),
    wsBullets: room.bullets,
    wsLasers: room.lasers,
    wsMysteryBoxes: room.boxes,
    wsMaze: room.maze,
    wsPhase: { tag: room.phase },
    wsScores: Array.from(room.tanks.values()).map(t => [t.tankId, t.tankPoints])
  };

  broadcastToRoom(room, 'SGameSnapshot', snapshot);
}

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        🎮  TankWar Dedicated Multiplayer Server v2.0  🎮     ║');
  console.log(`║  HTTP Web:      http://localhost:${PORT}/web/                     ║`);
  console.log(`║  WebSocket:     ws://localhost:${PORT}/                           ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`[Server] Sẵn sàng nhận kết nối online và tạo phòng (Chế độ PvP thuần túy)!`);
});
