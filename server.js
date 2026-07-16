cat > /home/claude/tanks-online/server.js << 'SERVEREOF'
// ==========================================================
//  TANKS ONLINE - сервер
//  Обычный бой (FFA) + командный бой по комнатам (роли,
//  контрольные точки), раунды по 10 минут, туман войны,
//  скины (сплошной/радужный/неоновый), кусты-укрытия на
//  песчаной карте, лимит игроков, heartbeat, панель хоста.
// ==========================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// ---------------------- Настройки игры ----------------------
const MAP_W = 3600;
const MAP_H = 2400;

const TANK_RADIUS      = 20;
const TANK_SPEED       = 95;
const TANK_ROT_SPEED   = 6;
const TURRET_ROT_SPEED = 12;

const BULLET_SPEED     = 780;
const BULLET_RADIUS    = 5;
const BULLET_DAMAGE    = 10;
const BULLET_LIFETIME  = 3000;

const MAX_HP           = 100;
const RESPAWN_MS       = 3000;
const SHOOT_COOLDOWN   = 3000;

const FFA_AMMO      = 50;
const ATTACKER_AMMO = 50;
const SUPPORT_AMMO  = 35;

const HEAL_RATE      = MAX_HP / 20;
const HEAL_COOLDOWN  = 90000;
const AMMO_REFILL_S  = 10;
const AMMO_COOLDOWN  = 60000;
const AMMO_MAX_USES  = 5;

// длительность одного раунда (10 минут). Можно временно переопределить
// через переменную окружения MATCH_DURATION_SEC для тестов.
const MATCH_DURATION_MS = (process.env.MATCH_DURATION_SEC ? +process.env.MATCH_DURATION_SEC : 600) * 1000;

const MAX_PLAYERS_PER_ROOM = 12;
const VISION_RANGE = 650;          // обычный радиус "тумана войны"
const BUSH_VISION_RANGE = 160;     // в кустах видно только почти вплотную
const OBSTACLE_COUNT = 70;

const TICK_MS      = 1000 / 60;
const BROADCAST_MS = 1000 / 20;
const HEARTBEAT_MS = 15000;

const FFA_CODE = 'PUBLIC';
const ADMIN_PASSWORD = 'sbascvxzc'; // пароль открытой панели хоста (кик / рестарт раунда)

const COLORS = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4',
                 '#42d4f4','#f032e6','#bfef45','#fabed4','#469990'];
const TEAM_COLORS = { red: '#e53935', blue: '#3949ab' };
const SKIN_TYPES = ['solid', 'rainbow', 'neon'];

// ---------------------- Генерация песчаной карты с кустами ----------------------
function generateMap(rand, exclusionZones = []) {
  const obstacles = [];
  const wallT = 50;
  obstacles.push({ x: 0, y: 0, w: MAP_W, h: wallT, type: 'wall' });
  obstacles.push({ x: 0, y: MAP_H - wallT, w: MAP_W, h: wallT, type: 'wall' });
  obstacles.push({ x: 0, y: 0, w: wallT, h: MAP_H, type: 'wall' });
  obstacles.push({ x: MAP_W - wallT, y: 0, w: wallT, h: MAP_H, type: 'wall' });

  // wall (камни) блокируют, crate (ящики) блокируют, bush (кусты) — НЕ блокируют
  // проезд и снаряды, но прячут стоящего в них игрока (туман войны сильнее)
  const types = ['wall', 'bush', 'bush', 'crate'];
  let placed = 0, attempts = 0;
  while (placed < OBSTACLE_COUNT && attempts < 3000) {
    attempts++;
    const type = types[Math.floor(rand() * types.length)];
    let w, h;
    if (type === 'wall') { w = 70 + rand() * 150; h = 70 + rand() * 150; }
    else if (type === 'bush') { w = h = 60 + rand() * 40; }
    else { w = h = 48 + rand() * 22; }
    const x = 120 + rand() * (MAP_W - 240 - w);
    const y = 120 + rand() * (MAP_H - 240 - h);
    const cx = x + w / 2, cy = y + h / 2;
    let blocked = false;
    for (const z of exclusionZones) {
      if (Math.hypot(cx - z.x, cy - z.y) < z.r + Math.max(w, h) / 2) { blocked = true; break; }
    }
    if (blocked) continue;
    obstacles.push({ x, y, w, h, type });
    placed++;
  }
  return obstacles;
}

