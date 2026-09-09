// ---------------------------------------------------------------------------
// sim.js — the simulation, kept separate from rendering and input.
//
// Rules for this file:
//   - No DOM, no canvas, no keyboard, no Date.now(), no Math.random()
//   - step(state, inputs) depends only on its arguments
//
// Why: the research was unanimous that retrofitting this separation later is
// effectively a rewrite. Keeping it costs nothing now.
// ---------------------------------------------------------------------------

// World size. The canvas is a 960x540 window onto this, following the player.
export const W = 1920;
export const H = 1080;

export const PLAYER_W = 22;
export const PLAYER_H = 30;

// Movement feel. These are the numbers the tuning sliders write to.
// Units are pixels per tick at 60 ticks/second.
export const TUNE = {
  gravity:      0.60,
  maxFall:     13.00,
  jumpVel:    -13.50,
  cutJumpVel:  -2.70,  // releasing jump early clamps upward speed to this
  moveAccel:    3.00,
  maxRunSpeed:  5.50,
  groundFric:   0.80,
  airFric:      0.73,
  coyoteTicks:  6,     // can still jump this many ticks after leaving ground
  bufferTicks:  6,     // a jump pressed this early still fires on landing
};

// An attack runs for attackDur ticks, but the hitbox only exists between
// activeFrom and activeTo — startup, then active frames, then recovery. That
// gap is what makes a swing whiffable instead of instant.
//
// 'none' is bare hands, the baseline every player starts with. Every weapon
// must be a straight upgrade on it, so that walking over one is never bad.
// The bow keeps bare-hands melee exactly as it is and adds arrows on their own
// separate, much longer cooldown. That is what keeps it a straight upgrade:
// you never become worse in a close scramble by picking it up, and the "long
// recovery" lands on the shooting rather than on the punching.
export const WEAPONS = {
  none:  { reach: 30, swingH: 26, attackDur: 12, activeFrom:  9, activeTo: 4, attackCd: 18 },
  spear: { reach: 70, swingH: 26, attackDur: 14, activeFrom: 11, activeTo: 5, attackCd: 20 },
  bow:   { reach: 30, swingH: 26, attackDur: 12, activeFrom:  9, activeTo: 4, attackCd: 18,
           arrowCd: 45 },
};

export const ARROW = {
  speed: 15,     // ~1 second to cross a screen width
  life:  240,    // despawn after 4s so strays do not accumulate
  len:   12,
  thick:  4,
};

export const COMBAT = {
  respawnTicks: 90,
  invulnTicks:  75,
  // A swing stays active for several ticks. Without a grace window after a
  // shield breaks, the very same swing kills you on the next tick and the
  // shield may as well not exist.
  shieldBreakInvuln: 30,
};

// Dash is a base ability everyone has. Pure mobility — it does not kill on
// contact, so it never replaces melee. Gravity is suspended for its duration,
// which is what makes it read as a deliberate burst rather than a stumble.
export const DASH = {
  speed: 13.0,   // against a run speed of 5.5
  ticks: 10,     // roughly 1/6 of a second, covering ~130px
  cd:    45,
};

export const PICKUP = {
  w: 16,
  h: 16,
  refillTicks: 480,   // 8s before a spot that was emptied can refill
};

// Caps count everything of that kind in the world, carried ones included.
// Without a cap, spots keep refilling while dead players keep dropping, and
// within a couple of minutes everyone is holding one — which would make them
// worthless. `weight` sets how often a refilling spot picks that kind.
export const KINDS = {
  spear:  { slot:'weapon', capBase: 2, capPerPlayers: 3, weight: 3 },
  bow:    { slot:'weapon', capBase: 1, capPerPlayers: 5, weight: 2 },
  shield: { slot:'shield', capBase: 1, capPerPlayers: 6, weight: 1 },
};

export const KIND_NAMES = Object.keys(KINDS);

export function weaponOf(p) { return WEAPONS[p.weapon || 'none']; }

// --- map generation --------------------------------------------------------
//
// Everything here is driven by a seed so that the host and every guest build
// byte-identical maps. The host sends only the seed, never the geometry.

const WALL = 20;

export const MAP = {
  rows:      [900, 760, 620, 480, 340, 200],
  minPerRow: 2,
  maxPerRow: 4,
  minWidth:  140,
  maxWidth:  360,
  minGap:     70,  // horizontal space left between platforms in the same row
  // A full jump rises about 152px at the default gravity/jumpVel, and rows sit
  // 140px apart. maxReach is how far sideways you can still be and land on the
  // platform above. Kept conservative on purpose — an unreachable ledge is a
  // far worse bug than a slightly easy one.
  maxReach:  110,
};

