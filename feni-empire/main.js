'use strict';

/* =====================================================================
   FeNi Empire — Итерация 4: фотореалистичная «живая» стратегия
   ---------------------------------------------------------------------
   Мир = пиксели фоновой картинки map-bg.png (1344 × 768).
   Фон снят в перспективе: чем выше точка (меньше y), тем дальше она
   от камеры и тем мельче там транспорт → масштаб depthScale(y).
   Экономика тикает раз в секунду, транспорт едет плавно и сам
   возит грузы: Рудник → (грузовики) → Завод → (поезд) → Порт → (судно) → $.
   ===================================================================== */

/* ============================ ДАННЫЕ ============================ */
const DATA = {
  world: { w: 1344, h: 768, bg: 'map-bg.png' },
  perspective: { far: 0.25, near: 1.0 }, // масштаб у верхнего и у нижнего края кадра

  // Здания: base — точка, где здание стоит на земле (низ-центр картинки), w — ширина на карте
  buildings: {
    mine:  { name: 'Рудник', kicker: 'Добыча', src: 'mine.png',    base: [285, 312], w: 228, ay: 0.97 },
    plant: { name: 'Завод',  kicker: 'Плавка ферроникеля', src: 'factory.png', base: [205, 548], w: 205, ay: 0.985,
             chimneys: [[0.497, 0.244], [0.739, 0.26]] },
    port:  { name: 'Порт',   kicker: 'Экспорт морем', src: 'port.png', base: [872, 748], w: 330, ay: 0.985 },
  },

  // Транспорт: near — ширина картинки у нижнего края кадра; faces — куда смотрит нос на картинке
  vehicles: {
    truck: { src: 'truck.png', near: 118, faces: 'left', ay: 0.9 },
    train: { src: 'train.png', near: 190, faces: 'left', ay: 0.86 },
    ship:  { src: 'ship.png',  near: 215, faces: 'left', ay: 0.86 },
  },

  // Маршруты в пикселях фона (от отправителя к получателю)
  routes: {
    road: [[402, 266], [440, 248], [474, 262], [503, 293], [519, 330], [506, 373], [470, 410], [430, 440], [385, 468], [336, 500]],
    rail: [[306, 561], [400, 591], [500, 630], [600, 668], [690, 700], [748, 716]],
    sea:  [[930, 526], [850, 452], [772, 392], [710, 332], [642, 282], [588, 232], [577, 182], [608, 130], [630, 80], [628, 26]],
  },
  spurs: [ // грунтовки от дороги к зданиям (рисуются поверх фона)
    [[396, 268], [440, 248]],
    [[392, 465], [336, 500]],
  ],

  economy: {
    capital: 150000,
    nickel: 16000,          // стартовая цена никеля, $/т (LME)
    salePrice: 20000,       // выручка за 1 ед. FeNi при цене никеля $16,000
    oreCost: 1500,          // себестоимость добычи 1 ед. руды
    trucks: 2, truckSpeed: 62,                 // скорость — пикс/с у нижнего края кадра; загрузка растёт с уровнем рудника
    trainLoad: 3, trainSpeed: 85, trainWait: 5,
    shipSpeed: 74, shipWait: 8, shipAway: 3,
  },

  // Уровни зданий: эффект и цена улучшения
  upgrades: {
    mine:  { base: 40000, growth: 1.7, effect: (l) => ({ period: 5 / (1 + 0.35 * (l - 1)), cap: 8 + 4 * (l - 1), truckLoad: 2 + (l - 1) }) },
    plant: { base: 60000, growth: 1.7, effect: (l) => ({ smelt: 8 / (1 + 0.35 * (l - 1)) }) },
    port:  { base: 50000, growth: 1.7, effect: (l) => ({ shipCap: 4 + (l - 1), loadTime: 1.4 / (1 + 0.3 * (l - 1)) }) },
  },
};

const SPEED = Math.max(0.25, Math.min(10, Number(new URLSearchParams(location.search).get('speed')) || 1)); // ?speed=5 — ускорить для теста

/* ============================ ЗАГРУЗКА КАРТИНОК ============================ */
const IMG = {};
function loadImage(key, src) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => { IMG[key] = im; res(); };
    im.onerror = () => { console.warn('Не загрузилась картинка:', src); res(); };
    im.src = src;
  });
}