const CONTROL_POINT_DEFS = [
  { id: 'heal', type: 'heal', x: MAP_W * 0.30, y: MAP_H * 0.5, r: 90 },
  { id: 'ammo', type: 'ammo', x: MAP_W * 0.70, y: MAP_H * 0.5, r: 90 }
];
const CONTROL_POINT_EXCLUSIONS = CONTROL_POINT_DEFS.map(cp => ({ x: cp.x, y: cp.y, r: 220 }));

function createControlPoints() {
  return CONTROL_POINT_DEFS.map(def => ({
    ...def,
    cooldownUntil: 0,
    inUseBy: null,
    usesLeft: def.type === 'ammo' ? AMMO_MAX_USES : undefined
  }));
}

function makeMapFor(mode) {
  return mode === 'team' ? generateMap(Math.random, CONTROL_POINT_EXCLUSIONS) : generateMap(Math.random);
}

// ---------------------- Утилиты ----------------------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function circleRectCollide(cx, cy, r, rect) {
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX, dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
}

// кусты не мешают проезду танков
function collidesAnyIn(obstacles, x, y, r) {
  for (const o of obstacles) {
    if (o.type === 'bush') continue;
    if (circleRectCollide(x, y, r, o)) return true;
  }
  return false;
}

// снаряды пролетают сквозь кусты
function collidesSolidBullet(obstacles, x, y, r) {
  for (const o of obstacles) {
    if (o.type === 'bush') continue;
    if (circleRectCollide(x, y, r, o)) return true;
  }
  return false;
}

function insideBush(obstacles, x, y) {
  for (const o of obstacles) {
    if (o.type !== 'bush') continue;
    if (circleRectCollide(x, y, TANK_RADIUS * 0.5, o)) return true;
  }
  return false;
}

function findSpawnPoint(room, team) {
  for (let i = 0; i < 60; i++) {
    let x;
    if (room.mode === 'team' && team === 'red') x = 150 + Math.random() * (MAP_W * 0.35 - 150);
    else if (room.mode === 'team' && team === 'blue') x = MAP_W * 0.65 + Math.random() * (MAP_W - 150 - MAP_W * 0.65);
    else x = 150 + Math.random() * (MAP_W - 300);
    const y = 150 + Math.random() * (MAP_H - 300);
    if (!collidesAnyIn(room.obstacles, x, y, TANK_RADIUS + 8)) return { x, y };
  }
  return { x: MAP_W / 2, y: MAP_H / 2 };
}

function angleLerp(a, target, maxDelta) {
  let diff = target - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return a + Math.sign(diff) * maxDelta;
}

function genId() { return 'p' + Math.random().toString(36).slice(2, 10); }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
}
function sanitizeSkin(s) {
  return SKIN_TYPES.includes(s) ? s : 'solid';
}

function findSlot(room, requestedRole) {
  const caps = { attacker: 4, support: 2 };
  const counts = { red: { attacker: 0, support: 0 }, blue: { attacker: 0, support: 0 } };
  for (const p of room.players.values()) {
    if (p.team && p.role && counts[p.team] && counts[p.team][p.role] !== undefined) counts[p.team][p.role]++;
  }
  const totalRed = counts.red.attacker + counts.red.support;
  const totalBlue = counts.blue.attacker + counts.blue.support;
  const order = totalRed <= totalBlue ? ['red', 'blue'] : ['blue', 'red'];
  for (const team of order) {
    if (counts[team][requestedRole] < caps[requestedRole]) return { team, role: requestedRole };
  }
  const other = requestedRole === 'attacker' ? 'support' : 'attacker';
  for (const team of order) {
    if (counts[team][other] < caps[other]) return { team, role: other };
  }
  return null;
}

