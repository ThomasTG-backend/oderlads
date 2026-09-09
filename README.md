# Oderlads

A browser-based multiplayer arena brawler. Melee combat, generated maps,
peer-to-peer — no server, no install, no accounts.

**▶ Play: https://thomastg-backend.github.io/oderlads/**

Works on desktop and phones. Everything runs in the browser.

---

## Playing together

One person clicks **Host a room** and gets a four-character code. Everyone else
enters that code and clicks **Join**. **Practise alone** skips straight into the
arena on your own.

Two things worth knowing:

- **The host's browser runs the game for everyone.** If the host closes their
  tab, the match ends.
- **The host must keep their tab visible.** Browsers throttle background tabs
  to roughly one frame per second, which slows the game down for every player.

## Controls

| Action | Keyboard | Touch |
|---|---|---|
| Move | `←` `→` or `A` `D` | left pad |
| Jump | `Space` | ⇧ button |
| Attack | `J`, `F` or `/` | ⚔ button |
| Aim the attack | hold `↑` / `↓` | up / down on the pad |
| Dash | `Shift` or `K` | » button |

Attacks go the way you're facing. Hold up or down to swing that way instead —
in the air or on the ground. Aim is locked when the swing starts.

One hit kills. You respawn a couple of seconds later, briefly invulnerable.
Kills are points.

## Pickups

Weapons spawn at fixed points around the map. **Walk over one to pick it up.**
You keep it until you die, and you can't swap — a full slot ignores anything
else of that type. Everything you carry drops where you fell, for anyone to
take.

| Pickup | Slot | Effect |
|---|---|---|
| **Spear** | weapon | Much longer reach |
| **Bow** | weapon | Fires arrows on their own cooldown; melee is unchanged |
| **Shield** | separate | Absorbs one hit, then shatters |

Weapons and shields use separate slots, so you can carry both.

## Development

The game is static files — no build step, no dependencies to install.

```bash
# Any static server works; ES modules will not load over file://
python -m http.server 8000
```

Then open `http://localhost:8000`.

### URL flags

| Flag | Effect |
|---|---|
| `?dev` | Shows the map seed, connection stats, and live tuning sliders |
| `?touch` | Forces touch controls on, for testing them without a phone |

`?dev` is how you tune the game. Every movement, combat and dash value is a
live slider — drag while playing, then **Copy values** to get them as JSON.

### Layout

```
index.html    everything: rendering, input, networking, UI
src/sim.js    the simulation
```

`sim.js` deliberately contains no DOM, canvas, input or randomness. `step(state,
inputs)` depends only on its arguments, which is what keeps host and clients
able to agree on the same world.

## How it works

- **Peer-to-peer over WebRTC.** Game traffic goes browser to browser. A public
  PeerJS broker introduces peers to each other and then drops out of the loop.
- **Host-authoritative.** Guests send input, the host simulates everything and
  broadcasts state 30 times a second. Guests render 100ms in the past and
  interpolate, so movement stays smooth between updates.
- **Maps are generated from a seed**, and only the seed is sent — every player
  builds the same map locally. Generation guarantees every platform is
  reachable from the one below it.
- **Collision is hand-rolled AABB**, resolved one axis at a time, with coyote
  time, jump buffering and variable jump height.

See [DESIGN.md](DESIGN.md) for decisions and [RESEARCH.md](RESEARCH.md) for the
research behind them.
