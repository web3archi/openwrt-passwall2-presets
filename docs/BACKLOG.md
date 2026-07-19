# Backlog

Open items and decisions specific to this repository (`openwrt-passwall2-presets`),
numbered starting from this project's own P1. For diagnostic history
inherited from the previous project (`openwrt-passwall2-watchdog`, now
archived/private), see [`LEGACY_BACKLOG.md`](LEGACY_BACKLOG.md) — that
file is a frozen import and is not appended to further.

## P1 — 2026-07-17 Language policy: English for code/comments/docs, README bilingual

**Status:** decided, in effect immediately, applied retroactively to
this repository's initial import where practical.

**Decision:** Starting with this repository, all source code, code
comments, commit messages, and internal documentation are written in
English. Rationale: prepares the project for eventual localization/i18n
(both of the LuCI UI itself and of any future public sharing), and
English is the more natural default for code comments read alongside
upstream PassWall2/sing-box source, which is itself English.

**Exception — README only:** the top-level `README.md` is maintained in
English as the canonical version, with a Russian translation kept in
sync as `README.ru.md`. Each links to the other at the top. This is the
one place where a Russian version is deliberately maintained alongside
English, since it's the first thing a human reader (not code) opens.

**What changed as part of this decision (2026-07-17):**
- `README.md` translated to English (was Russian); `README.ru.md` added
  as the Russian counterpart.
- `docs/SPEC_v0.6.0.md` translated to English (was Russian) — this is
  the addon's core working spec and coding has not started yet, so this
  was the cheapest point to do the translation.
- `docs/LEGACY_BACKLOG.md` left untouched (Russian, mixed with some
  English) — it is a frozen historical import from the archived
  `openwrt-passwall2-watchdog` repo, not actively maintained prose that
  this policy needs to reach backward into.
- This file (`docs/BACKLOG.md`) started fresh in English rather than
  continuing the old repo's Cyrillic numbering/style.

**Not yet done (apply at first opportunity going forward):**
- No code exists yet in this repo, so there is nothing to retrofit for
  comments/variable-naming — the policy simply applies from the first
  line of code written.
- If any future contribution (patch, script, doc) arrives in Russian, it
  should be translated into English before merging, per this policy.

## P2 — 2026-07-18 Incident: OOM-killer terminates Xray, no respawn, killswitch causes total outage

**Status:** confirmed root cause via device diagnostics, fix not yet designed — needs discussion before any code/config change.

**What happened:** during an ad-hoc "Wave 1" manual test of native PassWall2
Xray balancing (protocol `_balancing`, `balancingStrategy='leastLoad'`,
`expected='2'`, `tolerance='10'`, `probeInterval='2m'`, pool of 27
subscription nodes, no custom LuCI/code — pure UCI), the router lost all
network connectivity overnight (~2026-07-18 02:41 MSK) and stayed down for
~9 hours, undetected, until the user checked in the morning.

**Root cause (confirmed from live diagnostics, not guessed):**
- `dmesg` on the device: `oom-killer` explicitly killed the `xray` process
  (`Out of memory: Killed process ... (xray) total-vm:603580kB,
  anon-rss:37180kB`). Device has only ~244MB total RAM (`free`: total
  250304kB) — tight for Xray running Observatory health-checks against a
  27-node balancing pool every `probeInterval`.
- `uptime` showed no reboot (18h16m uptime at time of check) — this is a
  process-level kill, not a device crash/hang.
- `/tmp/log/passwall2.log` had zero entries after the last successful
  restart (2026-07-17 20:17:48) — the passwall2 init script has **no
  watchdog/respawn logic** to detect that the Xray process died and
  restart it. Nothing in the userspace log even records the kill; it's
  kernel-only (`dmesg`).
- Because the nftables interception (killswitch) rules stayed loaded and
  active while Xray was dead, **all** router traffic was blackholed —
  not just proxied LAN traffic. The user's own `wan_monitor.log` shows
  `google=ERR x.com=ERR direct(2ip)=ERR` simultaneously (`NO SIGNAL`),
  consistent with total outbound blockage rather than a normal
  proxy-down/direct-leak split.
- The user's own external watchdog (`wan_monitor.sh`, SSHing into the
  router from a separate machine) also stopped logging at the same time
  and was not running the next morning — cause not yet established,
  possibly unrelated (client machine sleep/close) since LAN-side SSH to
  the router remained reachable throughout for diagnostics.

**Not yet decided — needs design before implementation (do not rush a fix):**
- Whether balancing pool size (27 nodes) should be capped for this
  hardware, independent of the `expected`/`tolerance` tuning in P3 below.
