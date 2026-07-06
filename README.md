# Tank Brawl 🎮

A 2–4 player tank battle in the spirit of AZ Tanks / Tank Trouble.
**This build is the menu only** — local join, online lobbies, and keybind
settings. The battle scene is the next step and has clean hook points
(listed at the bottom).

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
index.html            all menu screens
css/style.css         styles (mobile-first)
js/main.js            screen router, toast, shared helpers
js/settings.js        keybinds (localStorage)
js/local.js           local join flow
js/online.js          Firebase lobby flow
js/firebase-config.js paste your Firebase config here
netlify.toml          Netlify config (no build step)
```

## Hook points for the game scene (next step)

- **Local start** → joined colors are saved to
  `sessionStorage["tank.localPlayers"]` (e.g. `["red","blue"]`) and keybinds
  come from `getBinds()` in `js/settings.js`.
- **Online start** → host sets `state: "starting"`; every client's lobby
  listener sees it, which is where the game scene should take over.
  Your stable per-tab id is `sessionStorage["tank.playerId"]`.
