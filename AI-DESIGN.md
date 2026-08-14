# Tank Brawl — AI design

Written before any code, because the last three attempts failed for the
same reason: I started writing behaviour before I understood what the
game's mechanics actually *permit*. Everything below is grounded in the
real constants, listed first.

The plan is to build **one expert AI** whose decisions are correct, then
derive the lower tiers by degrading its perception and judgement — never
by handicapping its hands.

---

## 0. The mechanics that shape everything

Measured from the code, not assumed.

| Fact | Value | Why it matters |
|---|---|---|
| Turret is welded to the hull | — | Facing **is** direction of travel. A tank cannot aim one way and strafe another. This single constraint drives most of the design. |
| Forward / reverse | 121 / 83.5 px/s | Reverse is **69%** speed. It keeps the gun on target but costs mobility — a deliberate trade, not a default. |
| Accel / brake | 0.5 s / 0.2 s | **Stopping is 2.5× quicker than starting.** Braking is cheap, committing is expensive. |
| Turn rate / spin-up | 3.36 rad/s / 0.28 s | A 180° turn takes ~1.2 s including spin-up. Reversing out is often faster than turning around. |
| Tank size | 21.8 px radius, cell 96 px | A tank is under a quarter of a corridor. Two can pass; gaps matter. |
| Health | 10 HP | |
| Bullet | 184 px/s, **6 s life, bounces** | A bullet crosses a cell in ~0.5 s and stays lethal for 6 s. The arena fills with ricochets. |
| **Own bullets kill you** after 75 ms | — | Firing into a confined space is genuinely dangerous. |
| Basic mag | 3 rounds, 0.5 s apart, **3.5 s each to regen** | Sustained fire is one shot per 3.5 s. Ammo is a resource to spend deliberately. |
| Zone | first at 30 s, then every 30 s; 1 dmg / 2 s per layer of depth | Crossing one layer for 4 s costs ~2 HP. This is a *computable* price. |

**Damage:** basic 3 · MG 1 · cannon ball 5 (+2 per shrapnel, 36 of them) ·
rocket 7 · sniper 7 · laser 7 at zero bounces, −1 per bounce (min 1).

**Abilities:** armour +6 HP / 20 s · heal 1 HP per 0.86 s for 6 s (~7 HP,
but you must *stand on a 48 px pad*) · wall 12 HP / 20 s · mud 0.3× speed
/ 30 s · boost 1.4× / 6 s · phase intangible 1 s.

Two numbers stand out. **Armour (+6) is worth more than most single
weapons deal.** And **a full heal (~7 HP) is worth more than any single
hit in the game** — which is exactly why "win the heal-off" is a real
strategy and needs to be modelled, not hand-waved.

---

## 1. Architecture

Four stages, run in order, each with one job. Every stage reads a
**belief**, never the live world, so reaction time is structural rather
than a delay bolted on afterwards.

```
SENSE   → build/age the belief: enemies, projectiles, gear, zone, threats
ASSESS  → score the situation: am I winning? safe? armed? cornered?
DECIDE  → pick ONE intent from a utility set, then COMMIT to it
ACT     → resolve intent into steering + gun + ability, honouring inertia
```

**Why commitment matters:** every previous version dithered because it
re-decided every frame and the top two options kept swapping. An intent
is held for a minimum dwell time and only interrupted by a *hard
interrupt* (see §4). That is the difference between a tank that looks
like it has a plan and one that vibrates.

---

## 2. Navigation

Three layers, because one is never enough:

1. **Route (global).** BFS over the maze's passage graph to the target
   cell. Recomputed only when the goal cell changes or every ~2 s —
   never mid-junction, which is what caused the pirouetting.
2. **String-pull (mid).** Aim at the furthest waypoint on a clear line,
   not the next cell centre, so the tank cuts corners smoothly.
3. **Steering (local).** Context steering over 24 directions, scoring
   openness, goal alignment, threat, and **forward bias** (reverse is
   69% speed, so backwards headings must be genuinely better to win).

**Clearance probing** uses the hull's true half-width (14.3 px), not the
bounding radius (21.8) — that mistake made every corridor read as
blocked and is why bots crept and stalled.

**Wall-hug avoidance:** probe far enough ahead (≈4 tank-lengths) that the
turn begins before contact. A tank that only sees the wall at the nose is
already committed.

**Stuck watchdog:** if commanded movement produces no displacement for
0.7 s, force a committed reverse-and-turn for 0.7 s. Steering is a local
method and *will* occasionally trap itself; the recovery must exist.

---

## 3. Dodging — the hard part

This is where the game is won, and where every previous version was
weakest. Three distinct problems:

