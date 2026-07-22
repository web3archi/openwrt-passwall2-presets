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

**Third occurrence, 2026-07-19 evening (different trigger, watchdog
still not built):** `dmesg` turned up a *third* OOM-kill of xray
(pid 13686, `anon-rss:107472kB`) — roughly 3x the RSS of the first two
kills (~34–37MB each). Unlike incidents 1–2, `loglevel`/tmpfs were
both already clean at the time (the P2 fix held) — this time Xray's
own process memory itself scaled up, coincident with heavy LAN
download traffic (NVIDIA/CUDA driver update) on a client host driving
up concurrent connection volume through the balancer. Killswitch
nftables rules remained loaded post-kill as always (confirmed via
`nft list ruleset` — by-design fail-closed behavior, working as
intended, just still with no auto-recovery).

Also resolved an apparent mystery from the same incident: the user's
"switched to direct" recovery action was *not* a passwall2/router-
level change (no matching stop/reload lines in `passwall2.log`,
ruleset unchanged) — it was enabling a separate wired network path on
the client host that bypasses the OpenWrt router/PW2 entirely. The
same-evening `wan_monitor.log`'s `LEAK DETECTED` hit on
`91.236.238.36` is fully explained as the exit IP of that alternate,
non-router path, not a router-side killswitch failure. **Noting for
future incident interpretation:** "switched to direct" from the user
does not necessarily mean a PW2 shunt/killswitch action was taken —
confirm the mechanism before assuming router-side state changed.

Net effect: the same failure mode (OOM → silent black hole, zero
auto-recovery) has now recurred under a *second, distinct* trigger
(connection volume under heavy client load, vs. log bloat the first
two times). This raises the priority of the still-deferred watchdog
(auto-detect Xray death + auto-restart, originally scoped under this
same P2) from "nice to have" to "addressing a recurring structural
fragility on ~244MB RAM hardware, not a single fixed bug." Decision on
whether to actually build it now was deferred at this point — see
fourth occurrence below, which resolved it.

