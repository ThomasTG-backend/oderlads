# Research Findings

Output from four research agents, run 2026-09-09.

**Nothing in this file is a decision.** These are findings and the agents'
recommendations, kept so we don't have to search again. Decisions live in
DESIGN.md and only go there when Tumas says so.

---

## 1. Physics & collision

**Agent verdict: hand-roll AABB collision. Do not use a physics engine**
(Matter.js, Planck.js, Rapier2D, Box2D/WASM) for character movement.

### TowerFall and Celeste use no physics engine

Same designer, same custom system, documented publicly by its author.
Celeste's source is public and usable as reference.

- Two concepts: **Solid** (level geometry) and **Actor** (anything that moves)
- All colliders are AABBs at integer pixel positions
- **Actors have no built-in velocity or gravity.** The engine provides only
  `MoveX(amount, onCollide)` and `MoveY(amount, onCollide)`. Gravity,
  acceleration and jump logic live in the player subclass
- Movement accumulates a sub-pixel remainder, then advances one whole pixel at
  a time, checking for a blocking Solid before each step
- X and Y resolved as separate passes
- Moving platforms: an actor on top is **carried**; one in the way is **pushed**
  the minimum distance, triggering `Squish()` (death if crushed)
- Celeste's `Player.cs` is deliberately one large monolithic file — the README
  says splitting hand-tuned control code across files makes the feel harder to
  keep coherent

Sources:
- https://www.maddymakesgames.com/articles/celeste_and_towerfall_physics/index.html
- https://github.com/NoelFB/Celeste/tree/master/Source/Player

### Why rigid-body engines lose

Documented failure modes: characters slide off moving platforms because
velocity doesn't transfer cleanly; rectangular hitboxes catch on seams between
adjacent tiles that look flat; slopes cause bunny-hopping; and fundamentally,
engines move things via forces while platformers need velocity dictated by hand
every frame.

Every account converges on the same workaround — bypass the engine's force
integration and set velocity manually — at which point it is an expensive AABB
query tool.

**Super Meat Boy** is the strongest evidence: it started on Box2D and discarded
essentially all physical behaviour. Tommy Refenes: *"Nothing in the game is
physically accurate to real physics, not a single thing. All of Meat Boy's weird
controls are done in-game, not in-engine."*

Sources:
- https://www.learn-cocos2d.com/2013/08/physics-engine-platformer-terrible-idea/
- https://www.gamedev.net/blogs/entry/2263391-day-1-do-not-use-physics-engines-for-platformers/
- https://raw.githubusercontent.com/Isetta-Team/Isetta-Website-Raw/master/docs/interviews/TommyRefenes-interview.md

### Estimated code size

~600–1000 lines for the whole movement/collision/hitbox layer:

| Part | Lines |
|---|---|
| AABB vs static geometry, X/Y separate passes | 150–300 |
| Swept collision for fast movers (only if needed) | 100–150 |
| Moving/one-way platforms, carry/push/squish | 100–200 |
| Player controller state machine + tuning | 200–400 |

The tuning eats the time, not the code.

### Game-feel techniques

**Essential** (each 5–20 lines once you own the movement code):
- **Coyote time** — jump still works ~100–150ms after walking off a ledge
- **Jump buffering** — a jump pressed just before landing fires on landing
- **Variable jump height** — releasing early cuts the jump short

**Polish:**
- **Apex hang time** — reduced gravity at the top of the arc
- **Corner correction** — nudge past a corner you barely clipped instead of
  killing momentum

These are harder on a physics engine because they require selectively
overriding contact resolution — coyote time is literally "you are not touching
the ground, but let the jump happen anyway."

### Melee hitboxes

Standard pattern, needs no physics engine: attacks decompose into
**startup → active → recovery** frames. The hitbox exists *only* during active
frames — it is not a persistent collider. Hurtbox is the character's normal AABB.
Detection is a plain overlap test during the active window. Frame data is a data
table per attack.

No rigid-body engine has a primitive for "this shape exists for 3 of the next 12
frames", so this is hand-rolled regardless of the movement decision.

### Determinism

Floating point is **not** reliably identical across machines — compiler
reordering, fused multiply-add, x87 vs SSE2, and differing `Math.sin`/`cos`
implementations all cause divergence. Rapier2D has the strongest cross-platform
determinism claim of the JS engines, but it breaks if you feed it ordinary JS
transcendental functions.

Mitigation used by studios shipping deterministic lockstep: fixed-point math for
authoritative state, floats only for local rendering.

