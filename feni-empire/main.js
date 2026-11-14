'use strict';

/* =====================================================================
   FeNi Empire — Итерация 3: спрайты + экономика
   ---------------------------------------------------------------------
   Мировые координаты: (x, y) — клетки сетки, z — высота в пикселях.
   Проекция 2:1 (классическая игровая изометрия):
       screenX = (x − y) · 32
       screenY = (x + y) · 16 − z
   ===================================================================== */

/* ============================ ДАННЫЕ ============================ */
const DATA = {
  map: {
    size: 28,          // сетка 28×28 клеток
    band: 7,           // |x − y| ≤ band → вертикальная «полоса» острова под портретный экран
    maxS: 47,          // x + y ≤ maxS
    coast: 31,         // где начинается море (по x + y)
    island: { minS: 38, minD: 0 }, // остров клиента за морем
  },

  nodes: [
    // foot — «пятно» узла на сетке [x0, y0, x1, y1]: по нему ставится спрайт и считается клик
    { id: 'mine',   name: 'Рудник', sub: 'Добыча сырья',        label: [4.1, 2.0, 70],   apron: null,                   foot: [2.0, 0.0, 6.2, 4.2],    sprite: 'mine' },
    { id: 'plant',  name: 'Завод',  sub: 'Плавка ферроникеля',  label: [6.6, 9.4, 64],   apron: [4.6, 7.6, 9.9, 12.5],  foot: [4.6, 7.6, 9.9, 12.5],   sprite: 'factory' },
    { id: 'port',   name: 'Порт',   sub: 'Погрузка на суда',    label: [15.0, 12.4, 70], apron: [12.8, 11.0, 16.7, 15.0], foot: [12.6, 10.6, 17.9, 15.9], sprite: 'port' },
    { id: 'client', name: 'Клиент', sub: 'Терминал покупателя', label: [23.4, 19.4, 52], apron: [21.0, 18.0, 25.0, 22.0], foot: [21.0, 18.0, 25.0, 22.0], sprite: null },
  ],

  // Спрайты (PNG с прозрачностью, лежат рядом с index.html).
  // Здания: ширина = ширина «пятна» foot в изометрии × k; низ картинки — на переднем углу foot (+dy).
  // Транспорт: width — ширина в пикселях мира; faces — куда «смотрит» картинка; anchor — точка касания земли (доля высоты).
  // Если файла нет — объект рисуется кодом, как в итерации 2.
  sprites: {
    mine:    { src: 'mine.png',    k: 1.02, dx: 0, dy: 8 },
    factory: { src: 'factory.png', k: 1.0,  dx: 0, dy: 6 },
    port:    { src: 'port.png',    k: 1.12, dx: 4, dy: 22 },
    truck:   { src: 'truck.png',   width: 46, faces: 'right', anchor: 0.78 },
    ship:    { src: 'ship.png',    width: 84, faces: 'left',  anchor: 0.72 },
    train:   { src: null,          width: 54, faces: 'right', anchor: 0.78 }, // положи train.png и впиши src — поезд заменит грузовик на ж/д
  },

  economy: {
    capital: 1000000,
    oreCost: 5000,        // «Купить руду»: −$5,000 → +1 руда
    smeltSeconds: 10,     // «Запустить плавку»: 1 руда → 10 с → 1 FeNi
    salePrice: 20000,     // «Продать»: −1 FeNi → +$20,000
    nickel: 16000,        // стартовая цена никеля (LME, $/т)
    xpPerSale: 0.25,
    xpPerSmelt: 0.05,
  },

  // pts — ломаная по осям сетки; lane — смещение полос от оси;
  // speed — клеток в секунду; dwell — секунд на погрузку/разгрузку
  routes: [
    { id: 'road', kind: 'road', vehicle: 'truck', pts: [[4, 4.4], [4, 6.6], [6.6, 6.6], [6.6, 7.9]],    lane: 0.2,  count: 3, speed: 1.25, dwell: 1.2 },
    { id: 'rail', kind: 'rail', vehicle: 'train', pts: [[9.7, 10], [11.6, 10], [11.6, 12.7], [12.9, 12.7]], lane: 0.24, count: 2, speed: 1.5,  dwell: 1.6 },
    { id: 'sea',  kind: 'sea',  vehicle: 'ship',  pts: [[18.6, 14.4], [18.6, 21.4], [19.5, 21.4]],      lane: 0.34, count: 2, speed: 0.6,  dwell: 2.5 },
  ],
};

/* ============================ ПРОЕКЦИЯ И ЦВЕТ ============================ */
const HW = 32, HH = 16;           // половины ширины/высоты клетки
const WATER_Z = -4;               // уровень воды ниже суши
const SLAB = 26;                  // толщина «плиты» острова
const iso = (x, y, z = 0) => [(x - y) * HW, (x + y) * HH - z];

const shadeCache = new Map();
function shade(hex, k) {
  const key = hex + k;
  let v = shadeCache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    const c = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
    v = `rgb(${c(16)},${c(8)},${c(0)})`;
    shadeCache.set(key, v);
  }
  return v;
}

function rng(seed) { // mulberry32 — детерминированный «случай»
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash2 = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0);

/* ============================ CANVAS / КАМЕРА ============================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = canvas.parentElement;
let VW = 0, VH = 0, DPR = 1;
const cam = { x: 0, y: 0, s: 1, fit: 1, userMoved: false };
const bounds = { x0: 0, x1: 0, y0: 0, y1: 0 };

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  VW = stage.clientWidth; VH = stage.clientHeight;
  canvas.width = Math.round(VW * DPR);
  canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + 'px';
  canvas.style.height = VH + 'px';
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  cam.fit = Math.min((VW - 12) / bw, (VH - 12) / bh);
  if (!cam.userMoved) fitCamera(); else clampCam();
}

function fitCamera() {
  cam.s = cam.fit;
  cam.x = (bounds.x0 + bounds.x1) / 2;
  cam.y = (bounds.y0 + bounds.y1) / 2;
}
function clampCam() {
  cam.s = Math.max(cam.fit * 0.85, Math.min(cam.fit * 4, cam.s));
  cam.x = Math.max(bounds.x0, Math.min(bounds.x1, cam.x));
  cam.y = Math.max(bounds.y0, Math.min(bounds.y1, cam.y));
}
const worldToScreen = (wx, wy) => [(wx - cam.x) * cam.s + VW / 2, (wy - cam.y) * cam.s + VH / 2];
const setWorldTransform = () => ctx.setTransform(DPR * cam.s, 0, 0, DPR * cam.s, DPR * (VW / 2 - cam.x * cam.s), DPR * (VH / 2 - cam.y * cam.s));
const setScreenTransform = () => ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

/* ============================ ПРИМИТИВЫ ============================ */
function poly(pts, fill) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function pathPoly(p, pts) {
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
}
function vgrad(y0, y1, cTop, cBot) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, cTop); g.addColorStop(1, cBot);
  return g;
}

// Объёмный параллелепипед: видны верх, левая (+y) и правая (+x) грани.
// Свет — сверху-слева: верх светлее всего, левая грань — средняя, правая — тёмная.
function drawBox(x, y, z, w, d, h, col, o = {}) {
  const A = iso(x, y + d, z), B = iso(x + w, y + d, z), C = iso(x + w, y, z);
  const A2 = iso(x, y + d, z + h), B2 = iso(x + w, y + d, z + h), C2 = iso(x + w, y, z + h), D2 = iso(x, y, z + h);
  const L = o.grad ? vgrad(A2[1], A[1] + 6, shade(col, 0.82), shade(col, 0.42)) : shade(col, 0.74);
  const R = o.grad ? vgrad(C2[1], B[1] + 6, shade(col, 0.6), shade(col, 0.3)) : shade(col, 0.52);
  poly([A, B, B2, A2], L);
  poly([B, C, C2, B2], R);
  poly([D2, C2, B2, A2], o.top || shade(col, 1.0));
  if (o.edge !== false) {
    ctx.beginPath();
    ctx.moveTo(A2[0], A2[1]); ctx.lineTo(B2[0], B2[1]); ctx.lineTo(C2[0], C2[1]);
    ctx.moveTo(B2[0], B2[1]); ctx.lineTo(B[0], B[1]);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
}

// Двускатная крыша с коньком вдоль оси X
function drawRoofX(x, y, z, w, d, rh, col) {
  const ym = y + d / 2;
  poly([iso(x, y, z), iso(x + w, y, z), iso(x + w, ym, z + rh), iso(x, ym, z + rh)], shade(col, 1.05));
  poly([iso(x, ym, z + rh), iso(x + w, ym, z + rh), iso(x + w, y + d, z), iso(x, y + d, z)], shade(col, 0.78));
  poly([iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, ym, z + rh)], shade(col, 0.5));
  ctx.beginPath();
  const r0 = iso(x, ym, z + rh), r1 = iso(x + w, ym, z + rh);
  ctx.moveTo(r0[0], r0[1]); ctx.lineTo(r1[0], r1[1]);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 0.8; ctx.stroke();
}