**Fourth occurrence, 2026-07-22 ~03:01 MSK — resolves the `monitor.sh`
reliability question, watchdog now greenlit:** `dmesg` showed a fourth
OOM-kill of xray (pid 8472, `anon-rss:35904kB` — back in the ~34–37MB
range of incidents 1–2, not the 107MB outlier of incident 3). Computed
from `uptime`/`date` at diagnosis time: boot 2026-07-17 14:22:39 UTC,
OOM at uptime 380297.69s = 2026-07-22 00:00:57 UTC = **03:00:57 MSK**.
User reported "no internet on clients" at ~12:05 MSK the same day and a
fresh diagnostic dump was taken at 12:06:35 MSK (09:06:35 UTC) — **9h5m
after the kill, with zero auto-recovery**:
- `ps w` showed no `xray` process at all (confirmed dead, not hung).
- `monitor.sh` itself *was* alive and running (`pid 8476`, matching the
  process PW2 spawned right after incident #3's silent respawn) — so
  this is not a case of the watchdog script itself being absent or
  killed. It was running and simply did not restart Xray within 9+
  hours, versus the ~58–64s the code (`monitor.sh` source, `pgrep`-based
  loop) implies it should.
- `nft list ruleset` confirmed killswitch chains (`PSW2_MANGLE`,
  `PSW2_NAT`, `PSW2_DNS`) still fully loaded, TPROXY/REDIRECT still
  pointed at ports 1041/11400 with nothing listening — fail-closed as
  designed, total blackhole (`curl` to the local SOCKS port returned
  `HTTP:000` instantly; `nslookup` against the router's own resolver
  timed out — DNS is redirected through the same dead Xray, so this
  incident blacked out DNS too, not just proxied HTTP/TCP).
- LuCI reportedly still showed passwall2 as "running" with nodes
  "alive" during this window — confirms that surface-level PW2 GUI
  status reflects config/cached balancer state, not a live probe of
  the actual Xray process, and should not be trusted alone when
  diagnosing a total outage.

**This settles the previously-open `monitor.sh` reliability question
(§0.2 in SPEC_v0.6.0.md, "empirically contested"): confirmed unreliable.**
A real incident produced stronger evidence than the planned kill-test
would have (9+ hours of non-recovery vs. a single controlled kill). No
further test is required before deciding.

**Decision (user, 2026-07-22 ~12:13 MSK): greenlit — build an external
Xray-death watchdog.** Default action on detected death: restart
(`/etc/init.d/passwall2 restart` or a more targeted restart of just the
Xray process, to be determined during design — the full restart's brief
nft teardown/reapply leak window per SPEC §4.1 is an accepted
trade-off vs. hours of total blackout). This sits as `xray_dead_action`
in the presets addon's draft UCI schema (`SPEC_v0.6.0.md` §3) —
remains an opt-in toggle per project convention (not a silent default),
but the toggle now defaults to enabled once the watchdog exists,
since four independent incidents (2026-07-18 ×2, 2026-07-19, 2026-07-22)
across two different trigger types (log-bloat OOM, connection-volume
OOM) is no longer a single fixable bug — it is a structural property of
running Xray on ~244MB RAM hardware. Design/implementation not yet
started as of this entry.

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

## P6 — 2026-07-19 App IA/UI: current tentative plan (Overview / Nodes / Settings)

**Status:** design notes only, logged as the *current tentative
variant* per user request — not built, not finalized. Node-tab
statistics content is explicitly still TBD ("уточняется").

### Overview page
- Top: an info/status panel (metrics TBD).
- Below it: a "recent events" list sourced from wan_monitor history.
- The same wan_monitor history is also shown in a standalone widget —
  but the widget renders just the raw list, with none of the page's
  surrounding info-panel/browser chrome.

### Nodes tab
- Per-node statistics table, sortable by every column (click column
  header — pure UI sort over already-native data, no new routing
  logic, doesn't violate the "native PW2 only" principle). Candidate
  columns, drafted 2026-07-19:
  1. Last URL-response measurement (full HTTP(S) round-trip through
     the tunnel to a test URL — reflects real browsing feel: DNS+TCP+
     TLS+HTTP through the proxy).
  2. Average URL-response time across all measurements for that node.
  3. Uptime %, historical — over the entire observed lifetime of the
     node.
  4. Uptime %, last 24h — deliberately separate from (3): a node can
     look great on lifetime % while having quietly degraded very
     recently; the 24h window surfaces that immediately.
  5. Plain ping/latency to the node's own endpoint (TCP-connect or
     ICMP, *without* the proxy protocol overhead) — isolates "bad
     network path to the server" from "bad protocol/cipher overhead
     on MT7621," since (1)/(2) and (5) can disagree and that
     disagreement itself is diagnostic.
  6. Jitter / latency variance — a node averaging 100ms but swinging
     50–500ms behaves worse in practice than a steady 150ms node;
     average alone hides this.
  7. Packet loss % (from the plain ping check).
  8. Consecutive-failure streak ("flappiness") — a node with 95%
     uptime that fails in bursts of 10 in a row behaves worse than one
     with the same 95% but isolated single blips; plain uptime % can't
     tell these apart.
  9. % of time this node was the *actual selected* exit IP (not just
     "available") — directly derivable today from wan_monitor.log's
     exit-IP-changed history, cross-referenced by IP.
  10. Time since last failure ("stable for Xh") — quick at-a-glance
      freshness indicator.
  11. Provider/location label, if present in the node's remarks or
      subscription metadata — lets the user visually group and spot
      "all the flaky ones are from provider X" patterns.
  12. Count of `LEAK DETECTED` hits attributed to this node (per the
      wan_monitor false-positive discussion) — not treated as a real
      leak signal, but tracked as a diagnostic flag in case a specific
      node behaves atypically often for reasons worth a closer look
      later.

  **Open technical question (not yet resolved):** PW2's own LuCI GUI
  typically caches only the *latest* single ping value per node, not a
  time series — so columns 2–4, 6, 8, 10 need *some* background
  sampler maintaining history (either reading Xray's own
  Observatory/API balancer probe results if accessible, or an
  extension of the existing external URLTest-style polling). This is
  a monitoring/dashboard-layer addition (same category as the existing
  `net-watch-tools-dashboard`/wan_monitor tooling), not a change to
  PW2's own routing logic, so it doesn't conflict with the Wave 1
  "native PW2 only" principle for the proxy path itself — but the
  concrete data source still needs to be picked before this table can
  be built.

- **Deferred to a later version (user's own call, not urgent):**
  per-node quick actions right in this table — "switch to this node
  now," "make this a fallback node," "assign this node to a specific
  domain/direction." Cheap to add later since it maps directly onto
  existing UCI fields from P5/P6 (`uci set` + `commit` + apply on
  `default_node`/`fallback_node`/shunt rules) — just not in this pass.

### Settings tab
- An expandable/collapsible list of presets.
- Each preset row exposes its own available settings, plus two
  checkboxes: **show in Overview** and **show in widget**.
- **Proposed addition (floated for discussion, not yet decided):**
  give relevant presets a native-LuCI-style control to configure
  fallback chains and per-domain routing, built entirely from PW2's
  own already-loaded node list — not a free-form custom-server field,
  since the app's core principle is "shell over PW2, no logic outside
  it" ("если у нас только оболочка для ПВ2, наверное так правильнее
  выбор из списка ПВ2"). Concretely:
  - Pick a node from the loaded list → "this is fallback server #1."
  - Click a "+" to add another → "fallback of the fallback," and so on.
  - Each entry has a checkbox: **exclude this node from normal
    balancer rotation** — so a node dedicated as a fallback doesn't
    also compete as a regular leastLoad pool candidate.
  - The *same* pick-from-list / "+" / exclude-checkbox pattern should
    be reused for the "route specific domains through specific
    server(s)" section (per-domain shunt assignment) — one consistent
    UX pattern for both fallback-chain config and domain-to-node
    routing, rather than two different widgets.
- **Hard global design constraint:** everything must look and behave
  like native OpenWrt/LuCI — no invented UI patterns. Every action
  goes through the standard OpenWrt **Save / Save & Apply / Cancel**
  buttons; no custom app-level save flow.

### Relation to P5
This is a concrete UI answer to two of the P5 native-option survey
items — balancer `fallback_node` / shunt `default_node` chain
selection, and per-domain routing to a specific node — both proposed
to be exposed through the same "pick from PW2's own node list, no
free text" pattern, keeping the Wave 1 principle of native PW2
features only, no custom logic invented outside it.

## P7 — 2026-07-22 Observer/watchdog design: 4 probes (A/B/C/D) + Overview status panel

**Status: design decided, not yet built.** Confirmed with the user (2026-07-22
~14:27 MSK) that the Xray-death watchdog (P2/§0.2 decision) is not a separate
component — it's the same Observer probe loop, extended. Four distinct probes,
confirmed mapping:

- **Probe A — IP via proxy (leak monitor):** `curl` through the local SOCKS port to
  an IP-echo service (default list, tried in order: `ifconfig.me/ip`, `2ip.io`,
  `api.ipify.org`). Displays **IP** (the exit address). This is the one indicator
  meant primarily for the end user, not just diagnostics — and doubles as the
  watchdog's death signal: if this fails **and** `pgrep -f xray` finds no process,
  after a grace period (default 30s, opt-in toggle, UI range 0–180s to let
  `monitor.sh` try first), restart passwall2.
- **Probe B — blocked resource via proxy:** ping + curl-ping to 1-2 user-entered
  hosts known to be blocked in *their* region (e.g. `x.com` for RU — deliberately
  **no hardcoded default**, since this project also targets Iran, North Korea,
  etc. with different block lists; UI ships only a placeholder/example).
  Confirms genuinely-blocked traffic actually tunnels. Displays **status**
  (reachable/unreachable + latency).
- **Probe C — IP via direct/shunt path:** same IP-echo service list as Probe A, but
  routed through PW2's direct/shunt path instead of the proxy. Displays **IP** (the
  real ISP address) — confirms the direct-routing rule is actually direct. Requires
  the user to have added the IP-checker host to their direct rule; since we don't
  auto-modify PW2's routing config, this needs a how-to doc (how to enable the
  shunt, add direct rules, add a verification host that returns an IP into that
  rule) rather than us configuring it silently.
