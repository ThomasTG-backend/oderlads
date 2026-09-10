// The version lives in exactly one place: the ?v= on this file's own tag in
// index.html. Reading it back off our own URL and passing it down means
// bumping that single number busts the cache for every module in the graph,
// which matters because there is no build step to do it for us.
const V = new URL(import.meta.url).search;
const VERSION = new URLSearchParams(V).get('v') || 'dev';

const {
  W, H, PLAYER_W, PLAYER_H, TUNE, COMBAT, WEAPONS, PICKUP, DASH, ARROW,
  createState, regenerate, generateMap, addPlayer, removePlayer, step,
  snapshot, swingBox, isSwingActive, EMPTY_INPUT,
} = await import('./sim.js' + V);

const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');

const PREFIX = 'oderlads-exp-';
const TICK_MS = 1000 / 60;
const SEND_EVERY = 2;          // broadcast every 2nd tick => 30Hz
const INTERP_MS = 100;         // guests render this far in the past

// The canvas is a window onto a larger world. Nothing about this affects what
// gets sent over the wire — every client still receives every player.
const VIEW_W = 960, VIEW_H = 540;
const CAM_EASE = 0.18;         // 1 = snap to the player, lower = lazier follow
const cam = { x: 0, y: 0, ready: false };

const COLORS = ['#6ee7a8','#f0b95c','#7fb6f0','#f07a7a','#c79bf0','#6ee0e7'];

let mode = 'solo';
let peer = null, conns = [];
let myId = 'p' + Math.random().toString(36).slice(2, 6);

// --- name ------------------------------------------------------------------

// Storage can throw outright in a private window or with site data blocked,
// so every access is guarded and the game works fine without it.
function stored(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not important */ }
}

// Drop control characters, keep everything else — spaces, punctuation and
// emoji are all fine in a name.
function cleanName(raw) {
  return [...raw].filter(c => c.codePointAt(0) >= 32).join("").trim().slice(0, 12);
}

const savedName = cleanName(stored('oderlads-name', ''));
let myName = savedName || myId;

const newSeed = () => Math.floor(Math.random() * 1e9);

let state = createState(newSeed());
addPlayer(state, myId, myName, COLORS[0]);

// Guests never receive geometry — only the seed — and rebuild the map locally.
let viewPlatforms = state.platforms;

const inputs = {};
let keyInput = { ...EMPTY_INPUT };
const touchInput = { ...EMPTY_INPUT };
const buffer = [];

// --- input -----------------------------------------------------------------

// Space jumps. Up and down aim the swing rather than moving you, so an
// attack goes wherever you are holding — and your facing direction otherwise.
const KEYS = {
  ArrowLeft:'left',  KeyA:'left',
  ArrowRight:'right', KeyD:'right',
  ArrowUp:'up',      KeyW:'up',
  ArrowDown:'down',  KeyS:'down',
  Space:'jump',
  KeyJ:'attack', KeyF:'attack', Slash:'attack',
  ShiftLeft:'dash', ShiftRight:'dash', KeyK:'dash',
};

// Swallowed whether or not they do anything yet, so the page never scrolls
// out from under the game. ArrowDown is in here deliberately: it has no action
// bound to it, but it still must not scroll.
const SWALLOW = new Set([
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space',
  'KeyW','KeyA','KeyS','KeyD','KeyJ','KeyF','KeyK','Slash',
  'ShiftLeft','ShiftRight',
]);

addEventListener('keydown', e => {
  if (SWALLOW.has(e.code)) e.preventDefault();
  const k = KEYS[e.code];
  if (k) keyInput[k] = true;
});
addEventListener('keyup', e => {
  if (SWALLOW.has(e.code)) e.preventDefault();
  const k = KEYS[e.code];
  if (k) keyInput[k] = false;
});
addEventListener('blur', () => { keyInput = { ...EMPTY_INPUT }; });

// --- touch -----------------------------------------------------------------

const TOUCH = new URLSearchParams(location.search).has('touch') ||
              matchMedia('(pointer: coarse)').matches;

if (TOUCH) {
  document.body.classList.add('touch');
  $('touch').classList.remove('hide');
}