const RX = 45.25, RY = 22.63; // проекция окружности радиуса 1 клетка
function drawCyl(x, y, z, r, h, col) {
  const [px, py] = iso(x, y, z);
  const rx = r * RX, ry = r * RY, ty = py - h;
  const g = ctx.createLinearGradient(px - rx, 0, px + rx, 0);
  g.addColorStop(0, shade(col, 0.8)); g.addColorStop(0.35, shade(col, 1.08)); g.addColorStop(1, shade(col, 0.38));
  ctx.beginPath();
  ctx.moveTo(px - rx, ty); ctx.lineTo(px - rx, py);
  ctx.ellipse(px, py, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(px + rx, ty); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.ellipse(px, ty, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = shade(col, 1.18); ctx.fill();
}

function drawPile(x, y, r, h, col) {
  const [px, py] = iso(x, y, 0);
  const rx = r * RX, ry = r * RY;
  const g = ctx.createLinearGradient(px - rx, 0, px + rx, 0);
  g.addColorStop(0, shade(col, 1.15)); g.addColorStop(0.45, shade(col, 0.95)); g.addColorStop(1, shade(col, 0.45));
  ctx.beginPath();
  ctx.moveTo(px - rx, py); ctx.lineTo(px - rx * 0.15, py - h); ctx.lineTo(px + rx * 0.1, py - h + 1);
  ctx.lineTo(px + rx, py); ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI);
  ctx.closePath(); ctx.fillStyle = g; ctx.fill();
}

/* ============================ ГЕОМЕТРИЯ МАРШРУТОВ ============================ */
// Смещённая ломаная (для полос движения и колей). Сегменты — по осям сетки.
function offsetPolyline(pts, off) {
  const segN = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dy);
    segN.push([-dy / l, dx / l]);
  }
  return pts.map((p, i) => {
    const a = segN[i - 1], b = segN[i];
    const nx = (a ? a[0] : 0) + (b ? b[0] : 0), ny = (a ? a[1] : 0) + (b ? b[1] : 0);
    return [p[0] + nx * off, p[1] + ny * off];
  });
}

function makeLane(pts) {
  const segs = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    segs.push({ ax, ay, dx: (bx - ax) / len, dy: (by - ay) / len, len, start: total });
    total += len;
  }
  return { pts, segs, len: total };
}
function laneAt(lane, dist) {
  dist = Math.max(0, Math.min(lane.len, dist));
  let s = lane.segs[0];
  for (const sg of lane.segs) { if (dist >= sg.start) s = sg; }
  const k = dist - s.start;
  return { x: s.ax + s.dx * k, y: s.ay + s.dy * k, dx: s.dx, dy: s.dy };
}

function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
    best = Math.min(best, Math.hypot(px - ax - vx * t, py - ay - vy * t));
  }
  return best;
}

/* ============================ ЗЕМЛЯ ============================ */
const M = DATA.map;
const inMap = (gx, gy) => gx >= 0 && gy >= 0 && gx < M.size && gy < M.size && Math.abs(gx - gy) <= M.band && gx + gy <= M.maxS;
const inRect = (x, y, r, pad = 0) => r && x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;

function tileType(gx, gy) {
  const cx = gx + 0.5, cy = gy + 0.5, s = cx + cy, d = cx - cy;
  for (const n of DATA.nodes) if (inRect(cx, cy, n.apron, 0.3)) return 'land';
  const coast = M.coast + Math.round(Math.sin(d * 1.3) * 0.9);
  const islandEdge = M.island.minD + Math.round(Math.sin(s * 0.8) * 0.6);
  if (s >= M.island.minS && d >= islandEdge) return 'land';
  return s >= coast ? 'water' : 'land';
}

const ground = {};      // Path2D-слои, собранные один раз
const waterTiles = [];

function buildGround() {
  const P = () => new Path2D();
  const land = [P(), P(), P(), P()], dirt = [P(), P(), P(), P()], water = [P(), P(), P()];
  const grid = P(), coastFaceL = P(), coastFaceR = P(), coastLine = P();
  const sideLandL = P(), sideLandR = P(), sideWaterL = P(), sideWaterR = P();
  const type = {};
  for (let gx = 0; gx < M.size; gx++) for (let gy = 0; gy < M.size; gy++) if (inMap(gx, gy)) type[gx + ',' + gy] = tileType(gx, gy);
  const T = (gx, gy) => type[gx + ',' + gy];

  bounds.x0 = bounds.y0 = Infinity; bounds.x1 = bounds.y1 = -Infinity;
  const road = DATA.routes.find((r) => r.kind === 'road');

  for (const key in type) {
    const [gx, gy] = key.split(',').map(Number);
    const t = type[key];
    const z = t === 'water' ? WATER_Z : 0;
    const q = [iso(gx, gy, z), iso(gx + 1, gy, z), iso(gx + 1, gy + 1, z), iso(gx, gy + 1, z)];
    const h = hash2(gx, gy);

    q.forEach(([x, y]) => {
      bounds.x0 = Math.min(bounds.x0, x); bounds.x1 = Math.max(bounds.x1, x);
      bounds.y0 = Math.min(bounds.y0, y); bounds.y1 = Math.max(bounds.y1, y + SLAB);
    });

    if (t === 'water') {
      const deep = gx + gy > 40 ? 2 : h % 2;
      pathPoly(water[deep], q);
      waterTiles.push([gx, gy, h]);
    } else {
      const cx = gx + 0.5, cy = gy + 0.5;
      const nearMine = Math.hypot(cx - 4.2, cy - 2.4) < 4.2 || distToPolyline(cx, cy, road.pts) < 1.1;
      pathPoly((nearMine ? dirt : land)[h % 4], q);
      // сетка: верхние рёбра клетки
      grid.moveTo(q[3][0], q[3][1]); grid.lineTo(q[0][0], q[0][1]); grid.lineTo(q[1][0], q[1][1]);
      // уступ берега (суша выше воды)
      if (T(gx, gy + 1) === 'water') { pathPoly(coastFaceL, [q[3], q[2], iso(gx + 1, gy + 1, WATER_Z), iso(gx, gy + 1, WATER_Z)]); coastLine.moveTo(...q[3]); coastLine.lineTo(...q[2]); }
      if (T(gx + 1, gy) === 'water') { pathPoly(coastFaceR, [q[2], q[1], iso(gx + 1, gy, WATER_Z), iso(gx + 1, gy + 1, WATER_Z)]); coastLine.moveTo(...q[1]); coastLine.lineTo(...q[2]); }
    }

    // боковые грани плиты по краю острова
    if (!T(gx, gy + 1)) pathPoly(t === 'water' ? sideWaterL : sideLandL, [q[3], q[2], iso(gx + 1, gy + 1, -SLAB), iso(gx, gy + 1, -SLAB)]);
    if (!T(gx + 1, gy)) pathPoly(t === 'water' ? sideWaterR : sideLandR, [q[2], q[1], iso(gx + 1, gy, -SLAB), iso(gx + 1, gy + 1, -SLAB)]);
  }
  bounds.y0 -= 110; // запас сверху под трубу завода и подписи

  // Фоновая бесконечная изосетка
  const bg = P();
  for (let k = -40; k <= 70; k++) {
    bg.moveTo(...iso(k, -40)); bg.lineTo(...iso(k, 70));
    bg.moveTo(...iso(-40, k)); bg.lineTo(...iso(70, k));
  }

  Object.assign(ground, { land, dirt, water, grid, coastFaceL, coastFaceR, coastLine, sideLandL, sideLandR, sideWaterL, sideWaterR, bg });
  buildRoutesGround();
}

/* ---------- дороги, рельсы, фарватер ---------- */
function ribbon(p, pts, hw) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const x0 = Math.min(ax, bx) - hw, x1 = Math.max(ax, bx) + hw;
    const y0 = Math.min(ay, by) - hw, y1 = Math.max(ay, by) + hw;
    pathPoly(p, [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)]);
  }
}
function polyPath(p, pts, z = 0) {
  p.moveTo(...iso(pts[0][0], pts[0][1], z));
  for (let i = 1; i < pts.length; i++) p.lineTo(...iso(pts[i][0], pts[i][1], z));
}

function buildRoutesGround() {
  const road = DATA.routes.find((r) => r.kind === 'road');
  const rail = DATA.routes.find((r) => r.kind === 'rail');
  const sea = DATA.routes.find((r) => r.kind === 'sea');

  // Дорога
  ground.roadBed = new Path2D(); ribbon(ground.roadBed, road.pts, 0.5);
  ground.asphalt = new Path2D(); ribbon(ground.asphalt, road.pts, 0.4);
  ground.roadEdges = new Path2D();
  polyPath(ground.roadEdges, offsetPolyline(road.pts, 0.37));
  polyPath(ground.roadEdges, offsetPolyline(road.pts, -0.37));
  ground.roadCenter = new Path2D(); polyPath(ground.roadCenter, road.pts);

  // Ж/д — две колеи
  ground.ballast = new Path2D(); ribbon(ground.ballast, rail.pts, 0.55);
  ground.sleepers = new Path2D(); ground.rails = new Path2D();
  [rail.lane, -rail.lane].forEach((off) => {
    const track = offsetPolyline(rail.pts, off);
    const lane = makeLane(track);
    for (let d = 0.05; d < lane.len; d += 0.2) {
      const p = laneAt(lane, d), nx = -p.dy, ny = p.dx;
      const a = [p.x + nx * 0.17, p.y + ny * 0.17], b = [p.x - nx * 0.17, p.y - ny * 0.17];
      const tx = p.dx * 0.035, ty = p.dy * 0.035;
      pathPoly(ground.sleepers, [iso(a[0] - tx, a[1] - ty), iso(a[0] + tx, a[1] + ty), iso(b[0] + tx, b[1] + ty), iso(b[0] - tx, b[1] - ty)]);
    }
    polyPath(ground.rails, offsetPolyline(track, 0.085));
    polyPath(ground.rails, offsetPolyline(track, -0.085));
  });

  // Фарватер
  ground.seaLane = new Path2D(); polyPath(ground.seaLane, sea.pts, WATER_Z);
}