- What a safe watchdog/respawn mechanism looks like for Xray specifically
  on this device (procd respawn stanza? external cron health-check? tie
  into the user's existing `wan_monitor.sh`?) and whether it should also
  fail open (drop killswitch) or fail closed (current behavior) when Xray
  is confirmed dead vs. merely restarting.
- Memory budget under sustained balancing (does RSS grow over hours, or
  was this a one-off spike?) — no data yet, needs a longer observation
  window before concluding it's a hard ceiling vs. a leak.

**Recovery note (2026-07-18 12:03–12:05 MSK):** manually running
`/etc/init.d/passwall2 restart` did restore the service (confirmed via
`ps`, clean `passwall2.log`, and `curl` returning the proxy IP again) —
so the outage was purely "nobody restarted it since the OOM kill ~9.5h
earlier", not a deeper corruption. Restart itself took **~2–3 minutes**
end-to-end (nftables rule parsing against the RU_WHITELIST geoip/geosite
set is the slow step, ~60–90s alone) — any future watchdog/respawn
mechanism must tolerate this before declaring a restart attempt failed.

**ROOT CAUSE CONFIRMED (2026-07-18, second OOM recurrence at ~15:16 MSK,
only ~3h11m after the restart above):** it is NOT a memory leak in the
xray process itself — our own `oom_watch.sh` sampling showed xray's RSS
stayed flat (~33–34MB) the entire time, and the kernel OOM line at death
(`total-vm:603696kB, anon-rss:33908kB`) is nearly identical to the first
incident's numbers. The actual culprit is
`passwall2.cfg013fd6.loglevel='debug'` (global Xray log level) combined
with the `xtls-rprx-vision` flow on the balancer: debug level logs every
XTLS pad/unpad/readv operation on every connection, writing to
`/tmp/etc/passwall2/acl/default/global.log` — which lives on tmpfs (RAM).
Measured: 579,747 lines / ~61.7MB accumulated in ~3h11m of runtime
(~50 lines/sec average). This file is never rotated or truncated by
passwall2, so it grows monotonically until it alone exhausts the
router's ~40MB free-memory margin and triggers OOM — explaining both the
variable time-to-OOM (3–9+ hours, depending on traffic/health-check
volume) and the flat process-level RSS (the growth is in the log file,
not the process heap). A secondary, unrelated ~17MB of dead weight was
also found in tmpfs: `/tmp/bak_v2ray/geoip.dat` (17,872,715 bytes), a
stale full-geoip backup from the Incident 1 fix (2026-07-13), superseded
by the smaller RU-WHITELIST-pruned `/tmp/geoip.dat` (1.6MB) and no
longer read by anything.

**Fix (applied):** set `loglevel` to `warning` (keeps real
warnings/errors visible, drops the `[Info]`/`[Debug]` per-packet flood),
truncate the existing bloated `global.log`, and remove the stale
`/tmp/bak_v2ray` backup. This is a config-level fix, not a code change —
no new watchdog/respawn logic was needed to resolve *this* incident's
root cause. A watchdog/respawn mechanism (see above) remains valuable as
defense-in-depth for *other* potential failure modes, but is no longer
the primary mitigation for OOM specifically.

**Verified (2026-07-18 18:16 MSK):** after truncating `global.log`,
removing `/tmp/bak_v2ray`, and setting `loglevel='warning'` (kept at
`warning`, not reverted all the way to upstream's `error` default —
still useful visibility, still low-volume), a fresh restart confirmed
recovery: `df -h /tmp` went from 84.2M used / 38.0M available to
**5.5M used / 116.7M available** — tmpfs headroom roughly tripled.
Xray alive, `curl` through the proxy working, restart completed in
~1 minute (faster than the debug-log-choked restarts, since there's no
60MB+ log file to contend with).

**P4 (deferred, not urgent) — log-size safety net:** regardless of
whatever `loglevel` ends up configured (upstream default is `error`;
this router had drifted to `debug` from an earlier troubleshooting
session and was never reverted — root cause of this whole incident),
`/tmp/etc/passwall2/acl/default/global.log` lives on tmpfs (RAM) and is
never rotated or size-capped by passwall2 itself. Standard practice
(logrotate, journald `SystemMaxUse`, docker `log-opts max-size`) is to
cap log files by size unconditionally rather than rely on the level
staying low-volume forever — protects against future
re-drift/forgetfulness or unexpectedly chatty levels over very long
uptimes. Proposed (not yet built): a small cron entry that truncates
`global.log` (and any other passwall2 tmpfs logs) once it exceeds a
few MB. Low priority — `warning` level is currently low-volume and this
is pure defense-in-depth, not an active problem.

## P3 — 2026-07-18 Promote balancer stickiness setting to production: `expected='1'`

**Status: APPLIED 2026-07-19 ~13:43 MSK.** Empirical evidence from a
full overnight `wan_monitor.log` (2026-07-18 22:00 → 2026-07-19 13:36,
15.6h, no monitoring gaps) justified applying this now rather than just
deciding it: **2436 exit-IP changes in 15.6h ≈ one switch every ~23s
on average** with `expected='2'`. Set `passwall2.wave1_bal.expected`
from `'2'` to `'1'`, committed, restarted — pending a follow-up
observation window to confirm switch frequency drops. Same log also
showed: 19 distinct real exit IPs + 78 `ip=FAILED` samples, 11 brief
`PROXY DOWN` blips and 51 `DIRECT DOWN` blips (likely clustered around
failover moments, unconfirmed), one isolated 30–40s `NO SIGNAL` at
2026-07-19 08:32 MSK (self-recovered, far too short to be a repeat of
the OOM incident), and 30 `LEAK DETECTED` hits all on the same IP
(`194.190.152.237`) — confirmed as a wan_monitor false-positive (its
leak heuristic is tuned to an older/different node set), not a real
leak. No genuine leak found; specifically checked and ruled out for
IP `91.236.238.36` (never appears in the log at all).

**Original context** — tracked here per user request to "вынести
настройки в прод".

**Context:** during the same Wave 1 test, the user observed the active
exit IP switching every 5–20 seconds — far more often than the configured
`probeInterval='2m'` — and asked how to make the balancer "sit" on one
proxy longer, noting this should be configurable rather than hardcoded.

**Finding:** this is expected behavior of Xray's `leastLoad` strategy with
`expected='2'` — it keeps the top 2 candidates "equally good" in the
active pool and round-robins new connections between them on every
connection, independent of `probeInterval` (which only controls how often
the health-check re-ranks candidates, not how often a new connection
picks among current winners).

**Recommended default:** `expected='1'` keeps exactly one "winner" node
active until the next `probeInterval` health-check reconsiders the
ranking — this gives the requested stickiness. `probeInterval` remains
the user-configurable knob for how long that stickiness lasts. Purely a
UCI/config value, no code change needed.

**Not yet done:** decide where "production" config values like this live
(SPEC defaults? a shipped UCI defaults file applied on install?) so it
doesn't need to be re-discovered/re-typed by hand each time — should be
addressed together with the no-hardcoding node-discovery logic already
required elsewhere in this project.

## P5 — 2026-07-19 Preset board: survey of PW2-native failure/fallback options

**Status:** logged for future preset-board design, nothing implemented yet.

**Context:** user asked whether PW2 can be configured to fall back to
direct (unproxied) if all proxy hosts go down. Short answer: yes, but
only for one specific failure mode — there's a second, more severe
failure mode (the P2 OOM incident) that this does *not* cover, and the
two need different fixes. Since "мы хотим сделать удобный пресет борд,
а какие у людей будут предпочтения — мы не знаем," this whole area
should land as explicit, opt-in preset-board toggles, not a silently
chosen default — fail-open at any level trades away the anti-leak
purpose of running a killswitch at all, and that's a per-user threat
model decision, not ours to make for them.

**Two distinct failure modes, two distinct fixes:**
1. All `balancing_node` candidates fail health checks, but the Xray
   *process* is still alive — natively fixable today by setting the
   balancer's `fallback_node` to the special value `_direct`, which
   `gen_balancer()` in
   [`util_xray.lua`](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/luasrc/passwall2/util_xray.lua)
   maps to Xray's `direct` (`freedom` protocol) outbound instead of
   another proxy node. Pure UCI value, no code change.
2. The Xray *process itself* dies (OOM, crash — this is what actually
   happened in P2) — `fallback_node` cannot help here, since the logic
   that would apply it lives inside the process that's now dead; the
   nftables killswitch rules stay loaded regardless and blackhole
   traffic. Only fixable externally, by the P2 watchdog: on detected
   Xray death, either (a) restart Xray — default, privacy-preserving,
   or (b) explicitly flush/relax the nftables killswitch rules to allow
   direct — opt-in, availability-preserving. This choice belongs on the
   preset board too, as its own toggle, not bundled with (1).

**Other PW2-native options worth surveying for the preset board (found
while researching this, not yet each individually vetted):**
- Shunt-level `default_node`/rule node accepts the same `_direct`
  special value, not just balancer `fallback_node` — used by community
  scripts (e.g. [`passwall-auto-switch.sh`](https://gist.github.com/fakhamatia/d84bdddc39f555bef30574185a19bc53):
  `uci set passwall2.myshunt.default_node="_direct"`) as a manual
  one-click "emergency direct" toggle, independent of the automatic
  all-nodes-down fallback in item 1. Could be a separate dashboard
  button.
- ACL per-source `tcp_no_redir_ports`/`udp_no_redir_ports` let specific
  LAN devices/IP ranges bypass the proxy entirely regardless of global
  killswitch/proxy health — worth a preset toggle for "always-direct
  devices" (smart TV, IoT, etc.), orthogonal to the failure-handling
  toggles above.
- Shunt already has three explicit lanes (Reject=blackhole/drop,
  Direct, Proxy) — worth double-checking any preset doesn't hardcode
  the Reject lane (ad-block, etc.) in a way that conflicts with a
  `_direct` fallback added later.

**Known pitfall to check before wiring `_direct` into any preset:**
[xiaorouji/openwrt-passwall2 issue #439](https://github.com/xiaorouji/openwrt-passwall2/issues/439)
documents that setting a shunt's default node to direct can silently
break remote DNS resolution for domains that were relying on the proxy
node's DNS server list — i.e. failing over to `_direct` might trade a
clean outage for degraded/broken DNS instead. Needs a dedicated look
(does this bug apply to balancer `fallback_node='_direct'` the same
way, or only to shunt `default_node`?) before this becomes a preset
default rather than an opt-in advanced toggle.