// Rebuilt from the full set of live touches on every event. Doing it this way
// rather than tracking press/release per button is what makes holding left
// while tapping attack work, and what handles a finger sliding off a button.
const PAD_DEADZONE = 16;

// Eight sectors around the pad centre. Sectors rather than independent x/y
// thresholds, so pushing straight left gives *only* left — with thresholds, a
// slightly high thumb would also aim upward and change where your attack goes.
const PAD_SECTORS = [
  ['right'], ['right','down'], ['down'], ['left','down'],
  ['left'],  ['left','up'],    ['up'],   ['right','up'],
];

function padDirections(t) {
  const r = $('tpad').getBoundingClientRect();
  const dx = t.clientX - (r.left + r.width / 2);
  const dy = t.clientY - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < PAD_DEADZONE) return [];
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return PAD_SECTORS[((sector % 8) + 8) % 8];
}

function inRect(t, r) {
  return t.clientX >= r.left && t.clientX <= r.right &&
         t.clientY >= r.top  && t.clientY <= r.bottom;
}

// Rebuilt from the full set of live touches on every event. Doing it this way
// rather than tracking press/release per button is what makes holding left
// while tapping attack work, and what handles a finger sliding off a button.
function applyTouches(e) {
  e.preventDefault();

  const zone = $('tzone').getBoundingClientRect();
  const down = new Set();

  for (const t of e.touches) {
    // Anywhere in the steering zone reads as a direction, from wherever the
    // thumb happens to be — no gaps to fall between.
    if (inRect(t, zone)) {
      for (const k of padDirections(t)) down.add(k);
      continue;
    }
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const k = el && el.dataset && el.dataset.k;
    if (k) down.add(k);
  }

  for (const key of Object.keys(EMPTY_INPUT)) touchInput[key] = down.has(key);
  for (const el of $('touch').querySelectorAll('[data-k]')) {
    el.classList.toggle('on', down.has(el.dataset.k));
  }
}

for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
  $('touch').addEventListener(ev, applyTouches, { passive: false });
}

// Keyboard and touch are merged, so either works and both can be used at once.
function readInput() {
  const out = {};
  for (const k of Object.keys(EMPTY_INPUT)) out[k] = keyInput[k] || touchInput[k];
  return out;
}

// Portrait at 16:9 leaves the game unplayably small, so ask rather than try.
function checkOrientation() {
  const portrait = matchMedia('(orientation: portrait)').matches;
  $('rotate').classList.toggle('hide', !(TOUCH && portrait));
}
if (TOUCH) {
  checkOrientation();
  addEventListener('resize', checkOrientation);
  addEventListener('orientationchange', checkOrientation);
}

// --- fullscreen ------------------------------------------------------------

const docEl = document.documentElement;
const canFullscreen = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);

// Already launched from the home screen: there is no chrome to hide.
const STANDALONE = navigator.standalone === true ||
                   matchMedia('(display-mode: standalone)').matches;

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function goFullscreen() {
  if (!TOUCH || !canFullscreen || isFullscreen()) return;
  const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
  req.call(docEl).catch(() => {});
}

function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit) exit.call(document).catch(() => {});
}

if (TOUCH && !STANDALONE) $('btnFull').classList.remove('hide');

$('btnFull').onclick = () => {
  if (!canFullscreen) {
    // iPhone Safari. The only way to lose the URL bar is the home screen, so
    // say that plainly instead of leaving a button that does nothing.
    const hint = $('fullHint');
    hint.textContent = 'iPhone Safari cannot go fullscreen. Tap Share, then ' +
                       '"Add to Home Screen" — opening it from there hides ' +
                       'the address bar.';
    hint.classList.toggle('hide');
    return;
  }
  isFullscreen() ? exitFullscreen() : goFullscreen();
};

for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    $('btnFull').innerHTML = isFullscreen() ? '&#10005;' : '&#9974;';
  });
}

// --- loop ------------------------------------------------------------------

let last = performance.now(), acc = 0, frames = 0, fpsAt = last, scoresAt = 0;