/* ============================ СТАТИЧНЫЕ ОБЪЕКТЫ ============================ */
const statics = [];      // { depth, draw(t) }
const shadowBoxes = [];  // [x, y, w, d, h]
const staticLights = []; // [x, y, z, radius, 'r,g,b', alpha, blinkPhase|null]
const CONT_COLORS = ['#7a3b2e', '#2f5d62', '#8a6d2f', '#4b5563', '#6b2f3a', '#3e5a3a'];

let G = null; // текущая группа при сборке: 'mine' | 'factory' | 'port' | null
function addStatic(depth, draw) { statics.push({ depth, draw, group: G }); }
function tagGroup(group, build) {
  const a = statics.length, b = shadowBoxes.length, c = staticLights.length;
  G = group; build(); G = null;
  for (let i = b; i < shadowBoxes.length; i++) shadowBoxes[i].group = group;
  for (let i = c; i < staticLights.length; i++) staticLights[i].group = group;
}
function addBox(x, y, z, w, d, h, col, o = {}) {
  addStatic(x + w / 2 + y + d / 2 + (o.bias || 0), () => drawBox(x, y, z, w, d, h, col, o));
  if (!o.noShadow && z <= 1) shadowBoxes.push([x, y, w, d, h]);
}
function addLamp(x, y, h = 30) {
  addStatic(x + y, () => {
    drawBox(x - 0.04, y - 0.04, 0, 0.08, 0.08, h, '#55595e', { edge: false });
    drawBox(x - 0.09, y - 0.09, h, 0.18, 0.18, 2, '#6b6f74', { edge: false });
  });
  staticLights.push([x, y, h - 1, 46, '255,170,70', 0.55, null]);
}

function buildMine() {
  const terraces = [
    [2.0, 0.0, 4.2, 4.0, 11, '#4f3828'],
    [2.35, 0.3, 3.4, 3.25, 10, '#5b412e'],
    [2.75, 0.6, 2.5, 2.45, 10, '#664a35'],
    [3.15, 0.9, 1.6, 1.6, 9, '#71543c'],
  ];
  const r = rng(7);
  const pebbles = Array.from({ length: 46 }, () => [r(), r(), r()]);
  addStatic(6.2, () => {
    let z = 0;
    terraces.forEach(([x, y, w, d, h, c], i) => {
      drawBox(x, y, z, w, d, h, c, { grad: true });
      // камни на уступе
      ctx.fillStyle = shade(c, 0.6);
      pebbles.forEach(([a, b, s], k) => {
        if (k % terraces.length !== i) return;
        const [px, py] = iso(x + a * w, y + b * d, z + h);
        ctx.fillRect(px, py, 1.5 + s * 2, 1 + s);
      });
      z += h;
    });
    // вход в штольню
    poly([iso(3.3, 4, 0), iso(3.9, 4, 0), iso(3.9, 4, 6), iso(3.6, 4, 8.5), iso(3.3, 4, 6)], '#0b0907');
    poly([iso(3.4, 4, 0), iso(3.8, 4, 0), iso(3.8, 4, 4.5), iso(3.6, 4, 6), iso(3.4, 4, 4.5)], 'rgba(255,140,40,0.22)');
  });
  shadowBoxes.push([2.0, 0.0, 4.2, 4.0, 40]);
  staticLights.push([3.6, 4.05, 3, 26, '255,140,50', 0.35, null]);

  // отвалы руды
  addStatic(10.3, () => drawPile(5.3, 5.0, 0.5, 15, '#4a3324'));
  addStatic(10.4, () => drawPile(5.9, 4.5, 0.36, 10, '#3f2c20'));
  // экскаватор
  addStatic(7.6, () => {
    drawBox(2.3, 4.7, 0, 0.55, 0.45, 5, '#2a2a2a', { edge: false });
    drawBox(2.35, 4.72, 5, 0.45, 0.4, 6, '#8f6d22');
    drawBox(2.62, 4.75, 11, 0.18, 0.3, 5, '#9c7a2a');
    const a = iso(2.6, 4.9, 10), b = iso(3.2, 5.35, 18), c = iso(3.5, 5.6, 4);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c);
    ctx.strokeStyle = '#8f6d22'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.stroke();
    drawBox(3.38, 5.5, 0, 0.25, 0.22, 4, '#5a4a2a', { edge: false });
  });
  shadowBoxes.push([2.3, 4.7, 0.55, 0.45, 12]);
}

function buildPlant() {
  // главный цех
  addStatic(15.7, () => {
    drawBox(5.0, 8.2, 0, 2.8, 2.0, 26, '#4b5056', { grad: true });
    // ряд окон на фасаде
    for (let i = 0; i < 7; i++) {
      const x = 5.15 + i * 0.38;
      poly([iso(x, 10.2, 15), iso(x + 0.22, 10.2, 15), iso(x + 0.22, 10.2, 19), iso(x, 10.2, 19)], i % 3 === 1 ? 'rgba(255,190,90,0.55)' : 'rgba(255,190,90,0.18)');
    }
    drawRoofX(5.0, 8.2, 26, 2.8, 2.0, 9, '#3b4046');
  });
  shadowBoxes.push([5.0, 8.2, 2.8, 2.0, 32]);

  // плавильный цех — с пылающими воротами
  addStatic(17.8, (t) => {
    drawBox(5.0, 10.7, 0, 2.3, 1.4, 20, '#57524c', { grad: true });
    drawBox(5.0, 10.7, 20, 2.3, 1.4, 2, '#3e3a36', { edge: false });
    const f = 0.55 + 0.25 * Math.sin(t * 9) * Math.sin(t * 3.7);
    [5.35, 6.35].forEach((x) => {
      poly([iso(x, 12.1, 0), iso(x + 0.55, 12.1, 0), iso(x + 0.55, 12.1, 11), iso(x, 12.1, 11)], '#120c08');
      poly([iso(x + 0.06, 12.1, 0), iso(x + 0.49, 12.1, 0), iso(x + 0.49, 12.1, 8), iso(x + 0.06, 12.1, 8)], `rgba(255,${120 + 40 * f | 0},30,${0.55 + 0.4 * f})`);
    });
    drawCyl(5.5, 11.2, 22, 0.12, 10, '#4a4a4a');
    drawCyl(6.6, 11.2, 22, 0.12, 10, '#4a4a4a');
  });
  shadowBoxes.push([5.0, 10.7, 2.3, 1.4, 22]);

  // дымовая труба
  addStatic(17.4, () => {
    drawBox(8.35, 8.35, 0, 0.7, 0.7, 8, '#45484c');
    drawCyl(8.7, 8.7, 8, 0.27, 60, '#5d6165');
    drawCyl(8.7, 8.7, 68, 0.27, 7, '#7d2f27');
    drawCyl(8.7, 8.7, 75, 0.26, 11, '#5d6165');
    drawCyl(8.7, 8.7, 86, 0.26, 6, '#7d2f27');
    drawCyl(8.7, 8.7, 92, 0.21, 1, '#1a1a1a');
  });
  shadowBoxes.push([8.4, 8.4, 0.6, 0.6, 92]);
  staticLights.push([8.7, 8.7, 95, 22, '255,40,30', 0.9, 0]); // мигающий огонь на трубе

  // ёмкости + трубопровод
  addStatic(19.8, () => {
    drawBox(7.8, 10.86, 12, 0.75, 0.08, 2, '#7a7f84', { edge: false });
    drawCyl(8.9, 10.9, 0, 0.42, 20, '#6a6f74');
  });
  addStatic(20.7, () => drawCyl(8.9, 11.85, 0, 0.36, 15, '#5f6469'));
  shadowBoxes.push([8.5, 10.5, 0.8, 0.8, 20], [8.55, 11.5, 0.7, 0.7, 15]);

  // склад лома у разгрузки грузовиков
  addStatic(13.6, () => drawPile(5.6, 7.95, 0.38, 9, '#5d5a55'));
  addLamp(4.85, 12.25); addLamp(9.65, 7.85);
}