### 3a. Threat modelling
Each projectile is reduced to: **time to closest approach**, **miss
distance at that time**, and **which way to step to increase the miss**.
Rockets get a shorter effective time (they steer). Lasers are
instantaneous — there is no dodging the shot, only *not being on the
line*, so they're modelled as a line to vacate, not an object to avoid.

### 3b. Bounces
Bullets live 6 s and ricochet. A threat model that only looks at the
current velocity vector will walk a bot into a round that is about to
come off a wall. Projectile paths are therefore **raycast forward through
up to 2 bounces**, and each segment is treated as its own threat.

### 3c. Multiple projectiles — worst-case, not sum
The critical fix. Scoring each threat independently and adding lets a
direction that dodges one shot beautifully while driving into another
come out on top. **A heading is only as good as the round it handles
worst** — so directions are scored by their *minimum* safety across all
live threats.

"Finding a path between active projectiles" then falls out naturally: it
is the direction whose worst-case miss distance is still positive. If no
direction is safe, pick the least-bad *and* escalate to an ability
(phase > boost > wall).

### 3d. Commitment
A dodge is held for ~0.5 s unless a *better* dodge appears. Re-choosing
each frame produced two half-dodges and a hit. And a dodge must be
*reachable*: given 0.5 s accel and 0.28 s spin-up, a direction the tank
cannot actually get to in time scores zero.

---

## 4. Aggression — when to press, when to break

A single **posture** value, recomputed on the planning tick, from:

- **Health ratio** — mine vs the nearest threat's
- **Ammo state** — rounds in hand and time to next round
- **Weapon matchup** — do I out-range them? (sniper 5 cells vs flame 1)
- **Ability state** — armour up? phase available? their armour up?
- **Position** — am I between them and safety, or the reverse?

Producing one of:

| Posture | When | Behaviour |
|---|---|---|
| **Press** | Healthy, armed, favourable matchup | Close to preferred range, hold the line, fire |
| **Trade** | Even | Hold preferred range, fire on good solutions only |
| **Disengage** | Low HP, dry, or out-ranged | Break line of sight, regain ammo/heal, re-approach |
| **Reposition** | Cornered or zone-pressed | Movement is the only objective; fire only if free |

**Hard interrupts** override posture immediately: a round that will hit
within ~0.3 s, the zone claiming the cell I'm standing in, or death being
one hit away.

**Preferred range is per weapon** — flame wants 0.6 cells, sniper 4,
mortar arcs over walls entirely. Fighting at the wrong range is a common
way for a bot to look stupid while doing everything else right.

---

## 5. Pickups — when it's worth breaking off

Score each crate: `value(type) − travel_cost − exposure_cost`.

- **Value** depends on what I already hold. Another gun when armed is
  worth almost nothing — *this is what made bots orbit crates they
  couldn't use*. Armour at 4 HP is worth more than any weapon.
- **Travel cost** is BFS path length, not straight-line distance.
- **Exposure cost** is time spent in an enemy's likely firing line, plus
  zone damage along the route.

Contest logic: if an enemy is closer to the crate than I am, going for it
means arriving second *and* being shot on the way. Only contest when I'd
win the race or I'm strong enough to want the fight.

---

## 6. The zone

### 6a. Escaping
The zone shrinks inward from the arena outline. Safety is "inside the
current inset polygon". Escaping is a **routing** problem: BFS to the
nearest cell that is (a) safe now, (b) still safe two layers deeper, so
the bot doesn't flee into ground that dies next.

Timing matters — with a 5 s warning and a 30 s period, a bot should
begin moving when `travel_time + margin > time_until_this_layer_dies`,
not when the damage starts.

### 6b. Crossing it deliberately
The interesting case, and it's arithmetic:

```
cost    = ceil(seconds_in_zone / 2) × layer_depth        (HP)
benefit = damage I can land + position I gain
```

Crossing one layer for 4 s costs ~2 HP. Worth it to finish a 3 HP enemy;
never worth it to reposition. This makes "should I cut through the red to
reach them" a decision with a number behind it rather than a vibe.

### 6c. The heal-off
When both tanks are low and the zone is closing, the game becomes: who
banks more HP before the ground runs out. The bot should recognise this
state — *both low, zone advanced, heal available* — and switch to
denying the enemy's heal (a heal pad is a fixed 48 px point they must
*stand on* for 6 s, which makes them a stationary target) rather than
racing for its own. **Interrupting a heal is worth more than landing a
hit**, because it denies ~7 HP.

---

## 7. Using every ability properly

Each has a trigger condition, a timing rule, and a *don't* clause.

