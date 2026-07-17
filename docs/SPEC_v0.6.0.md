# SPEC v0.6.0 — "PW2 Presets Addon"

Status: draft for discussion. Coding has not started — architecture is fixed first.
Date: 2026-07-17.

## 0. Research summary (basis for this spec)

Key pivot: the old watchdog/chooser daemon is redundant. PassWall2 (hereafter PW2)
already natively does what we were trying to build on top of it: automatic
best-node selection (Xray Balancing / sing-box URLTest), health-checking, fallback.
Our code should become a thin layer — a config-preset generator plus a lightweight
observer — rather than a parallel traffic-control engine.

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
  observed in the WAN Monitor log: a total internet outage, but never a leaked outside IP.
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

**Conclusion:** PW2's native behavior needs no additional killswitch for the "Xray died
while running" scenario — it's already fail-closed there. What might be worth building
(if we decide to) is a **narrow "guard" covering only the stop→start window and the
boot-before-init window** — a fundamentally lighter task than a 24/7 parallel nft DROP
table (which is likely the actual cause of P18 — the throughput drop bug).

### 0.2 Open items requiring on-router diagnostics (cannot verify myself — no router access)

Before coding any guard/killswitch v2, we need facts, not guesses:

1. Confirm/refute the OOM hypothesis for the 2026-07-17 05:57–06:01 incident:
   ```
   logread | grep -iE "oom|xray|killed|segfault" | grep "Jul 17.*0[56]:5"
   dmesg -T | grep -i xray | tail -30
   ps w | grep xray
   uptime -p; cat /proc/uptime
   ```
2. Check whether PW2's own watchdog is enabled (explains why auto-recovery didn't
   happen within the expected ~58–64s):
   ```
   uci get passwall2.@global[0].enabled
   uci get passwall2.@global_delay[0].start_daemon
   ```
3. Confirm the firewall backend (nftables/fw4 expected on OpenWrt 23.05, but verify):
   ```
   uci get passwall2.@global_forwarding[0].prefer_nft
   ```
4. (Not blocking for this spec, but useful for the guard decision) Measure the actual
   duration of the "hole" on this hardware: during `/etc/init.d/passwall2 restart`, run
   a separate `tcpdump -i <wan_iface>` or a direct (non-SOCKS) `ping`/`curl` loop and see
   how many packets actually get through directly and for how long.

> **Update (2026-07-17, later the same day):** items 1–3 above have since been answered
> with real router data — see `LEGACY_BACKLOG.md` P19 in this repo for the full
> diagnostic trail (OOM-kill of xray confirmed and time-correlated to the outage;
> `enabled=1` and `start_daemon=1` both confirmed, yet recovery still took 8+ hours;
> `prefer_nft=1` confirmed). Item 4 (exact leak-window duration) remains unmeasured.
> §5 (killswitch v2 / guard) stays out of MVP scope regardless, per the roadmap below.

## 1. Architecture

The addon is not a separate traffic-control daemon — it is three layers:

1. **Presets Engine** — a set of presets, each being a set of `uci set`/
   `uci commit passwall2` commands plus `/etc/init.d/passwall2 reload` (not a full
   restart, if supported — need to confirm with PW2 exactly what triggers a full
   `stop()+start()` versus a partial reload, to minimize the window from §0.1). No
   hardcoded node ids/names — selection always goes through discovery (the actual list
   of existing `passwall2.@nodes[*]`, as in the previous project).
2. **Observer (lightweight)** — reuse the existing `wan_monitor.sh`-style approach in
   spirit: a periodic curl (through PW2's SOCKS port for "current IP/speed," and
   separately outside the proxy as a "did we leak" reference) plus `EXIT IP CHANGED`
   detection for a switch counter. It observes, it does not control traffic — it never
   touches iptables/nft, so it cannot create a second version of the P18 bug.
3. **LuCI pages** (Overview / Nodes / Help) — read-only: (a) state from PW2's own UCI,
   (b) state from our own Observer. Duplicates none of PW2's internal logic.

Explicitly NOT building: our own chooser/failover engine (Balancing/URLTest already do
this), our own 24/7 nft killswitch (see §0.1).

## 2. Presets — implementation priority

### Wave 1 (needed immediately — P1 and P2 from the task)

**Preset A — "Best node" (native switching)**
Configures Xray `_balancing` (for Xray-type nodes) or sing-box `_urltest` (for
sing-box-type nodes) — the engine is chosen automatically based on the user's node
types, no hardcoding.

Strategy choice — exposed to the user as an understandable choice (not a blind
"leastPing" field):

| UI option | What actually gets set |
|---|---|
| "Fastest" | Xray Balancing `strategy=leastPing`; sing-box `urltest` with a low `tolerance` (~30-50ms) |
| "Most stable" (default) | Xray Balancing `strategy=leastLoad`, `expected` and `tolerance` drawn from the pool of good nodes (as already configured manually today: expected=2, tolerance=10) |
| "Manual with auto-restore" | SOCKS Auto Switch: `Main node` + `List of backup nodes` + `Restore Switch` — for when the user wants an explicitly pinned primary node rather than "best by metric" |