function frame(now) {
  requestAnimationFrame(frame);

  acc += Math.min(now - last, 250);   // clamp so a background tab cannot spiral
  last = now;

  while (acc >= TICK_MS) { acc -= TICK_MS; tick(); }

  render(now);

  frames++;
  if (now - fpsAt >= 500) {
    $('sFps').textContent = Math.round(frames * 1000 / (now - fpsAt));
    frames = 0; fpsAt = now;
  }
}

function tick() {
  const input = readInput();
  if (mode === 'guest') {
    // Guests simulate nothing. They send input and render what the host says.
    send({ t:'i', i: input });
    return;
  }
  inputs[myId] = input;
  step(state, inputs);
  if (mode === 'host' && state.tick % SEND_EVERY === 0) {
    broadcast({ t:'s', s: snapshot(state) });
  }
}

requestAnimationFrame(frame);

// --- render ----------------------------------------------------------------

function render(now) {
  const pair = mode === 'guest' ? framePair(now) : null;
  const list = mode === 'guest' ? playersFrom(pair) : normalize(state.players);
  const arrows = mode === 'guest' ? arrowsFrom(pair) : state.arrows;
  $('sPlayers').textContent = list.length;

  updateCamera(list);

  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.save();
  ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

  ctx.fillStyle = '#1e2530';
  for (const s of viewPlatforms) {
    // Skip anything off screen. Cheap now, and it keeps mattering as the
    // map grows.
    if (s.x + s.w < cam.x || s.x > cam.x + VIEW_W ||
        s.y + s.h < cam.y || s.y > cam.y + VIEW_H) continue;
    ctx.fillRect(s.x, s.y, s.w, s.h);
  }

  for (const k of viewPickups()) drawPickup(k);

  noteShieldBreaks(list);

  for (const p of list) {
    if (p.dead) continue;
    drawPlayer(p);
  }

  for (const a of arrows) drawArrow(a);

  drawBreaks();

  ctx.restore();

  if (now - scoresAt > 250) { drawScores(list); scoresAt = now; }
}

// Centre on your own player, but stop at the world edges so you never see
// past the walls.
function updateCamera(list) {
  const me = list.find(p => p.id === myId && !p.dead);
  if (!me) return;

  const tx = clamp(me.x + PLAYER_W / 2 - VIEW_W / 2, 0, W - VIEW_W);
  const ty = clamp(me.y + PLAYER_H / 2 - VIEW_H / 2, 0, H - VIEW_H);

  if (!cam.ready) { cam.x = tx; cam.y = ty; cam.ready = true; return; }
  cam.x += (tx - cam.x) * CAM_EASE;
  cam.y += (ty - cam.y) * CAM_EASE;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Host reads its own state; guests read the newest snapshot they have.
function viewPickups() {
  if (mode !== 'guest') return state.pickups;
  const last = buffer[buffer.length - 1];
  return last && last.s.k ? last.s.k.map(r => ({ x:r[0], y:r[1], kind:r[2] })) : [];
}

const SHIELD_COLOR = '#7fd0f0';
const BOW_COLOR = '#c8a25e';

function drawArrow(a) {
  const hx = Math.sign(a.vx) * ARROW.len / 2;
  const hy = Math.sign(a.vy) * ARROW.len / 2;
  ctx.strokeStyle = '#ffe9a8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a.x - hx, a.y - hy);
  ctx.lineTo(a.x + hx, a.y + hy);
  ctx.stroke();
  // Bright head, so direction of travel is readable at speed.
  ctx.fillStyle = '#fff';
  ctx.fillRect(a.x + hx - 2, a.y + hy - 2, 4, 4);
}

// A bow shape, used both on the ground and in a player's hands.
function bowPath(cx, cy, r, facing) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, facing > 0 ? -Math.PI / 2.1 : Math.PI / 2.1,
          facing > 0 ? Math.PI / 2.1 : Math.PI * 1.52, facing < 0);
  ctx.stroke();
}