// Deterministic PRNG (mulberry32). Same seed, same map, on every machine.
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Horizontal distance between two platforms, 0 if they overlap.
function gapBetween(a, b) {
  return Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
}

export function generateMap(seed) {
  const rand = rng(seed);
  const pick = (lo, hi) => lo + rand() * (hi - lo);

  const platforms = [
    { x: 0,        y: H - 40, w: W,    h: 40   },  // floor
    { x: 0,        y: 0,      w: W,    h: WALL },  // ceiling
    { x: 0,        y: 0,      w: WALL, h: H    },  // left wall
    { x: W - WALL, y: 0,      w: WALL, h: H    },  // right wall
  ];

  const usable = W - WALL * 2;
  // The floor is the starting point: anything on the first row is reachable
  // from it, since it spans the whole world.
  let below = [{ x: WALL, y: H - 40, w: usable, h: 40 }];

  for (const y of MAP.rows) {
    const count = Math.floor(pick(MAP.minPerRow, MAP.maxPerRow + 0.999));
    const slot = usable / count;
    const row = [];

    for (let i = 0; i < count; i++) {
      const maxW = Math.min(MAP.maxWidth, slot - MAP.minGap);
      const w = Math.max(MAP.minWidth, Math.min(maxW, pick(MAP.minWidth, MAP.maxWidth)));
      const slack = Math.max(0, slot - w - MAP.minGap);
      const x = WALL + i * slot + pick(0, slack);
      // Ledges are one-way: jump up through them, land on top. Only the
      // floor, ceiling and walls are fully solid.
      row.push({ x, y, w, h: 16, oneWay: true });
    }

    // Guarantee every platform is reachable from the row beneath it. If the
    // nearest one below is too far, slide this platform toward it.
    for (const p of row) {
      let nearest = below[0], best = Infinity;
      for (const b of below) {
        const g = gapBetween(p, b);
        if (g < best) { best = g; nearest = b; }
      }
      if (best > MAP.maxReach) {
        const shift = best - MAP.maxReach;
        const dir = (nearest.x + nearest.w / 2) < (p.x + p.w / 2) ? -1 : 1;
        p.x += shift * dir;
        p.x = Math.max(WALL, Math.min(W - WALL - p.w, p.x));
      }
    }

    row.forEach(p => { p.x = Math.round(p.x); p.w = Math.round(p.w); });
    platforms.push(...row);
    below = row;
  }

  const ledges = platforms.filter(p => p.h === 16);

  // Spawn on top of platforms, so nobody ever appears inside geometry.
  const spawns = [];
  for (const p of ledges) {
    spawns.push({ x: Math.round(p.x + p.w / 2 - PLAYER_W / 2), y: p.y - PLAYER_H - 2 });
  }
  for (let i = 0; i < 4; i++) {
    spawns.push({ x: Math.round(WALL + (usable / 5) * (i + 1)), y: H - 40 - PLAYER_H - 2 });
  }

  // Pickup spots sit on a subset of ledges, so they are places you learn
  // rather than anywhere at all.
  const spots = [];
  for (let i = 0; i < ledges.length; i += 2) {
    const p = ledges[i];
    spots.push({
      x: Math.round(p.x + p.w / 2 - PICKUP.w / 2),
      y: p.y - PICKUP.h - 2,
      cooldown: 0,
      filled: false,
    });
  }

  return { platforms, spawns, spots };
}

export const EMPTY_INPUT = {
  left:false, right:false, up:false, down:false,
  jump:false, attack:false, dash:false,
};

// Which way a swing points. Locked in when the swing starts, so you cannot
// rotate an attack mid-animation.
export const DIR_SIDE = 0, DIR_UP = 1, DIR_DOWN = 2;

export function createState(seed = 1) {
  const { platforms, spawns, spots } = generateMap(seed);
  return {
    tick: 0, seed, platforms, spawns, spots,
    players: [], pickups: [], arrows: [], nextArrowId: 1, events: [],
  };
}