Mandatory preset fields: `fallback_node` is **never** Direct (the preset validator
checks this and blocks saving with an explicit explanation why — see §0.1; this is the
one leak protection that actually works).

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
discovery comes from the user's existing ipset/geosite sets, not hardcoded. This is the
one place in the entire architecture where Direct is a deliberate, explicit choice
rather than an emergency fallback.

### Wave 2 (next)

**Preset C — "Fixed IP"**
A separate Shunt rule for specific domains (banking/streaming) → one pinned node, not
routed through Balancing/URLTest (so the IP doesn't change). Combining this with
Preset A's Fallback Node is under discussion: if the pinned node dies, either (a) the
same general pool of "good" nodes as the shared Fallback, or (b) a dedicated fallback
specific to this domain group — offer the user the choice when creating the preset,
don't silently decide for them.

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

**Killswitch v2 / boot-and-restart guard** — only after the diagnostics from §0.2. If
the leak window on this hardware turns out to be negligibly short (tens of ms) — don't
build it at all, save the complexity. If it's significant, it should be built not as a
24/7 DROP table, but as a temporary default-deny that's held exactly from `stop()`
until `start()` completes (and on boot — until PW2's first successful start), then
lifts itself.

## 3. Addon UCI schema (draft, for discussion)

A separate config, not mixed with `passwall2`:

```
config global 'main'
    option preset 'best_node'      # currently active preset (discovery/id, no hardcoded values inside)
    option strategy 'stable'       # fast|stable|manual — maps to the table in §2

config observer 'main'
    option enabled '1'
    option interval '30'           # seconds; lightweight probe, not 58s like monitor.sh — a separate process
    option probe_url 'https://api.ipify.org'
    option socks_port ''           # discovered from passwall2.@global[0].node_socks_port, not hardcoded

config preset 'bypass'
    option enabled '0'
    list direct_domain_set ''      # discovered from existing geosite/ipset sets, not hardcoded

config preset 'fixed_ip'
    option enabled '0'
    list domains ''
    option node ''                 # discovered from passwall2.@nodes[*]
    option fallback_mode 'shared'  # shared|dedicated — see §2 Wave 2
```

## 4. LuCI pages (screen spec)

- **Overview** — active preset, current node + latency, switch counter
  (today/last hour), status of the last N observations (a compact WAN Monitor
  analog), a "test now" button.
- **Nodes** — list sourced from PW2 (we don't duplicate its database), with a
  "in preset A's pool: yes/no" column.
- **Help** — static text explaining the presets and warning about Wave 3.
- **Widget** (LuCI main-page widget) — a collapsed version of Overview: node, speed,
  status.

## 5. Implementation order (roadmap)

1. Close §0.2 (on-router diagnostics) — don't code blind.
2. Observer prototype (no UI) — reuse/adapt the existing wan_monitor script, add
   current-node detection via SOCKS-port discovery.
3. Preset A (auto-selection engine) — UCI generator for Xray Balancing / sing-box
   URLTest, plus a "fallback ≠ Direct" validator.
4. LuCI Overview + Widget, backed by Observer data.
5. Preset B (Shunt-based bypass).
6. Preset C (fixed IP) — Wave 2.
7. Extended package (HAProxy/SOCKS Auto Switch) with a warning gate — Wave 3, on
   request only.
8. Killswitch v2 (guard) — only if §0.2/measurements justify it.

## 6. Sources

- [app.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/app.sh) — start/stop, DNS generation, no auto-cleanup on Xray crash.
- [nftables.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/nftables.sh) — DNS hijack and TPROXY/REDIRECT rules, `del_firewall_rule()`.
- [monitor.sh](https://github.com/Openwrt-Passwall/openwrt-passwall2/blob/main/luci-app-passwall2/root/usr/share/passwall2/monitor.sh) — PW2's built-in process watchdog.
- [GitHub issue #796 "Kill Switch"](https://github.com/xiaorouji/openwrt-passwall2/issues/796) — confirms the absence of a native killswitch and the feature being closed as not planned.
- Project research report: `PassWall2-avtoperekliuchenie-proksi-URLTest-health-check-i-balansirovka.md` (Space file) — Shunt/Balancing/URLTest/HAProxy/SOCKS Auto Switch mechanics, GitHub citations to `type/ray.lua`, `type/sing-box.lua`, `util_xray.lua`, `shunt_options.lua`.
- WAN Monitor log for the 2026-07-17 incident (`paste.txt`, user attachment) — factual data on the absence of leaks and the nature of the final outage.
- `LEGACY_BACKLOG.md` P19 (this repo) — confirmed OOM root cause and rollback decision, superseding §0.2 items 1-3 above.