Most P2P browser games sidestep this entirely by syncing authoritative state
rather than requiring bit-exact agreement.

Sources:
- https://gafferongames.com/post/floating_point_determinism/
- https://rapier.rs/docs/user_guides/javascript/determinism/

---

## 2. Game frameworks

**Agent verdict: Phaser** — primarily for input, sprites, audio, scenes and the
loop, not for its physics.

> Note: this agent assumed a full-mesh topology and opened with a warning that
> 20 players will not work. That premise is wrong for our design (star
> topology). Its mesh math is likely correct and simply does not apply.

| Framework | Version (date) | Maintained | CDN / no build | Notes |
|---|---|---|---|---|
| **Phaser** | 4.2.1 (Jul 2026); 3.x still supported | Very active, 40.3k stars | Yes | ~345KB min, ~110KB gzip custom build. Native headless mode since 3.2.0, fixed/variable timestep |
| **KAPLAY** (ex-Kaboom) | 3001.0.19 (Jun 2025), 4000-alpha active | Active, 1.8k stars | Best zero-build story | **3 FPS at 10k sprites** vs Phaser's 43 — rejected on performance |
| **Excalibur** | 0.32.0, pre-1.0 | Very active, 2.3k stars | Bundler-first docs | Clean TS, "not different enough from Phaser to justify switching" |
| **PixiJS** | 8.20.1 | Extremely active, 48.1k stars | Yes | Rendering only — 47 FPS at 10k sprites, but no input/audio/physics/scenes |
| **melonJS** | 19.8.0 | Active, small team, 6.4k stars | Yes | Genuinely platformer-oriented (native Tiled slope/platform support) but ~1k weekly downloads |
| **Vanilla canvas** | — | — | Trivially | Highest time risk; its only edge (loop control) Phaser already provides |

**Kaboom is dead.** Replit laid off its creator and kept the trademark; the
community forked it as KAPLAY. Use the new name when searching.

**Phaser 3 vs 4:** agent recommended **3** for the timeline — 4 launched April
2026 and troubleshooting material is thinner.

