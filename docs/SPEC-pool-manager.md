# SPEC — Pool manager (passive census, ranked seating)

- **Status:** accepted (operator design session 2026-11-22 evening + 2026-11-23
  resolutions: census cadence = 1/min on the observer grid, pool cap = constant 13 with
  a quality cutoff, no on-demand speed button — PW2 own UI covers it. Passive mandate:
  no automatic seating, no automatic rollback; everything that can stay a
  PassWall2-native runtime behavior stays one)
- **Scope:** `files/etc/passwall2-presets/observer_watchdog.sh` (census step),
  `files/etc/config/passwall2_presets` (pool section),
  `files/etc/passwall2-presets/crontab.snippet` (mechanism unchanged, census rides it),
  `files/www/luci-static/resources/view/passwall2-presets/settings.js` (Pool manager
  section). **Out of scope:** the kill-switch (coexistence rules only, §7), subscription
  management, Widget/Overview rows (BACKLOG), any throughput measurement (rejected
  2026-11-23: the operator measures speed in PassWall2 own UI when needed).

## Context

2026-11-22: the balancer was rebuilt live (pool-13 across two providers, fallback =
"Авто | Самый быстрый"), and the same day three suspected "poisoned pool" incidents were
root-caused to *path drift*, not pool composition: a Settings-page save had switched
`passwall2.@global[0].tcp_node/udp_node` to the addon manual preset, and the shunt
`default_node` had been moved off the Balancing node — the config generator then
correctly omitted a balancer no longer in the active path. Two stable tools came out of
that day and are normative here:

- **Headless generation** (`lua /usr/lib/lua/luci/passwall2/util_xray.lua gen_config`
  with a JSON var and `no_run`, output redirected to a file — reads COMMITTED uci, never
  touches the live xray): any pool/shunt composition is verified *before* apply, with
  zero restarts. Acceptance criteria for every write path in this SPEC are headless
  checks.
- **Fallback resolution rule** (read from `util_xray.lua` gen_balancer, verified live):
  a fallback node that is ALSO a pool member resolves to `blackhole` silently (its
  outbound tag already exists, the second generation returns nil). A fallback OUTSIDE the
  pool resolves to its real tag. Therefore **fallback_node ∩ balancing_node = ∅** is an
  invariant, enforced at write time (§6) and visible in the UI (§4).

The operator mandate (verbatim intent): the addon is *passive* — it measures, ranks, and
seats proxies ONLY on an explicit checkbox selection + Save & Apply; it never reseats or
rolls back on its own. Where the balancer routes traffic under failure, that is PassWall2
own leastLoad/fallback runtime, not us.

## §1 Census (the periodic measurement)

- **Cadence: ONE census probe per minute** — the observer cron grid (sleep-offset lines,
  15s cadence) is NOT touched; the census step runs on exactly one of the four observer
  ticks (the `sleep 45` line), i.e. once per minute (AMENDED 2026-11-24: throttled to once per 5 minutes by the
  minute-divisible-by-5 gate in census_run — test A showed the 1/min temp-xray spawn
  doubled the chain median, 0.33 s quiet to 0.79 s with the census running). A full sweep of ~90 sections is
  ~90 min; per-probe memory is occupied ~5% of the time. The status/watchdog freshness
  keeps its native 15s cadence (operator resolution 1, 2026-11-23).
- **One probe per census fire**: the PW2-native method — a temporary local socks instance
  with that node as outbound, `curl -I` against the global `url_test_url`, warm-up +
  measured pass. The existing observer lock covers it: lock busy → the census step is
  skipped this tick (load stays ≤ 1 probe; the sweep self-slows under contention).
- Per-probe cost is one short-lived xray (~30–50 MB RSS, measured live 2026-11-22) —
  memory-safe singly, which is why there is never a batch mode.
- **State**: `/tmp/passwall2_presets/` stays volatile (status), but **stats live on the
  overlay** (`/overlay` is USB and survives reboot — the 2026-11-22 reboot wiped a tmpfs
  status and the Overview empty): one JSON file, per-node records, pruned past 7 days. No
  secrets — node ids, latency, verdicts only.
- **Census is observation only**: it never restarts PassWall2, never writes `passwall2`,
  never arms/disarms anything (§7).

## §2 Metrics (per node, all from census probes)

- `p50`/`p90` latency over the 24h window (probe `time_pretransfer`), `last` latency,
  `success_rate` 24h, `fail_streak` (consecutive failures, resets on any success),
  `since_ok` (time since last success), `attempts` 24h. Hierarchy score = p50 primary,
  success_rate tiebreak, fail_streak penalty.