function drawPickup(k) {
  const x = Math.round(k.x), y = Math.round(k.y);

  if (k.kind === 'shield') {
    // A rounded shield outline — a different colour and silhouette from the
    // spear, so you can tell what a distant pickup is before walking to it.
    ctx.strokeStyle = SHIELD_COLOR;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 2);
    ctx.lineTo(x + PICKUP.w - 2, y + 2);
    ctx.lineTo(x + PICKUP.w - 2, y + PICKUP.h - 7);
    ctx.quadraticCurveTo(x + PICKUP.w / 2, y + PICKUP.h + 3, x + 2, y + PICKUP.h - 7);
    ctx.closePath();
    ctx.stroke();
    return;
  }

  if (k.kind === 'bow') {
    ctx.strokeStyle = BOW_COLOR;
    ctx.lineWidth = 2.5;
    bowPath(x + PICKUP.w / 2 - 2, y + PICKUP.h / 2, PICKUP.h / 2, 1);
    return;
  }

  // A spear on the ground: a shaft with a bright tip, angled so it reads as a
  // weapon rather than a box at this size.
  ctx.strokeStyle = '#d8c48a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + PICKUP.h);
  ctx.lineTo(x + PICKUP.w, y);
  ctx.stroke();
  ctx.fillStyle = '#fff6d5';
  ctx.fillRect(x + PICKUP.w - 5, y - 1, 5, 5);
}

// Shield breaks are detected client-side by watching the flag flip, so both
// host and guest get the effect without needing events over the wire.
const hadShield = new Map();
const breaks = [];

function noteShieldBreaks(list) {
  for (const p of list) {
    const before = hadShield.get(p.id) || false;
    if (before && !p.shield && !p.dead) {
      breaks.push({ x: p.x + PLAYER_W / 2, y: p.y + PLAYER_H / 2, age: 0 });
    }
    hadShield.set(p.id, !!p.shield);
  }
}