function buildPort() {
  // контейнерный штабель
  const r = rng(21);
  [11.3, 11.78].forEach((y, row) => {
    [13.2, 14.05, 14.9, 15.75].forEach((x, col) => {
      const n = 1 + Math.floor(r() * 3);
      const cols = Array.from({ length: n }, () => CONT_COLORS[Math.floor(r() * CONT_COLORS.length)]);
      addStatic(x + y + 0.6 + 0.001 * row, () => cols.forEach((c, i) => drawBox(x, y, i * 7, 0.8, 0.4, 7, c)));
      shadowBoxes.push([x, y, 0.8, 0.4, 7 * n]);
    });
  });
  // пакгауз
  addStatic(28.9, () => {
    drawBox(13.2, 13.5, 0, 1.5, 1.2, 15, '#474b4f', { grad: true });
    poly([iso(13.45, 14.7, 0), iso(14.05, 14.7, 0), iso(14.05, 14.7, 9), iso(13.45, 14.7, 9)], '#1b1d1f');
    drawRoofX(13.2, 13.5, 15, 1.5, 1.2, 5, '#363b40');
  });
  shadowBoxes.push([13.2, 13.5, 1.5, 1.2, 20]);

  // причал
  addBox(16.6, 12.4, -6, 3.7, 1.1, 7, '#3b3e42', { noShadow: true, bias: -1.5 });

  // портальные краны
  [[17.2, 0], [18.85, 2.1]].forEach(([x, ph]) => {
    addStatic(x + 13.3, (t) => {
      const legs = [[x, 12.5], [x + 0.55, 12.5], [x, 13.32], [x + 0.55, 13.32]];
      legs.forEach(([lx, ly]) => drawBox(lx, ly, 1, 0.08, 0.08, 34, '#9a6f1d', { edge: false }));
      drawBox(x - 0.04, 12.45, 35, 0.67, 1.0, 4, '#a7781f');
      drawBox(x + 0.06, 12.5, 39, 0.55, 0.6, 7, '#8f6a1d');
      const ty = 14.0 + 0.9 * Math.sin(t * 0.55 + ph);
      const hz = 14 + 10 * (0.5 + 0.5 * Math.sin(t * 0.9 + ph));
      drawBox(x + 0.13, 11.9, 41, 0.42, 3.5, 3, '#b8862a');
      const c0 = iso(x + 0.34, ty + 0.11, 40), c1 = iso(x + 0.34, ty + 0.11, hz + 3);
      ctx.beginPath(); ctx.moveTo(...c0); ctx.lineTo(...c1); ctx.strokeStyle = '#222'; ctx.lineWidth = 0.9; ctx.stroke();
      drawBox(x + 0.16, ty, 39, 0.36, 0.22, 2, '#2d3033', { edge: false });
      drawBox(x + 0.18, ty - 0.02, hz, 0.32, 0.26, 3, '#c9a23a', { edge: false });
      drawBox(x + 0.16, 13.55, 33, 0.3, 0.3, 6, '#cfc9b8');
    });
    staticLights.push([x + 0.34, 15.3, 44, 14, '255,60,40', 0.8, ph]);
  });
  addLamp(13.0, 14.85, 36); addLamp(16.45, 11.15, 36);
}

function buildClient() {
  addStatic(41.3, () => {
    drawBox(22.4, 18.3, 0, 2.3, 1.7, 20, '#45484b', { grad: true });
    [22.6, 23.25, 23.9].forEach((x, i) => {
      poly([iso(x, 20.0, 0), iso(x + 0.45, 20.0, 0), iso(x + 0.45, 20.0, 9), iso(x, 20.0, 9)], i === 1 ? 'rgba(255,200,120,0.75)' : '#17191b');
    });
    for (let i = 0; i < 5; i++) {
      const x = 22.55 + i * 0.42;
      poly([iso(x, 20.0, 14), iso(x + 0.25, 20.0, 14), iso(x + 0.25, 20.0, 17), iso(x, 20.0, 17)], 'rgba(255,190,90,0.18)');
    }
    drawRoofX(22.4, 18.3, 20, 2.3, 1.7, 7, '#353a3f');
  });
  shadowBoxes.push([22.4, 18.3, 2.3, 1.7, 26]);
  staticLights.push([23.47, 20.05, 5, 30, '255,200,120', 0.4, null]);

  const r = rng(99);
  [[20.55, 0], [21.05, 0]].forEach(([y]) => {
    [21.3, 22.15, 23.0, 23.85].forEach((x) => {
      const n = 1 + Math.floor(r() * 3);
      const cols = Array.from({ length: n }, () => CONT_COLORS[Math.floor(r() * CONT_COLORS.length)]);
      addStatic(x + y + 0.6, () => cols.forEach((c, i) => drawBox(x, y, i * 7, 0.8, 0.4, 7, c)));
      shadowBoxes.push([x, y, 0.8, 0.4, 7 * n]);
    });
  });
  // причал клиента
  addBox(20.25, 20.85, -6, 0.8, 1.1, 7, '#3b3e42', { noShadow: true, bias: -1 });
  addLamp(21.2, 18.2, 32); addLamp(24.8, 21.8, 32);
}

function buildDecor() {
  const r = rng(2024);
  const blockers = DATA.routes.map((x) => x.pts);
  let placed = 0, tries = 0;
  while (placed < 26 && tries++ < 600) {
    const gx = Math.floor(r() * M.size), gy = Math.floor(r() * M.size);
    if (!inMap(gx, gy) || tileType(gx, gy) !== 'land') continue;
    const x = gx + 0.2 + r() * 0.6, y = gy + 0.2 + r() * 0.6;
    if (DATA.nodes.some((n) => inRect(x, y, n.apron, 0.8))) continue;
    if (Math.hypot(x - 4.2, y - 2.2) < 3.6 || (x > 12.6 && x < 21 && y > 10.6 && y < 22)) continue;
    if (blockers.some((p) => distToPolyline(x, y, p) < 1.0)) continue;
    const kind = r() < 0.65 ? 'tree' : 'rock';
    const s = 0.7 + r() * 0.6;
    if (kind === 'tree') {
      addStatic(x + y, () => {
        drawBox(x - 0.03, y - 0.03, 0, 0.06, 0.06, 5 * s, '#2a211a', { edge: false });
        const [px, py] = iso(x, y, 4 * s);
        ctx.beginPath(); ctx.moveTo(px - 7 * s, py); ctx.lineTo(px, py - 20 * s); ctx.lineTo(px + 7 * s, py); ctx.closePath();
        const g = ctx.createLinearGradient(px - 7 * s, 0, px + 7 * s, 0);
        g.addColorStop(0, '#2f3b33'); g.addColorStop(1, '#151c18');
        ctx.fillStyle = g; ctx.fill();
      });
      shadowBoxes.push([x - 0.1, y - 0.1, 0.2, 0.2, 18 * s]);
    } else {
      addStatic(x + y, () => drawPile(x, y, 0.18 * s, 5 * s, '#4a4d50'));
    }
    placed++;
  }
}

/* ============================ СПРАЙТЫ ============================ */
const SPR = {};
function loadSprites() {
  for (const [key, cfg] of Object.entries(DATA.sprites)) {
    if (!cfg.src) continue;
    const img = new Image();
    img.onload = () => { SPR[key] = img; };
    img.onerror = () => console.warn('Спрайт не найден, рисую кодом:', cfg.src);
    img.src = cfg.src;
  }
}
const sprReady = (key) => !!(key && SPR[key]);

// Прямоугольник здания-спрайта в пикселях мира
function spriteRect(node) {
  const cfg = DATA.sprites[node.sprite], img = SPR[node.sprite];
  const [x0, y0, x1, y1] = node.foot;
  const w = ((x1 - x0) + (y1 - y0)) * HW * (cfg.k || 1);
  const h = w * img.height / img.width;
  const cx = iso((x0 + x1) / 2, (y0 + y1) / 2)[0] + (cfg.dx || 0);
  const by = iso(x1, y1)[1] + (cfg.dy || 0);
  return { x: cx - w / 2, y: by - h, w, h };
}
function buildSpriteNodes() {
  for (const n of DATA.nodes) {
    if (!n.sprite) continue;
    const [x0, y0, x1, y1] = n.foot;
    statics.push({
      depth: (x0 + x1) / 2 + (y0 + y1) / 2, spriteOf: n.sprite,
      draw: () => { const r = spriteRect(n); ctx.drawImage(SPR[n.sprite], r.x, r.y, r.w, r.h); },
    });
  }
}

// Транспорт-спрайт: отражаем по горизонтали, если едет «не в ту сторону» экрана
function drawVehicleSprite(key, x, y, z, dx, dy, ox = 0, oy = 0, rot = 0) {
  const cfg = DATA.sprites[key], img = SPR[key];
  const [px, py] = iso(x, y, z);
  const sdx = dx - dy; // знак = движение вправо/влево по экрану
  const flip = cfg.faces === 'right' ? sdx < 0 : sdx > 0;
  const w = cfg.width, h = w * img.height / img.width;
  ctx.save();
  ctx.translate(px + ox, py + oy);
  if (rot) ctx.rotate(rot);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, -h * cfg.anchor, w, h);
  ctx.restore();
}

/* ============================ ТРАНСПОРТ ============================ */
const vehicles = [];
const buoys = [];

function buildTransport() {
  DATA.routes.forEach((r) => {
    const fwd = makeLane(offsetPolyline(r.pts, r.lane));
    const back = makeLane(offsetPolyline(r.pts, -r.lane).slice().reverse());
    const cycle = fwd.len / r.speed + r.dwell + back.len / r.speed + r.dwell;
    for (let i = 0; i < r.count; i++) vehicles.push({ r, fwd, back, cycle, offset: (i / r.count) * cycle });
  });
  const sea = DATA.routes.find((r) => r.kind === 'sea');
  const x = sea.pts[0][0];
  [[x - 0.8, 15.6, 'r'], [x + 0.8, 15.6, 'g'], [x - 0.8, 18.6, 'r'], [x + 0.8, 18.6, 'g']].forEach((b, i) => buoys.push([...b, i]));
}

function vehicleState(v, t) {
  const { r, fwd, back, cycle } = v;
  let ph = (t + v.offset) % cycle;
  const t1 = fwd.len / r.speed;
  if (ph < t1) return { lane: fwd, dist: ph * r.speed, loaded: true, moving: true };
  ph -= t1;
  if (ph < r.dwell) return { lane: fwd, dist: fwd.len, loaded: false, moving: false };
  ph -= r.dwell;
  const t2 = back.len / r.speed;
  if (ph < t2) return { lane: back, dist: ph * r.speed, loaded: false, moving: true };
  return { lane: back, dist: back.len, loaded: true, moving: false };
}

