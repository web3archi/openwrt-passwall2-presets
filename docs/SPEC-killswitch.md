# SPEC — Kill-switch (no direct leak while PassWall2 is down)

- **Status:** accepted (operator, 2026-10-04: variant "state-mirror", 15s cadence); amended twice the same day after live acceptance (armed-semantics correction; Settings section + arming window)
- **Scope:** `files/etc/passwall2-presets/observer_watchdog.sh`, `files/etc/init.d/passwall2-presets-killswitch`, `files/etc/config/passwall2_presets`, `files/etc/passwall2-presets/crontab.snippet`, `files/www/luci-static/resources/view/passwall2-presets/settings.js`

## Context

2026-10-03: an unclean router reboot left a window with PassWall2's nft rules absent;
fw4's zone-accept forwarded LAN traffic out the WAN directly → provider IP → OpenRouter
access cut. The same evening a LuCI Scheduled-Tasks save zeroed `/etc/crontabs/root`
(observer dead for 12h). A flat lan→wan drop cannot work as a standing rule: the shunt's
RU-direct for TCP rides Xray's own outbound (output chain) and never traverses forward,
PW2 marks only proxied flows (`0x50535732`), and nft sets cannot be referenced across
tables — hence the state-mirror below, not an always-on drop.

## Design (state-mirror)

- Table `inet psw2_ks`, chain `ks_fwd` `{ type filter hook forward priority -10; policy accept; }`,
  one rule: `iifname <lan_if> oifname <wan_if> counter drop`. Priority -10 runs before
  fw4's filter chain (priority 0). Family inet = dual-stack (a future wan6 delegation is
  covered too). NOTE: no `comment` statement on the rule — this router's nft build does
  not support rule comments (both statement orders fail with a syntax error, verified
  live 2026-10-04); the table name is the identifier. `ks_arm` logs "armed" only after
  re-reading the chain and confirming the drop rule actually landed (a table-only check
  once reported armed with an empty chain — caught during the 2026-10-04 acceptance).
- Boot: the init script (START=25, after firewall4@19, before passwall2@99) arms the wall
  and calls `--ensure-cron`. Boot default ARMED.
- Observer (once per arming window): healthy = xray alive AND (Probe A ok OR Probe A not
  configured) — deliberately NOT the watchdog STATUS string, so protection is independent
  of `watchdog_enabled`. Healthy → disarm (the only place the wall lifts); unhealthy →
  arm. The watchdog's own restart branch arms BEFORE `/etc/init.d/passwall2 restart`.
- Config `config killswitch 'killswitch'` (the NAME must match the observer's reads and
  the Settings NamedSection; the first cut shipped 'main' in the template — caught before
  any install): `enabled` (default 1 when the section is absent — a config loss never
  silently disables the kill-switch), `window` (15–60 s, default 15 — the observer
  polling period and the bound on the arm delay after an unscheduled crash),
  `lan_if` (br-lan), `wan_if` (wan).
- Cron: sleep-offset lines generated from the window (15 s → offsets 0/15/30/45), kept
  canonical by `--ensure-cron` (idempotent, preserves foreign lines, bumps the crontab
  dir mtime — busybox crond rescans without a restart).
- Apply path: Settings > Kill-switch → Save & Apply → `uci commit passwall2_presets` →
  ucitrack (`passwall2_presets` → init `passwall2-presets-killswitch`) → the init's
  `reload()` → `--ensure-cron` only; the wall state itself is never flashed by an apply —
  the observer alone owns arm/disarm.
- Lock-free CLI (before the lock and the observer-enabled gate): `--arm` (obeys enabled),
  `--disarm` (escape hatch), `--status`, `--ensure-cron`.
- Status JSON gains `"killswitch": "armed|disarmed|disabled"` (Overview row deferred —
  BACKLOG P14).
- Settings UI: a collapsible "Kill-switch" section (after Widget) — an enable checkbox
  whose description states honestly what the wall covers and the accepted leak residuals,
  and an "Arming window (seconds)" field (validate: integer 15–60).

## Armed semantics (measured live 2026-10-04)

- PW2 up + healthy: disarmed; everything works exactly as before.
- xray alive, armed (manual test or transition window): TCP traffic — including the
  shunt's RU-direct, which Xray dials out through its own output chain — still flows;
  only flows that actually TRAVERSE the forward chain are dropped: non-proxied UDP
  (though note udp/53 from LAN is intercepted by PW2's dns_redirect before forward), ICMP,
  and any other non-redirected protocol. Measured: while armed and healthy,
  `curl https://2ip.io` still returned the provider IP; a background flow was dropped
  (nft counter 8 packets in a ~15 s window).
- PW2 rules absent (boot/crash/restart): everything lan→wan is dropped — silence over
  leak, by design. This is the scenario the kill-switch exists for, and in it the wall
  is total.
- The router's own output chain is deliberately NOT covered: PW2 must be able to reach
  its nodes to recover. DNS names may still leak to the ISP resolver during down
  windows (accepted).

## Residuals (operator-accepted 2026-10-04, restated in the Settings annotation)

1. Unscheduled PW2 crash: up to one window (15 s default) of open time before the
   observer arms. A resident watcher daemon was proposed and declined.
2. Boot sliver before init START=25: the WAN has no address there yet — practically
   unreachable.

## Field acceptance (2026-10-04, the same day it shipped)

An accidental Save & Apply on the presets Settings page restarted PassWall2 on a live
network at 11:59 UTC. The observer log: `KILLSWITCH: armed` at 11:59:01, the watchdog's
own restart behind the wall at 12:00:01 (cooldown held the retries), `KILLSWITCH:
disarmed` at 12:01:33 — 2.5 minutes of silence over leak instead of a provider-IP
exposure. Uptime was continuous (a PW2-restart window, not a reboot) — this incident is
the crash-class scenario, harder than the boot test, which remains desirable only to
confirm the S25 autostart and the boot-time cron self-heal.

## Deploy & tests (DEC-106 discipline; no service restarts anywhere)

0. Backup pair first: `sysupgrade -b` pulled off the router + `uci export passwall2` /
   `uci export passwall2_presets` (done 2026-10-04, before any deployment).
1. Deploy: `scp -O` the observer, the init script (0755 + `enable`) and settings.js;
   one-time router config: `uci set passwall2_presets.killswitch.window='15'` (or rely
   on defaults) and the ucitrack entry (`uci add ucitrack passwall2_presets; uci set
   ucitrack.@passwall2_presets[0].init='passwall2-presets-killswitch'; uci commit
   ucitrack`); `--ensure-cron`; md5 clone == router.
2. Post-deploy (≤ one window): `/etc/crontabs/root` carries the sleep-offset observer
   lines; the status JSON shows `"killswitch":"disarmed"`.
3. Live arm test (window-bounded, auto-disarms on the next healthy pass — run the arm
   and the probes as ONE compound command): the nft counter is the primary instrument
   (`nft list chain inet psw2_ks ks_fwd` — the drop rule with `counter packets > 0`);
   a direct non-53 UDP flow from a LAN client is a secondary probe; TCP via xray keeps
   flowing throughout.
4. Boot test (one planned reboot): from early boot the LAN is dry until the first
   healthy pass; after reboot `--status` → disarmed; the observer log shows
   "KILLSWITCH: armed … disarmed"; the crontab self-heals via the init script.

Rollback: `/etc/init.d/passwall2-presets-killswitch disable` + `--disarm` + restore the
backup pair; the nft table is RAM-only (gone on reboot once the init is off).