function drawBreaks() {
  for (let i = breaks.length - 1; i >= 0; i--) {
    const b = breaks[i];
    b.age++;
    if (b.age > 24) { breaks.splice(i, 1); continue; }
    const t = b.age / 24;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = SHIELD_COLOR;
    ctx.lineWidth = 3 * (1 - t) + 1;
    // Shards flying outward, so a break is unmistakable even in a crowd.
    for (let s = 0; s < 8; s++) {
      const a = (s / 8) * Math.PI * 2;
      const r0 = 14 + t * 26, r1 = r0 + 9;
      ctx.beginPath();
      ctx.moveTo(b.x + Math.cos(a) * r0, b.y + Math.sin(a) * r0);
      ctx.lineTo(b.x + Math.cos(a) * r1, b.y + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawPlayer(p) {
  const x = Math.round(p.x), y = Math.round(p.y);

  // Invulnerable players flash. Driven off the countdown so host and guest
  // flash in step with each other.
  const flashing = p.invuln > 0 && ((p.invuln >> 2) & 1);
  ctx.globalAlpha = flashing ? 0.3 : 1;

  if (p.attackTimer > 0) {
    // Pass the player itself — swingBox reads .weapon, and a stripped object
    // silently falls back to bare-hands reach.
    const hb = swingBox(p);
    const live = isSwingActive(p);
    ctx.fillStyle = live ? '#ffffff' : 'rgba(255,255,255,0.18)';
    if (live) {
      ctx.fillRect(Math.round(hb.x), Math.round(hb.y), hb.w, hb.h);
    } else {
      // Windup: a thin line along the axis of the swing, so you can read
      // which way it is about to go before it becomes dangerous.
      const vertical = (p.attackDir || 0) !== 0;
      if (vertical) ctx.fillRect(Math.round(hb.x + hb.w / 2 - 1.5), Math.round(hb.y), 3, hb.h);
      else          ctx.fillRect(Math.round(hb.x), Math.round(hb.y + hb.h / 2 - 1.5), hb.w, 3);
    }
  }

  // Dash trail: ghosts behind you, so a dash reads as movement rather than a
  // teleport — both to you and to whoever you are dashing at.
  if (p.dashTimer > 0) {
    for (let i = 1; i <= 3; i++) {
      ctx.globalAlpha = 0.16 * (4 - i);
      ctx.fillStyle = p.color;
      ctx.fillRect(x - p.facing * i * 11, y, PLAYER_W, PLAYER_H);
    }
    ctx.globalAlpha = flashing ? 0.3 : 1;
  }

  ctx.fillStyle = p.color;
  ctx.fillRect(x, y, PLAYER_W, PLAYER_H);

  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(p.facing > 0 ? x + PLAYER_W - 7 : x + 3, y + 7, 4, 4);

  // Carrying a weapon has to be visible at a glance — it tells everyone else
  // who is worth hunting, and tells you why their reach just got longer.
  if (p.weapon === 'bow') {
    ctx.strokeStyle = BOW_COLOR;
    ctx.lineWidth = 2.5;
    bowPath(x + PLAYER_W / 2 + p.facing * 13, y + PLAYER_H / 2, 11, p.facing);
  }

  if (p.weapon === 'spear') {
    const tipX = p.facing > 0 ? x + PLAYER_W + 16 : x - 16;
    ctx.strokeStyle = '#d8c48a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.facing > 0 ? x + 4 : x + PLAYER_W - 4, y + 20);
    ctx.lineTo(tipX, y + 8);
    ctx.stroke();
    ctx.fillStyle = '#fff6d5';
    ctx.fillRect(tipX - 2, y + 6, 5, 5);
  }

  if (p.id === myId) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + PLAYER_W / 2 - 1, y - 8, 2, 5);
  }

  // A carried shield draws as a bubble around you — visible from across the
  // arena, so everyone knows you need hitting twice.
  if (p.shield) {
    ctx.strokeStyle = SHIELD_COLOR;
    ctx.lineWidth = 2;
    ctx.globalAlpha = (flashing ? 0.3 : 1) * 0.85;
    ctx.beginPath();
    ctx.ellipse(x + PLAYER_W / 2, y + PLAYER_H / 2, PLAYER_W, PLAYER_H * 0.78,
                0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = flashing ? 0.3 : 1;
  }

  ctx.fillStyle = '#8b93a3';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, x + PLAYER_W / 2, y - 11);
  ctx.globalAlpha = 1;
}

function drawScores(list) {
  const rows = [...list].sort((a, b) => b.score - a.score);
  $('scores').innerHTML = rows.map(p =>
    '<tr><td style="color:' + p.color + '">' + p.name + '</td><td>' +
    p.score + '</td></tr>').join('') || '<tr><td>–</td><td>0</td></tr>';
}

// --- state shaping ---------------------------------------------------------

const meta = new Map();
function metaFor(id) { return meta.get(id) || { name:id, color:COLORS[0] }; }
function rememberMeta(list) {
  list.forEach((p, i) => meta.set(p.id, {
    name: p.name, color: p.color || COLORS[i % COLORS.length],
  }));
}

function normalize(players) {
  return players.map(p => ({
    id:p.id, x:p.x, y:p.y, facing:p.facing, attackTimer:p.attackTimer,
    dead:p.dead, invuln:p.invuln, score:p.score, weapon:p.weapon,
    attackDir:p.attackDir, dashTimer:p.dashTimer, shield:p.shield,
    name:p.name, color:p.color,
  }));
}

// Row:
//   [id, x, y, facing, onGround, attackTimer, dead, invuln, score, weapon, attackDir]
function row(r) {
  const m = metaFor(r[0]);
  return {
    id:r[0], x:r[1], y:r[2], facing:r[3], attackTimer:r[5],
    dead: !!r[6], invuln:r[7], score:r[8], weapon: r[9] || null,
    attackDir: r[10] || 0, dashTimer: r[11] || 0, shield: !!r[12],
    name:m.name, color:m.color,
  };
}

// Guests render slightly in the past and blend between the two snapshots
// straddling that moment. Without this, 30Hz updates look visibly steppy.
// Only position is interpolated — attack and death states come from the
// newer snapshot, since a half-blended hitbox would be meaningless.
// Advance the buffer once per frame and hand back the two snapshots to blend.
// Shared by players and arrows so the buffer is not walked twice.
function framePair(now) {
  const target = now - INTERP_MS;
  while (buffer.length > 2 && buffer[1].at <= target) buffer.shift();
  if (!buffer.length) return null;
  if (buffer.length === 1) return { a: buffer[0], b: buffer[0], f: 0 };

  const a = buffer[0], b = buffer[1];
  const span = b.at - a.at;
  const f = span > 0 ? Math.max(0, Math.min(1, (target - a.at) / span)) : 1;
  return { a, b, f };
}

function playersFrom(pair) {
  if (!pair) return [];
  const { a, b, f } = pair;
  if (a === b) return a.s.p.map(row);

  const byId = new Map(b.s.p.map(r => [r[0], r]));
  return a.s.p.map(ra => {
    const rb = byId.get(ra[0]);
    if (!rb) return row(ra);
    const out = row(rb);
    // A respawn teleports; snap rather than sliding across the map.
    const teleported = Math.abs(rb[1] - ra[1]) > 200 ||
                       Math.abs(rb[2] - ra[2]) > 200;
    if (!teleported) {
      out.x = ra[1] + (rb[1] - ra[1]) * f;
      out.y = ra[2] + (rb[2] - ra[2]) * f;
    }
    return out;
  });
}

function arrowRow(r) { return { id:r[0], x:r[1], y:r[2], vx:r[3], vy:r[4] }; }

function arrowsFrom(pair) {
  if (!pair) return [];
  const { a, b, f } = pair;
  const from = a.s.a || [];
  if (a === b) return from.map(arrowRow);

  const byId = new Map((b.s.a || []).map(r => [r[0], r]));
  return from.map(ra => {
    const rb = byId.get(ra[0]);
    const out = arrowRow(rb || ra);
    if (rb) {
      out.x = ra[1] + (rb[1] - ra[1]) * f;
      out.y = ra[2] + (rb[2] - ra[2]) * f;
    }
    return out;
  });
}

// --- networking ------------------------------------------------------------

function newPeer(id) {
  return new Peer(id, {
    debug: 1,
    config: { iceServers: [
      { urls:'stun:stun.l.google.com:19302' },
      { urls:'stun:stun1.l.google.com:19302' },
    ]},
  });
}

function makeCode() {
  const a = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
  return Array.from({length:4}, () => a[Math.floor(Math.random()*a.length)]).join('');
}

$('btnHost').onclick = () => {
  goFullscreen();                    // must happen inside the tap itself
  const code = makeCode();
  mode = 'host';
  peer = newPeer(PREFIX + code);

  peer.on('open', () => {
    $('code').textContent = code;
    enterGame();
    $('sRole').textContent = 'host';
    lockName();
    $('netHint').textContent = 'Others join with this code. You run the simulation.';
  });

  peer.on('connection', conn => {
    const name = (conn.metadata && conn.metadata.name) || 'guest';
    conn.on('open', () => {
      conns.push(conn);
      addPlayer(state, conn.peer, name, COLORS[state.players.length % COLORS.length]);
      broadcastMeta();

      // Snapshot layout is hand-rolled and changes between builds, so a guest
      // on a stale cached version can break in ways that look like bugs.
      const theirs = (conn.metadata && conn.metadata.v) || 'unknown';
      if (theirs !== VERSION) {
        conn.send({ t:'vwarn', host: VERSION, yours: theirs });
      }
    });
    conn.on('data', d => {
      if (d.t === 'i') inputs[conn.peer] = d.i;
      else if (d.t === 'ping') conn.send({ t:'pong', ts:d.ts });
    });
    conn.on('close', () => {
      conns = conns.filter(c => c !== conn);
      removePlayer(state, conn.peer);
      delete inputs[conn.peer];
      broadcastMeta();
    });
  });

  peer.on('error', onErr);
};

$('btnJoin').onclick = () => {
  const code = $('inCode').value.trim().toUpperCase();
  if (code.length !== 4) return;
  goFullscreen();                    // must happen inside the tap itself

  mode = 'guest';
  peer = newPeer(null);

  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code, {
      reliable: true,
      metadata: { name: myName, v: VERSION },
    });

    conn.on('open', () => {
      conns = [conn];
      myId = peer.id;                  // the host keys us by our peer id
      $('code').textContent = code;
      enterGame();
      $('sRole').textContent = 'guest';
      lockName();
      $('netHint').textContent = 'The host runs the simulation. You send input.';
      $('tuneWarn').classList.remove('hide');
      setInterval(() => {
        conn.send({ t:'ping', ts: Date.now() });
        readIce(conn);
      }, 2000);
    });

    conn.on('data', d => {
      if (d.t === 's') buffer.push({ at: performance.now(), s: d.s });
      else if (d.t === 'meta') {
        rememberMeta(d.players);
        if (d.seed !== undefined && d.seed !== state.seed) {
          state.seed = d.seed;
          viewPlatforms = generateMap(d.seed).platforms;
          cam.ready = false;
          $('seed').textContent = d.seed;
        }
      }
      else if (d.t === 'pong') $('sPing').textContent = (Date.now() - d.ts) + ' ms';
      else if (d.t === 'vwarn') {
        $('verWarn').textContent =
          'You are on version ' + d.yours + ' but the host is on ' + d.host +
          '. Reload the page to update.';
        $('verWarn').classList.remove('hide');
      }
    });

    conn.on('close', () => {
      mode = 'solo';
      backToLobby('Host disconnected.');
    });
  });

  peer.on('error', onErr);
};