/* ============================ CANVAS / КАМЕРА ============================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = canvas.parentElement;
const W = DATA.world.w, H = DATA.world.h;
let VW = 0, VH = 0, DPR = 1;
const cam = { x: 600, y: H / 2, s: 1, min: 0.3, max: 3, cover: 1, start: 1, userMoved: false, target: null };
const CHAIN = [130, 1060]; // по X: от завода до порта — это должно быть видно на старте

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  VW = stage.clientWidth; VH = stage.clientHeight;
  canvas.width = Math.round(VW * DPR); canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
  cam.cover = Math.max(VW / W, VH / H);                       // карта заполняет экран
  cam.start = Math.min(cam.cover, VW / (CHAIN[1] - CHAIN[0])); // вся цепочка в кадре
  cam.min = Math.min(cam.start, Math.min(VW / W, VH / H));
  cam.max = cam.cover * 3.2;
  if (!cam.userMoved) fitCamera(); else clampCam();
}
function fitCamera() {
  cam.s = cam.start; cam.target = null;
  cam.x = (CHAIN[0] + CHAIN[1]) / 2; cam.y = H / 2;
  clampCam();
}
// Плавно подлететь к зданию (с поправкой на выезжающую снизу карточку)
function focusOn(id) {
  const r = buildingRect(id);
  const s = Math.max(cam.s, Math.min(cam.cover * 0.9, VW / (r.w * 2.1)));
  const sheetH = $('sheet').querySelector('.sheet-panel').offsetHeight || VH * 0.5;
  cam.padBottom = sheetH / s;
  // центр здания — по середине видимой над карточкой части экрана
  const visibleH = Math.max(120, VH - sheetH + 40);
  cam.target = { x: r.x + r.w / 2, y: r.y + r.h * 0.5 + (VH / 2 - visibleH / 2) / s, s };
  cam.userMoved = true;
}
function updateCamera(rdt) {
  if (!cam.target) return;
  const k = 1 - Math.exp(-rdt * 6);
  cam.x += (cam.target.x - cam.x) * k; cam.y += (cam.target.y - cam.y) * k; cam.s += (cam.target.s - cam.s) * k;
  clampCam();
  if (Math.abs(cam.target.s - cam.s) < 0.002 && Math.hypot(cam.target.x - cam.x, cam.target.y - cam.y) < 0.5) cam.target = null;
}
// Размытая подложка за краями карты (без ctx.filter — работает и в Safari)
let backdrop = null;
function buildBackdrop() {
  if (!IMG.bg) return;
  backdrop = document.createElement('canvas');
  backdrop.width = 48; backdrop.height = 28;
  backdrop.getContext('2d').drawImage(IMG.bg, 0, 0, 48, 28);
}
function clampCam() {
  cam.s = Math.max(cam.min, Math.min(cam.max, cam.s));
  const hw = VW / 2 / cam.s, hh = VH / 2 / cam.s;
  cam.x = hw * 2 >= W ? W / 2 : Math.max(hw, Math.min(W - hw, cam.x));
  const pad = cam.padBottom || 0; // пока открыта карточка, можно «опустить» карту ниже края
  cam.y = hh * 2 >= H + pad ? Math.max(H / 2, Math.min(H / 2 + pad, cam.y)) : Math.max(hh, Math.min(H - hh + pad, cam.y));
}
const toScreen = (x, y) => [(x - cam.x) * cam.s + VW / 2, (y - cam.y) * cam.s + VH / 2];
const toWorld = (sx, sy) => [cam.x + (sx - VW / 2) / cam.s, cam.y + (sy - VH / 2) / cam.s];
const setWorld = () => ctx.setTransform(DPR * cam.s, 0, 0, DPR * cam.s, DPR * (VW / 2 - cam.x * cam.s), DPR * (VH / 2 - cam.y * cam.s));
const setScreen = () => ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
const depthScale = (y) => { const p = DATA.perspective; return p.far + (p.near - p.far) * Math.max(0, Math.min(1, y / H)); };

/* ============================ ПУТИ ============================ */
function makePath(pts) {
  const segs = []; let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const l = Math.hypot(bx - ax, by - ay);
    segs.push({ ax, ay, dx: (bx - ax) / l, dy: (by - ay) / l, l, start: len });
    len += l;
  }
  return { pts, segs, len };
}
function pathAt(path, d) {
  d = Math.max(0, Math.min(path.len, d));
  let s = path.segs[0];
  for (const g of path.segs) if (d >= g.start) s = g;
  const k = d - s.start;
  return { x: s.ax + s.dx * k, y: s.ay + s.dy * k, dx: s.dx, dy: s.dy };
}
const PATH = Object.fromEntries(Object.entries(DATA.routes).map(([k, v]) => [k, makePath(v)]));

/* ============================ ЭКОНОМИКА ============================ */
const E = DATA.economy;
const SAVE_KEY = 'feni-empire-save-v4';
function freshState() {
  return {
    capital: E.capital, price: E.nickel, revenue: 0, shipped: 0,
    mine:  { lvl: 1, stock: 0, prog: 0 },
    plant: { lvl: 1, ore: 0, feni: 0, prog: 0, busy: false },
    port:  { lvl: 1, feni: 0 },
    income: [], // [время, сумма] — для «выручки в минуту»
  };
}
let S = freshState();
try {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
  if (saved && saved.mine) S = { ...freshState(), ...saved, income: [] };
} catch (e) { /* без сохранений */ }
const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...S, income: [] })); } catch (e) { /* ignore */ } };

const fx = (id) => DATA.upgrades[id].effect(S[id].lvl);
const upgradeCost = (id) => Math.round(DATA.upgrades[id].base * Math.pow(DATA.upgrades[id].growth, S[id].lvl - 1) / 1000) * 1000;
const salePrice = () => Math.round(E.salePrice * S.price / E.nickel);
const companyLevel = () => S.mine.lvl + S.plant.lvl + S.port.lvl - 2;