**Known Phaser Arcade Physics issues:** moving-platform friction scales
incorrectly with physics FPS (GitHub issue #4672), and determinism edge cases
reported on their forum.

**Practical point:** community size affects how reliably AI coding assistance
works. Thin documentation means more hallucinated APIs.

Sources:
- https://github.com/phaserjs/phaser
- https://phaser.io/news/2026/04/phaser-vs-kaplay-vs-excalibur-2d-web-game-framework
- https://github.com/Shirajuki/js-game-rendering-benchmark
- https://jslegenddev.substack.com/p/kaboomjs-is-now-kaplay

---

## 3. Multiplayer architecture

**Agent verdict: 20 players P2P with one browser hosting is feasible** — star
topology, binary encoding, naive broadcast first.

### Star vs mesh

Mesh at 20 players = 190 connections, and the burden lands on *every* player,
not just the host — including whoever has the worst laptop. Star is also the
correct topology for a host-authoritative game. Mesh only makes sense for
lockstep.

### Bandwidth math

Snapshot: 20 players x ~20–25 bytes (quantized position, velocity, aim,
state flags) + projectiles ≈ **~670 bytes/tick binary**.

| Encoding | Tick rate | Host upload |
|---|---|---|
| Binary | 30Hz | **~3.0 Mbps** |
| Binary | 20Hz | ~2.0 Mbps |
| JSON | 30Hz | **~16 Mbps** |

Video call adds ~3 Mbps. Binary + call ≈ 6–7 Mbps, fine above ~20 Mbps upload.

Agent's framing: binary vs JSON "is the difference between *clearly viable* and
*will work at the office LAN but strand your at-home players*".

Mitigations by priority: binary encoding (4–5x — close to mandatory), lower tick
rate (linear), delta compression (stretch goal), area-of-interest filtering
(skip — arena is one screen, nothing to cull).

### Connection limits — the riskiest unknown

No source benchmarks ~20 *data-only* peer connections in one tab. Adjacent
evidence: Chrome supports 512 concurrent data channels (Firefox 128); observed
failures in real tests were video-codec CPU/memory bound, which does not apply
to us. Agent estimates strain begins around 30–50 connections.

**Flagged as the top thing to validate early, on the weakest laptop that might
host — not on a dev machine.**

Source: https://tensorworks.com.au/blog/webrtc-stream-limits-investigation/

### Netcode approaches

| Approach | Complexity | Verdict |
|---|---|---|
| Naive state broadcast | Low | Correct first milestone |
| Host-authoritative + local prediction | Moderate | Add later if latency feels bad |
| Deterministic lockstep | High | Rejected — stalls on slowest peer |
| Rollback (GGPO-style) | Very high | Rejected — multi-week, benefits evaporate at 20 players |

### Data channels

Use **two channels per connection**:
- `{ordered: false, maxRetransmits: 0}` for position/state — a stale position is
  worthless, do not retransmit
- reliable + ordered for events (kills, round start/end, score)

Source: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel

### Serialization

Hand-rolled `DataView`/`ArrayBuffer` packing, not MessagePack/FlatBuffers.
Manual packing allows game-specific quantization (arena bounds, angle
precision) that generic serializers cannot do. Gaffer On Games example: 40 bytes
uncompressed to 10 bytes quantized.

### Retrofit costs

- Interpolation: cheap to add later (~3 hours reported)
- **Prediction: requires snapshot-able simulation separated from rendering.
  Retrofitting onto entangled code is "effectively a rewrite of the simulation
  layer."**

### Host migration

Genuinely hard — detect loss, elect successor, resume state, re-signal all
remaining connections. Agent recommends explicitly scoping it out: detect host
disconnect, end match gracefully.

Sources:
- https://gafferongames.com/post/state_synchronization/
- https://gafferongames.com/post/snapshot_compression/
- https://bloggeek.me/webrtc-p2p-mesh/

---

## 4. Signaling

**Structural finding:** you can have **zero manual steps per player** (a broker)
or **zero third-party dependency** (manual links). Never both. Two browsers with
no prior relationship cannot find each other without an out-of-band channel —
human or service.

### PeerJS public broker

Operational as of 2026-09-09, but their own docs say:

> *"you will be sharing it with other people and IDs may collide"*
>
> *"for high-traffic applications, please host your own PeerServer"*

No SLA, undocumented limits, history of outage and 429 rate-limit reports.
Latest v1.5.5 (June 2025), 13.3k stars, slow-moving but not abandoned.

### Trystero

Agent's recommended broker alternative. Signals over Nostr (default), MQTT,
BitTorrent, IPFS, Supabase or Firebase behind one API. Nostr is default because
it has hundreds of independent relays rather than one central service. No
account needed. Robustness ranking from its own README: Nostr > MQTT >
BitTorrent > IPFS.

- https://github.com/dmotz/trystero
- https://trystero.dev/

### Link-based signaling (manual)

**Mechanics work:** offer is 2–6 KB; browsers handle 32k–80k char URLs; Slack
allows 40,000 chars. The fragment after `#` is never sent to Slack's crawler.
Compression only buys 24–37% — the "97% smaller" results online require
rewriting the handshake as a custom binary protocol.

**Return path has no trick.** Every project examined has a human relay both hops.

**Cost at 20 players:** ~20 sequential cycles for the host, ~40 Slack messages,
10–40+ minutes of the host's undivided attention before anyone plays. One
confused person blocks the queue.

**Where it works:** as a one-off fallback for a single stuck player after
everyone else connected normally — 4 steps, 2 messages. Reasonable once.

**Vanilla ICE required** (a link is a static blob, trickle has nowhere to go).
Full gathering can take ~25s worst case; common workaround is cutting it short
at ~3s, accepting whatever candidates exist.

**QR codes: not viable here.** A 2–6 KB blob needs a Version 30+ code taking
8–15s to scan, and assumes physical proximity.

Source: https://magarcia.io/air-gapped-webrtc-breaking-the-qr-limit/

### Self-hosted signaling

A signaling server is small — PeerServer is a few lines with the `peerjs`
package, or a ~50-line WebSocket relay. It passes two blobs between browsers
then drops out; game traffic never touches it.

Requirements: reachable from outside the office, served over WSS with a real
certificate (mixed content is blocked, self-signed certs are rejected), and
kept running as a process.

### STUN / TURN

**STUN does not count as a server you maintain** — stateless, no account, no
config beyond a URL. Hardcode 3–4 (Google, Cloudflare, Twilio, Metered).

**TURN** is needed by the ~10–20% of players behind symmetric NAT. All free
options need a one-time signup:

| Provider | Free tier |
|---|---|
| Metered / Open Relay | 0.5 GB/mo no card; 20 GB/mo with card |
| Xirsys | 0.5 GB/mo after trial |
| Cloudflare Realtime | Large free allotment, then $0.05/GB |

Game state is tiny, so these tiers are plausibly sufficient.

- https://www.metered.ca/tools/openrelay/
- https://www.twilio.com/en-us/stun-turn