// Dev tools are off unless asked for, so the default view is just the game.
const DEV = ['dev', 'debug'].some(k => new URLSearchParams(location.search).has(k));
if (DEV) $('dev').classList.remove('hide');
$('sVer').textContent = VERSION;

function enterGame() {
  $('lobby').classList.add('hide');
  $('hud').classList.remove('hide');
}

// Anything that goes wrong returns you to the lobby with a reason, rather
// than leaving you staring at a game you are not connected to.
function backToLobby(msg) {
  $('lobby').classList.remove('hide');
  $('netHint').textContent = msg;
  $('inName').disabled = false;
}

$('btnSolo').onclick = () => {
  goFullscreen();
  $('code').textContent = 'SOLO';
  enterGame();
};

function onErr(err) {
  const why = err.type === 'peer-unavailable' ? 'No room with that code.'
            : err.type === 'unavailable-id'   ? 'That code is taken — try hosting again.'
            : 'Error [' + err.type + '] ' + err.message;
  backToLobby(why);
  mode = 'solo';
}

function send(msg)      { conns.forEach(c => c.open && c.send(msg)); }
function broadcast(msg) { conns.forEach(c => c.open && c.send(msg)); }
function broadcastMeta() {
  broadcast({ t:'meta', seed: state.seed, players: state.players.map(p =>
    ({ id:p.id, name:p.name, color:p.color })) });
}