// Параллелепипед, ориентированный по направлению движения (оси сетки)
function obox(cx, cy, z, dx, dy, len, wid, h, col, o) {
  const alongX = Math.abs(dx) > Math.abs(dy);
  const w = alongX ? len : wid, d = alongX ? wid : len;
  drawBox(cx - w / 2, cy - d / 2, z, w, d, h, col, o);
}
function vShadow(cx, cy, dx, dy, len, wid, z = 0) {
  const alongX = Math.abs(dx) > Math.abs(dy);
  const w = (alongX ? len : wid) + 0.06, d = (alongX ? wid : len) + 0.06;
  const x = cx - w / 2 + 0.07, y = cy - d / 2 + 0.02;
  poly([iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)], 'rgba(0,0,0,0.35)');
}

function collectVehiclePrims(t, out, lights) {
  for (const v of vehicles) {
    const st = vehicleState(v, t);
    const p = laneAt(st.lane, st.dist);
    const { dx, dy } = p;

    const phase = v.offset * 7.3;

    // --- спрайтовые версии ---
    if (v.r.vehicle === 'truck' && sprReady('truck')) {
      const shake = st.moving ? Math.sin(t * 38 + phase) * 0.55 : 0;           // вибрация в движении
      out.push({ depth: p.x + p.y, draw: () => drawVehicleSprite('truck', p.x, p.y, 0, dx, dy, shake * 0.4, shake) });
      if (st.moving) lights.push([p.x + dx * 0.45, p.y + dy * 0.45, 4, 12, '255,225,160', 0.55]);
      continue;
    }
    if (v.r.vehicle === 'train' && (sprReady('train') || sprReady('truck'))) {
      const key = sprReady('train') ? 'train' : 'truck';                       // нет train.png → грузовик
      const shake = st.moving ? Math.sin(t * 30 + phase) * 0.45 : 0;
      out.push({ depth: p.x + p.y, draw: () => drawVehicleSprite(key, p.x, p.y, 0, dx, dy, 0, shake) });
      if (st.moving) lights.push([p.x + dx * 0.45, p.y + dy * 0.45, 6, 16, '255,225,160', 0.6]);
      continue;
    }
    if (v.r.vehicle === 'ship' && sprReady('ship')) {
      const bob = Math.sin(t * 1.6 + phase) * 1.6;                              // качка
      const roll = Math.sin(t * 1.1 + phase) * 0.025;
      out.push({
        depth: p.x + p.y, draw: () => {
          if (st.moving) {
            const w0 = iso(p.x - dx * 0.8, p.y - dy * 0.8, WATER_Z), w1 = iso(p.x - dx * 2.2, p.y - dy * 2.2, WATER_Z);
            ctx.beginPath(); ctx.moveTo(...w0); ctx.lineTo(...w1);
            ctx.strokeStyle = 'rgba(200,225,235,0.16)'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke();
          }
          drawVehicleSprite('ship', p.x, p.y, WATER_Z, dx, dy, 0, bob, roll);
        },
      });
      lights.push([p.x, p.y, 34 - bob, 10, '255,255,255', 0.5 + 0.5 * Math.sin(t * 2 + v.offset)]);
      continue;
    }

    // --- запасной вариант: геометрия (если спрайт не загрузился) ---
    if (v.r.vehicle === 'truck') {
      const tc = [p.x - dx * 0.14, p.y - dy * 0.14], cc = [p.x + dx * 0.25, p.y + dy * 0.25];
      out.push({
        depth: p.x + p.y, draw: () => {
          vShadow(p.x, p.y, dx, dy, 0.8, 0.32);
          const parts = [
            () => { obox(tc[0], tc[1], 1, dx, dy, 0.52, 0.3, 8, '#7d6420'); if (st.loaded) obox(tc[0], tc[1], 9, dx, dy, 0.44, 0.22, 3, '#4a3324', { edge: false }); },
            () => obox(cc[0], cc[1], 1, dx, dy, 0.22, 0.3, 10, '#b9b6ad'),
          ];
          if (tc[0] + tc[1] < cc[0] + cc[1]) { parts[0](); parts[1](); } else { parts[1](); parts[0](); }
        },
      });
      if (st.moving) lights.push([p.x + dx * 0.45, p.y + dy * 0.45, 4, 12, '255,225,160', 0.55]);
    }

    if (v.r.vehicle === 'train') {
      const cars = [];
      for (let k = 0; k < 4; k++) {
        const q = laneAt(st.lane, st.dist - k * 0.78);
        cars.push({ q, k });
      }
      cars.forEach(({ q, k }) => {
        out.push({
          depth: q.x + q.y, draw: () => {
            vShadow(q.x, q.y, q.dx, q.dy, 0.72, 0.32);
            if (k === 0) {
              obox(q.x, q.y, 1, q.dx, q.dy, 0.72, 0.32, 12, '#6e2a22');
              obox(q.x - q.dx * 0.12, q.y - q.dy * 0.12, 13, q.dx, q.dy, 0.3, 0.26, 3, '#3a3d40', { edge: false });
            } else {
              obox(q.x, q.y, 1, q.dx, q.dy, 0.7, 0.32, 8, '#3b3f44');
              if (st.loaded) obox(q.x, q.y, 9, q.dx, q.dy, 0.56, 0.22, 2.5, '#a8b0b6', { edge: false });
            }
          },
        });
      });
      if (st.moving) lights.push([p.x + dx * 0.45, p.y + dy * 0.45, 6, 16, '255,225,160', 0.6]);
    }

    if (v.r.vehicle === 'ship') {
      const bob = Math.sin(t * 1.6 + v.offset) * 0.8;
      const z = WATER_Z - 2 + bob;
      out.push({
        depth: p.x + p.y, draw: () => {
          if (st.moving) {
            const w0 = iso(p.x - dx * 0.7, p.y - dy * 0.7, WATER_Z), w1 = iso(p.x - dx * 1.9, p.y - dy * 1.9, WATER_Z);
            ctx.beginPath(); ctx.moveTo(...w0); ctx.lineTo(...w1);
            ctx.strokeStyle = 'rgba(200,225,235,0.18)'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
          }
          obox(p.x, p.y, z, dx, dy, 1.45, 0.46, 3, '#6b2a24', { edge: false });
          obox(p.x, p.y, z + 3, dx, dy, 1.45, 0.46, 5, '#2b3035');
          const sx = p.x - dx * 0.5, sy = p.y - dy * 0.5;
          const deck = () => {
            if (!st.loaded) return;
            [-0.18, 0.08, 0.34].forEach((o, i) => obox(p.x + dx * o, p.y + dy * o, z + 8, dx, dy, 0.24, 0.36, 6, CONT_COLORS[(i + (v.offset | 0)) % CONT_COLORS.length]));
          };
          const bridge = () => obox(sx, sy, z + 8, dx, dy, 0.3, 0.38, 13, '#c2c0b6');
          if (sx + sy < p.x + p.y) { bridge(); deck(); } else { deck(); bridge(); }
        },
      });
      lights.push([p.x - dx * 0.5, p.y - dy * 0.5, z + 22, 10, '255,255,255', 0.5 + 0.5 * Math.sin(t * 2 + v.offset)]);
    }
  }

  // бакены
  for (const [x, y, c, i] of buoys) {
    const bz = WATER_Z + Math.sin(t * 2 + i) * 1;
    out.push({ depth: x + y, draw: () => drawCyl(x, y, bz, 0.07, 7, c === 'r' ? '#9b2c22' : '#2f7a45') });
    if (Math.sin(t * 2.5 + i * 1.7) > 0.6) lights.push([x, y, bz + 8, 12, c === 'r' ? '255,60,40' : '60,255,120', 0.8]);
  }
}