// ---------------------- Комната / матч ----------------------
class GameRoom {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode;
    this.players = new Map();
    this.bullets = [];
    this.bulletIdCounter = 1;
    this.killFeed = [];
    this.controlPoints = mode === 'team' ? createControlPoints() : [];
    this.obstacles = makeMapFor(mode);
    this.matchEndAt = Date.now() + MATCH_DURATION_MS;
  }
}

const rooms = new Map();
rooms.set(FFA_CODE, new GameRoom(FFA_CODE, 'ffa'));

function sanitizeName(name) {
  return (name || 'Танк').toString().trim().slice(0, 16) || 'Танк';
}

function createPlayer(id, name, ws, room, team, role, forcedColor, skin) {
  const maxAmmo = room.mode === 'team' ? (role === 'support' ? SUPPORT_AMMO : ATTACKER_AMMO) : FFA_AMMO;
  const spawn = findSpawnPoint(room, team);
  const color = team ? TEAM_COLORS[team] : (forcedColor || COLORS[Math.floor(Math.random() * COLORS.length)]);
  return {
    id, ws,
    name: sanitizeName(name),
    team: team || null,
    role: role || 'ffa',
    skin: sanitizeSkin(skin),
    x: spawn.x, y: spawn.y,
    angle: 0, turret: 0,
    hp: MAX_HP, alive: true,
    color,
    inBush: false,
    maxAmmo, ammo: maxAmmo,
    input: { mx: 0, my: 0 },
    aim: 0,
    lastShot: 0,
    respawnAt: 0,
    kills: 0, deaths: 0
  };
}

function sendWelcome(ws, room, p) {
  ws.send(JSON.stringify({
    t: 'welcome', id: p.id,
    mode: room.mode, roomCode: room.mode === 'team' ? room.code : null,
    team: p.team, role: p.role, maxAmmo: p.maxAmmo,
    map: { w: MAP_W, h: MAP_H },
    obstacles: room.obstacles,
    controlPoints: room.controlPoints.map(cp => ({ id: cp.id, type: cp.type, x: cp.x, y: cp.y, r: cp.r })),
    matchEndAt: room.matchEndAt,
    constants: {
      tankRadius: TANK_RADIUS, bulletRadius: BULLET_RADIUS, maxHp: MAX_HP,
      shootCooldown: SHOOT_COOLDOWN, visionRange: VISION_RANGE
    }
  }));
}

function broadcastRoom(room, obj) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