- `verdict` per node: `ok` (answers), `unreachable` (probe fails but the temporary
  instance STARTS — server-side down, keep sweeping), `broken` (the temporary instance
  fails to START — config-class failure, the "Франкфурт" class from 2026-11-22; ranked
  out of the hierarchy until a manual retest changes it).
- **List cutoff** (operator resolution 2, 2026-11-23 — the suggestion list is earned,
  not padded): a node appears in the ranked suggestion list only if
  `verdict == ok` AND `attempts_24h >= 2` AND `success_rate_24h >= 50%` AND
  `fail_streak < 3`. Script constants (`CENSUS_*` in observer_watchdog.sh), tunable in
  place. A flapping or data-starved node simply does not appear — if three qualify,
  three rows it is.

## §3 Census set (who gets probed) and fitness

- All `nodes`-type sections whose `type` is Xray-compatible **and** protocol in the
  allowlist (`vless`, `trojan`). Explicitly excluded: `ss`/`ssr` (operator 2026-11-22:
  the protocol does not work here; schema never verified), `_balancing`/`_shunt`
  carriers themselves, and the addon own infrastructure sections (`pw2p_*`,
  `custom_socks`).
- **Not RU**: sections flagged RU in remarks/group are excluded from candidacy (group
  value `RU`, or remarks carrying the RU flag — the existing convention in this config).
  Exit-IP geo-check is a later optional refinement (Probe A already exposes the exit IP
  of the active path).
- **Seated nodes are NOT census-probed** (operator decision 2026-11-26): every
  balancing_node member is live-tested by PW2 own burstObservatory (subjectSelector
  `blc-`, every `probeInterval` inside the running xray), so a census probe on them is
  duplicate load; the census ranks CANDIDATES only. Harvesting PW2 own latency
  numbers is impossible (no Xray API inbound, BACKLOG P7) - delegation is skip-only.
- The census set may be probed even when not seated anywhere (measurement is global;
  seating is a separate manual act).

## §4 UI — Settings, collapsible "Pool manager"

- Placement: collapsible `<details>` section between **Custom SOCKS5** and **Best node
  (Preset A)** (operator-specified order, 2026-11-22), same wrapInDetails mechanism as the
  existing sections; collapsed by default (P12.7 convention).
- **Force-balancer checkbox at the top of the section** (§5) — the one mode control.
- **Ranked list**: one row per cutoff-qualified candidate, non-editable stat cells
  (DummyValue: rank, remarks/geo, verdict, p50/success/streak/since-ok — one line each,
  doc conventions), plus TWO checkbox columns: `→ balancer` (seat into the pool) and
  `→ fallback` (seat as THE fallback). Checkboxes are UI-time and write-time mutex:
  ticking fallback unticks balancer for that row, and **fallback is at most ONE row**
  (ticking a second fallback unticks the first — PW2 schema holds one sid).