$('btnMap').onclick = () => {
  if (mode === 'guest') return;          // the host owns the map
  regenerate(state, newSeed());
  viewPlatforms = state.platforms;
  cam.ready = false;                     // do not sweep across the new map
  $('seed').textContent = state.seed;
  broadcastMeta();
};

$('seed').textContent = state.seed;

// --- name input ------------------------------------------------------------

$('inName').value = savedName;

$('inName').oninput = () => {
  const typed = cleanName($('inName').value);
  myName = typed || myId;             // blank falls back to the generated id
  store('oderlads-name', typed);

  const me = state.players.find(p => p.id === myId);
  if (me) me.name = myName;
  if (mode === 'host') broadcastMeta();
};

// Locked once you are in a room — changing identity mid-match would just be
// confusing, and the host has already told everyone who you are.
function lockName() { $('inName').disabled = true; }

// Reports whether WebRTC went direct, through NAT, or via a relay.
function readIce(conn) {
  const pc = conn.peerConnection;
  if (!pc || !pc.getStats) return;
  pc.getStats(null).then(stats => {
    let pair = null; const c = {};
    stats.forEach(r => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') c[r.id] = r;
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
    });
    if (!pair) return;
    const L = c[pair.localCandidateId], R = c[pair.remoteCandidateId];
    if (!L || !R) return;
    $('sPath').textContent =
      (L.candidateType === 'relay' || R.candidateType === 'relay') ? 'TURN relay'
      : (L.candidateType === 'host' && R.candidateType === 'host') ? 'direct (LAN)'
      : 'STUN';
  }).catch(() => {});
}