// ---------------------- HTTP статика ----------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function heartbeat() { this.isAlive = true; }
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.isAdmin = false;
  ws.on('pong', heartbeat);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // --------- открытая панель хоста (пароль, честные инструменты - без читов) ---------
    if (msg.t === 'hostAuth') {
      ws.isAdmin = (typeof msg.password === 'string' && msg.password === ADMIN_PASSWORD);
      ws.send(JSON.stringify({ t: 'hostAuthResult', ok: ws.isAdmin }));
      return;
    }
    if (msg.t === 'hostAction') {
      if (!ws.isAdmin) { ws.send(JSON.stringify({ t: 'hostAuthResult', ok: false })); return; }
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (msg.action === 'kick' && msg.targetId) {
        const target = room.players.get(msg.targetId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify({ t: 'kicked' }));
          target.ws.close();
        }
      } else if (msg.action === 'restartRound') {
        startNewRound(room, Date.now());
        broadcastRoom(room, {
          t: 'mapUpdate',
          obstacles: room.obstacles,
          controlPoints: room.controlPoints.map(cp => ({ id: cp.id, type: cp.type, x: cp.x, y: cp.y, r: cp.r }))
        });
      }
      return;
    }

    // --------- обычный бой (FFA) ---------
    if (msg.t === 'join') {
      const room = rooms.get(FFA_CODE);
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        ws.send(JSON.stringify({ t: 'error', text: 'Сервер заполнен (максимум 12 игроков). Попробуйте позже.' }));
        return;
      }
      const id = genId();
      const color = sanitizeColor(msg.color);
      const p = createPlayer(id, msg.name, ws, room, null, 'ffa', color, msg.skin);
      if (room.players.size === 0) room.matchEndAt = Date.now() + MATCH_DURATION_MS;
      room.players.set(id, p);
      ws.playerId = id; ws.roomCode = FFA_CODE;
      sendWelcome(ws, room, p);
      broadcastRoom(room, { t: 'chat', text: `${p.name} присоединился к игре` });
      return;
    }

    // --------- создать комнату командного боя ---------
    if (msg.t === 'createRoom') {
      const code = generateRoomCode();
      const room = new GameRoom(code, 'team');
      rooms.set(code, room);
      const role = msg.role === 'support' ? 'support' : 'attacker';
      const slot = findSlot(room, role);
      const id = genId();
      const p = createPlayer(id, msg.name, ws, room, slot.team, slot.role, null, msg.skin);
      room.players.set(id, p);
      ws.playerId = id; ws.roomCode = code;
      sendWelcome(ws, room, p);
      return;
    }

    // --------- войти в комнату по коду ---------
    if (msg.t === 'joinRoom') {
      const code = (msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room || room.mode !== 'team') {
        ws.send(JSON.stringify({ t: 'error', text: 'Комната не найдена. Проверьте код.' }));
        return;
      }
      const requestedRole = msg.role === 'support' ? 'support' : 'attacker';
      const slot = findSlot(room, requestedRole);
      if (!slot) {
        ws.send(JSON.stringify({ t: 'error', text: 'Комната заполнена (максимум 12 игроков).' }));
        return;
      }
      const id = genId();
      if (room.players.size === 0) room.matchEndAt = Date.now() + MATCH_DURATION_MS;
      const p = createPlayer(id, msg.name, ws, room, slot.team, slot.role, null, msg.skin);
      room.players.set(id, p);
      ws.playerId = id; ws.roomCode = code;
      sendWelcome(ws, room, p);
      const teamName = slot.team === 'red' ? 'Красных' : 'Синих';
      const roleName = slot.role === 'attacker' ? 'нападающий' : 'саппорт';
      broadcastRoom(room, { t: 'chat', text: `${p.name} присоединился к команде ${teamName} (${roleName})` });
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = room.players.get(ws.playerId);
    if (!p) return;

    if (msg.t === 'input') {
      p.input.mx = clamp(+msg.mx || 0, -1, 1);
      p.input.my = clamp(+msg.my || 0, -1, 1);
    } else if (msg.t === 'aim') {
      p.aim = +msg.angle || 0;
    } else if (msg.t === 'shoot') {
      tryShoot(room, p);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (room && ws.playerId && room.players.has(ws.playerId)) {
      const p = room.players.get(ws.playerId);
      room.players.delete(ws.playerId);
      broadcastRoom(room, { t: 'chat', text: `${p.name} покинул игру` });
      if (room.mode === 'team' && room.players.size === 0) rooms.delete(room.code);
    }
  });
});

function tryShoot(room, p) {
  if (!p.alive) return;
  const now = Date.now();
  if (now - p.lastShot < SHOOT_COOLDOWN) return;
  if (p.ammo <= 0) return;
  p.lastShot = now;
  p.ammo -= 1;
  const distOff = TANK_RADIUS + BULLET_RADIUS + 8;
  room.bullets.push({
    id: room.bulletIdCounter++,
    x: p.x + Math.cos(p.aim) * distOff,
    y: p.y + Math.sin(p.aim) * distOff,
    angle: p.aim,
    ownerId: p.id,
    ownerTeam: p.team,
    createdAt: now
  });
}

function startNewRound(room, now) {
  room.obstacles = makeMapFor(room.mode);
  room.bullets = [];
  room.killFeed = [];
  if (room.mode === 'team') room.controlPoints = createControlPoints();
  room.matchEndAt = now + MATCH_DURATION_MS;
  for (const p of room.players.values()) {
    p.kills = 0; p.deaths = 0; p.hp = MAX_HP; p.alive = true; p.ammo = p.maxAmmo;
    const spawn = findSpawnPoint(room, p.team);
    p.x = spawn.x; p.y = spawn.y;
  }
}