- **Proposal slate** (operator mandate 2026-11-23: "предрассаживание — после каждого круга
  предложить новый список"): the checkboxes PRE-TICK the suggested slate — the top
  cutoff-qualified nodes of the rolling 24h census window — instead of mirroring the
  current pool. A banner states the diff vs the live pool (+new / −dropped) because ANY
  Save & Apply on the Settings page seats the slate; rows seated in PW2 but outside the
  slate stay visible with a `· [current pool]` marker. Zero qualified data → the live
  pool stays pre-ticked (no surprise empty reseat). Seating still happens ONLY on the
  operator's Save & Apply — the pre-ticks are a proposal to review, not an action; the
  passive mandate is unchanged.
- **Pool cap = 13, a constant** (operator resolution 2, 2026-11-23: not a UCI field, no
  ceiling slider): the suggestion list shows at most 13 rows — the best-score
  cutoff-qualified nodes, pre-ticked with the current pool membership. **13 is a
  maximum, not a quota** — fewer qualifying rows render fewer rows, honestly. The
  operator is never obliged to tick all of them; seating seats whatever is ticked.
- Save & Apply on this page is a normal LuCI save: the form write path (§6) does the
  seating, ucitrack restarts PassWall2 once. No option on the page validates in a way
  that can reject the whole map (the 2026-11-22 `52e5f9a` lesson).

## §5 Force-balancer (the top checkbox)

- **Ticked** → write `passwall2.rulenode.default_node = <the discovered _balancing node>`
  (the shunt STAYS the Main node: RU-direct rules keep flowing; only its default target
  moves) and remember the displaced value under this section (`prev_default_node`) for
  restore. **Never** touches `@global[0].node/tcp_node/udp_node` — the 2026-11-22 drift
  that took the whole path down came from exactly there, and the manual-preset write path
  that does that remains a separate explicit user action in its own section.
- **Unticked** → restore `prev_default_node` ONLY IF the current `default_node` is still
  our Bal sid (never clobbers a value the user set by hand meanwhile); no remembered
  value → write nothing, show a notification that the shunt was left as found.
- **No shunt configured** → the checkbox is inert with an inline notice (we do NOT
  create a shunt; the Balancing node discovery failure is reported, per the 2026-07-22
  policy of not creating PW2 entities for the user).
- Checkbox state is a MIRROR: cfgvalue reads whether `rulenode.default_node` currently IS
  the Bal sid — not a stored flag. Single source of truth is `passwall2` itself.

## §6 Write semantics (Save & Apply)

- Pool: `uci -q delete passwall2.<bal>.balancing_node` then `uci add_list` per selected
  sid — **never `uci set` with a space-joined string** (the 2026-11-22 crash:
  LuCI `api.lua:1854 concat` — lists must be lists).
- Fallback: `uci set passwall2.<bal>.fallback_node = <sid>`, and the write path FIRST
  removes that sid from the pool list if present (the Context invariant;
  headless-verified 2026-11-22: an in-pool fallback degrades to `blackhole` silently).
- Post-write self-check (in the write path, before the ucitrack restart): headless
  `gen_config` over the committed state must show `balancers >= 1`, `blc-*` tags equal
  to the ticked pool count, and the resolved `fallbackTag` equal to the chosen sid tag;
  a mismatch logs a notification and an honest "not applied cleanly" message — no
  silent half-states.
- The addon never restarts PassWall2 from the observer/census path; restarts happen only
  through this explicit Save & Apply (ucitrack) or the user own actions.

## §7 Kill-switch coexistence (explicit non-interaction)

- The pool manager never calls `--arm`/`--disarm`, never reads the wall state, and is not
  part of the observer healthy/unhealthy verdict. The census temporary socks instances
  dial out through the output chain (exactly like PW2 own xray and the existing
  `url_test_node`), which the wall forward-chain drop does not touch — armed or disarmed,
  the census works the same.
- Config independence: pool/force-balancer state lives in its own `config pool` section;
  the killswitch section remains owner-only of its fields. The two features meet only as
  sections on the same Settings page.

## §8 Storage & template

    config pool
        option enabled              1   # census on/off (ranking still renders last data)
        option prev_default_node        # force-balancer restore memory (§5)

Stats: `/overlay/passwall2-presets/pool-stats.json` (7-day prune, no secrets). Census
cursor: state dir (volatile is fine — a reboot just restarts the sweep). Cutoff
constants: `CENSUS_MIN_ATTEMPTS=2`, `CENSUS_MIN_SUCCESS=50`, `CENSUS_MAX_STREAK=2` (a
streak of 3 excludes), `POOL_CAP=13` — in observer_watchdog.sh.

## §9 Acceptance (all headless-first)

1. Census: 60 sequential minutes probe ~60 distinct set members, cursor advances, stats
   grow, one xray at a time (`ps` check), lock contention skips (no overlap); observer
   status keeps its 15s freshness (untouched grid).
2. Broken-class detection: a known non-starting section (the "Игры|Франкфурт" class,
   confirmed 2026-11-22) gets `verdict: broken` and never appears in the suggestion list.
3. Cutoff honesty: a node with 1 attempt, or 40% success, or an active fail streak does
   not appear; N qualifying nodes render N rows (≤ 13), never padded.
4. Seating write: tick 13 + one fallback → Save & Apply → committed uci has a 13-element
   LIST + a single fallback sid; headless gen shows `balancers=1`, `blc-*` count 13,
   `fallbackTag` resolved to the fallback tag; PassWall2 restarts once via ucitrack.
5. Mutex: ticking fallback on a pooled row removes it from the pool in the same save; a
   second fallback tick displaces the first (UI + write).
6. Force-balancer: tick → `rulenode.default_node` = Bal sid, prev remembered, `@global`
   node/tcp/udp UNTOUCHED (diff-verified); untick → restore only-if-current-is-ours.
7. Kill-switch: with the wall armed and the chain healthy, a census fire neither arms,
   disarms, nor delays (log delta shows no wall transitions).
