# Tank Brawl 🎮

A 2–4 player tank battle in the spirit of AZ Tanks / Tank Trouble.
**This build (v0.3)** adds combat: bouncing bullets (5 live per tank,
they kill anyone — including you), bot tanks with 3 difficulties for
local AND online (so you can play solo), rounds with scores, and
Tank-Trouble wall friction — touching a wall at any angle is a hard
stop; tanks never slide along walls.

Rename the game freely — the title only lives in `index.html`.

## The stack (and who does what)

| Piece | Job |
|---|---|
| **GitHub** | Source of truth for the code |
| **Netlify** | Hosts the site (pure static files, no build step) |
| **Firebase Realtime Database** | Online lobbies (create / join by 4-digit code) |
| **localStorage** | Saves each player's keybinds on their device |

Local battles work with zero setup — Firebase is only loaded when
someone opens the Online screen.

## Run it locally

ES modules need a web server (double-clicking `index.html` won't work):

```bash
# from the project folder — either of these:
python3 -m http.server 8080
npx serve
```

Then open http://localhost:8080

## Firebase setup (~5 min, needed for Online only)

1. Go to https://console.firebase.google.com → **Add project** (Analytics optional).
2. In the project: **Build → Realtime Database → Create database** → start in **locked mode**.
3. In the **Rules** tab, paste this and publish:

   ```json
   {
     "rules": {
       ".read": false,
       ".write": false,
       "lobbies": {
         "$code": {
           ".read": true,
           ".write": true,
           ".validate": "$code.matches(/^[0-9]{4}$/)"
         }
       }
     }
   }
   ```

   > These rules are open enough for development (anyone can read/write
   > under `/lobbies`). Tighten them before a serious launch — e.g. add
   > Firebase Anonymous Auth and validate writes per player.

4. **Project settings (gear icon) → Your apps → Web (`</>`)** → register an app.
5. Copy the `firebaseConfig` object it shows you into `js/firebase-config.js`,
   replacing the placeholders. (Firebase web keys are public identifiers,
   not secrets — committing them is normal. The rules are the lock.)
6. Reload the site — the Online screen now shows Create/Join.

## Deploy: GitHub → Netlify

```bash
git init
git add .
git commit -m "Tank Brawl: menu build"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tank-brawl.git
git push -u origin main
```

Then on https://app.netlify.com → **Add new site → Import an existing
project** → pick the repo. Leave the build command **empty**; the
included `netlify.toml` already sets the publish directory to the repo
root. Every push to `main` auto-deploys.

## Default controls (rebindable in Settings)

| Tank | Forward | Reverse | Left | Right | Shoot |
|---|---|---|---|---|---|
| 🔴 Red | W | S | A | D | Space |
| 🟢 Green | ↑ | ↓ | ← | → | Enter |
| 🔵 Blue | I | K | J | L | O |
| 🟡 Yellow | T | G | F | H | Y |

On phones (no keyboard), players tap a tank's card to join local play.

## How online lobbies work

Data lives at `lobbies/{code}` in the Realtime Database:

```
lobbies/8341: {
  createdAt: <server timestamp>,
  hostId: "<player id>",
  state: "waiting" | "starting",
  players: { "<player id>": { joinedAt: <server timestamp> } }
}
```

- Codes are random 1000–9999; creation rerolls if a code is taken.
- Max 4 players; colors are assigned by join order (red → green → blue → yellow),
  so every client derives the same colors with no extra writes.
- `onDisconnect` removes a player automatically if their tab dies; if the
  host vanishes, the oldest remaining player claims host.
- Leaving as the last player deletes the lobby. (Abandoned empty lobbies
  from hard disconnects can linger — a cleanup function is a nice later add.)

## Project map

```
index.html            all screens (menus + battle arena)
css/style.css         styles (mobile-first)
js/main.js            screen router, toast, shared helpers
js/settings.js        keybinds (localStorage)
js/local.js           local join flow + bot slots
js/online.js          Firebase lobby flow, bots, round/shot/death sync
js/maze.js            seeded RNG, maze generation, wall + ray geometry
js/game.js            arena: movement, shooting, rounds, collision
js/ai.js              bot drivers (easy / medium / hard)
js/firebase-config.js paste your Firebase config here
netlify.toml          Netlify config (no build step)
```

## How the battle works (v0.3)

- **Maze**: seeded recursive backtracker — a perfect maze with zero
  closed loops; players 1 & 2 spawn in opposite corners.
- **Wall friction**: driving into a wall at ANY angle hard-stops the
  tank (no sliding). Turn away first, then drive — like Tank Trouble.
- **Hitboxes**: tanks collide as true oriented rectangles matching
  their drawn treads (SAT physics) — shots skimming past a tank's
  side genuinely miss, and rotation can be blocked by a nearby wall.
  Bullets test against the exact rectangle too. Arena is white with
  gray walls, Tank-Trouble style, and barrels are as thick as the
  shots they fire.
- **Shooting**: each tank keeps up to 5 bullets alive; bullets bounce
  off walls for 6 seconds and kill whoever they touch — including
  the tank that fired them. Last tank alive wins the round; scores
  show in the battle header, and a fresh maze spawns each round.
- **Bots**: on the Local screen, tap a slot's bot chip to cycle
  Easy → Medium → Hard. In an online lobby the host taps "Add a bot
  tank" (and taps the bot's chip to change difficulty, ✕ to remove).
  Bots use real pathfinding and the exact same physics as players.
- **Online authority**: every client simulates its own tank and
  reports its own shots and death; the host's client also drives the
  bots and pushes each new round's seed. If the host leaves, the
  next player takes over automatically.
- **Phone controls**: ⟲ ⟳ turn, ▲ ▼ drive, FIRE shoots.