// Build a fresh map in place, keeping players and their scores.
export function regenerate(state, seed) {
  const { platforms, spawns, spots } = generateMap(seed);
  state.seed = seed;
  state.platforms = platforms;
  state.spawns = spawns;
  state.spots = spots;
  state.pickups = [];
  state.arrows = [];
  state.players.forEach((p, i) => {
    p.weapon = null;
    p.shield = false;
    placeAt(state, p, i);
  });
}

function placeAt(state, p, index) {
  const sp = state.spawns[index % state.spawns.length];
  p.x = sp.x; p.y = sp.y;
  p.vx = 0; p.vy = 0;
  p.dead = false;
  p.respawnIn = 0;
  p.invuln = COMBAT.invulnTicks;
  p.attackTimer = 0;
  p.attackCd = 0;
}

export function addPlayer(state, id, name, color) {
  const sp = state.spawns[state.players.length % state.spawns.length];
  state.players.push({
    id, name, color,
    x: sp.x, y: sp.y,
    vx: 0, vy: 0,
    facing: 1,
    onGround: false,
    coyote: 0,
    jumpBuf: 0,
    heldJump: false,
    heldAttack: false,
    heldDash: false,
    dashTimer: 0,
    dashCd: 0,
    dashDir: 1,
    attackTimer: 0,
    attackCd: 0,
    attackDir: DIR_SIDE,
    arrowCd: 0,
    weapon: null,
    shield: false,
    dead: false,
    respawnIn: 0,
    invuln: COMBAT.invulnTicks,
    score: 0,
    deaths: 0,
  });
}

export function removePlayer(state, id) {
  const p = state.players.find(x => x.id === id);
  if (p && p.weapon) dropWeapon(state, p);   // leave it on the map, not nowhere
  state.players = state.players.filter(x => x.id !== id);
}

// --- collision -------------------------------------------------------------

function hits(x, y, s) {
  return x < s.x + s.w && x + PLAYER_W > s.x &&
         y < s.y + s.h && y + PLAYER_H > s.y;
}

function boxOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// Resolve one axis at a time. Moving diagonally as a single test is what
// produces the classic "caught on a corner" bug.
function moveX(p, dx, platforms) {
  p.x += dx;
  for (const s of platforms) {
    if (s.oneWay) continue;              // ledges never block sideways movement
    if (!hits(p.x, p.y, s)) continue;
    p.x = dx > 0 ? s.x - PLAYER_W : s.x + s.w;
    p.vx = 0;
  }
}

function moveY(p, dy, platforms) {
  p.y += dy;
  p.onGround = false;
  for (const s of platforms) {
    if (!hits(p.x, p.y, s)) continue;

    // One-way ledges only exist for a player falling onto them from above.
    // Jump up through them; land on top. Comparing where the feet were
    // *before* this move is also what stops a fast fall passing through.
    if (s.oneWay) {
      if (dy <= 0) continue;
      const feetBefore = p.y + PLAYER_H - dy;
      if (feetBefore > s.y + 1) continue;
    }

    if (dy > 0) { p.y = s.y - PLAYER_H; p.onGround = true; }
    else        { p.y = s.y + s.h; }
    p.vy = 0;
  }
}

// Where a swing reaches. Exported so rendering can draw exactly what hits.
// For up and down, swingH becomes the width of the swing rather than its
// height — it is the thickness of the arc either way.
export function swingBox(p) {
  const wep = weaponOf(p);
  const dir = p.attackDir || DIR_SIDE;

  if (dir === DIR_UP) {
    return {
      x: p.x + PLAYER_W / 2 - wep.swingH / 2,
      y: p.y - wep.reach,
      w: wep.swingH,
      h: wep.reach,
    };
  }
  if (dir === DIR_DOWN) {
    return {
      x: p.x + PLAYER_W / 2 - wep.swingH / 2,
      y: p.y + PLAYER_H,
      w: wep.swingH,
      h: wep.reach,
    };
  }
  return {
    x: p.facing > 0 ? p.x + PLAYER_W : p.x - wep.reach,
    y: p.y + (PLAYER_H - wep.swingH) / 2,
    w: wep.reach,
    h: wep.swingH,
  };
}

export function isSwingActive(p) {
  const wep = weaponOf(p);
  return p.attackTimer <= wep.activeFrom && p.attackTimer >= wep.activeTo;
}

function respawn(state, p, index) {
  // Cycle spawns off the tick so it stays deterministic without an RNG.
  placeAt(state, p, state.tick + index);
}

// --- arrows ----------------------------------------------------------------

