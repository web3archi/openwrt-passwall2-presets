# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
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