| Ability | Use when | Timing | Never |
|---|---|---|---|
| **Armour** (+6/20 s) | Before an exchange, or when a heavy hitter has a line on me | Early — it's prevention | Refresh while still up; waste on a fleeing enemy |
| **Heal** (~7 HP/6 s) | Below 60% **and** out of contact | Needs 6 s of safety; check no enemy has a line | Drop it while being shot — you're a stationary target on a known point |
| **Wall** (12 HP/20 s) | Break a line of fire; block a corridor behind me | Reactively, against beams/heavy shots | In the open where it can be walked around |
| **Mud** (0.3×/30 s) | Behind me while breaking contact; on a chokepoint | Predictive — where they *will* be | On ground I need to cross myself |
| **Boost** (1.4×/6 s) | Closing a gap, escaping, racing to a crate, outrunning the zone | Whole-second commitment | As a dodge — too slow to start (0.5 s accel) |
| **Phase** (1 s intangible) | A shot that *will* land; crossing a laser line | **Late** — spend it ~0.2 s before impact or it lapses | Early, or against a shot that would miss anyway |

Phase timing is the sharpest skill expression in the kit: 1 s of
invulnerability spent 0.8 s early is wasted entirely.

---

## 8. Playing around *enemy* abilities

Reading the opponent is what will make this feel intelligent:

- **Enemy phasing** → hold fire. Rounds pass straight through. Keep the
  gun on and wait the 1 s out. (Wasting a 3-round magazine into a ghost
  is one of the most obviously-dumb things the old AI did.)
- **Enemy armoured** → +6 HP means the trade maths just changed. Either
  disengage until it lapses (20 s) or commit to burst damage.
- **Enemy healing** → they are stationary on a known point for 6 s.
  This is the single best attack window in the game. Take it.
- **Enemy boosting** → they close faster than expected; lead further and
  expect the range band to collapse.
- **Enemy wall** → line of fire is gone; reroute rather than shoot it
  (12 HP is four basic rounds).
- **Enemy mud** → treat as terrain to route around, not danger.
- **Enemy holds flame** → their threat is a 1-cell cone; the counter is
  simply *range*. Never brawl a flamethrower.

---

## 9. Firing discipline

- **Never fire into a wall at point-blank** — own rounds are lethal after
  75 ms and bounce back.
- **Check the line** for team-mates and, for a bouncing round, for
  *myself* on the ricochet path.
- **Ammo economy:** with 3.5 s regen per round, hold at least one round
  for a defensive shot unless the kill is on.
- **Weapon-specific:** mortar ignores line of sight (arcs over walls) —
  it should be used *from* cover; laser damage falls 7→1 with bounces, so
  it wants a direct line; MG has a 0.5 s wind-up, so it must be started
  *before* the target is in the cone.

---

## 10. Deriving the lower tiers

Once the expert is right, weaker tiers come from degrading **perception
and judgement**, never the hands. Handicapping speed or turn rate makes a
bot feel broken; degrading its information makes it feel human.

| Knob | Expert | Hard | Medium | Easy |
|---|---|---|---|---|
| Reaction latency | 0.13 s | 0.20 | 0.30 | 0.45 |
| Belief staleness (target lag) | 0.05 s | 0.10 | 0.18 | 0.30 |
| Threats considered at once | all | 3 | 2 | 1 |
| Bounce lookahead | 2 | 1 | 1 | 0 |
| Aim error | ~0 | small | moderate | large |
| Lead fraction applied | 1.0 | 0.85 | 0.55 | 0.25 |
| Ability recognition | always | usually | sometimes | rarely |
| Phase timing precision | ±0.1 s | ±0.2 | ±0.4 | mistimed |
| Zone cost arithmetic | exact | approximate | crude | ignores |
| Planning cadence | 180 ms | 240 | 320 | 420 |

**Speed and turn multipliers stay at 1.0 for every tier.** A weak bot
should lose because it reacted late, dodged one bullet instead of three,
and mistimed its phase — not because it drives like it's in treacle.

The "threats considered at once" knob is the one I expect to matter most:
it degrades gracefully and produces exactly the failure a human makes
under pressure — dodging the obvious round and walking into the other one.

---

## 11. Verification plan

I have no way to *play* this, so behaviour must be measurable. Before
shipping I'll assert, in a real maze with the real movement integrator:

1. **Navigation** — reaches a goal across the map; < 5% of frames in
   wall contact; no stalls.
2. **Smoothness** — turn-direction reversals per second below a
   threshold, with no incoming fire.
3. **Reverse usage** — < 10% of movement, and only when justified.
4. **Dodging** — hits taken from 1-, 3- and 5-round volleys, and the
   numbers must *separate by tier*.
5. **Gear** — never paths to a weapon crate while armed.
6. **Zone** — never sits in red ground; leaves before the layer falls.
7. **Abilities** — each fires under its intended condition and not
   otherwise; phase lands within its window.
8. **No stupidity** — never fires into a phasing target; never fires
   point-blank into a wall.

Every one of those is a number I can put in front of you rather than a
claim that it "feels better".