// ---------------------- Игровой цикл ----------------------
function tickRoom(room, now, dt) {
  if (room.players.size === 0) return;

  if (now >= room.matchEndAt) {
    const scores = Array.from(room.players.values())
      .map(p => ({ name: p.name, kills: p.kills, deaths: p.deaths, team: p.team }))
      .sort((a, b) => b.kills - a.kills);
    broadcastRoom(room, { t: 'matchEnd', scores });
    startNewRound(room, now);
    broadcastRoom(room, {
      t: 'mapUpdate',
      obstacles: room.obstacles,
      controlPoints: room.controlPoints.map(cp => ({ id: cp.id, type: cp.type, x: cp.x, y: cp.y, r: cp.r }))
    });
    return;
  }

  for (const p of room.players.values()) {
    if (!p.alive) {
      if (now >= p.respawnAt) {
        const spawn = findSpawnPoint(room, p.team);
        p.x = spawn.x; p.y = spawn.y; p.hp = MAX_HP; p.alive = true; p.ammo = p.maxAmmo;
      }
      continue;
    }
    const { mx, my } = p.input;
    const len = Math.hypot(mx, my);
    if (len > 0.05) {
      const nx = mx / len, ny = my / len;
      const targetAngle = Math.atan2(ny, nx);
      p.angle = angleLerp(p.angle, targetAngle, TANK_ROT_SPEED * dt);
      const speed = TANK_SPEED * Math.min(len, 1);
      const newX = p.x + nx * speed * dt;
      const newY = p.y + ny * speed * dt;
      if (!collidesAnyIn(room.obstacles, newX, p.y, TANK_RADIUS)) p.x = newX;
      if (!collidesAnyIn(room.obstacles, p.x, newY, TANK_RADIUS)) p.y = newY;
      p.x = clamp(p.x, TANK_RADIUS, MAP_W - TANK_RADIUS);
      p.y = clamp(p.y, TANK_RADIUS, MAP_H - TANK_RADIUS);
    }
    p.turret = angleLerp(p.turret, p.aim, TURRET_ROT_SPEED * dt);
    p.inBush = insideBush(room.obstacles, p.x, p.y);
  }

  const bullets = room.bullets;
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (now - b.createdAt > BULLET_LIFETIME) { bullets.splice(i, 1); continue; }
    b.x += Math.cos(b.angle) * BULLET_SPEED * dt;
    b.y += Math.sin(b.angle) * BULLET_SPEED * dt;

    let removed = false;
    if (collidesSolidBullet(room.obstacles, b.x, b.y, BULLET_RADIUS)) { bullets.splice(i, 1); continue; }

    if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { bullets.splice(i, 1); continue; }

    for (const p of room.players.values()) {
      if (!p.alive || p.id === b.ownerId) continue;
      if (room.mode === 'team' && b.ownerTeam && p.team === b.ownerTeam) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (dx * dx + dy * dy < (TANK_RADIUS + BULLET_RADIUS) ** 2) {
        p.hp -= BULLET_DAMAGE;
        bullets.splice(i, 1);
        if (p.hp <= 0) {
          p.alive = false;
          p.hp = 0;
          p.deaths++;
          p.respawnAt = Date.now() + RESPAWN_MS;
          const killer = room.players.get(b.ownerId);
          if (killer) killer.kills++;
          room.killFeed.push({ killer: killer ? killer.name : '???', victim: p.name, t: Date.now() });
          if (room.killFeed.length > 6) room.killFeed.shift();
        }
        removed = true;
        break;
      }
    }
  }

  if (room.mode === 'team') {
    for (const cp of room.controlPoints) {
      if (cp.type === 'ammo' && cp.usesLeft <= 0 && !cp.inUseBy) continue;

      if (cp.inUseBy) {
        const p = room.players.get(cp.inUseBy);
        let eligible = p && p.alive && dist(p, cp) <= cp.r;
        if (eligible) eligible = cp.type === 'heal' ? p.hp < MAX_HP : p.ammo < p.maxAmmo;

        if (!eligible) {
          cp.inUseBy = null;
          cp.cooldownUntil = now + (cp.type === 'heal' ? HEAL_COOLDOWN : AMMO_COOLDOWN);
        } else if (cp.type === 'heal') {
          p.hp = Math.min(MAX_HP, p.hp + HEAL_RATE * dt);
          if (p.hp >= MAX_HP) { cp.inUseBy = null; cp.cooldownUntil = now + HEAL_COOLDOWN; }
        } else {
          p.ammo = Math.min(p.maxAmmo, p.ammo + (p.maxAmmo / AMMO_REFILL_S) * dt);
          if (p.ammo >= p.maxAmmo) { p.ammo = p.maxAmmo; cp.inUseBy = null; cp.cooldownUntil = now + AMMO_COOLDOWN; }
        }
      } else if (now >= cp.cooldownUntil) {
        for (const p of room.players.values()) {
          if (!p.alive || dist(p, cp) > cp.r) continue;
          if (cp.type === 'heal' && p.hp < MAX_HP) { cp.inUseBy = p.id; break; }
          if (cp.type === 'ammo' && p.ammo === 0 && cp.usesLeft > 0) { cp.inUseBy = p.id; cp.usesLeft--; break; }
        }
      }
    }
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  for (const room of rooms.values()) tickRoom(room, now, dt);
}, TICK_MS);