// An arrow is long along the way it travels and thin across it.
export function arrowBox(a) {
  const horizontal = a.vx !== 0;
  return {
    x: a.x - (horizontal ? ARROW.len : ARROW.thick) / 2,
    y: a.y - (horizontal ? ARROW.thick : ARROW.len) / 2,
    w: horizontal ? ARROW.len : ARROW.thick,
    h: horizontal ? ARROW.thick : ARROW.len,
  };
}

function fireArrow(state, p) {
  let vx = 0, vy = 0;
  if (p.attackDir === DIR_UP)        vy = -ARROW.speed;
  else if (p.attackDir === DIR_DOWN) vy =  ARROW.speed;
  else                               vx =  p.facing * ARROW.speed;

  // Start just clear of the shooter so it never spawns inside them.
  const cx = p.x + PLAYER_W / 2, cy = p.y + PLAYER_H / 2;
  state.arrows.push({
    id: state.nextArrowId++,
    x: cx + Math.sign(vx) * (PLAYER_W / 2 + ARROW.len / 2),
    y: cy + Math.sign(vy) * (PLAYER_H / 2 + ARROW.len / 2),
    vx, vy,
    owner: p.id,
    life: ARROW.life,
  });
  state.events.push({ t:'shoot', id:p.id });
}

// Move arrows and drop the ones that expire or hit geometry. Player hits are
// resolved later, alongside melee, so shields behave identically either way.
function moveArrows(state) {
  for (let i = state.arrows.length - 1; i >= 0; i--) {
    const a = state.arrows[i];
    a.x += a.vx;
    a.y += a.vy;

    if (--a.life <= 0) { state.arrows.splice(i, 1); continue; }

    const box = arrowBox(a);
    let stopped = false;
    for (const s of state.platforms) {
      // Arrows are stopped by every surface, one-way ledges included — being
      // able to shoot up through the floor you are standing on would make the
      // bow absurd on a map this vertical.
      if (boxOverlap(box, s)) { stopped = true; break; }
    }
    if (stopped) {
      state.events.push({ t:'arrowHit', x:a.x, y:a.y });
      state.arrows.splice(i, 1);
    }
  }
}

// --- pickups ---------------------------------------------------------------

function dropWeapon(state, p) {
  if (!p.weapon) return;
  state.pickups.push({
    kind: p.weapon,
    x: Math.round(p.x + PLAYER_W / 2 - PICKUP.w / 2),
    y: Math.round(p.y + PLAYER_H - PICKUP.h),
    spot: -1,                            // dropped, not owned by a spawn spot
  });
  p.weapon = null;
}

// How many of `kind` exist anywhere — on the ground or being carried.
function countOf(state, kind) {
  let n = 0;
  for (const k of state.pickups) if (k.kind === kind) n++;
  for (const p of state.players) {
    if (KINDS[kind].slot === 'shield') { if (p.shield) n++; }
    else if (p.weapon === kind) n++;
  }
  return n;
}

function capOf(state, kind) {
  const c = KINDS[kind];
  return c.capBase + Math.floor(state.players.length / c.capPerPlayers);
}

// Integer hash, so which kind a spot rolls is deterministic rather than random.
function hash32(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = n + (n << 3);
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return n >>> 0;
}

// Can this player take this kind? Weapons and shields occupy separate slots,
// and a full slot is never swapped.
function canTake(p, kind) {
  return KINDS[kind].slot === 'shield' ? !p.shield : !p.weapon;
}

function updatePickups(state) {
  for (let i = 0; i < state.spots.length; i++) {
    const spot = state.spots[i];
    if (spot.filled) continue;
    if (spot.cooldown > 0) { spot.cooldown--; continue; }
    // Stagger which spot fills, so they do not all pop at once.
    if ((state.tick + i * 97) % PICKUP.refillTicks !== 0) continue;

    const available = KIND_NAMES.filter(k => countOf(state, k) < capOf(state, k));
    if (!available.length) continue;

    const total = available.reduce((s, k) => s + KINDS[k].weight, 0);
    let roll = hash32(state.tick + i * 7919) % total;
    let chosen = available[0];
    for (const k of available) {
      roll -= KINDS[k].weight;
      if (roll < 0) { chosen = k; break; }
    }

    spot.filled = true;
    state.pickups.push({ kind: chosen, x: spot.x, y: spot.y, spot: i });
  }

  // Collect. A full slot is never swapped, so a player carrying a spear can
  // still take a shield, but not another spear.
  for (const p of state.players) {
    if (p.dead) continue;
    for (let i = 0; i < state.pickups.length; i++) {
      const k = state.pickups[i];
      if (!canTake(p, k.kind)) continue;
      if (!boxOverlap({ x:p.x, y:p.y, w:PLAYER_W, h:PLAYER_H },
                      { x:k.x, y:k.y, w:PICKUP.w, h:PICKUP.h })) continue;

      if (KINDS[k.kind].slot === 'shield') p.shield = true;
      else p.weapon = k.kind;

      if (k.spot >= 0) {
        state.spots[k.spot].filled = false;
        state.spots[k.spot].cooldown = PICKUP.refillTicks;
      }
      state.pickups.splice(i, 1);
      state.events.push({ t:'pickup', id:p.id, kind:k.kind });
      break;
    }
  }
}

