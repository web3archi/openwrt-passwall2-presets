# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### 2026-11-26 — Census delegates seated-pool testing to PassWall2

- `fix(pool)`: census_run skips every balancing_node member (live UCI read each fire) — PW2 own burstObservatory already probes each pool member every probeInterval inside the live xray (subjectSelector `blc-`), so a census probe on them was pure duplicate load. The census ranks CANDIDATES only; literal harvesting of PW2 latency numbers is impossible (no Xray API inbound, BACKLOG P7). Settings rows of seated nodes now say so instead of showing stale stats. PW2 own probeInterval stays at 2 m: it is the balancer failover reaction clock, and changing it would need a restart (parked; the router must not be interrupted - a foreign test session is running).
- `docs`: SPEC-pool-manager.md §3 amended (skip-only delegation).

### 2026-11-24 - Census tunables in Settings; single probe again

- `feat(pool)`: the Pool manager section gains two operator fields: **Probe every N minutes** (`pool.probe_interval`, default 5, no ceiling - the census cadence, replacing the hardcoded 5-minute gate) and **Suggested pool size** (`pool.pool_size`, default 13, no ceiling - the ranked list cap, previously a script constant). Both are read live by the observer at the next cron tick; no PassWall2 restart involved.
- `fix(pool)`: the census is back to a SINGLE probe per fire (sampling=2, tried the same day, measured MORE chain disruption on this MT7621; BACKLOG P17 keeps the revisit trigger for stronger hardware).
- `docs`: BACKLOG P16 (per-service balancers, the b-ai pattern - not adopted, no feed stock) and P17.

### 2026-11-24 — Ghost checkboxes, probe run-switches, census throttle

