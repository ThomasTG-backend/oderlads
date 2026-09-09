# Oderlads — Design Doc

A browser game to play with ~20 colleagues, built as a leaving gift.
Playable from the office and from home. Roughly a month to build.

## Decided

- **TowerFall-like 2D arena brawler.** Short, high intensity, easy to pick up.
  Arrow keys plus one or two buttons.
- **Runs in the browser, peer-to-peer over WebRTC, no server.** Static hosting.
  Tested and working — on a local network and over the internet.
- **Melee is the baseline.** Everyone always has it. Ranged is a pickup, not a
  starting ability — see Base abilities and Pickups below.
- **No player limit.** The company is ~20 people, so that's the floor we support,
  not a cap.
- **Continuous respawn deathmatch.** No elimination — at 20 players, elimination
  means most people spend the match dead and watching.
- **Kills are points.**
- **Match ends on a timer.** 5 minutes for now, to be tuned by playing it.
- **Brief invulnerability after respawn.**
- **Bare-bones graphics.** Simple, cheap, small images. The charm comes from the
  characters — colleagues, or characters we all know and love.
- **Proof of concept first.**

## Base abilities

What every player has all the time, with no pickups. This is the baseline a
match starts from, and what pickups are measured against.

| Ability | State | Notes |
|---|---|---|
| **Move** | built | Run left and right. |
| **Jump** | built | Space. Variable height — hold longer to jump higher. |
| **Melee** | built | The default attack. One hit kills. |
| **Aimed attacks** | built | Attacks go the way you are facing. Hold **up** or **down** to swing that way instead, in the air or on the ground. Aim is locked when the swing starts, so an attack cannot be rotated mid-animation. |
| **Dash** | agreed, not built | Cooldown. Pure mobility — no kill on contact, so it never replaces melee. |

Jump is on space rather than up, because up is needed for aiming — and space
is where jump lives in most games.

## Pickups

Found on the map. **Fixed spawn spots, refilling on a timer, at a low rate** —
fixed rather than fully random so they become places people learn and fight
over.

The rules below are built and working, with the spear as the first pickup.

**Rules that apply to every pickup:**

- **Walk over it to pick it up.**
- **You keep it until you die. No swapping.** Walking over another one while
  already carrying does nothing. This stops people camping a spawn and cycling
  between weapons — shoot with the bow, switch to melee, switch back. Camping a
  spawn to deny it to others is still allowed; that's all it gets you.
- **Every pickup is a straight upgrade on the baseline.** So walking over one is
  never a bad thing, even accidentally. The game is meant to be fast — you die,
  you respawn, you kill, you move on.
- **Everything you carry drops where you fell when you die**, and anyone can
  pick it up. Keeps a strong pickup moving between people instead of one player
  snowballing with it, and makes whoever is carrying it a target.

### Weapons

One slot. Replaces melee while carried.

- **Spear** — long reach. *Built.*
- **Bow** — projectile, long recovery after firing.

### Items

Separate slot from weapons, so a spear and a shield can be carried at once.

- **Shield** — tanks one hit. Must be obvious both that someone has one and
  when it breaks.

## Later

- Death feedback — showing who killed you.
- Ammo limits on the bow. Ignored for now — the bow is unlimited until you die.
- Higher jump or double jump. Parked because, unlike the others, it has no
  natural end condition: a weapon ends when you die and a shield ends when it
  breaks, but a jump buff would just persist and stack.