// --- step ------------------------------------------------------------------

export function step(state, inputs) {
  state.tick++;
  state.events.length = 0;

  // 1. Movement and attack windup
  state.players.forEach((p, index) => {
    if (p.dead) {
      if (--p.respawnIn <= 0) respawn(state, p, index);
      return;
    }

    const inp = inputs[p.id] || EMPTY_INPUT;
    const wep = weaponOf(p);

    if (p.invuln > 0) p.invuln--;
    if (p.attackCd > 0) p.attackCd--;
    if (p.attackTimer > 0) p.attackTimer--;
    if (p.arrowCd > 0) p.arrowCd--;
    if (p.dashCd > 0) p.dashCd--;
    if (p.dashTimer > 0) p.dashTimer--;

    const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);

    // Start a dash on the press. Direction comes from what you are holding,
    // falling back to the way you face, so a standing dash still goes
    // somewhere sensible.
    if (inp.dash && !p.heldDash && p.dashCd <= 0 && p.dashTimer <= 0) {
      p.dashDir = dir !== 0 ? dir : p.facing;
      p.facing = p.dashDir;
      p.dashTimer = DASH.ticks;
      p.dashCd = DASH.cd;
      state.events.push({ t:'dash', id:p.id });
    }
    p.heldDash = inp.dash;

    const dashing = p.dashTimer > 0;

    // Horizontal
    if (dashing) {
      p.vx = p.dashDir * DASH.speed;
    } else if (dir !== 0) {
      p.vx += dir * TUNE.moveAccel;
      if (p.vx >  TUNE.maxRunSpeed) p.vx =  TUNE.maxRunSpeed;
      if (p.vx < -TUNE.maxRunSpeed) p.vx = -TUNE.maxRunSpeed;
      p.facing = dir;
    } else {
      p.vx *= p.onGround ? TUNE.groundFric : TUNE.airFric;
      if (Math.abs(p.vx) < 0.05) p.vx = 0;
    }

    // Coyote time: keep a window open after walking off an edge.
    if (p.onGround) p.coyote = TUNE.coyoteTicks;
    else if (p.coyote > 0) p.coyote--;

    // Jump buffer: remember a press that arrived slightly too early.
    if (inp.jump && !p.heldJump) p.jumpBuf = TUNE.bufferTicks;
    else if (p.jumpBuf > 0) p.jumpBuf--;

    if (p.jumpBuf > 0 && p.coyote > 0) {
      p.vy = TUNE.jumpVel;
      p.jumpBuf = 0;
      p.coyote = 0;
      p.onGround = false;
      p.dashTimer = 0;      // jumping cancels a dash, so you never feel stuck
    }

    // Variable height: let go early and the rise is cut short.
    if (!inp.jump && p.vy < TUNE.cutJumpVel) p.vy = TUNE.cutJumpVel;
    p.heldJump = inp.jump;

    // Attack on the press, not while held, so holding the key does not spam.
    if (inp.attack && !p.heldAttack && p.attackCd <= 0 && p.attackTimer <= 0) {
      // Aim is taken at the moment of the press and held for the whole swing.
      // Up wins over down if somehow both are held; otherwise you swing the
      // way you are facing.
      p.attackDir = inp.up ? DIR_UP : inp.down ? DIR_DOWN : DIR_SIDE;
      p.attackTimer = wep.attackDur;
      p.attackCd = wep.attackCd;
      state.events.push({ t:'swing', id:p.id, dir:p.attackDir });

      // The bow shoots on the same button, but only when its own longer
      // cooldown is up. Otherwise you just swing.
      if (wep.arrowCd && p.arrowCd <= 0) {
        fireArrow(state, p);
        p.arrowCd = wep.arrowCd;
      }
    }
    p.heldAttack = inp.attack;

    // A dash floats: no gravity for its duration. Re-read dashTimer rather
    // than using `dashing`, since a jump this tick may have cancelled it.
    if (p.dashTimer > 0) {
      p.vy = 0;
    } else {
      p.vy += TUNE.gravity;
      if (p.vy > TUNE.maxFall) p.vy = TUNE.maxFall;
    }

    moveX(p, p.vx, state.platforms);
    moveY(p, p.vy, state.platforms);

    // The walls contain the player; this is just a safety net so nothing can
    // end up outside the world if a collision is ever missed.
    if (p.x < 0) p.x = 0;
    else if (p.x + PLAYER_W > W) p.x = W - PLAYER_W;
    if (p.y < 0) p.y = 0;
    else if (p.y + PLAYER_H > H) p.y = H - PLAYER_H;
  });

  // 2. Move arrows, then resolve every hit together.
  // Collected first and applied after, so two players who swing into each
  // other on the same tick trade instead of the lower array index winning.
  moveArrows(state);

  const kills = [];
  for (const a of state.players) {
    if (a.dead || !isSwingActive(a)) continue;
    const hb = swingBox(a);
    for (const b of state.players) {
      if (b === a || b.dead || b.invuln > 0) continue;
      if (boxOverlap(hb, { x:b.x, y:b.y, w:PLAYER_W, h:PLAYER_H })) {
        kills.push({ killer:a, victim:b });
      }
    }
  }

  // Arrow hits join the same list, so a shield stops an arrow exactly the way
  // it stops a swing.
  for (let i = state.arrows.length - 1; i >= 0; i--) {
    const arrow = state.arrows[i];
    const box = arrowBox(arrow);
    for (const b of state.players) {
      if (b.dead || b.invuln > 0 || b.id === arrow.owner) continue;
      if (!boxOverlap(box, { x:b.x, y:b.y, w:PLAYER_W, h:PLAYER_H })) continue;
      const shooter = state.players.find(p => p.id === arrow.owner);
      if (shooter) kills.push({ killer: shooter, victim: b });
      state.arrows.splice(i, 1);
      break;
    }
  }

  // One resolution per victim per tick. Without this, two attackers landing
  // on the same tick would break the shield and then kill through it.
  const resolved = new Set();
  for (const k of kills) {
    if (k.victim.dead || resolved.has(k.victim)) continue;
    resolved.add(k.victim);

    if (k.victim.shield) {
      k.victim.shield = false;
      k.victim.invuln = COMBAT.shieldBreakInvuln;
      state.events.push({
        t:'shieldBreak', id:k.victim.id, by:k.killer.id,
        x:k.victim.x, y:k.victim.y,
      });
      continue;                           // survived: no death, no point
    }

    k.victim.dead = true;
    k.victim.respawnIn = COMBAT.respawnTicks;
    k.victim.deaths++;
    k.killer.score++;
    dropWeapon(state, k.victim);          // drops where you fell
    state.events.push({
      t:'kill', killer:k.killer.id, victim:k.victim.id,
      x:k.victim.x, y:k.victim.y,
    });
  }

  // 3. Spawning and collecting
  updatePickups(state);

  return state;
}

// Only what rendering needs. Kept small deliberately — this is the thing that
// goes over the wire 30 times a second.
// Player row:
//   [id, x, y, facing, onGround, attackTimer, dead, invuln, score, weapon,
//    attackDir, dashTimer, shield]
// Pickup row: [x, y, kind]
export function snapshot(state) {
  return {
    t: state.tick,
    p: state.players.map(p => [
      p.id, Math.round(p.x), Math.round(p.y), p.facing, p.onGround ? 1 : 0,
      p.attackTimer, p.dead ? 1 : 0, p.invuln, p.score, p.weapon || 0,
      p.attackDir, p.dashTimer, p.shield ? 1 : 0,
    ]),
    k: state.pickups.map(k => [k.x, k.y, k.kind]),
    // Arrows carry an id so guests can interpolate them between snapshots the
    // same way as players — at 15px/tick they would visibly stutter otherwise.
    a: state.arrows.map(a => [a.id, Math.round(a.x), Math.round(a.y), a.vx, a.vy]),
  };
}
