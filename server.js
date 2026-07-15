// ==========================================================
//  TANKS ONLINE - сервер
//  Node.js + ws. Раздаёт клиента (public/) и держит игровое
//  состояние: карту, танки, снаряды, коллизии, респавн.
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
const TANK_SPEED       = 95;    // px/сек  -> танки медленные
const TANK_ROT_SPEED   = 6;     // рад/сек, поворот корпуса
const TURRET_ROT_SPEED = 12;    // рад/сек, поворот башни

const BULLET_SPEED     = 780;   // px/сек  -> снаряды летят быстро
const BULLET_RADIUS    = 5;
const BULLET_DAMAGE    = 20;    // один снаряд = 20хп
const BULLET_LIFETIME  = 3000;  // мс

const MAX_HP           = 100;   // у танка 100хп (5 попаданий)
const RESPAWN_MS       = 3000;  // возрождение через 3 секунды
const SHOOT_COOLDOWN   = 350;   // мс между выстрелами одного танка

const TICK_MS      = 1000 / 60;
const BROADCAST_MS = 1000 / 20;

const COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4',
                 '#42d4f4','#f032e6','#bfef45','#fabed4','#469990'];

// ---------------------- Генерация карты ----------------------
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateMap() {
  const rand = seededRandom(20240715);
  const obstacles = [];
  const wallT = 50;
  // границы огромной карты - непроходимые стены
  obstacles.push({ x: 0, y: 0, w: MAP_W, h: wallT, type: 'wall' });
  obstacles.push({ x: 0, y: MAP_H - wallT, w: MAP_W, h: wallT, type: 'wall' });
  obstacles.push({ x: 0, y: 0, w: wallT, h: MAP_H, type: 'wall' });
  obstacles.push({ x: MAP_W - wallT, y: 0, w: wallT, h: MAP_H, type: 'wall' });

  const types = ['wall', 'tree', 'crate'];
  const COUNT = 130;
  for (let i = 0; i < COUNT; i++) {
    const type = types[Math.floor(rand() * types.length)];
    let w, h;
    if (type === 'wall') { w = 70 + rand() * 160; h = 70 + rand() * 160; }
    else if (type === 'tree') { w = h = 44 + rand() * 34; }
    else { w = h = 48 + rand() * 22; }
    const x = 120 + rand() * (MAP_W - 240 - w);
    const y = 120 + rand() * (MAP_H - 240 - h);
    obstacles.push({ x, y, w, h, type });
  }
  return obstacles;
}

const OBSTACLES = generateMap();

// ---------------------- Утилиты столкновений ----------------------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function circleRectCollide(cx, cy, r, rect) {
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX, dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
}

function collidesAny(x, y, r) {
  for (const o of OBSTACLES) {
    if (circleRectCollide(x, y, r, o)) return true;
  }
  return false;
}

// возрождение в любой точке карты, кроме объектов (коллизия объектов)
function findSpawnPoint() {
  for (let i = 0; i < 60; i++) {
    const x = 150 + Math.random() * (MAP_W - 300);
    const y = 150 + Math.random() * (MAP_H - 300);
    if (!collidesAny(x, y, TANK_RADIUS + 8)) return { x, y };
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

// ---------------------- Игровое состояние ----------------------
const players = new Map();
const bullets = [];
let bulletIdCounter = 1;
let killFeed = [];

function createPlayer(id, name, ws) {
  const spawn = findSpawnPoint();
  return {
    id, ws,
    name: (name || 'Танк').toString().slice(0, 16) || 'Танк',
    x: spawn.x, y: spawn.y,
    angle: 0, turret: 0,
    hp: MAX_HP, alive: true,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    input: { mx: 0, my: 0 },
    aim: 0,
    lastShot: 0,
    respawnAt: 0,
    kills: 0, deaths: 0
  };
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

wss.on('connection', (ws) => {
  let id = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.t === 'join') {
      id = 'p' + Math.random().toString(36).slice(2, 10);
      const p = createPlayer(id, msg.name, ws);
      players.set(id, p);
      ws.send(JSON.stringify({
        t: 'welcome', id,
        map: { w: MAP_W, h: MAP_H },
        obstacles: OBSTACLES,
        constants: { tankRadius: TANK_RADIUS, bulletRadius: BULLET_RADIUS, maxHp: MAX_HP }
      }));
      broadcast({ t: 'chat', text: `${p.name} присоединился к игре` });
      return;
    }

    const p = players.get(id);
    if (!p) return;

    if (msg.t === 'input') {
      p.input.mx = clamp(+msg.mx || 0, -1, 1);
      p.input.my = clamp(+msg.my || 0, -1, 1);
    } else if (msg.t === 'aim') {
      p.aim = +msg.angle || 0;
    } else if (msg.t === 'shoot') {
      tryShoot(p);
    }
  });

  ws.on('close', () => {
    if (id && players.has(id)) {
      const p = players.get(id);
      players.delete(id);
      broadcast({ t: 'chat', text: `${p.name} покинул игру` });
    }
  });
});