// ---------------------- Рассылка состояния (индивидуально, с туманом войны) ----------------------
function buildStateFor(room, viewer) {
  const playersOut = [];
  for (const p of room.players.values()) {
    const range = p.inBush ? BUSH_VISION_RANGE : VISION_RANGE;
    const near = p.id === viewer.id || dist(p, viewer) <= range;
    playersOut.push({
      id: p.id, x: p.x, y: p.y, angle: p.angle, turret: p.turret,
      hp: p.hp, alive: p.alive, color: p.color, skin: p.skin, kills: p.kills, deaths: p.deaths,
      team: p.team, role: p.role, ammo: Math.floor(p.ammo), maxAmmo: p.maxAmmo,
      name: p.name, visible: near, inBush: p.inBush
    });
  }
  const bulletsOut = [];
  for (const b of room.bullets) {
    if (b.ownerId === viewer.id || dist(b, viewer) <= VISION_RANGE) {
      bulletsOut.push({ id: b.id, x: b.x, y: b.y, angle: b.angle, ownerId: b.ownerId });
    }
  }
  return {
    t: 'state',
    players: playersOut,
    bullets: bulletsOut,
    killFeed: room.killFeed,
    matchEndAt: room.matchEndAt,
    controlPoints: room.controlPoints.map(cp => ({
      id: cp.id, inUseBy: cp.inUseBy, cooldownUntil: cp.cooldownUntil,
      usesLeft: cp.usesLeft === undefined ? null : cp.usesLeft
    }))
  };
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    for (const viewer of room.players.values()) {
      if (viewer.ws.readyState === WebSocket.OPEN) {
        viewer.ws.send(JSON.stringify(buildStateFor(room, viewer)));
      }
    }
  }
}, BROADCAST_MS);

server.listen(PORT, () => {
  console.log(`\n  Tanks Online сервер запущен!`);
  console.log(`  Локально:     http://localhost:${PORT}`);
  console.log(`  Для друзей в одной сети: http://<твой-IP>:${PORT}`);
  console.log(`  Раунд: ${MATCH_DURATION_MS/1000}с | Лимит игроков: ${MAX_PLAYERS_PER_ROOM} | Пароль панели хоста: ${ADMIN_PASSWORD}\n`);
});
SERVEREOF
node -c /home/claude/tanks-online/server.js && echo "SYNTAX OK"