// Тик экономики — раз в секунду (с учётом ?speed)
let tickAcc = 0, tickFrac = 0;
function econTick() {
  // Рудник: добывает, пока есть место на складе и деньги на себестоимость
  const m = fx('mine');
  if (S.mine.stock < m.cap && S.capital >= E.oreCost) {
    S.mine.prog += 1 / m.period;
    while (S.mine.prog >= 1 && S.mine.stock < m.cap && S.capital >= E.oreCost) {
      S.mine.prog -= 1; S.mine.stock += 1; S.capital -= E.oreCost;
    }
  }
  if (S.mine.stock >= m.cap) S.mine.prog = Math.min(S.mine.prog, 0.999);

  // Завод: плавит по одной единице
  const p = fx('plant');
  if (!S.plant.busy && S.plant.ore > 0) { S.plant.ore -= 1; S.plant.busy = true; S.plant.prog = 0; }
  if (S.plant.busy) {
    S.plant.prog += 1 / p.smelt;
    if (S.plant.prog >= 1) {
      S.plant.busy = false; S.plant.prog = 0; S.plant.feni += 1;
      floater('plant', '+1 FeNi', '#bfe3ff');
    }
  }

  // Цена никеля «дышит»
  S.price *= 1 + (Math.random() - 0.495) * 0.003;
  save();
  renderHUD();
  renderSheet();
}

/* ============================ ТРАНСПОРТ (автоматы состояний) ============================ */
// Перспектива: по дальним участкам транспорт едет медленнее в пикселях
const advance = (v, path, speed, dt) => { const p = pathAt(path, v.d); v.d = Math.min(path.len, v.d + speed * depthScale(p.y) * dt); return v.d >= path.len; };
const retreat = (v, path, speed, dt) => { const p = pathAt(path, v.d); v.d = Math.max(0, v.d - speed * depthScale(p.y) * dt); return v.d <= 0; };

const trucks = Array.from({ length: E.trucks }, (_, i) => ({ id: i, st: 'wait', d: 0, load: 0, t: i * 2.5, dir: 1 }));
const train = { st: 'wait', d: 0, load: 0, t: 0, waited: 0, dir: 1 };
const ship = { st: 'dock', d: 0, load: 0, t: 0, waited: 0, dir: 1, alpha: 1 };

function updateTransport(dt) {
  // Грузовики: Рудник → Завод
  for (const v of trucks) {
    if (v.st === 'wait') {
      v.t -= dt;
      if (v.t <= 0 && S.mine.stock > 0 && !trucks.some((o) => o !== v && o.st === 'load')) {
        v.load = Math.min(fx('mine').truckLoad, S.mine.stock); S.mine.stock -= v.load; v.st = 'load'; v.t = 1.4;
      }
    } else if (v.st === 'load') {
      if ((v.t -= dt) <= 0) { v.st = 'go'; v.dir = 1; }
    } else if (v.st === 'go') {
      if (advance(v, PATH.road, E.truckSpeed, dt)) { v.st = 'unload'; v.t = 1.4; }
    } else if (v.st === 'unload') {
      if ((v.t -= dt) <= 0) {
        S.plant.ore += v.load; floater('plant', `+${v.load} руды`, '#e8b16a'); v.load = 0; v.st = 'back'; v.dir = -1; renderHUD();
      }
    } else if (v.st === 'back') {
      if (retreat(v, PATH.road, E.truckSpeed * 1.15, dt)) { v.st = 'wait'; v.t = 0.3; v.dir = 1; }
    }
  }

  // Поезд: Завод → Порт
  const tr = train;
  if (tr.st === 'wait') {
    if (S.plant.feni > 0) tr.waited += dt;
    if (S.plant.feni >= E.trainLoad || (S.plant.feni > 0 && tr.waited >= E.trainWait)) {
      tr.load = Math.min(E.trainLoad, S.plant.feni); S.plant.feni -= tr.load; tr.st = 'load'; tr.t = 1.6; tr.waited = 0;
    }
  } else if (tr.st === 'load') {
    if ((tr.t -= dt) <= 0) { tr.st = 'go'; tr.dir = 1; }
  } else if (tr.st === 'go') {
    if (advance(tr, PATH.rail, E.trainSpeed, dt)) { tr.st = 'unload'; tr.t = 1.6; }
  } else if (tr.st === 'unload') {
    if ((tr.t -= dt) <= 0) { S.port.feni += tr.load; floater('port', `+${tr.load} FeNi на склад`, '#bfe3ff'); tr.load = 0; tr.st = 'back'; tr.dir = -1; renderHUD(); }
  } else if (tr.st === 'back') {
    if (retreat(tr, PATH.rail, E.trainSpeed * 1.2, dt)) { tr.st = 'wait'; tr.dir = 1; }
  }

  // Судно: грузится у причала → уходит вверх по реке (продажа) → возвращается
  const sh = ship, pf = fx('port');
  if (sh.st === 'dock') {
    if (sh.load > 0) sh.waited += dt;
    sh.t -= dt;
    if (sh.t <= 0 && S.port.feni > 0 && sh.load < pf.shipCap) { S.port.feni -= 1; sh.load += 1; sh.t = pf.loadTime; renderHUD(); }
    if (sh.load >= pf.shipCap || (sh.load > 0 && sh.waited >= E.shipWait && S.port.feni === 0)) {
      const income = sh.load * salePrice();
      S.capital += income; S.revenue += income; S.shipped += sh.load; S.income.push([performance.now(), income]);
      floater('port', `+${fmtUSD(income)}`, '#4cd97b', true);
      pulse('hud-capital'); toast(`Судно ушло: ${sh.load} ед. FeNi → ${fmtUSD(income)}`);
      sh.st = 'away'; sh.dir = 1; sh.waited = 0; renderHUD();
    }
  } else if (sh.st === 'away') {
    const done = advance(sh, PATH.sea, E.shipSpeed, dt);
    sh.alpha = Math.min(1, Math.max(0, (PATH.sea.len - sh.d) / 90));
    if (done) { sh.st = 'gone'; sh.t = E.shipAway; sh.load = 0; }
  } else if (sh.st === 'gone') {
    if ((sh.t -= dt) <= 0) { sh.st = 'return'; sh.dir = -1; }
  } else if (sh.st === 'return') {
    sh.alpha = Math.min(1, Math.max(0, (PATH.sea.len - sh.d) / 90));
    if (retreat(sh, PATH.sea, E.shipSpeed * 1.3, dt)) { sh.st = 'dock'; sh.dir = 1; sh.alpha = 1; sh.t = 0.5; }
  }
}

