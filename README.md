# Tank Brawl 🎮

A top-down tank shooter for 2–8 players. Drive the hull, aim the turret
independently, fight through a maze that regenerates every round, and
reshape it as you go — drop brick walls, lay mud, and close the arena
down with a shrinking zone.

Play offline against bots on one keyboard, matchmake a 1v1, or open a
custom lobby for up to eight tanks.

## The stack (and who does what)

| Piece | Job |
|---|---|
| **GitHub** | Source of truth for the code |
| **Netlify** | Hosts the site (pure static files, no build step) |
| **Firebase Realtime Database** | Online lobbies, 1v1 matchmaking, accounts, friends |
| **localStorage** | Saves each player's keybinds and settings on their device |

Local battles work with zero setup — Firebase is only loaded when
someone opens an online screen.

## Run it locally

ES modules need a web server (double-clicking `index.html` won't work):

```bash
# from the project folder — either of these:
python3 -m http.server 8080
npx serve
```

Then open http://localhost:8080

## Firebase setup (~5 min, needed for online play only)

1. Go to https://console.firebase.google.com → **Add project** (Analytics optional).
2. In the project: **Build → Realtime Database → Create database**.
3. In the **Rules** tab, paste this and publish:

   ```json
   {
     "rules": {
       "lobbies": { ".read": true, ".write": true },
       "users":   { ".read": true, ".write": true },
       "uids":    { ".read": true, ".write": true },
       "names":   { ".read": true, ".write": true },
       "queue":   { ".read": true, ".write": true }
     }
   }
   ```

   > These rules are open enough for development (anyone can read and
   > write under those paths). Tighten them before a serious launch —
   > validate writes per player and lock `users` down to per-account
   > access.

   Without the `users`/`uids` rules, logging in shows "Permission
   denied". Without `queue`, the 1v1 search can't find anyone.

4. **Accounts need Email/Password sign-in enabled:** Firebase console →
   Build → **Authentication** → Get started → Sign-in method →
   **Email/Password** → Enable. Sessions persist on each device until
   the player logs out; logging out wipes their data from that device
   (the cloud copy returns on the next login).
5. **Project settings (gear icon) → Your apps → Web (`</>`)** → register an app.
6. Copy the `firebaseConfig` object it shows you into
   `js/firebase-config.js`, replacing the placeholders. (Firebase web
   keys are public identifiers, not secrets — committing them is
   normal. The rules are the lock.)
7. Reload the site — the online screens now work.

## Deploy: GitHub → Netlify

```bash
git init
git add .
git commit -m "Tank Brawl"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tank-brawl.git
git push -u origin main
```

Then on https://app.netlify.com → **Add new site → Import an existing
project** → pick the repo. Leave the build command **empty**; the
included `netlify.toml` already sets the publish directory to the repo
root. Every push to `main` auto-deploys.

## Default controls (rebindable in Settings)

You drive the **hull** and aim the **turret** independently:

| Action | Control |
|---|---|
| Drive hull (fwd / rev / turn) | **W S A D** |
| Aim turret | **Mouse** |
| Offense (special gun, else basic shot) | **Left-click** (Space also fires) |
| Defense (wall / armour / heal pad / mud) | **Right-click** |
| Agility (boost / phase) | **Left Shift** |

Pickups are split into three loadout categories — **offense**,
**defense** and **agility** — and a tank holds ONE item per category at
a time. Your three equipped items show as enlarged icons in the
bottom-right of the arena, each captioned with its activation control.

The hull turns with A/D while the barrel tracks your cursor, so you can
strafe past a wall while keeping your gun trained on a target. Online
opponents' turret angles are streamed alongside their position, so
everyone sees where everyone else is aiming.

On phones (no mouse), the turret tracks the hull and the on-screen
controls fire straight ahead. The game plays in landscape.

## Game modes

- **1v1** — matchmade. Join the queue and you're paired with whoever
  has been waiting longest; there's no rating and no skill-based
  matching. First to **3** round wins. Kills pay tags for the shop.
- **Custom** — create a lobby, share the 4-digit code, up to **8**
  tanks. The host picks map sizes, which abilities are in rotation, how
  many can be on the field, and whether the closing zone is on.
- **Local** — up to **4** players on one keyboard, plus bots. Seat 1
  starts as a human; anyone else joins by pressing their own fire key,
  even taking over a bot mid-match.

## The shop

Kills pay **tags** (💀), and tags are the only currency. What you can
*buy* depends on what you already own, not on how good you are:

- Each shade needs the same hue one step back:
  `red → dark red → light red → pastel red → neon red`. Red is free, so
  dark red is open from your very first tag; blue has to be bought
  before dark blue is.
- The six paid primaries (orange, yellow, green, blue, indigo, violet)
  are open from the start.
- A **material** needs its whole family finished — Bronze wants every
  primary, Silver every dark, Gold every light, Platinum every pastel,
  Diamond every neon.
- **Ruby** needs the entire rest of the catalogue behind it.

The materials aren't colours with an effect painted on top: the tank is
made of the stuff, shaded the way the real material responds to light
(`js/material.js`). None of it animates — a mirror horizon on silver, a
warm broad specular on gold, cut facets with dispersion on diamond and
ruby — and the shop chip shows exactly what the hull will wear.

**Patterns** are pure economy: no gates and no prerequisites, just a
price. A two-tone pattern is worn with any two colours you own.

## How online lobbies work

Data lives at `lobbies/{code}` in the Realtime Database:

```
lobbies/8341: {
  createdAt: <server timestamp>,
  hostId: "<player id>",
  state: "waiting" | "starting",
  matched: true,        // came from the 1v1 queue, not a shared code
  players: { "<player id>": { joinedAt, name, ukey, color, pattern } }
}
```

- Codes are random 1000–9999; creation rerolls if a code is taken.
- Max 8 players (bots count). Everyone wears the paint they bought; if
  two players equipped the same colour, the earlier joiner keeps it and
  the later one is bumped to a free primary, resolved identically on
  every client.
- `onDisconnect` removes a player automatically if their tab dies; if
  the host vanishes, the oldest remaining player claims host.
- Leaving as the last player deletes the lobby.
- Every client simulates its own tank and reports its own shots and
  death; the host also drives the bots and pushes each round's seed.

## Project map

```
index.html            all screens (menus + battle arena)
css/style.css         styles (mobile-first)
js/main.js            screen router, toast, shared helpers
js/settings.js        keybinds + audio settings (localStorage)
js/local.js           offline join flow + bot seats
js/duel.js            1v1 queue and matchmaking
js/online.js          Firebase lobby flow, bots, round/shot/death sync
js/social.js          accounts, friends, invites, the tag economy
js/chat.js            lobby text chat
js/versus.js          head-to-head loading card + win/loss records
js/results.js         post-match scoreboard + tag payout
js/shop.js            the shop UI (colours + patterns)
js/skins.js           paint catalogue, prices, the unlock chain
js/material.js        static material shading for the special paints
js/palette.js         control slots + colour lookup for the renderer
js/tanksprite.js      canvas tank previews (shop, versus, scoreboard)
js/maze.js            seeded RNG, maze generation, wall + ray geometry
js/weapons.js         pickups: laser, machine gun, homing rocket, cannon
js/game.js            arena: movement, shooting, rounds, collision
js/ai.js              bot drivers (easy / medium / hard / impossible)
js/audio.js           music + sound effects
js/firebase-config.js paste your Firebase config here
netlify.toml          Netlify config (no build step)
```

## How the battle works

- **Weapons**: crates appear on the floor a few seconds into each round.
  Drive over one and your barrel physically changes — sprite AND hitbox
  — until you fire it off.
  - **Laser**: while held, everyone sees your dashed aiming line. Fire =
    an instant bouncing beam that kills everything it crosses, including
    you if a reflection comes back.
  - **Machine gun**: 16 half-sized bouncing balls, fired manually — hold
    to spray, tap for single shots.
  - **Homing rocket**: flies straight (bouncing) for ~1.75 s, then locks
    on and HUNTS the nearest tank. Only slightly faster than a tank, so
    you CAN run, and it dies on its own after 6 seconds. Once seeking,
    touching a wall ends it. Its shooter is fair game too.
  - **Big cannon**: one slow heavy ball. On expiry — or the moment it
    hits a tank — it bursts into 22 shrapnel pieces that phase through
    walls and never expire.
  - **Mortar**: indirect fire. Plants the tank while you aim, arcs over
    everything, lands where you put the reticle.
- **Defense and agility**: brick walls, armour, heal pads and mud pits;
  boost and phase.
- **Barrel hitboxes**: the barrel is part of the tank. It blocks against
  walls (swinging your gun into a brick stops the turn) and it can be
  shot — each weapon's barrel has its own shape.
- **Maze**: seeded recursive backtracker, regenerated every round, with
  a guarantee of at least two independent routes between spawns. Some
  arenas roll a non-rectangular silhouette.
- **Wall friction**: driving into a wall at ANY angle hard-stops the
  tank. Turn away first, then drive — no sliding.
- **Hitboxes**: tanks collide as true oriented rectangles matching their
  drawn treads (SAT physics), so shots skimming a tank's side genuinely
  miss, and rotation can be blocked by a nearby wall.
- **Closing zone**: in 1v1 it always runs; in custom lobbies the host
  decides. Cells at the rim turn red and start dealing damage, so a
  stalemate can't last.

## Bots

Four difficulties: Easy → Medium → Hard → Impossible. Bots emit exactly
the same actions a human does, so they obey identical movement,
collision and firing rules — speed and turn rate are capped at human
rates. What separates the tiers is how well they *think*: reaction time,
aim precision, movement prediction, dodge commitment, and how well they
play their abilities.

The brain runs as a pipeline: perception (nothing is known the instant
it happens — every stimulus is stamped and only becomes actionable once
that bot's reaction time has elapsed), belief (lagged target tracks),
decision (utility scoring with a commitment bonus so they don't dither),
and context steering (score every compass direction for interest and
danger, then low-pass the result so the hull sweeps instead of snapping).

Bots read the arena **as it currently stands**, not as it was generated:
a brick wall a player drops is a new dead end they route around, and mud
is a toll they'll pay only if going round costs more. Neither is known
instantly — a wall dropped in a bot's face still catches it out for a
reaction time first.
