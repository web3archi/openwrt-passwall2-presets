# SPEC — Kill-switch (no direct leak while PassWall2 is down)

- **Status:** accepted (operator, 2026-10-04: variant "state-mirror", 15s cadence)
- **Scope:** `files/etc/passwall2-presets/observer_watchdog.sh`, `files/etc/init.d/passwall2-presets-killswitch` (new), `files/etc/config/passwall2_presets`, `files/etc/passwall2-presets/crontab.snippet`

## Context

2026-10-03: an unclean router reboot left a window with PassWall2's nft rules absent;
fw4's zone-accept forwarded LAN traffic out the WAN directly → provider IP → OpenRouter
access cut. The same evening a LuCI Scheduled-Tasks save zeroed `/etc/crontabs/root`
(observer dead for 12h). A flat lan→wan drop cannot work: RU-direct is an nft-level
PW2 bypass (`ip daddr @psw2_rulenode_RU_WHITELIST return` → forwarded when healthy),
PW2 marks only proxied flows (`0x50535732`, they never reach the forward chain), and
nft sets cannot be referenced across tables.

## Design (state-mirror)

- Table `inet psw2_ks`, chain `ks_fwd` `{ type filter hook forward priority -10; policy accept; }`,
  one rule: `iifname <lan_if> oifname <wan_if> counter drop`. Priority -10 runs before
  fw4's filter chain (priority 0). Family inet = dual-stack (a future wan6 delegation is
  covered too).
- Boot: the init script (START=25, after firewall4@19, before passwall2@99) arms the wall
  and calls `--ensure-cron`. Boot default ARMED.
- Observer (every ~15s): healthy = xray alive AND (Probe A ok OR Probe A not configured)
  — deliberately NOT the watchdog STATUS string, so protection is independent of
  `watchdog_enabled`. Healthy → disarm (the only place the wall lifts); unhealthy → arm.
  The watchdog's own restart branch arms BEFORE `/etc/init.d/passwall2 restart`.
- Config `config killswitch 'main'`: `enabled` (default 1 when the section is absent — a
  config loss never silently disables the kill-switch), `lan_if` (br-lan), `wan_if` (wan).
- Lock-free CLI (before the lock and the observer-enabled gate): `--arm` (obeys enabled),
  `--disarm` (escape hatch), `--status`, `--ensure-cron` (idempotent 4-line cron install,
  preserves foreign lines, bumps the crontab dir mtime so busybox crond rescans).
- Status JSON gains `"killswitch": "armed|disarmed|disabled"` (UI row deferred — BACKLOG P14).

## Armed semantics

- PW2 up + healthy: disarmed; RU-direct and everything else work exactly as before.
- xray alive, armed (manual test or transition): proxied traffic still flows (PW2's
  prerouting redirect beats the forward hook); only the nft-bypassed direct paths
  (RU-direct) are cut.
- PW2 rules absent (boot/crash/restart): everything lan→wan is dropped — silence over
  leak, by design.
- The router's own output chain is deliberately NOT covered: PW2 must be able to reach
  its nodes to recover. DNS names may still leak to the ISP resolver during down
  windows (accepted).

## Residuals (operator-accepted 2026-10-04)

1. Unscheduled PW2 crash: up to ~15s open window before the observer arms (a resident
   watcher daemon was proposed and declined — moving parts > threat).
2. Boot sliver before init START=25: the WAN has no address there yet — practically
   unreachable.

## Deploy & tests (DEC-106 discipline; no service restarts anywhere)

0. Backup pair first: `sysupgrade -b` pulled off the router + `uci export passwall2` /
   `uci export passwall2_presets` (done 2026-10-04, before any deployment).
1. Deploy: `scp -O` the observer and the init script; `install -m 755` the init; init
   `enable`; `--ensure-cron`; md5 clone == router.
2. Post-deploy (≤30s): `/etc/crontabs/root` carries 4 observer lines; the status JSON
   shows `"killswitch":"disarmed"`.
3. Live arm test (~30s, cuts LAN RU-direct): baseline `curl https://2ip.io` → provider
   IP; `--arm`; `curl https://2ip.io` → timeout while `curl https://api.ipify.org` still
   returns the VPN IP (the wall does not touch the healthy VPN path);
   `nft list chain inet psw2_ks ks_fwd` counter > 0; disarm (or ≤15s auto).
4. Boot test (one planned reboot): RU-direct dead from early boot until the first
   healthy pass (~1–2 min); after reboot `--status` → disarmed; the observer log shows
   "KILLSWITCH: armed … disarmed".

Rollback: `/etc/init.d/passwall2-presets-killswitch disable` + `--disarm` + restore the
backup pair; the nft table is RAM-only (gone on reboot once the init is off).