/* ============================ ОТРИСОВКА ============================ */
function buildingRect(id) {
  const b = DATA.buildings[id], im = IMG[id];
  const w = b.w, h = im ? w * im.height / im.width : w * 0.9;
  return { x: b.base[0] - w / 2, y: b.base[1] - h * b.ay, w, h };
}

function drawShadow(x, y, rx, ry, a = 0.35) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBuilding(id) {
  const im = IMG[id]; if (!im) return;
  const r = buildingRect(id), b = DATA.buildings[id];
  drawShadow(b.base[0], b.base[1] - r.h * 0.12, r.w * 0.55, r.w * 0.2, 0.4);
  ctx.drawImage(im, r.x, r.y, r.w, r.h);
}

function drawVehicle(key, x, y, dirX, opt = {}) {
  const im = IMG[key]; if (!im) return;
  const c = DATA.vehicles[key], s = depthScale(y);
  const w = c.near * s, h = w * im.height / im.width;
  const flip = c.faces === 'left' ? dirX > 0 : dirX < 0;
  ctx.save();
  ctx.globalAlpha = opt.alpha ?? 1;
  drawShadow(x + 4 * s, y - 2 * s, w * 0.42, w * 0.13, 0.45);
  ctx.translate(x + (opt.ox || 0), y + (opt.oy || 0));
  if (opt.rot) ctx.rotate(opt.rot);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(im, -w / 2, -h * c.ay, w, h);
  ctx.restore();
}