// --- tuning ----------------------------------------------------------------

const MOVE_SLIDERS = [
  ['gravity',      0.10,  1.60, 0.01],
  ['jumpVel',    -18.00, -4.00, 0.10],
  ['cutJumpVel',  -9.00,  0.00, 0.10],
  ['moveAccel',    0.10,  5.00, 0.05],
  ['maxRunSpeed',  1.00, 10.00, 0.10],
  ['groundFric',   0.50,  1.00, 0.01],
  ['airFric',      0.50,  1.00, 0.01],
  ['maxFall',      4.00, 25.00, 0.50],
  ['coyoteTicks',  0,    15,    1],
  ['bufferTicks',  0,    15,    1],
];

// Every weapon has the same shape, so one definition drives both panels.
const WEAPON_SLIDERS = [
  ['reach',       10, 140, 1],
  ['swingH',      10,  80, 1],
  ['attackDur',    4,  30, 1],
  ['activeFrom',   1,  30, 1],
  ['activeTo',     0,  30, 1],
  ['attackCd',     0,  60, 1],
];

const RESPAWN_SLIDERS = [
  ['respawnTicks', 0, 300, 5],
  ['invulnTicks',  0, 300, 5],
];

// Grouped because 'reach' now exists on more than one object — the panels
// would collide on element ids otherwise, and a value would silently write to
// the wrong weapon.
const DASH_SLIDERS = [
  ['speed',  4,  30, 0.5],
  ['ticks',  2,  30, 1],
  ['cd',     0, 150, 5],
];

const GROUPS = [
  { host:'sliders',        defs:MOVE_SLIDERS,    target:TUNE,          key:'movement' },
  { host:'dashSliders',    defs:DASH_SLIDERS,    target:DASH,          key:'dash' },
  { host:'fistSliders',    defs:WEAPON_SLIDERS,  target:WEAPONS.none,  key:'fists' },
  { host:'spearSliders',   defs:WEAPON_SLIDERS,  target:WEAPONS.spear, key:'spear' },
  { host:'respawnSliders', defs:RESPAWN_SLIDERS, target:COMBAT,        key:'respawn' },
];

const DEFAULTS = GROUPS.map(g => ({ ...g.target }));

for (const g of GROUPS) {
  for (const [key, min, max, stepSize] of g.defs) {
    const vid = 'v_' + g.key + '_' + key;

    const wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.innerHTML = '<div class="top"><span>' + key + '</span><span id="' +
                     vid + '">' + g.target[key] + '</span></div>';

    const r = document.createElement('input');
    r.type = 'range'; r.min = min; r.max = max; r.step = stepSize;
    r.value = g.target[key];
    r.dataset.group = g.key;
    r.dataset.key = key;
    r.oninput = () => {
      g.target[key] = parseFloat(r.value);
      $(vid).textContent = r.value;
    };

    wrap.appendChild(r);
    $(g.host).appendChild(wrap);
  }
}

$('btnCopy').onclick = () => {
  const out = {};
  GROUPS.forEach(g => { out[g.key] = { ...g.target }; });
  navigator.clipboard.writeText(JSON.stringify(out, null, 2));
  $('btnCopy').textContent = 'Copied';
  setTimeout(() => { $('btnCopy').textContent = 'Copy values'; }, 1200);
};

$('btnReset').onclick = () => {
  GROUPS.forEach((g, i) => Object.assign(g.target, DEFAULTS[i]));
  document.querySelectorAll('input[type=range]').forEach(r => {
    const g = GROUPS.find(x => x.key === r.dataset.group);
    if (!g) return;
    const v = g.target[r.dataset.key];
    r.value = v;
    $('v_' + g.key + '_' + r.dataset.key).textContent = v;
  });
};

addEventListener('beforeunload', () => { if (peer) peer.destroy(); });
