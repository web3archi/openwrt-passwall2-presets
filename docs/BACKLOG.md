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

## P3 — 2026-07-18 Promote balancer stickiness setting to production: `expected='1'`

**Status:** decided answer to a live question, not yet applied to any
production/default config — tracked here per user request to "вынести
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