/* ============================ ДЫМ ============================ */
const smoke = [];
let smokeAcc = 0;
const emitters = [
  { x: 8.7, y: 8.7, z: 93, rate: 7, size: 1 },
  { x: 5.5, y: 11.2, z: 33, rate: 1.6, size: 0.55 },
  { x: 6.6, y: 11.2, z: 33, rate: 1.6, size: 0.55 },
];
function currentEmitters() {
  const plant = DATA.nodes.find((n) => n.id === 'plant');
  if (!sprReady(plant.sprite)) return emitters.map((e) => ({ ...e, p: iso(e.x, e.y, e.z) }));
  const r = spriteRect(plant); // кончик пламени на спрайте завода
  return [{ p: [r.x + r.w * 0.74, r.y + r.h * 0.04], rate: 4, size: 0.8, vx: -7, alpha: 0.22 }];
}
function updateSmoke(dt) {
  smokeAcc += dt;
  for (const e of currentEmitters()) {
    if (Math.random() < e.rate * dt) {
      const [px, py] = e.p;
      smoke.push({ x: px + (Math.random() - 0.5) * 3, y: py, r: 3 * e.size, vr: (6 + Math.random() * 4) * e.size, vy: -(16 + Math.random() * 8), vx: (e.vx ?? 6) + Math.random() * 5, a: e.alpha ?? 0.38, life: 0, max: 5 + Math.random() * 2 });
    }
  }
  for (let i = smoke.length - 1; i >= 0; i--) {
    const p = smoke[i];
    p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.vy *= 0.995;
    if (p.life > p.max) smoke.splice(i, 1);
  }
}
function drawSmoke() {
  for (const p of smoke) {
    const k = p.life / p.max;
    const a = (k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9) * p.a;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${78 + 30 * k | 0},${80 + 30 * k | 0},${84 + 30 * k | 0},${a})`;
    ctx.fill();
  }
}

/* ============================ РЕНДЕР ============================ */
function drawGlow(px, py, r, rgb, a) {
  const g = ctx.createRadialGradient(px, py, 0, px, py, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(px - r, py - r, r * 2, r * 2);
}

const shadowPaths = {}; // по группам: null → общие
function buildShadowPath() {
  for (const box of shadowBoxes) {
    const [x, y, w, d, h] = box;
    const key = box.group || 'common';
    const sp = shadowPaths[key] || (shadowPaths[key] = new Path2D());
    const sx = h * 0.024, sy = h * 0.007;
    pathPoly(sp, [iso(x, y), iso(x + w, y), iso(x + w + sx, y + sy), iso(x + w + sx, y + d + sy), iso(x + sx, y + d + sy), iso(x, y + d)]);
  }
}

function drawGround(t) {
  const g = ground;
  const hair = 1 / cam.s;

  ctx.lineWidth = hair;
  ctx.strokeStyle = 'rgba(255,255,255,0.028)';
  ctx.stroke(g.bg);

  // плита острова
  ctx.fillStyle = '#1d1a17'; ctx.fill(g.sideLandL);
  ctx.fillStyle = '#141210'; ctx.fill(g.sideLandR);
  ctx.fillStyle = '#0b1c24'; ctx.fill(g.sideWaterL);
  ctx.fillStyle = '#081419'; ctx.fill(g.sideWaterR);

  // вода
  ['#0f2a36', '#0e2632', '#0b1f29'].forEach((c, i) => { ctx.fillStyle = c; ctx.fill(g.water[i]); });
  // волны: мерцание клеток + бегущие блики
  for (const [gx, gy, h] of waterTiles) {
    const a = Math.sin(t * 1.3 + gx * 0.7 + gy * 0.45) * 0.5 + 0.5;
    if (a > 0.55) {
      poly([iso(gx, gy, WATER_Z), iso(gx + 1, gy, WATER_Z), iso(gx + 1, gy + 1, WATER_Z), iso(gx, gy + 1, WATER_Z)], `rgba(90,150,180,${(a - 0.55) * 0.16})`);
    }
    if (h % 3 === 0) {
      const k = ((t * 0.18 + (h % 97) / 97) % 1);
      const x = gx + 0.15 + k * 0.6, y = gy + 0.3 + (h % 5) * 0.1;
      const p0 = iso(x, y, WATER_Z), p1 = iso(x + 0.22, y, WATER_Z);
      ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1);
      ctx.strokeStyle = `rgba(170,210,225,${0.22 * Math.sin(k * Math.PI)})`;
      ctx.lineWidth = 1.2; ctx.stroke();
    }
  }

  // суша
  ['#2a2d2f', '#2c2f31', '#27292b', '#2f3234'].forEach((c, i) => { ctx.fillStyle = c; ctx.fill(g.land[i]); });
  ['#382b21', '#3c2f25', '#34281e', '#403229'].forEach((c, i) => { ctx.fillStyle = c; ctx.fill(g.dirt[i]); });
  ctx.fillStyle = '#26282a'; ctx.fill(g.coastFaceL);
  ctx.fillStyle = '#1b1d1f'; ctx.fill(g.coastFaceR);
  ctx.strokeStyle = 'rgba(190,200,190,0.16)'; ctx.lineWidth = 1; ctx.stroke(g.coastLine);

  // бетонные площадки
  for (const n of DATA.nodes) {
    if (!n.apron || sprReady(n.sprite)) continue;
    const [x0, y0, x1, y1] = n.apron;
    const q = [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)];
    poly(q, '#333639');
    ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
    ctx.strokeStyle = 'rgba(214,170,60,0.28)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = hair; ctx.stroke(g.grid);

  // дорога
  ctx.fillStyle = '#2e2a26'; ctx.fill(g.roadBed);
  ctx.fillStyle = '#18191b'; ctx.fill(g.asphalt);
  ctx.strokeStyle = 'rgba(200,200,190,0.25)'; ctx.lineWidth = 1; ctx.stroke(g.roadEdges);
  ctx.setLineDash([7, 7]); ctx.strokeStyle = 'rgba(214,170,60,0.65)'; ctx.lineWidth = 1.2; ctx.stroke(g.roadCenter); ctx.setLineDash([]);

  // ж/д
  ctx.fillStyle = '#2c2925'; ctx.fill(g.ballast);
  ctx.fillStyle = '#40342a'; ctx.fill(g.sleepers);
  ctx.save(); ctx.translate(0, 0.8); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.2; ctx.stroke(g.rails); ctx.restore();
  ctx.strokeStyle = '#8d969d'; ctx.lineWidth = 1; ctx.stroke(g.rails);

  // фарватер
  ctx.setLineDash([5, 9]); ctx.strokeStyle = 'rgba(180,215,230,0.16)'; ctx.lineWidth = 1.2; ctx.stroke(g.seaLane); ctx.setLineDash([]);

  // тени зданий (тени геометрии прячем, если вместо неё спрайт)
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (const key in shadowPaths) if (key === 'common' || !sprReady(key)) ctx.fill(shadowPaths[key]);
  // мягкая тень под спрайтами зданий
  for (const n of DATA.nodes) {
    if (!sprReady(n.sprite)) continue;
    const [x0, y0, x1, y1] = n.foot;
    poly([iso(x0 + 0.2, y0 + 0.2), iso(x1 + 0.35, y0 + 0.2), iso(x1 + 0.35, y1 + 0.3), iso(x0 + 0.2, y1 + 0.3)], 'rgba(0,0,0,0.35)');
  }
}

/* ============================ ПОДПИСИ, ВЫДЕЛЕНИЕ, ВСПЛЫВАЮЩИЙ ТЕКСТ ============================ */
const labelRects = []; // экранные прямоугольники подписей — для тапа
const floaters = [];   // всплывающие «+$20,000» над узлами
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function nodeAnchor(n) { // точка над узлом (пиксели мира)
  if (sprReady(n.sprite)) { const r = spriteRect(n); return [r.x + r.w / 2, r.y + 14]; }
  return iso(...n.label);
}
function nodeSub(n) {
  switch (n.id) {
    case 'mine': return `Руда на складе: ${econ.ore}`;
    case 'plant': return econ.smelt ? `Плавка… ${Math.ceil(smeltLeft())} с` : (econ.ore > 0 ? 'Готов к плавке' : 'Нет руды');
    case 'port': return `FeNi к продаже: ${econ.feni}`;
    default: return `Принято партий: ${econ.sold}`;
  }
}
function nodeHasAction(n) {
  if (n.id === 'mine') return econ.capital >= oreCost();
  if (n.id === 'plant') return !econ.smelt && econ.ore > 0;
  if (n.id === 'port') return econ.feni > 0;
  return false;
}

function drawLabels(t) {
  setScreenTransform();
  labelRects.length = 0;
  const k = Math.max(0.85, Math.min(1.15, cam.s / cam.fit * 0.75 + 0.25));
  for (const n of DATA.nodes) {
    const [wx, wy] = nodeAnchor(n);
    const [sx, sy] = worldToScreen(wx, wy);
    const title = n.name.toUpperCase(), sub = nodeSub(n);
    ctx.save();
    ctx.translate(sx, sy); ctx.scale(k, k);
    ctx.font = `700 12px ${FONT}`; const w1 = ctx.measureText(title).width;
    ctx.font = `500 9.5px ${FONT}`; const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 24, h = 32, x = -w / 2, y = -h - 7;
    const active = selected === n.id, ready = nodeHasAction(n);
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 5) : ctx.rect(x, y, w, h);
    ctx.fillStyle = active ? 'rgba(40,30,12,0.92)' : 'rgba(16,18,20,0.86)'; ctx.fill();
    ctx.strokeStyle = active ? 'rgba(255,192,77,0.9)' : 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = ready ? '#4cd97b' : '#e8a321'; ctx.fillRect(x, y + 5, 2.5, h - 10);
    if (ready) { // мигающая точка «есть действие»
      ctx.beginPath(); ctx.arc(x + w - 8, y + 8, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(76,217,123,${0.45 + 0.55 * (Math.sin(t * 4) * 0.5 + 0.5)})`; ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(-5, -7); ctx.lineTo(5, -7); ctx.lineTo(0, -1); ctx.closePath(); ctx.fillStyle = 'rgba(16,18,20,0.86)'; ctx.fill();
    ctx.textAlign = 'left';
    ctx.font = `700 12px ${FONT}`; ctx.fillStyle = '#eef0f2'; ctx.fillText(title, x + 11, y + 14);
    ctx.font = `500 9.5px ${FONT}`; ctx.fillStyle = '#8e979e'; ctx.fillText(sub, x + 11, y + 26);
    // прогресс плавки прямо в подписи завода
    if (n.id === 'plant' && econ.smelt) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x + 11, y + h - 4, w - 22, 2);
      ctx.fillStyle = '#ff8a2b'; ctx.fillRect(x + 11, y + h - 4, (w - 22) * smeltProgress(), 2);
    }
    ctx.restore();
    labelRects.push({ id: n.id, x: sx + x * k, y: sy + y * k, w: w * k, h: (h + 7) * k });
  }
}