- `fix(luci)`: every Save & Apply and Reset on Settings now ends in a full page reload (handleSaveApply/handleReset overrides with mode passthrough). Root cause of the returning checkboxes: luci.js never reloads after save/apply, so a long-lived tab carries its pre-Apply DOM and its next Apply re-writes stale checkbox state back into uci (the kill-switch re-ticked exactly that way, live-verified). Plain Save stays stock — its chain is shared by Save & Apply, reloading inside it would abort the apply halfway.
- `feat(luci)`: the four Probe checkboxes (A/B/C/D) in the Widget section double as the probe's own RUN switch: cfgvalue mirrors the probe gate (ip_via_proxy.enabled and friends), write sets BOTH the show flag and the gate. Unticked stops the probe entirely (no traffic, no CPU), not just hidden. Non-probe rows stay pure visibility switches.
- `fix(observer)`: census throttled from one probe per minute to ONE PER 5 MINUTES (minute divisible by 5) — test A (2026-11-24) measured the 1/min temp-xray spawn doubling the chain median (0.33 s quiet to 0.79 s with the census running). SPEC-pool-manager.md §1 amended accordingly.
- `ops(pool)`: balancer pool reseated to the ranked top of the fresh census stats after test A (single-node pool left the operator exposed to provider flaps; fallback stays the operator's Auto-LTE pick).

### 2026-11-24 — Two UI-state bugs: force_balancer clobbered the SOCKS preset; full-tree deploys reset live config

- `fix(luci)`: force_balancer no longer clobbers the Custom SOCKS preset. Sections save in insertion order, so fBal.write (pool) ran after customEnable.write (custom_socks) pointed the shunt default_node at its own node — and rewrote it to the Balancing sid, silently unseating the preset on the very same Apply (smoking gun in UCI: pool.prev_default_node remembered 'pw2p_custom_socks_node'). Now fBal.write returns without touching default_node whenever the custom_socks_enabled checkbox formvalue in the same save is '1' — the preset owns the shunt exit and dials through the Balancing node as its first hop anyway.
- `fix(deploy)`: router deploys of this tree must NEVER include files/etc/config — a full-tree tar overwrites the live /etc/config/passwall2_presets with the template and resets operator runtime state (killswitch.enabled was re-ticked this way, live-verified). Deploy code files only; config-template changes land only via explicit operator action.

### 2026-11-23 - Census hang: PW2 get_new_port memo exhaustion (upstream bug workaround)

- `fix(pool)`: census_run now cleans the stale `get_port_*` memo lines from `/tmp/etc/passwall2/var` before each probe. Root cause of the evening census hang (empty probe codes 19:22-21:44): PW2 own `get_new_port()` memoizes EVERY handed-out port and never releases it - netstat is the real occupancy check, so the memo only ever blocks reuse of this census own short-lived temp socks instances. At one probe per minute the allocation walk crawled +1 port per minute (251 dead entries observed) until it exceeded the probe timeout and `test.sh` hung; manual retest after cleaning returned 204:0.559 instantly. Other cache keys untouched.

### 2026-11-23 — Proposal slate pre-ticks (предрассаживание)

- `feat(luci)`: the Pool manager checkboxes now PRE-TICK the suggested slate — the top cutoff-qualified nodes of the rolling 24h census window (operator mandate: "after each round, propose the new best list") — instead of mirroring the current pool. A banner states the diff vs the live pool (+new / −dropped) because any Save & Apply on the page seats the slate; live-pool rows outside the slate render with a `· [current pool]` marker; zero qualified data keeps the live pool pre-ticked. `SPEC-pool-manager.md` §4 amended (proposal-slate semantics). Still passive: nothing seats without the operator's Save & Apply.

### 2026-11-23 — Pool manager live verification (60-probe chain measurement)

- `docs`: first 60-probe latency measurement through the live chain (shunt → Balancing → the operator morning pool-8; fallback = "Авто - LTE", operator decision), probed from the router through the same SOCKS chain LAN clients ride: success 59/60 (98.3%, one 8s timeout, **zero total outages** — the 2026-11-22 collapse class did not reproduce under this pool), median 0.79s / p90 1.88s / max 3.36s, spikes ≥1.5s in ~17% of probes. Exit-IP distribution across five nodes (19/15/12/9/2) — leastLoad rotation working as designed; per-exit medians 0.71–0.97s: no single bad node, the spikes are per-request provider variance (the same provider-flap class as 2026-11-22), not node-localized. Versus the 2026-11-22 pool-10 baseline: no total outage (vs one ~5-minute one), median up 0.35→0.79s — the price of rotation across five exits. No data-forced reseat; `expected` 4→2 concentration stays a one-restart operator option if a lower median is worth fewer active exits.

### 2026-11-23 — Pool manager (passive census, ranked seating)

- `feat(pool)`: observer census step — ONE `url_test_node`-class probe per minute on the existing cron grid (`--census` rides the last sleep-offset line via `--ensure-cron`; the grid and the 15s status freshness untouched), round-robin over the fitness-filtered census set (Xray vless/trojan, ss excluded, RU excluded, addon infra excluded), samples appended to `/overlay/passwall2-presets/pool-stats` (USB — survives reboot; 24h window pruned per write). `pool.enabled` gates it independently of `main.enabled`. Simplification from SPEC §2: verdict collapses to ok/fail (start-vs-dead proved ambiguous live 2026-11-22).
- `feat(luci)`: Settings gains a collapsible "Pool manager" section between Custom SOCKS5 and Preset A — the ranked suggestion list (cutoff: verdict ok + at-least-2 attempts + at-least-50% success + streak below 3; cap 13 = maximum, never a quota), per-row seat checkboxes (write() no-ops; the fallback dropdown's write() rebuilds the full seating in one pass and always removes the fallback sid from the pool), a single-select fallback dropdown (native at-most-one — the SPEC §4 two-checkbox mutex resolved as a dropdown), and the force-balancer mirror checkbox (writes only `rulenode.default_node`, remembers `prev_default_node`, restores only-if-current-is-ours; never touches `@global` node/tcp/udp). Seated-but-unqualified rows render marked instead of vanishing.

### 2026-11-23 — Pool manager design

- `docs`: `SPEC-pool-manager.md` — passive census (one probe per minute on the existing observer grid), 24h window metrics (p50/p90/success/streak) with a quality cutoff for the suggestion list (verdict ok + at-least-2 attempts + at-least-50% success + streak below 3; cap 13 = maximum, never a quota), broken-class start detection, the Settings collapsible section (ranked DummyValue rows + balancer/fallback mutex checkboxes), force-balancer as a mirror checkbox (writes only `rulenode.default_node`, never `@global` node/tcp/udp), write semantics (add_list pools, fallback-out-of-pool invariant, headless post-write self-check), and explicit kill-switch non-interaction.

### 2026-10-04 — Kill-switch: Settings section, arming window, first-cut fixes

#### Added
- `feat(killswitch)`: Settings page gains a collapsible Kill-switch section — an enable checkbox with an honest annotation (what the wall covers and the accepted leak residuals) and an Arming window field (15–60 s, default 15; the observer's polling cadence, realized as sleep-offset cron lines and regenerated on Save & Apply via ucitrack → the killswitch init's `reload()`; the wall state itself is never flashed by an apply). The widget-field annotations' stale "about every 30 seconds" strings updated to the window wording.
- Field acceptance the same day: an accidental Save & Apply restarted PassWall2 (11:59 UTC); the log shows `KILLSWITCH: armed` at 11:59:01, the watchdog's own restart behind the wall at 12:00:01, `disarmed` at 12:01:33 — 2.5 minutes of silence over leak on a live network (uptime continuous; the crash-class scenario, not the boot test).

#### Fixed
- `fix(observer)`: the drop rule carries no `comment` statement — this router's nft rejects rule comments (both statement orders fail with a syntax error, verified live); `ks_arm` now re-reads the chain and logs `ARM FAILED` if the rule did not land, instead of logging armed on a table-only check.
- `fix(config)`: the template's killswitch section is named `killswitch` (the first cut shipped `main`, mismatching observer reads and the Settings NamedSection; caught before any fresh install used it).


### 2026-10-04 — Kill-switch (no direct leak while PassWall2 is down) + observer hardening

#### Added
- `feat(killswitch)`: LAN→WAN nft drop armed at boot (init script `passwall2-presets-killswitch`, START=25) and by the observer whenever the chain is unhealthy; lifted only on a healthy xray + Probe A. Closes the "PW2 rules absent" leak windows (boot, crash, watchdog restart) that exposed the provider IP on 2026-10-03. Lock-free CLI `--arm|--disarm|--status|--ensure-cron`; `killswitch` config section (defaults ON when absent).
- `feat(observer)`: ~15s cron cadence (four `sleep`-offset lines) with idempotent `--ensure-cron` self-heal installed by the init script at every boot (the 2026-10-03 LuCI Scheduled-Tasks wipe class); the status JSON gains a `killswitch` field (UI row deferred, BACKLOG P14).
- `docs`: `SPEC-killswitch.md` — design, armed semantics, the two accepted residual windows, deploy/test protocol.

#### Fixed
- `fix(observer)`: the status file is written via `${STATUS_FILE}.tmp` + atomic `mv` — the LuCI Overview page no longer intermittently flashes "No status data yet" when its 5s poll lands inside the old truncate-then-write window.
- `fix(docs)`: the observer header comment referenced the stale `files/etc/crontabs/root-observer-watchdog` path; now points at `files/etc/passwall2-presets/crontab.snippet`.
## [v0.1.0] - 2026-10-01

### 2026-10-01 — Settings: Custom SOCKS5 preset

#### Added
- `feat(luci)`: descriptions for the 9 widget visibility fields on the Settings page (`f70a8b9`).
- `feat(preset)`: Custom SOCKS5 preset section at the top of Settings — host/port/user/pass + apply checkbox; the exit is the fixed SOCKS5, chained through the Balancing node (`a79f624`).
- `feat(preset)`: the preset drives the shunt's `default_node` / `default_proxy_tag`; the strategy field reads the live global `node` key; the Preset A Manual switch writes `node` too (`f7d3b99`).

#### Fixed
- `fix(luci)`: the Widget section is collapsed on page open (`4560eb0`).
- `fix(preset)`: the Manual wrapper node must be `Xray/socks` in PW2 26.7.16 (`type='Socks'` does not exist) (`dfeec15`).
- `fix(preset)`: the `custom_socks` UCI section is created on demand by the form; the repo config template carries it (`a772a4a`).
- `fix(preset)`: the strategy check references the renamed `mainNode` (`67d1eb0`).

### 2026-07-17 … 2026-07-23 — Observer watchdog, Overview and Settings pages

#### Added
- Initial import: `SPEC_v0.6.0` + legacy backlog from `openwrt-passwall2-watchdog` (`bc4d7a5`); English-first language policy (`2764c54`).
- Observer watchdog: 4-probe design (A/B/C/D) merged from the earlier watchdog idea; `observer_watchdog.sh` implementation; status file consumed by LuCI (`a6a2ed4`, `7a16246`).
- LuCI Overview page with the native Status widget, later reworked per feedback: row reorder, dead row removed, IP-stability timer, Probe A flag/country from real node data (`909856e`, `325c100`, `8f65e05`, `e39ea69`).
- LuCI Settings tab: Widget field-visibility checkbox list, widget popup size floor, Preset A read+write (`80aa027`, `c1bb8f0`, `41b7f59`).

#### Fixed
- UCI section-name collision in the passwall2_presets config (`43671c7`).
- `observer_watchdog.sh` node count reported 1 instead of 27 (`27e18ca`).

#### Documented
- P2 out-of-memory incidents (three occurrences) and the `monitor.sh` root-cause resolution; P5 preset-board survey; P6 IA plan; P11 strategy-read bug report; P12/P13 items — see `docs/BACKLOG.md`.