function tryShoot(p) {
  if (!p.alive) return;
  const now = Date.now();
  if (now - p.lastShot < SHOOT_COOLDOWN) return;
  p.lastShot = now;
  const dist = TANK_RADIUS + BULLET_RADIUS + 8;
  bullets.push({
    id: bulletIdCounter++,
    x: p.x + Math.cos(p.aim) * dist,
    y: p.y + Math.sin(p.aim) * dist,
    angle: p.aim,
    ownerId: p.id,
    ownerName: p.name,
    createdAt: now
  });
}

// ---------------------- Игровой цикл ----------------------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  // --- танки ---
  for (const p of players.values()) {
    if (!p.alive) {
      if (now >= p.respawnAt) {
        const spawn = findSpawnPoint();
        p.x = spawn.x; p.y = spawn.y; p.hp = MAX_HP; p.alive = true;
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
      // раздельная проверка по осям -> танк скользит вдоль стен, а не залипает
      if (!collidesAny(newX, p.y, TANK_RADIUS)) p.x = newX;
      if (!collidesAny(p.x, newY, TANK_RADIUS)) p.y = newY;
      p.x = clamp(p.x, TANK_RADIUS, MAP_W - TANK_RADIUS);
      p.y = clamp(p.y, TANK_RADIUS, MAP_H - TANK_RADIUS);
    }
    p.turret = angleLerp(p.turret, p.aim, TURRET_ROT_SPEED * dt);
  }

  // --- снаряды ---
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (now - b.createdAt > BULLET_LIFETIME) { bullets.splice(i, 1); continue; }
    b.x += Math.cos(b.angle) * BULLET_SPEED * dt;
    b.y += Math.sin(b.angle) * BULLET_SPEED * dt;

    let removed = false;
    for (const o of OBSTACLES) {
      if (circleRectCollide(b.x, b.y, BULLET_RADIUS, o)) { bullets.splice(i, 1); removed = true; break; }
    }
    if (removed) continue;

    if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { bullets.splice(i, 1); continue; }

    for (const p of players.values()) {
      if (!p.alive || p.id === b.ownerId) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (dx * dx + dy * dy < (TANK_RADIUS + BULLET_RADIUS) ** 2) {
        p.hp -= BULLET_DAMAGE;
        bullets.splice(i, 1);
        if (p.hp <= 0) {
          p.alive = false;
          p.hp = 0;
          p.deaths++;
          p.respawnAt = Date.now() + RESPAWN_MS;
          const killer = players.get(b.ownerId);
          if (killer) killer.kills++;
          killFeed.push({ killer: killer ? killer.name : '???', victim: p.name, t: Date.now() });
          if (killFeed.length > 6) killFeed.shift();
        }
        removed = true;
        break;
      }
    }
  }
}, TICK_MS);

// ---------------------- Рассылка состояния ----------------------
setInterval(() => {
  const state = {
    t: 'state',
    players: Array.from(players.values()).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, turret: p.turret,
      hp: p.hp, alive: p.alive, color: p.color, kills: p.kills, deaths: p.deaths
    })),
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, angle: b.angle, ownerId: b.ownerId })),
    killFeed
  };
  broadcast(state);
}, BROADCAST_MS);

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

server.listen(PORT, () => {
  console.log(`\n  Tanks Online сервер запущен!`);
  console.log(`  Локально:     http://localhost:${PORT}`);
  console.log(`  Для друзей в одной сети: http://<твой-IP>:${PORT}\n`);
});
