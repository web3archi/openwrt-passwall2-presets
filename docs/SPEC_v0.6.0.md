# SPEC v0.6.0 — "PW2 Presets Addon"

Status: draft for discussion. Coding has not started — architecture is
fixed first.
Date: 2026-07-17. Updated: 2026-07-22 (4th OOM incident resolves the
`monitor.sh` reliability question; Xray-death watchdog build is now
greenlit and merged into the Observer as Probe A + `pgrep xray` +
grace period; Probes A/B/C/D and the Overview status panel content are
now specified — see §0.2, §2, §3, §4, and BACKLOG.md P2).

## 0. Research summary (basis for this spec)

Key pivot: the old watchdog/chooser daemon (previous project,
[`openwrt-passwall2-watchdog`](https://github.com/web3archi/openwrt-passwall2-watchdog),
now archived/private) is redundant. PassWall2 (hereafter PW2) already
natively does what that project was trying to build on top of it:
automatic best-node selection (Xray Balancing / sing-box URLTest),
health-checking, fallback. Our code in *this* repo
([`openwrt-passwall2-presets`](https://github.com/web3archi/openwrt-passwall2-presets))
should become a thin layer — a config-preset generator plus a
lightweight observer — rather than a parallel traffic-control engine.

### 0.1 Killswitch: what PW2's own code confirms (not a hypothesis — a fact from the source)

Read `app.sh`, `nftables.sh`, `monitor.sh` from
[Openwrt-Passwall/openwrt-passwall2](https://github.com/Openwrt-Passwall/openwrt-passwall2)
and issue [#796 "Kill Switch"](https://github.com/xiaorouji/openwrt-passwall2/issues/796).

- The `del_firewall_rule()` function (fully tears down all `PSW2_*` nft rules/chains/sets)
  is called **only** from `stop()`. There is no call to it from a live health-check or on
  Xray crash anywhere in the file.
- Meaning: **if Xray/sing-box crashes or hangs while the PW2 service itself was never
  stopped**, the TPROXY/REDIRECT nft rules stay in place, LAN traffic keeps getting
  redirected to a (dead) local port, and simply breaks/hangs. This is exactly what was
  observed in the WAN Monitor log, and again in the 2026-07-18/19 OOM incidents (§0.2):
  a total internet outage, but never a leaked outside IP.
- DNS works the same way: the `PSW2_DNS` chain unconditionally redirects UDP/TCP:53 from
  LAN to `dns_redirect_port` (`nft ... redirect to :$dns_redirect_port`). There is no
  explicit ACCEPT/direct-fallback rule anywhere in the code for the case where that port
  is unreachable. So DNS is **also fail-closed by construction** — when the process dies,
  DNS queries get redirected into a void rather than leaking out to a real upstream DNS.
- **The real leak window is not an Xray crash — it's the `stop()` → `start()` cycle**
  (manual restart, "Save & Apply" on many LuCI settings, router reboot before PW2 has
  initialized). `del_firewall_rule()` fully tears down protection, and until `start()`
  finishes, the LAN has a direct path out. This is exactly the gap issue #796's author
  asked to close ("keep the nftables rules in place across config changes so there's no
  internet if xray isn't connected") — **the feature was closed upstream as `not planned`
  (2025-04-22)**, i.e. it will not be added to PW2 itself.
- `monitor.sh` — PW2's own process watchdog: roughly every ~58s (+ up to 6s lock delay) it
  checks via `pgrep -f` whether a registered process is alive, and restarts it via
  `nohup` (no `procd respawn`). Only active if
  `passwall2.@global[0].enabled=1` **and** `passwall2.@global_delay[0].start_daemon=1`.
  `pgrep` only detects "process is gone," not "process is alive but hung (deadlocked)."
  **This claim does not hold in practice — see the "monitor.sh reliability" note in
  §0.2 below (RESOLVED 2026-07-22: confirmed unreliable, watchdog greenlit). Do not
  treat `pgrep`-based auto-respawn as trustworthy on this router.**

**Conclusion:** PW2's native behavior needs no additional killswitch for the "Xray died
while running" scenario — it's already fail-closed there. What might be worth building
(if we decide to) is a **narrow "guard" covering only the stop→start window and the
boot-before-init window** — a fundamentally lighter task than a 24/7 parallel nft DROP
table (which is likely the actual cause of the previous project's throughput-drop bug,
`LEGACY_BACKLOG.md` P18).

### 0.2 Incident diagnostic history (confirmed facts, not hypotheses)

The original spec (2026-07-17) listed open on-router diagnostic items. All of them have
since been answered with real device data across three separate OOM occurrences. This
section replaces that open list with the confirmed timeline.

**Incident #1 — 2026-07-18 ~02:41 MSK.** `dmesg`: `oom-killer` killed `xray`
(`pid 32432, total-vm:603580kB, anon-rss:37180kB`). Router had only ~244MB total RAM
(`free`: total 250304kB). Outage lasted ~9 hours undetected (overnight), until manually
fixed via `/etc/init.d/passwall2 restart` at 2026-07-18 12:03–12:05 MSK (confirmed
recovery via `ps`, clean `passwall2.log`, working `curl` through the proxy). Restart
itself took ~2–3 minutes end-to-end (nftables rule parsing against the RU_WHITELIST
geoip/geosite set is the slow step, ~60–90s alone).

**Incident #2 — 2026-07-18 ~15:16 MSK, only ~3h11m after incident #1's restart.**
`dmesg`: `pid 27537, total-vm:603696kB, anon-rss:33908kB` — RSS essentially identical to
incident #1, ruling out a growing process-level memory leak in xray itself (own
`oom_watch.sh` sampling confirmed flat ~33–34MB RSS the whole time). **Root cause
confirmed:** `passwall2.cfg013fd6.loglevel='debug'` (had drifted from an earlier
troubleshooting session and was never reverted) combined with the `xtls-rprx-vision`
flow on the balancer logs every XTLS pad/unpad/readv operation on every connection to
`/tmp/etc/passwall2/acl/default/global.log`, which lives on **tmpfs (RAM)**. Measured:
579,747 lines / ~61.7MB accumulated in ~3h11m (~50 lines/sec average), never rotated or
truncated by passwall2 — grows until it alone exhausts the router's ~40MB free-memory
margin and triggers OOM. A secondary, unrelated ~17MB of dead weight was also found:
`/tmp/bak_v2ray/geoip.dat` (17,872,715 bytes), a stale full-geoip backup superseded by
the smaller RU-WHITELIST-pruned `/tmp/geoip.dat` (1.6MB), no longer read by anything.

**Fix applied (2026-07-18 18:16 MSK):** set `loglevel` to `warning`, truncate the
bloated `global.log`, remove the stale `/tmp/bak_v2ray` backup. Verified:
`df -h /tmp` went from 84.2M used / 38.0M available to **5.5M used / 116.7M available**.
This was a config-level fix — no watchdog/respawn code was required for *this specific*
root cause.

**Deferred, not urgent — log-size safety net (originally "P4"):** regardless of
whatever `loglevel` ends up configured (upstream default is `error`), `global.log` on
tmpfs is never rotated or size-capped by passwall2 itself. Standard practice (logrotate,
journald `SystemMaxUse`, docker `log-opts max-size`) argues for capping by size
unconditionally, as defense-in-depth against future re-drift, independent of whatever
level currently happens to be configured. Proposed, not built: a small cron entry that
truncates `global.log` (and any other passwall2 tmpfs logs) past a size threshold.

**Incident #3 — 2026-07-19, exact time 19:13:50 MSK (computed from
`cat /proc/uptime; date` on 2026-07-20: uptime `179470.446297s` at OOM, boot time derived
as ≈2026-07-17 14:22:40 UTC).** `dmesg`: `pid 13686, total-vm:605076kB,
anon-rss:107472kB` — **~3x the RSS of incidents #1/#2.** Unlike those two, `loglevel`
was already `warning` and tmpfs was clean at the time (the incident #2 fix held) — this
time Xray's own process memory scaled up, coincident with heavy LAN download traffic
(NVIDIA/CUDA driver update) on a client host driving up concurrent connection volume
through the balancer. This is a **second, distinct trigger** for the same underlying
failure mode (OOM → nftables killswitch stays loaded → silent total outage, no
auto-recovery) — not a recurrence of the log-bloat cause already fixed.

Important timing note: this OOM (19:13:50 MSK) is **not the same event** as the
`wan_monitor.log` `NO SIGNAL` blackout logged the same evening (18:51:58–18:54:35 MSK,
self-recovered) — the OOM happened ~19 minutes *after* that blackout ended, so the
router experienced two separate anomalies that evening, not one.

Also resolved from the same incident: the user's "switched to direct" recovery action
that evening was **not** a passwall2/router-level change (no matching stop/reload lines
in `passwall2.log`, nftables ruleset unchanged) — it was enabling a separate wired
network path on the client host that bypasses the OpenWrt router/PW2 entirely. The same
evening's `wan_monitor.log` `LEAK DETECTED` hit on `91.236.238.36` is fully explained as
the exit IP of that alternate, non-router path, not a router-side killswitch failure.
**Methodological note for future incident interpretation:** "switched to direct" from
the user does not necessarily mean a PW2 shunt/killswitch action was taken — confirm the
actual mechanism before assuming router-side state changed.

**`monitor.sh` reliability — RESOLVED 2026-07-22: confirmed unreliable.** Incidents #1
and #2 each required *manual* restart after multi-hour outages despite
`passwall2.@global[0].enabled=1` and `passwall2.@global_delay[0].start_daemon=1` both
confirmed `1` (per source, `monitor.sh`'s `pgrep`-based respawn should catch a dead
process within ~58–64s). Incident #3 appeared to self-heal (Xray alive under a new pid
on next check, `passwall2.log` showing no matching restart entry) — later explained as a
silent `monitor.sh` respawn (no `stop()`/`start()` log line, since that log is written by
`app.sh`, not `monitor.sh`).

**Incident #4 (2026-07-22 ~03:01 MSK) settled it**: `monitor.sh` was confirmed alive
(`pid 8476`) throughout, yet did not restart the OOM-killed Xray for **9h5m** before the
next diagnostic check (vs. the ~58–64s the source implies). Full detail in
`docs/BACKLOG.md` P2, "Fourth occurrence." **Conclusion: `monitor.sh` is not a reliable
auto-recovery mechanism — it sometimes works (incident #3) and sometimes does not for
hours (incidents #1, #2, #4).** No further kill-test is required; a real 9h+ failure is
stronger evidence than a single controlled test would have provided.

**Root cause found 2026-07-22 ~15:00 MSK (source-grounded, not a guess).** A live check
during this incident (`ls /tmp/lock/passwall2_monitor.lock` → not found; `ps w | grep
monitor.sh` → pid 8476 alive) first **disproved** an initial stale-lock hypothesis: the
lock this session had floated does not exist, so `monitor.sh` is not stuck skipping its
own loop. Reading the actual upstream source instead
([`utils.sh`](https://raw.githubusercontent.com/Openwrt-Passwall/openwrt-passwall2/main/luci-app-passwall2/root/usr/share/passwall2/utils.sh),
[`app.sh`](https://raw.githubusercontent.com/Openwrt-Passwall/openwrt-passwall2/main/luci-app-passwall2/root/usr/share/passwall2/app.sh))
shows why: `ln_run()` only registers a launched process into `TMP_SCRIPT_FUNC_PATH`
(`monitor.sh`'s ongoing respawn watch list) when its `queue_run` argument is not `"1"`;
when `queue_run == "1"` it instead writes a one-shot entry into `TMP_PROCESS_LIST_PATH`,
which `run_process_queue()` consumes once and deletes — never added to the ongoing watch
list. `app.sh`'s normal `start()` flow sets `QUEUE_RUN=1` immediately before launching
nodes (`run_xray` included), and only the ad-hoc `run_socks`/`socks_node_switch` CLI
paths set `QUEUE_RUN=0`. **Conclusion: under a normal start/restart, the main Xray
process is never added to `monitor.sh`'s watch list at all — its 58s `pgrep` loop has
nothing to check for Xray by design, not due to a bug or stuck state.** This uniformly
explains incidents #1, #2 and #4 without needing per-incident special cases. It also
casts doubt on the earlier "silent `monitor.sh` respawn" explanation floated for incident
#3 — if Xray is genuinely never registered under a normal start, `monitor.sh` could not
have been what revived it in #3 either; incident #3's actual revival mechanism is
therefore **still unexplained** and is not re-investigated here (flagged, not closed).
Optional (non-blocking) confirming check for next router session: `ls -la
/tmp/etc/passwall2/script_func/` should be empty or contain no Xray-referencing entry.
This finding does not change the watchdog decision below — if anything it strengthens
it: our Observer/watchdog fills a genuine structural gap in PW2's own design, not a
flaky/duplicate of something that already works.

**Decision (user, 2026-07-22 ~12:13 MSK): GREENLIT — build an external Xray-death
watchdog.** No longer an open question. Default action: restart Xray on detected death
(exact restart mechanism — full `passwall2 restart` vs. a narrower restart of just the
Xray process — to be settled during design, see `xray_dead_action` in §3). This does not
replace `monitor.sh` (leave it running as-is); the new watchdog is an independent,
coarser-grained safety net on top of it. Design/implementation not started as of this
revision — tracked as the next roadmap item (§5).

### 0.3 Native PW2 failure/fallback options (survey, not yet each individually vetted)

Two distinct failure modes exist and need two distinct, **explicit opt-in** toggles on
the preset board — not a silently chosen default, since fail-open at any level trades
away the anti-leak purpose of running a killswitch at all, and that trade-off is a
per-user threat-model decision, not this app's to make for them ("а какие у людей будут
предпочтения — мы не знаем").

1. **All `balancing_node` candidates fail health checks, but the Xray process is still
   alive** — natively fixable today by setting the balancer's `fallback_node` to the
   special value `_direct`, which `gen_balancer()` in
   [`util_xray.lua`](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/luasrc/passwall2/util_xray.lua)
   maps to Xray's `direct` (`freedom` protocol) outbound instead of another proxy node.
   Pure UCI value, no code change. **Opt-in toggle, off by default.**
2. **The Xray process itself dies** (OOM, crash — incidents #1–#3 above) —
   `fallback_node` cannot help here, since the logic that would apply it lives inside the
   process that's now dead; the nftables killswitch rules stay loaded regardless and
   blackhole traffic. Only fixable externally, by a watchdog: on detected Xray death,
   either (a) restart Xray — default, privacy-preserving, or (b) explicitly
   flush/relax the nftables killswitch rules to allow direct — opt-in,
   availability-preserving. **Its own toggle, not bundled with (1), and blocked on the
   watchdog decision in §0.2.**

**Other native options found while researching, worth surveying for the preset board:**
- Shunt-level `default_node`/rule node accepts the same `_direct` special value, not just
  balancer `fallback_node` — used by community scripts (e.g.
  [`passwall-auto-switch.sh`](https://gist.github.com/fakhamatia/d84bdddc39f555bef30574185a19bc53):
  `uci set passwall2.myshunt.default_node="_direct"`) as a manual one-click "emergency
  direct" toggle, independent of the automatic all-nodes-down fallback in item 1. Could
  be a separate dashboard button.
- ACL per-source `tcp_no_redir_ports`/`udp_no_redir_ports` let specific LAN
  devices/IP ranges bypass the proxy entirely regardless of global killswitch/proxy
  health — worth a preset toggle for "always-direct devices" (smart TV, IoT, etc.),
  orthogonal to the failure-handling toggles above.
- Shunt already has three explicit lanes (Reject=blackhole/drop, Direct, Proxy) — worth
  double-checking any preset doesn't hardcode the Reject lane (ad-block, etc.) in a way
  that conflicts with a `_direct` fallback added later.

**Known pitfall to check before wiring `_direct` into any preset:**
[xiaorouji/openwrt-passwall2 issue #439](https://github.com/xiaorouji/openwrt-passwall2/issues/439)
documents that setting a shunt's default node to direct can silently break remote DNS
resolution for domains that were relying on the proxy node's DNS server list — i.e.
failing over to `_direct` might trade a clean outage for degraded/broken DNS instead.
Needs a dedicated look (does this apply to balancer `fallback_node='_direct'` the same
way, or only to shunt `default_node`?) before this becomes anything other than an opt-in
advanced toggle.

## 1. Architecture

The addon is not a separate traffic-control daemon — it is three layers:

1. **Presets Engine** — a set of presets, each being a set of `uci set`/
   `uci commit passwall2` commands plus `/etc/init.d/passwall2 reload` (not a full
   restart, if supported — need to confirm with PW2 exactly what triggers a full
   `stop()+start()` versus a partial reload, to minimize the window from §0.1). No
   hardcoded node ids/names — selection always goes through discovery (the actual list
   of existing `passwall2.@nodes[*]`, as in the previous project). **Rule holds for
   every setting surfaced anywhere in this app: nothing is hardcoded, entity/section/
   group names are discovered at runtime.**
2. **Observer (lightweight)** — reuse the existing `wan_monitor.sh`-style approach in
   spirit: a periodic curl (through PW2's SOCKS port for "current IP/speed," and
   separately outside the proxy as a "did we leak" reference) plus `EXIT IP CHANGED`
   detection for a switch counter. It observes, it does not control traffic — it never
   touches iptables/nft, so it cannot create a second version of the P18 bug. Its history
   feeds both the Overview page's recent-events list and the Nodes tab's time-series
   metrics (§4).
3. **LuCI pages** (Overview / Nodes / Settings, per the current tentative IA in §4) —
   mostly read-only observation, plus a native-OpenWrt-styled configuration surface for
   the opt-in toggles from §0.3: (a) state from PW2's own UCI, (b) state from our own
   Observer. Duplicates none of PW2's internal logic.

Explicitly NOT building: our own chooser/failover engine (Balancing/URLTest already do
this), our own 24/7 nft killswitch (see §0.1), any free-text custom-server field
anywhere (fallback chains and per-domain routing are pick-from-PW2's-own-node-list only —
"если у нас только оболочка для ПВ2, наверное так правильнее").

## 2. Presets — implementation priority

### Wave 1 (needed immediately)

**Preset A — "Best node" (native switching)**
Configures Xray `_balancing` (for Xray-type nodes) or sing-box `_urltest` (for
sing-box-type nodes) — the engine is chosen automatically based on the user's node
types, no hardcoding.

Strategy choice — exposed to the user as an understandable choice (not a blind
"leastPing" field):

| UI option | What actually gets set |
|---|---|
| "Fastest" | Xray Balancing `strategy=leastPing`; sing-box `urltest` with a low `tolerance` (~30-50ms) |
| "Most stable" (default) | Xray Balancing `strategy=leastLoad`, `expected='1'` (**production value since 2026-07-19 ~13:43 MSK — see below**), `tolerance` drawn from the pool of good nodes (currently `10`) |
| "Manual with auto-restore" | SOCKS Auto Switch: `Main node` + `List of backup nodes` + `Restore Switch` — for when the user wants an explicitly pinned primary node rather than "best by metric" |

**`expected` value — resolved, not just proposed.** Originally drafted as `expected='2'`
(keeps top 2 candidates "equally good," round-robins new connections between them on
every connection, independent of `probeInterval`). Live data from a full 15.6h
`wan_monitor.log` (2026-07-18 22:00 → 2026-07-19 13:36, no gaps) showed **2436 exit-IP
changes ≈ one switch every ~23s on average** with `expected='2'` — the user had asked
for "stickiness" and this was clearly excessive. **`expected='1'` was applied to
production on 2026-07-19 ~13:43 MSK** (`passwall2.wave1_bal.expected`, committed,
restarted) — this is now the default this preset should generate. `probeInterval`
remains the user-configurable knob for how long that stickiness lasts.

The same 15.6h log audit found: 19 distinct real exit IPs + 78 `ip=FAILED` samples, 11
brief `PROXY DOWN` blips and 51 brief `DIRECT DOWN` blips, one isolated 30–40s
`NO SIGNAL` at 08:32 MSK (self-recovered, far too short to be an OOM repeat), and 30
`LEAK DETECTED` hits all on the same IP (`194.190.152.237`) — confirmed as a
`wan_monitor.sh` false-positive (its leak heuristic is tuned to an older/different node
set), not a real leak. **This false-positive pattern is a known, standing property of
that external monitor script, not of PW2 or this addon — do not treat future
`LEAK DETECTED` hits on that specific node/IP pattern as real without cross-checking.**

**`fallback_node` handling — revised from the original blanket rule.** The original
draft of this spec said "`fallback_node` is never Direct (hardcoded validator block)."
Per the §0.3 survey, this is now refined: `fallback_node='_direct'` is a legitimate
native PW2 feature for failure mode 1 (all nodes down, Xray alive) and should be exposed
as an **explicit opt-in preset-board toggle, off by default**, with the DNS caveat
(issue #439) surfaced in the UI before the user enables it — not silently forbidden, and
not silently defaulted on either.

**Visibility (a hard requirement, not an option):**
- Overview: currently active node (detected via
  `curl -x socks5h://127.0.0.1:<port> https://api.ipify.org` — already live-tested
  this session, works), its current latency/speed (our own probe, since the code
  confirms Xray Observatory has no live-readable API — it only generates config),
  a switch counter for the period (`EXIT IP CHANGED` detection, as in wan_monitor), a
  mini-log in the style of WAN Monitor (last N status lines).
- Widget (same data set, compact): node, speed, number of switches today, status
  (OK/degraded/down).

**Preset B — "Bypass" (Shunt-based)**
Configures Shunt rules: whitelist domains/subnets (RU/local services) → explicit
`Direct Connection`, everything else → the node/group from Preset A. Domain-list
discovery comes from the user's existing ipset/geosite sets, not hardcoded. This is one
of the few places in the entire architecture where Direct is a deliberate, explicit
choice rather than an emergency fallback — the other being the opt-in `_direct` toggles
from §0.3.

### Wave 2 (next)

**Preset C — "Fixed IP"**
A separate Shunt rule for specific domains (banking/streaming) → one pinned node, not
routed through Balancing/URLTest (so the IP doesn't change). Combining this with
Preset A's Fallback Node is under discussion: if the pinned node dies, either (a) the
same general pool of "good" nodes as the shared Fallback, or (b) a dedicated fallback
specific to this domain group — offer the user the choice when creating the preset,
don't silently decide for them.

**Preset D — "Emergency direct" (from §0.3 survey)**
A manual, explicit, one-click toggle that sets shunt `default_node='_direct'` — distinct
from Preset A's automatic all-nodes-down `fallback_node`, and distinct from a dead-Xray
watchdog action. Purely a user-invoked panic button, off by default, DNS caveat surfaced
in the UI.

**Preset E — "Always-direct devices" (from §0.3 survey)**
Per-source bypass using ACL `tcp_no_redir_ports`/`udp_no_redir_ports` (or the equivalent
per-source shunt rule) for LAN devices/IP ranges that should never go through the proxy
regardless of its health — smart TVs, IoT, etc. Node/device list discovered from the
router's own DHCP leases / existing ACL config, not hardcoded, not free-text.

### Wave 3 (as needed, after Waves 1-2)

**Extended package for more powerful hardware (NOT MT7621-class)** — HAProxy Load
Balancing and SOCKS Auto Switch as separate optional presets, hidden behind an explicit
"Advanced Settings" toggle with a UI warning:

> "HAProxy and additional SOCKS Auto Switch processes add always-running processes and
> health-check requests. On weaker SoCs (MT7621 and similar) this noticeably eats
> CPU/memory. Only enable this if your router is more powerful than a typical home
> router (x86, ARM64 with 4+ cores, ≥512MB free memory) — otherwise use presets A/B."

- **Weighted balancing (HAProxy)** — for when different nodes need different traffic
  weights, not just "best/backup."
- **SOCKS Auto Switch with multiple independent profiles** — for when a single global
  tunnel isn't enough and several parallel SOCKS exits with different policies are
  needed.

**Xray-death watchdog — GREENLIT 2026-07-22, merged into the Observer (no longer a
separate Wave 3 item).** Both open questions from §0.2 are resolved: `monitor.sh` is
confirmed unreliable (incidents #1, #2, #4 — hours-long outages with no auto-recovery);
decision is to build our own watchdog as an independent layer on top of `monitor.sh`
(not a replacement). It is not a standalone daemon — it is the same probe loop as
Probe A (§2 Observer, "IP via proxy / leak monitor") below: when Probe A fails **and**
`pgrep -f xray` finds no process, after a configurable grace period (`grace_period`,
default 30s, UI range 0–180s, to give `monitor.sh` a chance first) it runs
`/etc/init.d/passwall2 restart`. Action is an explicit opt-in toggle
(`observer.main.xray_dead_action`, §3) per §0.3 item 2, defaulting to `restart` given the
confirmed unreliability. **Deployed and live-tested on the router 2026-07-22** — see §5
item 3a for the deployment log and the two bugs found/fixed during first deploy.

## 3. Addon UCI schema (draft, for discussion — updated for §0.3/§2 opt-in toggles)

A separate config file, `/etc/config/passwall2_presets` (package `passwall2_presets`),
not mixed with `passwall2`. Template shipped at `files/etc/config/passwall2_presets` in
this repo, consumed by `files/etc/passwall2-presets/observer_watchdog.sh`:

```
config global 'global'
    option preset 'best_node'      # currently active preset (discovery/id, no hardcoded values inside)
    option strategy 'stable'       # fast|stable|manual — maps to the table in §2

# NOTE: section names must be unique across the whole file regardless of type — UCI errors
# with "section of different type overwrites prior section with same name" if two sections
# (even of different types) share a name. `global 'global'` + `observer 'main'` avoids the
# collision that shipped in an earlier draft (`global 'main'` + `observer 'main'`), caught
# during first router deploy 2026-07-22.
config observer 'main'
    option enabled '1'
    option interval '30'                # seconds; lightweight probe, not 58s like monitor.sh — separate process
    option socks_port ''                # discovered from passwall2.@global[0].node_socks_port, not hardcoded
    option watchdog_enabled '1'         # opt-in, but defaults ON: monitor.sh confirmed unreliable (BACKLOG P2, 4 incidents)
    option grace_period '30'            # seconds; UI range 0-180 (0-3min) — waits for monitor.sh before acting
    option xray_dead_action 'restart'   # restart|none — moved here from `preset best_node` since detection
                                         # (Probe A) and action now live together in the Observer

config probe 'ip_via_proxy'             # Probe A — leak monitor; ALSO the watchdog's death signal (with pgrep xray)
    option enabled '1'
    list ip_check_url 'https://ifconfig.me/ip'
    list ip_check_url 'https://2ip.io'
    list ip_check_url 'https://api.ipify.org'   # tried in order; guards against one checker being down
    # Overview/widget display: IP (the exit IP returned through the proxy)

config probe 'blocked_via_proxy'        # Probe B — confirms a genuinely-blocked destination actually tunnels
    option enabled '0'                  # off until the user fills in a host — no hardcoded regional default
    list host ''                        # UI placeholder: "e.g. x.com — a host known blocked in YOUR region"
    # Overview/widget display: status (reachable/unreachable + latency) per host

config probe 'ip_direct'                # Probe C — confirms the direct/shunt path is actually direct
    option enabled '0'                  # off until the user has set up the direct-rule (needs a how-to doc,
                                         # incl. how to add an IP-checker host into that direct rule)
    list ip_check_url 'https://ifconfig.me/ip'
    list ip_check_url 'https://2ip.io'
    # Overview/widget display: IP (the real ISP IP, via the direct/shunt path)

config probe 'unblocked_direct'         # Probe D — baseline WAN sanity check via the direct path (no proxy)
    option enabled '0'
    list host ''                        # UI placeholder: "e.g. ya.ru — a host NOT blocked in your region"
    # Overview/widget display: status (reachable/unreachable) — distinguishes "proxy down" from "WAN down"

config preset 'bypass'
    option enabled '0'
    list direct_domain_set ''      # discovered from existing geosite/ipset sets, not hardcoded

config preset 'fixed_ip'
    option enabled '0'
    list domains ''
    option node ''                 # discovered from passwall2.@nodes[*]
    option fallback_mode 'shared'  # shared|dedicated — see §2 Preset C

config preset 'best_node'
    option fallback_direct_enabled '0'  # §0.3 item 1 — opt-in, off by default; surfaces the
                                         # issue #439 DNS caveat in the UI before enabling
    # xray_dead_action moved to `config observer 'main'` above (§0.2/§2) — detection (Probe A)
    # and the restart action now live together in the Observer, not the balancer preset.

config preset 'emergency_direct'
    option enabled '0'             # §2 Preset D — manual one-click shunt default_node='_direct'

config preset 'always_direct_devices'
    option enabled '0'
    list bypass_source ''          # discovered from DHCP leases / existing ACL config — §2 Preset E
```

## 4. LuCI pages (screen spec)

**Status: this section reflects the current tentative IA (2026-07-19), logged as such —
not built, not finalized. Supersedes the original Overview/Nodes/Help/Widget draft.**

### Overview page
**Built, 2026-07-22** — page + widget shipped exactly per the spec below, see roadmap
item 6 in §5 for file paths. Settings tab is still not built; the IA/metrics decisions
below are otherwise final, not tentative.

**Status panel content, decided 2026-07-22 (was "exact metrics still TBD"):**
- **Node count — RESOLVED 2026-07-22: use the fallback, no live Observatory query.**
  Xray's own **Observatory/BurstObservatory** feature (confirmed in
  [`util_xray.lua`](https://raw.githubusercontent.com/Openwrt-Passwall/openwrt-passwall2/main/luci-app-passwall2/luasrc/passwall2/util_xray.lua):
  `subjectSelector = {"blc-"}`, `probeInterval`) is what PW2's own balancer already uses
  internally for node health — but that same file never builds an Xray
  `ApiConfig`/`HandlerService`/`StatsService` block, so **PW2 does not expose an API
  inbound to query it live at all** (not a per-router config question — it's absent from
  the code path). Implementation: total from `passwall2.@nodes[*]` vs. count in the
  active balancer's `valid_nodes` selector — cruder, but still discovery-based, no
  hardcoding. See `docs/BACKLOG.md` P7 for the full trail.
- **Probe A (leak monitor):** current exit IP through the proxy, plus healthy/unhealthy
  state — the one indicator meant primarily for the end user, not just for diagnostics.
- **Watchdog status:** ok / degraded (probe failed but Xray alive — not our failure mode)
  / down-in-grace-period / restarting / restarted-confirming, per the Probe A + `pgrep
  xray` state machine described in §2.
- **Probes B/C/D:** status (B, D) and IP (C) for the resources the user configured, shown
  as secondary rows — off/blank until the user fills in a host for B/D or sets up the
  direct rule for C.
- Below the panel: a "recent events" list sourced from the Observer's wan-monitor-style
  history (probe transitions, watchdog restarts) — **revised 2026-07-22: hidden by
  default, shown only while a checkbox is checked** (the underlying data still
  refreshes in the background either way, so it's current the moment it's revealed).
  The checkbox row uses the same plain `.table`/`.tr`/`.td` row markup as the status
  panel above it, not the `.cbi-value` CBI-form convention — mixing the two on one
  page is what caused a reported alignment issue; see `docs/BACKLOG.md` P7.
- **Row order, revised 2026-07-22 evening:** Watchdog status → Xray process → Probe A
  → Probe C → Probe B → Probe D → Last updated → Configured nodes → Active
  balancer. The "Currently working" row is **removed** (documented dead field, no
  Xray API to back it — see below). Probe A's row additionally shows "unchanged for
  Xm" (how long the exit IP has held steady, tracked in `observer_watchdog.sh`'s own
  state as `probe_a.ip_since`). Probe A's row also shows a **flag + country/city
  label**, sourced by matching the observed exit IP against the active balancer's
  own node `address` fields and reading that node's PW2 `remarks` text — confirmed
  working against the user's own 27-node subscription. The flag itself is split out
  generically via the Unicode `\p{Regional_Indicator}` property escape (matches any
  flag emoji, not a hardcoded country list); remarks with no flag prefix fall back
  to plain text. No IP match (e.g. a hostname-based node `address`) → the slot is
  simply omitted. See `docs/BACKLOG.md` P7 for the full investigation.
- **Revised 2026-07-22, superseding the paragraph below:** the native Status >
  Overview widget slot was tried and explicitly rejected by the user ("не надо туда
  его" — wrong place for it). In its place, a **separate standalone page**
  (`admin/services/passwall2-presets/widget`, hidden from the menu tree, no browser
  chrome via the theme's own `blank_page` flag) instantiates the *exact same*
  Overview view — full status panel, not just the log — for kiosk/dashboard
  embedding. See roadmap item 6 in §5 for file paths.
- ~~The same history is also shown in a standalone widget — but the widget renders
  just the raw list, with none of the page's surrounding info-panel/browser
  chrome.~~ (superseded above — that was the native Status-widget approach, removed).
- **Badge colors, finalized 2026-07-22** (native luci-theme-bootstrap classes/vars
  only, no invented colors): green = `.label.success` (working/reachable), yellow =
  `.label.warning` (restarting/starting/waiting/degraded — any transitional state),
  grey = bare `.label` (undetermined/disabled/not configured), red = `.label` with
  an inline style reusing the theme's own `--error-color-high`/`--on-error-color`
  CSS variables (the bootstrap theme has no native `.label.danger` modifier — only
  `.btn`/`.alert-message`/`.cbi-tooltip` get a danger/error variant — so this reuses
  the same design tokens rather than inventing a new red).
- **Page header/description/section-title removed, 2026-07-22 evening (this round):**
  the `<h2>PassWall2 Presets — Overview</h2>` title, the `<p class="cbi-value-description">`
  paragraph below it ("Live status from the Observer probe loop... Settings tab for
  editing probes and the watchdog is planned but not built yet..."), and the
  `<h3>Status</h3>` sub-heading above the status panel are all removed from
  `overview.js`. Rationale: the menu entry itself already carries the page title
  (native LuCI chrome), so the in-page `<h2>` duplicated it; the description paragraph
  is now stale now that Settings is actively being built (this iteration); and
  "Status" as a section label added nothing the panel content didn't already convey.
  The status panel (`this.panelNode`) now renders directly inside a bare
  `cbi-section` div, no heading above it. "Recent events" keeps its own `<h3>`
  unchanged.

### Nodes tab
Per-node statistics table, sortable by every column (click column header — pure UI sort
over already-native/observed data, no new routing logic, doesn't violate the "native PW2
only" principle). Candidate columns, drafted 2026-07-19:

1. Last URL-response measurement (full HTTP(S) round-trip through the tunnel to a test
   URL — reflects real browsing feel: DNS+TCP+TLS+HTTP through the proxy).
2. Average URL-response time across all measurements for that node.
3. Uptime %, historical — over the entire observed lifetime of the node.
4. Uptime %, last 24h — deliberately separate from (3): a node can look great on
   lifetime % while having quietly degraded very recently; the 24h window surfaces that
   immediately.
5. Plain ping/latency to the node's own endpoint (TCP-connect or ICMP, *without* the
   proxy protocol overhead) — isolates "bad network path to the server" from "bad
   protocol/cipher overhead on MT7621," since (1)/(2) and (5) can disagree and that
   disagreement itself is diagnostic.
6. Jitter / latency variance — a node averaging 100ms but swinging 50–500ms behaves
   worse in practice than a steady 150ms node; average alone hides this.
7. Packet loss % (from the plain ping check).
8. Consecutive-failure streak ("flappiness") — a node with 95% uptime that fails in
   bursts of 10 in a row behaves worse than one with the same 95% but isolated single
   blips; plain uptime % can't tell these apart.
9. % of time this node was the *actual selected* exit IP (not just "available") —
   directly derivable today from the Observer's exit-IP-changed history, cross-referenced
   by IP.
10. Time since last failure ("stable for Xh") — quick at-a-glance freshness indicator.
11. Provider/location label, if present in the node's remarks or subscription metadata —
    lets the user visually group and spot "all the flaky ones are from provider X"
    patterns.
12. Count of `LEAK DETECTED` hits attributed to this node (per the `wan_monitor.sh`
    false-positive discussion in §2) — not treated as a real leak signal, but tracked as
    a diagnostic flag in case a specific node behaves atypically often for reasons worth
    a closer look later.

**Open technical question (not yet resolved):** PW2's own LuCI GUI typically caches only
the *latest* single ping value per node, not a time series — so columns 2–4, 6, 8, 10
need *some* background sampler maintaining history (either reading Xray's own
Observatory/API balancer probe results if accessible, or an extension of the existing
external URLTest-style polling / the Observer from §1). This is a monitoring/dashboard
layer addition, not a change to PW2's own routing logic, so it doesn't conflict with the
"native PW2 only" principle for the proxy path itself — but the concrete data source
still needs to be picked before this table can be built.

**Deferred to a later version (user's own call, not urgent):** per-node quick actions
right in this table — "switch to this node now," "make this a fallback node," "assign
this node to a specific domain/direction." Cheap to add later since it maps directly
onto existing UCI fields from §0.3/§3 (`uci set` + `commit` + apply on
`default_node`/`fallback_node`/shunt rules) — just not in this pass.

### Settings tab
- An expandable/collapsible list of presets.
- Each preset row exposes its own available settings, plus two checkboxes: **show in
  Overview** and **show in widget**.
- **Preset A ("Best node") scope, decided 2026-07-22 evening: read state AND write/switch
  strategy are built together in the same pass, not read-only first.** The underlying
  balancing behavior (Xray `leastLoad`+`expected='1'` — "Most stable", currently live in
  production; `leastPing`/higher `expected` — "Fastest", previously tested manually) is
  already proven and running on the router — configured by hand via PW2's own native
  pages, not through this addon. What Settings adds is (1) reading and displaying the
  currently active strategy/params, and (2) a generator that writes the chosen strategy
  (Fastest / Most stable / Manual with auto-restore — see §2 table) into
  `passwall2.<balancer>.*` when saved, plus the `fallback_direct_enabled` toggle with its
  issue #439 DNS caveat surfaced in the UI before enabling.
  - **"Manual with auto-restore" clarified:** this is PW2's own **SOCKS Auto Switch**
    feature, a distinct mechanism from Balancing/URLTest — a dedicated SOCKS server
    wrapping a fixed **Main node** + an ordered manual **List of backup nodes** +
    **Restore Switch** (switch back to Main once it's healthy again), then used as a
    Socks-type node pointed at `127.0.0.1:<port>`. Unlike Fastest/Most stable (algorithm
    picks the winner by metric), Manual is an explicit, user-ordered fallback chain.
- **Widget configuration — decided 2026-07-22 evening: a dedicated "Widget" collapsible
  section in Settings, built with native OpenWrt/LuCI CBI components only (same
  constraint as everything else on this page — no custom JS-only widgets).** Lists every
  field currently shown on the Overview status panel (watchdog status, Xray process,
  Probe A/B/C/D, last updated, configured nodes, active balancer, flag/country label,
  "unchanged for Xm", etc.), each with exactly one checkbox: show this field in the
  compact widget or not. Confirmed design principle: the widget is conceptually a mirror
  of the Overview panel, but is deliberately meant to stay compact — the whole point of
  a widget is to show less, not everything — so this checkbox list is how the user
  trims it down per field, rather than the widget always mirroring 100% of Overview.
  - **Implemented 2026-07-22 (Settings skeleton pass):** `settings.js` (a plain native
    `form.Map` bound to `passwall2_presets`, menu entry added at
    `admin/services/passwall2-presets/settings`, order 2) with one `form.Flag` per row
    (`show_watchdog_status`, `show_xray_process`, `show_probe_a`, `show_probe_c`,
    `show_probe_b`, `show_probe_d`, `show_last_updated`, `show_configured_nodes`,
    `show_active_balancer` — new `config widget 'widget'` UCI section, all defaulting to
    `'1'`). Wrapped in a native `<details>/<summary>` element (stock CBI has no generic
    collapsible-section primitive — checked `form.js` directly) so it reads as the
    requested expandable list without inventing anything non-native. `overview.js` gained
    a `widgetVisible()` helper that returns `true` unconditionally on the full Overview
    tab, and reads the matching UCI flag only when instantiated as the standalone widget
    (a `window.PW2P_WIDGET` flag set by `widget.ut` right before it calls
    `ui.instantiateView()` — that's the only difference between the two entry points now).
    Per-preset row-level checkboxes ("show in Overview"/"show in widget" from the bullet
    above) and Preset A read/write are **not** part of this pass — still open.
- **Fallback-chain and per-domain routing UX (proposed, not yet decided):** built
  entirely from PW2's own already-loaded node list — not a free-form custom-server
  field, since the app's core principle is "shell over PW2, no logic outside it."
  Concretely:
  - Pick a node from the loaded list → "this is fallback server #1."
  - Click a "+" to add another → "fallback of the fallback," and so on.
  - Each entry has a checkbox: **exclude this node from normal balancer rotation** — so
    a node dedicated as a fallback doesn't also compete as a regular leastLoad pool
    candidate.
  - The *same* pick-from-list / "+" / exclude-checkbox pattern is reused for the "route
    specific domains through specific server(s)" section (per-domain shunt assignment) —
    one consistent UX pattern for both fallback-chain config and domain-to-node routing,
    rather than two different widgets.
- **Hard global design constraint:** everything must look and behave like native
  OpenWrt/LuCI — no invented UI patterns. Every action goes through the standard OpenWrt
  page-footer buttons; no custom app-level save flow.
  - **Verified against LuCI's own source (`luci.js`, `LuCI.view.addFooter`/`handleSave`/
    `handleSaveApply`/`handleReset`): the three native buttons are labeled exactly
    "Save", "Save & Apply" and "Reset" — there is no "Dismiss"/"Cancel" button in the
    page footer.** ("Dismiss" only exists inside `form.js`'s save-error *modal dialog*,
    unrelated to the page footer.) "Reset" re-renders the form and discards unsaved
    edits — the closest native equivalent to what was being recalled as "Cancel". Any
    view using a `form.Map` and leaving `handleSave`/`handleSaveApply`/`handleReset`
    un-overridden (i.e. not set to `null`, as `overview.js` does since it's read-only)
    gets this exact footer for free — confirmed this is how `settings.js` works.

## 5. Implementation order (roadmap) — status as of 2026-07-22

1. ~~Close §0.2 (on-router diagnostics) — don't code blind.~~ **Done** — four OOM
   incidents fully diagnosed, root causes confirmed for #1/#2 and fixed, #3's trigger
   identified (connection-volume RSS spike), `monitor.sh` reliability question **resolved**
   by incident #4 (confirmed unreliable, see §0.2).
2. ~~Apply `expected='1'` to production.~~ **Done**, 2026-07-19 ~13:43 MSK.
3. ~~Decide the Xray-death watchdog question (§0.2/§2 Wave 3).~~ **Done** — **GREENLIT
   2026-07-22.** Build an external Xray-death watchdog; default action `restart`; does not
   replace `monitor.sh`, sits on top of it. Design/implementation is the new next step
   (item 3a below).
3a. Design + implement the Xray-death watchdog (detection loop, restart action, logging,
    opt-in `xray_dead_action` toggle wiring per §3). **Done — deployed and live-tested
    2026-07-22 ~16:10–16:20 MSK.** `files/etc/passwall2-presets/observer_watchdog.sh`,
    merged with item 4 below (same probe loop, per the §0.2/§2 watchdog-merge decision).
    Deployed via `scp -O` to `/etc/passwall2-presets/` on the still-broken (OOM #4) router
    as its own live test bed (user's call). **Live result:** watchdog detected the dead
    Xray, waited the 30s grace period, issued `/etc/init.d/passwall2 restart` at 13:14:00
    router time — that first attempt didn't bring Xray up in time and the state machine
    fell back to `down-in-grace`; correctly held off retrying through the 120s
    `RESTART_COOLDOWN` rather than restart-looping; second restart at 13:16:00 succeeded,
    reaching `ok` with a confirmed real exit IP by 13:17:01 — full unattended recovery from
    an hours-long dead state, no human action taken on the router itself.

    **Two bugs found and fixed during this first deploy** (both from real `uci`/router
    behavior that couldn't have been caught by `sh -n` alone, since the sandbox has no
    router access to test against):
    - UCI section-name collision: the config template used the same section name `'main'`
      for both `config global` and `config observer`, which UCI rejects file-wide
      regardless of type ("section of different type overwrites prior section with same
      name"). Fixed by renaming the `global` section to `'global'` (commit `43671c7`).
    - Node count always reported `1` instead of the real `27`: `uci -q get` on a
      list-type option returns all values space-separated on **one line** on this
      router's `uci` build, not one-per-line as the original code assumed — counting via
      `grep -c .` counts lines, not values. Fixed by counting via `set --
      $(uci_get_list ...); TOTAL_NODES=$#`, which counts whitespace-separated tokens
      through the shell's own word-splitting regardless of `uci`'s line format (commit
      `27e18ca`). Confirmed on the live router: `total_configured` now correctly reads
      `27` against the `wave1_bal` balancer.
4. Observer prototype (no UI) — all four probes (A/B/C/D). **Done — deployed alongside
    3a, same live test.** Config template at `files/etc/config/passwall2_presets`
    (package `passwall2_presets`, ships with region-neutral Probe A/C IP-checker
    defaults only — Probe B/D disabled until the user fills in a host, no regional
    defaults, per standing policy). Cron snippet (not auto-installed) at
    `files/etc/passwall2-presets/crontab.snippet`, appended manually to
    `/etc/crontabs/root`. Probe A confirmed live (`ok`, real exit IP). Probes B/C/D not
    yet exercised — they ship disabled/no-hosts by design and the user hasn't configured
    them yet. **Known limitation, not silently faked:** node count can only report the
    active balancer's configured pool size (`balancing_node`, discovered dynamically,
    confirmed `27` live) — a live "currently healthy" count is not available anywhere in
    UCI since PW2 doesn't expose an Xray API inbound (§4, BACKLOG P7); the status JSON
    reports this field as `"unavailable_no_xray_api"` rather than guessing a number.
5. Preset A (auto-selection engine) — UCI generator for Xray Balancing / sing-box
   URLTest, `expected='1'`/`leastLoad` as the "Most stable" default, plus the
   `fallback_direct_enabled` opt-in toggle and its issue #439 DNS-caveat UI copy.
   **Not started.**
6. LuCI Overview + standalone widget page, backed by Observer data. **Done,
   2026-07-22; revised 2026-07-22 per user feedback (native Status widget rejected,
   badges restyled, events gated, poll interval made explicit).** Read-only Overview
   page at `admin/services/passwall2-presets/overview`
   (`files/www/luci-static/resources/view/passwall2-presets/overview.js`) rendering
   the full status JSON (watchdog badge, Xray alive, active balancer, node counts,
   Probes A-D) plus a tailed recent-events log view (hidden behind a checkbox by
   default), auto-polling every 5s via `poll.add(fn, 5)`. Badges use only native
   luci-theme-bootstrap classes/CSS variables (`.label.success`/`.label.warning`/
   bare `.label`, plus `--error-color-high`/`--on-error-color` for the red state the
   theme doesn't have a `.label` modifier for) — see §4 for the exact mapping.
   **The native Status > Overview widget slot
   (`files/www/luci-static/resources/view/status/include/60_passwall2-presets.js`)
   was removed** — the user explicitly didn't want anything living there. In its
   place: a standalone chrome-less page at `admin/services/passwall2-presets/widget`
   (hidden from the menu tree, no title) backed by a ucode template
   (`files/usr/share/ucode/luci/template/passwall2-presets/widget.ut`) that uses the
   theme's own native `blank_page` flag (the same mechanism `sysauth.ut` and
   `luci-app-commands`'s `commands_public.ut` use) to drop the navbar/sidebar/footer,
   then instantiates the *same* `passwall2-presets/overview` view — one
   implementation, two entry points, full status panel (not just the log) on both.
   Menu entries (`files/usr/share/luci/menu.d/luci-app-passwall2-presets.json`) and
   ACL grant (`files/usr/share/rpcd/acl.d/luci-app-passwall2-presets.json`) for the
   status/log files ship alongside. Settings tab (editing probes/watchdog config)
   remains **not started** — router config must still be edited directly via
   `/etc/config/passwall2_presets`.
7. Preset B (Shunt-based bypass). **Not started.**
8. Nodes tab — 12-column sortable metrics table per §4, once the time-series data-source
   question is resolved. **Not started.**
9. Settings tab — preset list + fallback-chain/per-domain-routing UX per §4, native
   Save/Save & Apply/Cancel only. **Not started.**
10. Preset C (fixed IP) — Wave 2. **Not started.**
11. Preset D (emergency direct) / Preset E (always-direct devices) — Wave 2, from the
    §0.3 survey. **Not started.**
12. Extended package (HAProxy/SOCKS Auto Switch) with a warning gate — Wave 3, on
    request only. **Not started.**
13. Log-size safety net for `global.log` (deferred defense-in-depth from incident #2).
    **Not started, low priority.**

## 6. Environment & paths reference

**Router:** Asus RT-AX53U / RT-AX1800U, hostname `Shelter`, platform `ramips/mt7621`,
OpenWrt 23.05.x, LAN `192.168.206.1`, SSH port `56777`. ~244MB total RAM
(`free`: total 250304kB). Xray `26.7.11`, `luci-app-passwall2` `26.7.16`.

**This repo:** [`github.com/web3archi/openwrt-passwall2-presets`](https://github.com/web3archi/openwrt-passwall2-presets),
branch `master`, local clone at `/home/user/workspace/presets_repo` in the agent
sandbox. Deploy key for this repo is a dedicated `ssh-ed25519` key at
`~/.ai-profiles/profiles/web3archi/github/ssh/presets_ed25519(.pub)` on the user's own
machine (not the router, not the sandbox).

**Predecessor repo (archived, reference only):**
[`github.com/web3archi/openwrt-passwall2-watchdog`](https://github.com/web3archi/openwrt-passwall2-watchdog) —
the abandoned parallel-daemon approach this spec pivots away from; see
`LEGACY_BACKLOG.md` in this repo for its diagnostic history (P1–P19).

**Key on-router paths:**
- `/tmp/etc/passwall2/bin/xray` — the Xray binary PW2 launches (`xray run -c ...`).
- `/tmp/etc/passwall2/bin/dnsmasq` — PW2's own dnsmasq instances (two processes seen
  concurrently: one as `nobody`, one as `dnsmasq` user).
- `/usr/share/passwall2/monitor.sh` — PW2's built-in process watchdog (see §0.1/§0.2).
- `/usr/share/passwall2/lease2hosts.sh` — PW2 helper script, seen alive in `ps` alongside
  `monitor.sh` and dnsmasq during normal operation.
- `/tmp/etc/passwall2/acl/default/global.log` — Xray's log file, tmpfs-resident, root
  cause of incident #2 when `loglevel=debug` (see §0.2).
- `/tmp/bak_v2ray/geoip.dat` — stale backup removed as part of incident #2's fix; the
  live file is `/tmp/geoip.dat` (RU-WHITELIST-pruned, ~1.6MB).
- `/tmp/log/passwall2.log` — the init script's own restart/reload log (does **not**
  record OOM kills — those are kernel-only, visible only via `dmesg`).

**Confirmed current production balancer config** (`uci show passwall2.wave1_bal`, as of
2026-07-20): `type='Xray'`, `protocol='_balancing'`, `remarks='Wave1_Balancing'`,
`node_add_mode='manual'`, 27 `balancing_node` entries, `fallback_node='JsIDZcgP'`,
`balancingStrategy='leastLoad'`, `expected='1'` (see §2), `tolerance='10'`,
`probeInterval='2m'`. Global `loglevel='warning'` (`passwall2.@global[0].loglevel`).

## 7. Sources

- [app.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/app.sh) — start/stop, DNS generation, no auto-cleanup on Xray crash.
- [nftables.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/nftables.sh) — DNS hijack and TPROXY/REDIRECT rules, `del_firewall_rule()`.
- [monitor.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/monitor.sh) — PW2's built-in process watchdog (reliability empirically contested, §0.2).
- [util_xray.lua](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/luasrc/passwall2/util_xray.lua) — `gen_balancer()`, confirms `fallback_node='_direct'` maps to Xray's `direct`/`freedom` outbound.
- [GitHub issue #796 "Kill Switch"](https://github.com/xiaorouji/openwrt-passwall2/issues/796) — confirms the absence of a native killswitch and the feature being closed as not planned.
- [GitHub issue #439](https://github.com/xiaorouji/openwrt-passwall2/issues/439) — DNS-breakage pitfall when a shunt's default node is set to direct.
- [`passwall-auto-switch.sh` gist](https://gist.github.com/fakhamatia/d84bdddc39f555bef30574185a19bc53) — community example of `default_node="_direct"` as a manual emergency toggle.
- Project research report: `PassWall2-avtoperekliuchenie-proksi-URLTest-health-check-i-balansirovka.md` (Space file) — Shunt/Balancing/URLTest/HAProxy/SOCKS Auto Switch mechanics, GitHub citations to `type/ray.lua`, `type/sing-box.lua`, `util_xray.lua`, `shunt_options.lua`.
- `wan_monitor.log` excerpts (user attachments, 2026-07-17 through 2026-07-19 evening) — factual data on exit-IP switching frequency, leak false-positives, and the incident #3 blackout window.
- `LEGACY_BACKLOG.md` (this repo) — full diagnostic history (P1–P19) inherited from the archived `openwrt-passwall2-watchdog` project.
- `docs/BACKLOG.md` (this repo) — P1–P6, the living record this spec is periodically synchronized against.