function drawSelection(t) {
  if (!selected) return;
  const n = DATA.nodes.find((q) => q.id === selected);
  const [x0, y0, x1, y1] = n.foot;
  const q = [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)];
  ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
  ctx.save();
  ctx.setLineDash([10, 6]); ctx.lineDashOffset = -t * 20;
  ctx.strokeStyle = `rgba(255,192,77,${0.55 + 0.35 * Math.sin(t * 4)})`; ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(255,170,40,0.8)'; ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.restore();
}

function addFloater(nodeId, text, color) {
  const n = DATA.nodes.find((q) => q.id === nodeId);
  const [wx, wy] = nodeAnchor(n);
  floaters.push({ wx, wy, text, color, t0: clock });
}
function drawFloaters() {
  setScreenTransform();
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i], age = clock - f.t0;
    if (age > 1.8) { floaters.splice(i, 1); continue; }
    const [sx, sy] = worldToScreen(f.wx, f.wy);
    ctx.font = `800 15px ${FONT}`; ctx.textAlign = 'center';
    ctx.globalAlpha = age < 1.2 ? 1 : 1 - (age - 1.2) / 0.6;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(f.text, sx, sy - 52 - age * 26);
    ctx.fillStyle = f.color; ctx.fillText(f.text, sx, sy - 52 - age * 26);
    ctx.globalAlpha = 1;
  }
}

function drawVignette() {
  setScreenTransform();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, Math.min(VW, VH) * 0.35, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
}

/* ============================ КАДР ============================ */
let last = 0, clock = 0;
function frame(ts) {
  const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
  last = ts; clock += dt;
  const t = clock;

  setScreenTransform();
  const bg = ctx.createLinearGradient(0, 0, 0, VH);
  bg.addColorStop(0, '#141618'); bg.addColorStop(1, '#08090a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, VW, VH);

  setWorldTransform();
  drawGround(t);

  // объекты: спрайт здания показывается, когда загружен; иначе — геометрия его группы
  const lights = [];
  const prims = statics.filter((p) => (p.spriteOf ? sprReady(p.spriteOf) : !(p.group && sprReady(p.group))));
  collectVehiclePrims(t, prims, lights);
  prims.sort((a, b) => a.depth - b.depth);
  for (const p of prims) p.draw(t);

  drawSelection(t);
  updateSmoke(dt);
  drawSmoke();

  ctx.globalCompositeOperation = 'lighter';
  for (const L of staticLights) {
    if (L.group && sprReady(L.group)) continue;
    const [x, y, z, r, rgb, a, blink] = L;
    const k = blink === null ? 1 : (Math.sin(t * 3 + blink) > 0.2 ? 1 : 0.15);
    const [px, py] = iso(x, y, z);
    drawGlow(px, py, r, rgb, a * k);
  }
  const fl = 0.7 + 0.3 * Math.sin(t * 9) * Math.sin(t * 3.7);
  const plant = DATA.nodes.find((n) => n.id === 'plant');
  if (sprReady(plant.sprite)) {
    // жар над градирней; во время плавки — ярче
    const r = spriteRect(plant), boost = econ.smelt ? 1 : 0.45;
    drawGlow(r.x + r.w * 0.46, r.y + r.h * 0.17, 46, '255,120,30', 0.55 * fl * boost);
    drawGlow(r.x + r.w * 0.62, r.y + r.h * 0.12, 60, '255,150,40', 0.25 * fl * boost);
  } else {
    [[5.62, 12.1], [6.62, 12.1]].forEach(([x, y]) => { const [px, py] = iso(x, y, 5); drawGlow(px, py + 4, 34, '255,120,30', 0.5 * fl); });
  }
  for (const [x, y, z, r, rgb, a] of lights) { const [px, py] = iso(x, y, z); drawGlow(px, py, r, rgb, a); }
  ctx.globalCompositeOperation = 'source-over';

  drawLabels(t);
  drawFloaters();
  drawVignette();
  requestAnimationFrame(frame);
}

/* ============================ ЖЕСТЫ: тап / pinch / pan / wheel ============================ */
const pointers = new Map();
let pinch = null;
let tap = null; // кандидат на «тап»: палец почти не двигался
const localPt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

function beginPinch() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: cam.s, wx: cam.x + (mid.x - VW / 2) / cam.s, wy: cam.y + (mid.y - VH / 2) / cam.s };
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = localPt(e);
  pointers.set(e.pointerId, p);
  tap = pointers.size === 1 ? { x: p.x, y: p.y, t: performance.now() } : null;
  if (pointers.size === 2) beginPinch();
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId), cur = localPt(e);
  pointers.set(e.pointerId, cur);
  if (tap && Math.hypot(cur.x - tap.x, cur.y - tap.y) < 8) return; // ещё тап, карту не двигаем
  tap = null;
  cam.userMoved = true;
  if (pointers.size === 1) {
    cam.x -= (cur.x - prev.x) / cam.s;
    cam.y -= (cur.y - prev.y) / cam.s;
  } else if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    cam.s = pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist;
    cam.s = Math.max(cam.fit * 0.85, Math.min(cam.fit * 4, cam.s));
    cam.x = pinch.wx - (mid.x - VW / 2) / cam.s;
    cam.y = pinch.wy - (mid.y - VH / 2) / cam.s;
  }
  clampCam();
});
const endPointer = (e) => {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId); pinch = null;
  if (pointers.size === 2) beginPinch();
  if (e.type === 'pointerup' && tap && p && pointers.size === 0 && performance.now() - tap.t < 600) handleTap(p);
  if (pointers.size === 0) tap = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = localPt(e);
  const wx = cam.x + (p.x - VW / 2) / cam.s, wy = cam.y + (p.y - VH / 2) / cam.s;
  cam.s *= Math.exp(-e.deltaY * 0.0015);
  cam.s = Math.max(cam.fit * 0.85, Math.min(cam.fit * 4, cam.s));
  cam.x = wx - (p.x - VW / 2) / cam.s; cam.y = wy - (p.y - VH / 2) / cam.s;
  cam.userMoved = true; clampCam();
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS: не зумить страницу целиком
document.getElementById('fit-btn').addEventListener('click', () => { cam.userMoved = false; fitCamera(); });

// Попадание: сначала подписи (их удобно жать пальцем), потом сами узлы
function nodeHitRect(n) {
  if (sprReady(n.sprite)) return spriteRect(n);
  const [x0, y0, x1, y1] = n.foot;
  const pts = [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys) - 50, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) + 50 };
}
function handleTap(p) {
  const lr = labelRects.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  if (lr) return openNode(lr.id);
  const wx = cam.x + (p.x - VW / 2) / cam.s, wy = cam.y + (p.y - VH / 2) / cam.s;
  const hits = DATA.nodes.filter((n) => { const r = nodeHitRect(n); return wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h; });
  if (!hits.length) return closeSheet();
  // ближе к зрителю (больше x + y) — выше по приоритету
  hits.sort((a, b) => (b.foot[0] + b.foot[1]) - (a.foot[0] + a.foot[1]));
  openNode(hits[0].id);
}

/* ============================ ЭКОНОМИКА ============================ */
const $ = (id) => document.getElementById(id);
const fmtUSD = (n) => '$ ' + Math.round(n).toLocaleString('en-US');
const E = DATA.economy;
const SAVE_KEY = 'feni-empire-save-v1';

function freshEcon() {
  return {
    capital: E.capital, ore: 0, feni: 0, sold: 0, revenue: 0,
    level: 1, xp: 0, turn: 1, price: E.nickel,
    smelt: null,          // { end: timestamp, dur: секунд }
    mods: { oreDiscount: 0, saleBonus: 0, smeltDelay: 0 }, // эффекты событий на следующую операцию
  };
}
let econ = freshEcon();
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY)); if (s && typeof s.capital === 'number') econ = { ...freshEcon(), ...s, mods: { ...freshEcon().mods, ...(s.mods || {}) } }; } catch (e) { /* без сохранений */ }
const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(econ)); } catch (e) { /* ignore */ } };

const oreCost = () => Math.round(E.oreCost * (1 - econ.mods.oreDiscount));
const salePrice = () => Math.round(E.salePrice * (1 + econ.mods.saleBonus));
const smeltDuration = () => E.smeltSeconds + econ.mods.smeltDelay;
const smeltLeft = () => (econ.smelt ? Math.max(0, (econ.smelt.end - Date.now()) / 1000) : 0);
const smeltProgress = () => (econ.smelt ? 1 - smeltLeft() / econ.smelt.dur : 0);

function addXP(v) {
  econ.xp += v;
  while (econ.xp >= 1) { econ.xp -= 1; econ.level += 1; toast(`Уровень компании повышен: ${econ.level}`); }
}

const actions = {
  buyOre() {
    const cost = oreCost();
    if (econ.capital < cost) return toast('Недостаточно капитала');
    econ.capital -= cost; econ.ore += 1; econ.mods.oreDiscount = 0;
    addFloater('mine', '+1 руда', '#e8b16a'); addFloater('mine', `−${fmtUSD(cost)}`, '#ff8a80');
    pulse('capital', 'down'); changed();
  },
  smelt() {
    if (econ.smelt) return toast('Печь уже занята');
    if (econ.ore < 1) return toast('Нужна руда: купите на руднике');
    const dur = smeltDuration();
    econ.ore -= 1; econ.smelt = { end: Date.now() + dur * 1000, dur }; econ.mods.smeltDelay = 0;
    addFloater('plant', 'Плавка запущена', '#ffb05a'); changed();
  },
  sell() {
    if (econ.feni < 1) return toast('Нет ферроникеля: запустите плавку');
    const income = salePrice();
    econ.feni -= 1; econ.capital += income; econ.sold += 1; econ.revenue += income; econ.mods.saleBonus = 0;
    addXP(E.xpPerSale);
    addFloater('port', `+${fmtUSD(income)}`, '#4cd97b');
    pulse('capital', 'up'); changed();
  },
  reset() {
    econ = freshEcon(); closeSheet(); toast('Новая игра'); changed();
  },
};