// Рельсы и грунтовки рисуем один раз в отдельный слой поверх фона
let trackLayer = null;
function buildTrackLayer() {
  const k = 2; // запас разрешения
  trackLayer = document.createElement('canvas');
  trackLayer.width = W * k; trackLayer.height = H * k;
  const g = trackLayer.getContext('2d');
  g.scale(k, k); g.lineCap = 'round'; g.lineJoin = 'round';

  // грунтовки
  for (const sp of DATA.spurs) {
    for (let i = 0; i < sp.length - 1; i++) {
      const [ax, ay] = sp[i], [bx, by] = sp[i + 1], s = depthScale((ay + by) / 2);
      [[40, 0.12], [30, 0.16], [20, 0.2]].forEach(([wd, a]) => {
        g.strokeStyle = `rgba(150,136,112,${a})`; g.lineWidth = wd * s; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      });
      g.setLineDash([2 * s, 5 * s]); g.strokeStyle = 'rgba(60,52,42,0.35)'; g.lineWidth = 2 * s;
      [-6, 6].forEach((o) => { g.beginPath(); g.moveTo(ax, ay + o * s); g.lineTo(bx, by + o * s); g.stroke(); });
      g.setLineDash([]);
    }
  }

  // ж/д: насыпь → шпалы → рельсы (ширина зависит от глубины)
  const path = PATH.rail;
  const step = 3;
  const sample = [];
  for (let d = 0; d <= path.len; d += step) sample.push(pathAt(path, d));
  const strokeOffset = (off, width, color) => {
    g.strokeStyle = color; g.lineWidth = width;
    g.beginPath();
    sample.forEach((p, i) => {
      const s = depthScale(p.y), nx = -p.dy, ny = p.dx;
      const x = p.x + nx * off * s, y = p.y + ny * off * s * 0.6;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
  };
  // насыпь
  for (let i = 0; i < sample.length - 1; i++) {
    const p = sample[i], q = sample[i + 1], s = depthScale(p.y);
    g.strokeStyle = 'rgba(46,42,38,0.85)'; g.lineWidth = 34 * s;
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }
  // шпалы
  for (let d = 2; d < path.len; d += 9) {
    const p = pathAt(path, d), s = depthScale(p.y), nx = -p.dy, ny = p.dx * 0.6;
    g.strokeStyle = 'rgba(78,60,44,0.95)'; g.lineWidth = 3.4 * s;
    g.beginPath(); g.moveTo(p.x + nx * 14 * s, p.y + ny * 14 * s); g.lineTo(p.x - nx * 14 * s, p.y - ny * 14 * s); g.stroke();
  }
  strokeOffset(-8, 2.4, 'rgba(20,20,20,0.6)');
  strokeOffset(8, 2.4, 'rgba(20,20,20,0.6)');
  strokeOffset(-8, 1.4, 'rgba(170,176,182,0.95)');
  strokeOffset(8, 1.4, 'rgba(170,176,182,0.95)');
}

// Дым из труб завода
const smoke = [];
function updateSmoke(dt) {
  const r = buildingRect('plant'), b = DATA.buildings.plant;
  const rate = S.plant.busy ? 5 : 1.6;
  for (const [fx_, fy_] of b.chimneys) {
    if (Math.random() < rate * dt) {
      smoke.push({ x: r.x + r.w * fx_ + (Math.random() - 0.5) * 3, y: r.y + r.h * fy_ - 14, r: 4, vr: 3 + Math.random() * 2.5, vx: 4 + Math.random() * 4, vy: -(10 + Math.random() * 6), life: 0, max: 4 + Math.random() * 2 });
    }
  }
  for (let i = smoke.length - 1; i >= 0; i--) {
    const p = smoke[i];
    p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
    if (p.life > p.max) smoke.splice(i, 1);
  }
}
function drawSmoke() {
  for (const p of smoke) {
    const k = p.life / p.max, a = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * 0.26;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(214,216,220,${a})`; ctx.fill();
  }
}

function drawGlow(x, y, r, rgb, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/* ---------- подписи и всплывающие цифры ---------- */
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const labelRects = [];
const floaters = [];
let selected = null;

function labelText(id) {
  if (id === 'mine') return `Руда ${S.mine.stock}/${fx('mine').cap}`;
  if (id === 'plant') return S.plant.busy ? `Плавка ${Math.round(plantProgress() * 100)}%` : (S.plant.ore ? 'Загрузка печи' : 'Ждёт руду');
  return `Склад FeNi ${S.port.feni}`;
}
const plantProgress = () => (S.plant.busy ? Math.min(1, S.plant.prog + tickFrac / fx('plant').smelt) : 0);
const canUpgrade = (id) => S.capital >= upgradeCost(id);

function drawLabels(t) {
  setScreen();
  labelRects.length = 0;
  for (const id of Object.keys(DATA.buildings)) {
    const r = buildingRect(id);
    const [sx, sy] = toScreen(r.x + r.w / 2, r.y + r.h * 0.08);
    const k = Math.max(0.8, Math.min(1.1, cam.s / cam.cover * 0.6 + 0.4));
    const title = `${DATA.buildings[id].name.toUpperCase()} · УР. ${S[id].lvl}`, sub = labelText(id);
    ctx.save(); ctx.translate(sx, sy); ctx.scale(k, k);
    ctx.font = `800 11.5px ${FONT}`; const w1 = ctx.measureText(title).width;
    ctx.font = `600 10px ${FONT}`; const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 26, h = 34, x = -w / 2, y = -h - 8;
    const act = selected === id;
    const minX = (w / 2) * k + 6, maxX = VW - (w / 2) * k - 6;
    const shift = Math.max(minX, Math.min(maxX, sx)) - sx; // сдвиг пилюли внутрь экрана
    ctx.translate(shift / k, 0);
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 6) : ctx.rect(x, y, w, h);
    const bg = ctx.createLinearGradient(0, y, 0, y + h);
    bg.addColorStop(0, act ? 'rgba(70,52,18,0.95)' : 'rgba(42,45,49,0.92)'); bg.addColorStop(1, act ? 'rgba(36,26,8,0.95)' : 'rgba(18,20,22,0.92)');
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = act ? 'rgba(255,192,77,0.95)' : 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = canUpgrade(id) ? '#4cd97b' : '#e8a321'; ctx.fillRect(x, y + 6, 3, h - 12);
    ctx.beginPath(); ctx.moveTo(-5 - shift / k, -8); ctx.lineTo(5 - shift / k, -8); ctx.lineTo(-shift / k, -2); ctx.closePath(); ctx.fillStyle = 'rgba(18,20,22,0.92)'; ctx.fill();
    ctx.textAlign = 'left';
    ctx.font = `800 11.5px ${FONT}`; ctx.fillStyle = '#f1f2f3'; ctx.fillText(title, x + 12, y + 15);
    ctx.font = `600 10px ${FONT}`; ctx.fillStyle = '#9aa3aa'; ctx.fillText(sub, x + 12, y + 28);
    if (id === 'plant' && S.plant.busy) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x + 12, y + h - 4, w - 24, 2);
      ctx.fillStyle = '#ff8a2b'; ctx.fillRect(x + 12, y + h - 4, (w - 24) * plantProgress(), 2);
    }
    ctx.restore();
    labelRects.push({ id, x: sx + shift + x * k, y: sy + y * k, w: w * k, h: (h + 8) * k });
  }
}

function floater(id, text, color, big = false) {
  const r = buildingRect(id);
  floaters.push({ x: r.x + r.w / 2, y: r.y + r.h * 0.08, text, color, big, t0: clock });
}
function drawFloaters() {
  setScreen();
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i], age = clock - f.t0;
    if (age > 2) { floaters.splice(i, 1); continue; }
    const [sx, sy] = toScreen(f.x, f.y);
    ctx.font = `800 ${f.big ? 18 : 13}px ${FONT}`; ctx.textAlign = 'center';
    ctx.globalAlpha = age < 1.4 ? 1 : 1 - (age - 1.4) / 0.6;
    const yy = sy - 58 - age * 22;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(f.text, sx, yy);
    ctx.fillStyle = f.color; ctx.fillText(f.text, sx, yy);
    ctx.globalAlpha = 1;
  }
}

/* ---------- кадр ---------- */
let last = 0, clock = 0;
function frame(ts) {
  const rdt = Math.min(0.05, (ts - last) / 1000 || 0.016);
  last = ts;
  const dt = rdt * SPEED;
  clock += rdt;

  tickAcc += dt;
  while (tickAcc >= 1) { tickAcc -= 1; econTick(); }
  tickFrac = tickAcc;

  updateTransport(dt);
  updateSmoke(rdt);

  updateCamera(rdt);
  setScreen();
  ctx.fillStyle = '#0b0c0d'; ctx.fillRect(0, 0, VW, VH);
  if (backdrop) {
    const k = Math.max(VW / 48, VH / 28);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(backdrop, (VW - 48 * k) / 2, (VH - 28 * k) / 2, 48 * k, 28 * k);
    ctx.fillStyle = 'rgba(8,9,10,0.55)'; ctx.fillRect(0, 0, VW, VH);
  }
  setWorld();
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 30; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.restore();
  if (IMG.bg) ctx.drawImage(IMG.bg, 0, 0, W, H);
  if (trackLayer) ctx.drawImage(trackLayer, 0, 0, W, H);

  // объекты, отсортированные по глубине (низ картинки = ближе)
  const items = [];
  for (const id of Object.keys(DATA.buildings)) items.push({ y: DATA.buildings[id].base[1], draw: () => drawBuilding(id) });
  for (const v of trucks) {
    if (v.st === 'wait' && v.d === 0 && v.id > 0 && trucks[0].st === 'wait' && trucks[0].d === 0) continue; // стоят «внутри» рудника
    const p = pathAt(PATH.road, v.d), s = depthScale(p.y);
    const lane = (v.dir > 0 ? 7 : -7) * s;
    const x = p.x - p.dy * lane, y = p.y + p.dx * lane * 0.5;
    const moving = v.st === 'go' || v.st === 'back';
    const shake = moving ? Math.sin(clock * 42 + v.id * 3) * 0.6 * s : 0;
    items.push({ y, draw: () => drawVehicle('truck', x, y, p.dx * v.dir, { oy: shake, ox: shake * 0.3 }) });
    if (moving) lightsQ.push([x + p.dx * v.dir * 30 * s, y + p.dy * v.dir * 30 * s - 10 * s, 18 * s, '255,214,150', 0.45]);
  }
  {
    const p = pathAt(PATH.rail, train.d), s = depthScale(p.y);
    const moving = train.st === 'go' || train.st === 'back';
    const shake = moving ? Math.sin(clock * 30) * 0.5 * s : 0;
    items.push({ y: p.y, draw: () => drawVehicle('train', p.x, p.y, p.dx * train.dir, { oy: shake }) });
    if (moving) lightsQ.push([p.x + p.dx * train.dir * 70 * s, p.y + p.dy * train.dir * 70 * s - 30 * s, 26 * s, '255,214,150', 0.5]);
  }
  if (ship.st !== 'gone') {
    const p = pathAt(PATH.sea, ship.d), s = depthScale(p.y);
    const bob = Math.sin(clock * 1.5) * 1.6 * s, roll = Math.sin(clock * 1.1) * 0.02;
    items.push({
      y: p.y, draw: () => {
        if (ship.st === 'away' || ship.st === 'return') { // кильватерный след
          ctx.save(); ctx.globalAlpha = 0.25 * ship.alpha;
          ctx.strokeStyle = 'rgba(220,235,240,1)'; ctx.lineWidth = 6 * s; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.dx * ship.dir * 70 * s, p.y - p.dy * ship.dir * 70 * s); ctx.stroke();
          ctx.restore();
        }
        drawVehicle('ship', p.x, p.y, p.dx * ship.dir, { oy: bob, rot: roll, alpha: ship.alpha });
      },
    });
  }
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();

  drawSmoke();
  drawSelection();

  // свет
  ctx.globalCompositeOperation = 'lighter';
  const pr = buildingRect('plant');
  const fl = 0.7 + 0.3 * Math.sin(clock * 9) * Math.sin(clock * 3.3);
  drawGlow(pr.x + pr.w * 0.5, pr.y + pr.h * 0.82, pr.w * 0.45, '255,120,40', (S.plant.busy ? 0.32 : 0.1) * fl);
  for (const [x, y, r, rgb, a] of lightsQ) drawGlow(x, y, r, rgb, a);
  lightsQ.length = 0;
  ctx.globalCompositeOperation = 'source-over';

  // атмосфера: дымка вдали + виньетка
  setScreen();
  const [, hy] = toScreen(0, 0), [, hy2] = toScreen(0, H * 0.35);
  const haze = ctx.createLinearGradient(0, hy, 0, hy2);
  haze.addColorStop(0, 'rgba(120,135,150,0.28)'); haze.addColorStop(1, 'rgba(120,135,150,0)');
  ctx.fillStyle = haze; ctx.fillRect(0, hy, VW, hy2 - hy);
  const vg = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, VW, VH);

  drawLabels(clock);
  drawFloaters();
  if (cardId === 'plant') { // плавная полоса плавки в карточке
    const bar = document.querySelector('.card-progress i'), txt = document.querySelector('.card-progress span');
    if (bar && S.plant.busy) { bar.style.width = (plantProgress() * 100).toFixed(1) + '%'; txt.textContent = `Плавка ${Math.round(plantProgress() * 100)}%`; }
  }
  requestAnimationFrame(frame);
}
const lightsQ = [];

function drawSelection() {
  if (!selected) return;
  const r = buildingRect(selected), b = DATA.buildings[selected];
  ctx.save();
  ctx.translate(b.base[0], b.base[1] - r.h * 0.1); ctx.scale(1, 0.38);
  ctx.beginPath(); ctx.arc(0, 0, r.w * 0.56, 0, Math.PI * 2);
  ctx.setLineDash([12, 8]); ctx.lineDashOffset = -clock * 24;
  ctx.strokeStyle = `rgba(255,192,77,${0.6 + 0.3 * Math.sin(clock * 4)})`; ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(255,170,40,0.9)'; ctx.shadowBlur = 12; ctx.stroke();
  ctx.restore();
}

/* ============================ ЖЕСТЫ ============================ */
const pointers = new Map();
let pinch = null, tap = null;
const localPt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
function beginPinch() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const [wx, wy] = toWorld(mid.x, mid.y);
  pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: cam.s, wx, wy };
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = localPt(e); pointers.set(e.pointerId, p);
  tap = pointers.size === 1 ? { ...p, t: performance.now() } : null;
  if (pointers.size === 2) beginPinch();
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId), cur = localPt(e);
  pointers.set(e.pointerId, cur);
  if (tap && Math.hypot(cur.x - tap.x, cur.y - tap.y) < 8) return;
  tap = null; cam.userMoved = true; cam.target = null;
  if (pointers.size === 1) { cam.x -= (cur.x - prev.x) / cam.s; cam.y -= (cur.y - prev.y) / cam.s; }
  else if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    cam.s = Math.max(cam.min, Math.min(cam.max, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
    cam.x = pinch.wx - (mid.x - VW / 2) / cam.s; cam.y = pinch.wy - (mid.y - VH / 2) / cam.s;
  }
  clampCam();
});
const endPointer = (e) => {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId); pinch = null;
  if (pointers.size === 2) beginPinch();
  if (e.type === 'pointerup' && tap && p && pointers.size === 0 && performance.now() - tap.t < 600) handleTap(p);
  if (!pointers.size) tap = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = localPt(e), [wx, wy] = toWorld(p.x, p.y);
  cam.s = Math.max(cam.min, Math.min(cam.max, cam.s * Math.exp(-e.deltaY * 0.0015)));
  cam.x = wx - (p.x - VW / 2) / cam.s; cam.y = wy - (p.y - VH / 2) / cam.s;
  cam.userMoved = true; cam.target = null; clampCam();
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
$('fit-btn').addEventListener('click', () => { cam.userMoved = false; fitCamera(); });

function handleTap(p) {
  const lr = labelRects.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  if (lr) return openCard(lr.id);
  const [wx, wy] = toWorld(p.x, p.y);
  const hits = Object.keys(DATA.buildings).filter((id) => { const r = buildingRect(id); return wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h; });
  if (!hits.length) return closeCard();
  hits.sort((a, b) => DATA.buildings[b].base[1] - DATA.buildings[a].base[1]);
  openCard(hits[0]);
}

/* ============================ HUD И КАРТОЧКИ ============================ */
function $(id) { return document.getElementById(id); }
const fmtUSD = (n) => '$ ' + Math.round(n).toLocaleString('en-US');

function incomePerMin() {
  const now = performance.now();
  S.income = S.income.filter(([t]) => now - t < 60000 / SPEED * 1);
  return S.income.reduce((a, [, v]) => a + v, 0) * 1;
}
function renderHUD() {
  $('hud-capital').textContent = fmtUSD(S.capital);
  $('hud-ore').textContent = S.mine.stock + S.plant.ore + trucks.reduce((a, v) => a + v.load, 0);
  $('hud-feni').textContent = S.plant.feni + train.load + S.port.feni + ship.load;
  $('hud-level').textContent = companyLevel();
  const delta = (S.price / E.nickel - 1) * 100;
  $('bar-price').textContent = fmtUSD(S.price);
  const d = $('bar-delta'); d.textContent = `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)}%`; d.classList.toggle('down', delta < 0);
  $('bar-income').textContent = fmtUSD(incomePerMin());
  $('bar-ship').textContent = { dock: ship.load ? `Погрузка ${ship.load}/${fx('port').shipCap}` : 'У причала', away: 'В рейсе', gone: 'В рейсе', return: 'Возвращается' }[ship.st];
}
function pulse(id) { const el = $(id).closest('.hud-btn'); el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }

let toastTimer;
function toast(text) {
  const el = $('toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

let cardId = null;
const row = (k, v, cls = '') => `<div class="card-row ${cls}"><span>${k}</span><b>${v}</b></div>`;
function openCard(id) { selected = id; cardId = id; renderSheet(); $('sheet').classList.add('open'); focusOn(id); }
function closeCard() { selected = null; cardId = null; $('sheet').classList.remove('open'); cam.padBottom = 0; clampCam(); }

function renderSheet() {
  if (!cardId) return;
  const id = cardId, b = DATA.buildings[id], lvl = S[id].lvl, cost = upgradeCost(id);
  const cur = fx(id), next = DATA.upgrades[id].effect(lvl + 1);
  $('card-img').src = b.src;
  $('card-kicker').textContent = b.kicker;
  $('card-title').textContent = b.name;
  $('card-level').textContent = `Ур. ${lvl}`;
  let html = '', gain = '';
  if (id === 'mine') {
    html = row('Руда на складе', `${S.mine.stock} / ${cur.cap}`) +
      row('Добыча', `1 ед. за ${cur.period.toFixed(1)} с`) +
      row('Загрузка самосвала', `${cur.truckLoad} ед.`) + row('Себестоимость', `${fmtUSD(E.oreCost)} / ед.`) +
      row('Статус', S.mine.stock >= cur.cap ? 'Склад полон' : (S.capital < E.oreCost ? 'Нет средств' : 'Добыча идёт'), S.mine.stock >= cur.cap ? 'warn' : '');
    gain = `Добыча ${cur.period.toFixed(1)} → ${next.period.toFixed(1)} с · самосвал ${cur.truckLoad} → ${next.truckLoad} ед.`;
  } else if (id === 'plant') {
    html = row('Руда у печи', `${S.plant.ore} ед.`) + row('Готовый FeNi', `${S.plant.feni} ед.`) +
      row('Плавка', `${cur.smelt.toFixed(1)} с / ед.`) +
      `<div class="card-progress ${S.plant.busy ? 'on' : ''}"><i style="width:${(plantProgress() * 100).toFixed(0)}%"></i><span>${S.plant.busy ? `Плавка ${Math.round(plantProgress() * 100)}%` : (S.plant.ore ? 'Загрузка печи' : 'Ждём руду')}</span></div>`;
    gain = `Плавка ${cur.smelt.toFixed(1)} → ${next.smelt.toFixed(1)} с`;
  } else {
    html = row('Цена никеля (LME)', fmtUSD(S.price)) + row('Выручка за ед.', fmtUSD(salePrice())) +
      row('Склад FeNi', `${S.port.feni} ед.`) +
      row('Судно', `${ship.st === 'dock' ? `у причала · ${ship.load}/${cur.shipCap}` : 'в рейсе'}`) +
      row('Отгружено всего', `${S.shipped} ед. · ${fmtUSD(S.revenue)}`);
    gain = `Вместимость судна ${cur.shipCap} → ${next.shipCap} · погрузка быстрее`;
  }
  html += `<button class="btn-3d" data-act="upgrade" ${S.capital < cost ? 'disabled' : ''}>
      <span class="btn-3d-title">Улучшить здание</span><span class="btn-3d-sub">${fmtUSD(cost)} · ${gain}</span></button>`;
  if (S.capital < cost) html += `<p class="card-hint">Не хватает ${fmtUSD(cost - S.capital)}</p>`;
  $('card-body').innerHTML = html;
}

$('sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled && b.dataset.act === 'upgrade') {
    const cost = upgradeCost(cardId);
    if (S.capital < cost) return;
    S.capital -= cost; S[cardId].lvl += 1;
    floater(cardId, `Уровень ${S[cardId].lvl}!`, '#ffc04d', true); pulse('hud-capital');
    toast(`${DATA.buildings[cardId].name}: уровень ${S[cardId].lvl}`);
    save(); renderHUD(); renderSheet();
    return;
  }
  if (e.target === $('sheet')) closeCard();
});
$('card-close').addEventListener('click', closeCard);
document.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openCard(el.dataset.open)));
$('btn-reset').addEventListener('click', (e) => {
  const b = e.currentTarget;
  if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = 'Точно? Ещё раз'; setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Новая игра'; }, 3000); return; }
  S = freshState(); save(); closeCard(); renderHUD(); toast('Новая игра'); delete b.dataset.confirm; b.textContent = 'Новая игра';
});

/* ============================ PWA ============================ */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ============================ СТАРТ ============================ */
(async function start() {
  resize();
  window.addEventListener('resize', resize);
  renderHUD();
  await Promise.all([
    loadImage('bg', DATA.world.bg),
    ...Object.entries(DATA.buildings).map(([id, b]) => loadImage(id, b.src)),
    ...Object.entries(DATA.vehicles).map(([id, v]) => loadImage(id, v.src)),
  ]);
  buildTrackLayer();
  buildBackdrop();
  document.body.classList.add('ready');
  requestAnimationFrame(frame);
})();