- **Probe D — unblocked resource via direct path:** ping + curl-ping to 1-2
  user-entered hosts known *not* to be blocked in their region (e.g. `ya.ru` for
  RU — again no hardcoded default). Displays **status**. Baseline WAN sanity check,
  distinguishing "proxy is down" from "the whole WAN is down" — exactly the
  distinction we made by hand during today's live incident diagnosis (curl via
  SOCKS vs. `nslookup` against the router's own resolver).

**Overview/widget node count:** "total nodes / working nodes" should read from
Xray's own **Observatory/BurstObservatory** feature (confirmed in
[`util_xray.lua`](https://raw.githubusercontent.com/Openwrt-Passwall/openwrt-passwall2/main/luci-app-passwall2/luasrc/passwall2/util_xray.lua) —
`subjectSelector = {"blc-"}`, `probeInterval`), which is exactly what PW2's balancer
already uses — not a metric we invent ourselves.

**Open item (blocking node-count implementation):** whether Xray's API inbound is
enabled on this router, needed to query Observatory live. `uci show passwall2 |
grep -i api` only found unrelated `tls_serverName` matches — the API inbound (if
present) is generated into the runtime Xray JSON config, not stored in UCI.
Next diagnostic step (when back on the router): `grep -rl '"api"'
/tmp/etc/passwall2/ /var/etc/passwall2/` on the generated config, plus `ps w | grep
xray` (also tells us whether Xray has come back up since today's OOM #4) and
`netstat -tlnp | grep xray` / `ss -tlnp | grep xray` for an extra listening port.
If no API inbound exists, fallback: total from `passwall2.@nodes[*]` vs. count in
the active balancer's `valid_nodes` selector — cruder, still discovery-based, no
hardcoding.

UCI schema and Overview page content updated accordingly in `docs/SPEC_v0.6.0.md`
§2 (watchdog merge), §3 (`config observer 'main'` + four new `config probe`
sections), §4 (Overview status panel content, previously "TBD").