// Таймер плавки — проверяем 4 раза в секунду (переживает перезагрузку страницы)
setInterval(() => {
  if (econ.smelt && Date.now() >= econ.smelt.end) {
    econ.smelt = null; econ.feni += 1; addXP(E.xpPerSmelt);
    addFloater('plant', '+1 FeNi', '#9fd3ff'); toast('Плавка завершена: +1 ферроникель'); changed();
  } else if (econ.smelt) { renderHUD(); if (sheetNode === 'plant') renderSheet(); }
}, 250);

// Цена никеля «дышит» сама по себе
setInterval(() => {
  econ.price *= 1 + (Math.random() - 0.49) * 0.004;
  renderHUD(); if (sheetNode === 'port') renderSheet();
}, 2000);

/* ---------- случайные события на «Следующий шаг» ---------- */
const EVENTS = [
  { w: 3, title: 'Премия покупателя', text: 'Клиент готов доплатить за срочную партию: следующая продажа +15%.', apply: () => { econ.mods.saleBonus = 0.15; } },
  { w: 3, title: 'Скидка поставщика', text: 'Рудник отдаёт следующую партию руды со скидкой 20%.', apply: () => { econ.mods.oreDiscount = 0.2; } },
  { w: 2, title: 'Ремонт печи', text: 'Футеровка требует внимания: следующая плавка дольше на 5 секунд.', apply: () => { econ.mods.smeltDelay = 5; } },
  { w: 2, title: 'Таможенный сбор', text: 'Доначисление по экспортной декларации: −$7,500.', apply: () => { econ.capital -= 7500; pulse('capital', 'down'); } },
  { w: 2, title: 'Госсубсидия', text: 'Компенсация затрат на логистику: +$12,000.', apply: () => { econ.capital += 12000; pulse('capital', 'up'); } },
  { w: 3, title: 'Движение LME', text: '', apply: () => { const k = (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.04); econ.price *= 1 + k; return `Цена никеля ${k > 0 ? 'выросла' : 'снизилась'} на ${(Math.abs(k) * 100).toFixed(1)}%: ${fmtUSD(econ.price)}.`; } },
  { w: 2, title: 'Спокойная неделя', text: 'Без происшествий. Цепочка работает штатно.', apply: () => {} },
];
function nextStep() {
  econ.turn += 1;
  const total = EVENTS.reduce((a, e) => a + e.w, 0);
  let r = Math.random() * total, ev = EVENTS[0];
  for (const e of EVENTS) { if ((r -= e.w) < 0) { ev = e; break; } }
  const extra = ev.apply();
  changed();
  openEvent(ev.title, extra || ev.text);
}

/* ---------- HUD ---------- */
function renderHUD() {
  $('capital').textContent = fmtUSD(econ.capital);
  $('nickel').textContent = fmtUSD(econ.price);
  const delta = (econ.price / E.nickel - 1) * 100;
  const d = $('nickel-delta');
  d.textContent = `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)}%`;
  d.classList.toggle('down', delta < 0);
  $('level').textContent = econ.level;
  $('xp').style.width = Math.round(econ.xp * 100) + '%';
  $('turn').textContent = econ.turn;
  $('res-ore').textContent = econ.ore;
  $('res-feni').textContent = econ.feni;
  $('res-smelt').textContent = econ.smelt ? `${Math.ceil(smeltLeft())} с` : '—';
  $('res-smelt-wrap').classList.toggle('on', !!econ.smelt);
}
function pulse(id, dir) {
  const el = $(id).closest('.gauge-well');
  el.classList.remove('pulse-up', 'pulse-down'); void el.offsetWidth; el.classList.add('pulse-' + dir);
}
function changed() { save(); renderHUD(); renderSheet(); }

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- карточка узла (bottom sheet) ---------- */
let selected = null, sheetNode = null;
const NODE_KICKER = { mine: 'Добыча', plant: 'Производство', port: 'Экспорт', client: 'Покупатель' };

function openNode(id) { selected = id; sheetNode = id; renderSheet(); $('sheet').classList.add('open'); }
function openEvent(title, text) {
  selected = null; sheetNode = '__event';
  $('sheet-kicker').textContent = `Событие · ход ${econ.turn}`;
  $('sheet-title').textContent = title;
  $('sheet-body').innerHTML = `<p class="sheet-text">${text}</p>${modsHTML()}<div class="sheet-actions"><button class="btn-metal btn-sm" data-act="close">Понятно</button></div>`;
  $('sheet').classList.add('open');
}
function closeSheet() { selected = null; sheetNode = null; $('sheet').classList.remove('open'); }

const row = (k, v, cls = '') => `<div class="sheet-row ${cls}"><span>${k}</span><b>${v}</b></div>`;
function modsHTML() {
  const m = econ.mods, tags = [];
  if (m.oreDiscount) tags.push(`Руда −${m.oreDiscount * 100}%`);
  if (m.saleBonus) tags.push(`Продажа +${Math.round(m.saleBonus * 100)}%`);
  if (m.smeltDelay) tags.push(`Плавка +${m.smeltDelay} с`);
  return tags.length ? `<div class="sheet-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>` : '';
}
function renderSheet() {
  if (!sheetNode || sheetNode === '__event') return;
  const n = DATA.nodes.find((q) => q.id === sheetNode);
  $('sheet-kicker').textContent = NODE_KICKER[n.id];
  $('sheet-title').textContent = n.name;
  let html = '';
  if (n.id === 'mine') {
    const cost = oreCost();
    html = row('Руда на складе', `${econ.ore} ед.`) + row('Цена партии', fmtUSD(cost) + (econ.mods.oreDiscount ? ' <i>скидка</i>' : '')) + row('Капитал', fmtUSD(econ.capital)) +
      modsHTML() +
      `<div class="sheet-actions"><button class="btn-metal" data-act="buyOre" ${econ.capital < cost ? 'disabled' : ''}>Купить руду <small>−${fmtUSD(cost)}</small></button></div>` +
      `<p class="sheet-hint">1 ед. руды = 1 плавка на заводе</p>`;
  } else if (n.id === 'plant') {
    const busy = !!econ.smelt;
    html = row('Руда', `${econ.ore} ед.`) + row('Ферроникель', `${econ.feni} ед.`) +
      row('Статус печи', busy ? `Плавка · ${smeltLeft().toFixed(1)} с` : 'Ожидание', busy ? 'hot' : '') +
      `<div class="progress ${busy ? 'on' : ''}"><i style="width:${(smeltProgress() * 100).toFixed(1)}%"></i></div>` +
      modsHTML() +
      `<div class="sheet-actions"><button class="btn-metal" data-act="smelt" ${busy || econ.ore < 1 ? 'disabled' : ''}>${busy ? 'Печь работает…' : 'Запустить плавку'} <small>${smeltDuration()} с · −1 руда</small></button></div>` +
      `<p class="sheet-hint">${econ.ore < 1 && !busy ? 'Нет руды — купите её на руднике' : 'По окончании: +1 ед. ферроникеля'}</p>`;
  } else if (n.id === 'port') {
    const delta = (econ.price / E.nickel - 1) * 100;
    html = row('Цена никеля (LME)', `${fmtUSD(econ.price)} <i class="${delta < 0 ? 'down' : 'up'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)}%</i>`) +
      row('Ферроникель к продаже', `${econ.feni} ед.`) + row('Выручка за единицу', fmtUSD(salePrice())) +
      modsHTML() +
      `<div class="sheet-actions"><button class="btn-metal" data-act="sell" ${econ.feni < 1 ? 'disabled' : ''}>Продать <small>+${fmtUSD(salePrice())}</small></button></div>` +
      `<p class="sheet-hint">${econ.feni < 1 ? 'Нет ферроникеля — запустите плавку на заводе' : 'Партия уйдёт клиенту морем'}</p>`;
  } else {
    html = row('Принято партий', `${econ.sold}`) + row('Выручка всего', fmtUSD(econ.revenue)) + row('Ход', econ.turn) +
      `<p class="sheet-text">Покупатель принимает ферроникель через порт. Цепочка: руда → плавка → продажа.</p>` +
      `<div class="sheet-actions"><button class="btn-ghost" data-act="reset">Начать заново</button></div>`;
  }
  $('sheet-body').innerHTML = html;
}

$('sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) {
    const a = b.dataset.act;
    if (a === 'close') return closeSheet();
    if (a === 'reset' && !b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = 'Точно сбросить? Нажмите ещё раз'; return; }
    actions[a]();
    return;
  }
  if (e.target === $('sheet')) closeSheet(); // тап по затемнению
});
$('sheet-close').addEventListener('click', closeSheet);
$('next-btn').addEventListener('click', nextStep);

/* ============================ PWA ============================ */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ============================ СТАРТ ============================ */
loadSprites();
buildGround();
tagGroup('mine', buildMine);
tagGroup('factory', buildPlant);
tagGroup('port', buildPort);
buildClient();
buildDecor();
buildSpriteNodes();
buildTransport();
buildShadowPath();
renderHUD();
resize();
window.addEventListener('resize', resize);
requestAnimationFrame(frame);
