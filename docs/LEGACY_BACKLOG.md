# Backlog

Open items, ordered by priority. Move to `BUGS.md` when reproducible /
investigated.

## v0.5.1 shipped: killswitch lock fix + UI honesty pass

Fixed a race condition where the background `ks_daemon_loop`'s periodic
`ks_reconcile()` could run concurrently with an interactive CLI
`pw2watchdog.sh killswitch {reconcile|drop|rebuild}` invocation, producing
`reconcile FAILED: ... No such file or directory` errors in syslog when both
fired at once. Fixed with a dedicated `KS_LOCK_FILE` lock (separate from
`pw2watchdog.sh`'s own daemon lock) guarding all killswitch table mutations
in `pw2watchdog-killswitch.sh`: `ks_drop_table()`/`ks_reconcile()` are now
locked public wrappers around lock-agnostic `_ks_drop_table_raw()`/
`_ks_reconcile_raw()`, and a new atomic `ks_rebuild()` replaces the old
unlocked drop-then-reconcile-then-reconcile CLI sequence.

Also bundled in this release (all four items requested together):

1. **"Recommended concurrency budget" relabel (was "Device performance").**
   The Overview Low/Medium/High tier (previously labelled Weak/Medium/
   Powerful) was never a live CPU/RAM benchmark — `HW_RECOMMENDED_CANDIDATES`
   in `pw2watchdog-env.sh` `collect_hw_info()` is a pure function of
   `check_interval`/`timeout_per_node` only. This is why a router with
   unchanged hardware could flip from "Weak" to "Powerful" tier just by
   retuning those two settings — nothing about the actual CPU was measured.
   Renamed tiers + added an explicit disclaimer line in Overview, and
   corrected the matching text in `help.js` and `README.md`. No underlying
   hardware benchmarking was added — this is a UI-honesty fix, not a new
   detection feature. A real hardware-aware recommendation (reading actual
   CPU/RAM) remains a possible future enhancement, not done here.
2. **Widget "Reset counters" button was still in Russian** in
   `pw2widget.html` (button label + `confirm()` dialog text) despite the
   rest of the UI being English — fixed both strings.
3. **Stale annotations audit vs v0.5.0.** `help.js`'s "Independent
   Killswitch" note block still described the removed v0.4.2 reactive model
   (mode=auto/always/off, failure_detection=dual/rules_only/socks_only,
   hysteresis, grace_period) and referenced non-existent CLI commands
   (`ks-status`/`ks-arm`/`ks-disarm`) — rewritten to describe the actual
   v0.5.0+ fields (enabled toggle, `reconcile_interval`,
   `active_node_override`, `whitelist_extra`) and the real CLI
   (`pw2watchdog.sh killswitch {status|reconcile|drop|rebuild}`).
   `settings.js`'s Advanced Settings descriptions for `pw2_proxy_port`/
   `pw2_proxy_check_url` claimed these feed "the killswitch SOCKS probe" —
   that probe was removed in v0.5.0 (the new killswitch never touches
   SOCKS); descriptions now say so and mark the fields legacy/diagnostic
   only (consumed as a fallback default by `wd-preflight.sh`).
4. **New "Killswitch status" tile in Overview**, placed between the
   existing Watchdog status and Proxy status tiles in the main status
   block, showing the current posture (Enforcing drop-by-default /
   Enforcing direct-allowed / disabled / error) via a reusable
   `buildKsPostureCell()` helper (previously this badge logic was only
   used in one place; extracting it into a function avoids a DOM
   single-parent-reuse bug if the same built node were ever attached to
   two rows).

## v0.5.0 shipped: permanent structural killswitch

The entire reactive arm/disarm killswitch model (`ks_arm`/`ks_disarm`,
SOCKS-alive probing, `min_pw2_rules` threshold, `bg_grace`/`bg_hysteresis`
anti-flap) was replaced by a permanent default-deny nftables table that
reconciles against dynamically-discovered PassWall2 state on a timer.
See the "Design idea: structural fail-closed killswitch" entry further
down (marked SHIPPED) for the full design/implementation writeup, and
the v0.5.0-beta entry in [README.md](../README.md) for the user-facing
changelog. As a consequence, several older tickets below that were
written against the reactive model are now marked OBSOLETE / RESOLVED /
needing re-verification: P1, P4 (adaptive baseline), P6, P13, P14 —
look for the `v0.5.0` annotations in each ticket's status line. A
companion fix to `pw2watchdog-directcheck.sh` (v0.1 → v0.1.1, a
fallback-aware leak classifier + an idle-gap episode-duration bugfix)
shipped in the same release.

## P1 — ks_xray_socks_alive() probe runs with empty SOCKS port → permanent armed — OBSOLETE (superseded by v0.5.0)

**Status:** OBSOLETE as of v0.5.0. The reactive arm/disarm state machine
this bug lived in (`ks_apply`, `ks_arm`, `ks_xray_socks_alive`, `ks_load_env`
SOCKS-port resolution) was removed entirely in the v0.5.0 structural
rewrite — see "Design idea: structural fail-closed killswitch" below,
shipped section. The new `pw2watchdog-killswitch.sh` never probes SOCKS
and never arms/disarms; it reconciles a permanent default-deny table
against discovered PW2 state on a timer. Kept below for historical
context only (the `lan4` CIDR-detection bug it also surfaced was fixed
separately and carried forward — the current killswitch derives LAN
CIDRs from the kernel route table, not from `uci show network` regexes).

**Original status (pre-0.5.0):** root cause confirmed 2026-06-23 00:40 MSK. Workaround applied.
Pending proper fix in `pw2watchdog-env.sh` + `ks_load_env()` + LuCI.

### Symptom (pre-workaround)
- xray alive, `PSW2_MANGLE` has 16 rules, SOCKS on 1070 responds normally
- But `ks.state=armed` with `reason=xray_unreachable` or `reason=guard_active`
- syslog spams `pw2watchdog-killswitch: armed` every 5–10 s
- scanner shows almost every node as `latency=0 status=red`

### Root cause
1. `pw2watchdog-env.sh` writes to `/var/run/pw2watchdog/env.static`
   the fields `PW2_NFTABLE_NAME`, `PW2_NFTCHAIN_MANGLE`, `PW2_FWMARK`,
   etc. — **but not `PW2_SOCKS_PORT` and not `PW2_PROXY_CHECK_URL`**.
2. `ks_load_env()` in `pw2watchdog-killswitch.sh` then tries to fill the
   gap from UCI:
   - `uci get pw2watchdog.advanced.pw2_proxy_port` → not defined → `""`
   - `uci get pw2watchdog.advanced.pw2_proxy_check_url` → not defined →
     fallback to `https://cp.cloudflare.com/generate_204` ✓
3. So `PW2_SOCKS_PORT=""` in runtime.
4. `ks_xray_socks_alive()` invokes:
   ```sh
   curl --socks5 127.0.0.1:""  --max-time 4  "$PW2_PROXY_CHECK_URL"
   ```
   With empty port the call either errors out (`curl: option : blank
   argument where content is expected`) or fallbacks to default SOCKS
   1080 which is closed → return code not `2xx/3xx` → `socks_bad=1`.
5. `ks_apply()` sees `socks_bad=1` → arm. Next loop iteration: still
   bad → arm again. Forever.

UCI namespace mismatch (background): UI exposes
`pw2watchdog.advanced.proxy_check_url` (no `pw2_` prefix, used by
health-monitor), but `ks_load_env()` reads
`pw2watchdog.advanced.pw2_proxy_check_url` (with prefix). Two different
fields by accident, neither user-visible for the killswitch path.

### Workaround (manual, applied)
```sh
uci set pw2watchdog.advanced.pw2_proxy_port='1070'
uci commit pw2watchdog
/etc/init.d/pw2watchdog restart
```
Result: `ks.state=standby/healthy`, preflight 6/6 PASS — BUT see
secondary issue below: even when probe works and ks looks healthy, LAN
clients are still blocked because `lan4` set is built incorrectly.

### Secondary bug found 2026-06-23 ~01:00 MSK — `lan4` set covers only router IP

When armed, the `forward` chain whitelists `ip daddr @lan4` and
`ip saddr @lan4`. `lan4` is supposed to contain the LAN subnet so that
client-to-client and client-to-proxy traffic passes. In current code
it's built by two regexes against `uci show network`:

1. `s/.*\.ipaddr='([0-9.]+)\/([0-9]+)'/\1\/\2/p` — matches
   `ipaddr='X.X.X.X/Y'` (CIDR form)
2. `s/.*\.ipaddr='([0-9.]+)'$/\1/p` — matches `ipaddr='X.X.X.X'` (no
   mask) and filters by RFC1918

On this OpenWrt build (and most stock ones), the LAN interface stores
`ipaddr='192.168.1.1'` and `netmask='255.255.255.0'` as **two
separate options**. Regex #1 never matches; regex #2 catches only the
router's own IP. → `lan4 = { 192.168.1.1 }`. LAN clients
(192.168.1.140 etc.) are not in the set → forward chain drops them.

**Impact:** during any armed window (which is permanent under primary
P1 bug), the whole LAN is cut off from the proxy AND from each other
across routed segments. Hosted at `<router-ip>` is still reachable
(that's @lan4), but client → internet via proxy is gone.

**Proper fix:**
- Read `network.lan.ipaddr` and `network.lan.netmask` together
- Convert to CIDR (`ipcalc` or manual mask-to-prefix)
- Add the resulting subnet (e.g. `192.168.1.0/24`) to `lan4`
- Also handle multi-LAN setups (loop over all `interface` sections
  with proto=static)

### Proper fix (planned)
1. **`pw2watchdog-env.sh`**: auto-detect SOCKS port from PSW2 var file
   (same place `pw2_get_tproxy_port` reads, but for the SOCKS inbound
   instead of tproxy port). Record into `env.static` as
   `PW2_SOCKS_PORT='…'`.
2. **`ks_load_env()`**: keep UCI override capability, but also fall back
   to `1070` (PSW2 default) if both env.static and UCI are empty —
   instead of leaving the variable blank.
3. **LuCI**: surface `pw2_proxy_port` (and `direct_ip_ranges`, see P2)
   in the Advanced tab with sensible labels.
4. **Trace**: when `ks_xray_socks_alive` returns 1, also log the URL +
   port it used. Current `ks_trace "socks probe failed port=$port
   code=${code:-none}"` would have made this 30-minute hunt a 30-second
   one — but trace file is not enabled by default; consider switching
   on for armed-state transitions only.

### Verification
After proper fix, removing the UCI workaround
(`uci delete pw2watchdog.advanced.pw2_proxy_port; uci commit; restart`)
must still produce `standby/healthy`.

---

## P2 — `direct_ip_ranges` field has no human-readable label in LuCI — DONE

**Status:** resolved in repo source (checked 2026-07-16) — `settings.js`
now shows a proper label "★ Real WAN IP (CIDR)" above the field.
No further action needed; will ship with the next deploy.

**Observed (original, historical):** UI shows the input box with helper text
`"Required. Without this field the proxy IP monitor cannot detect
leaks......"` but no actual field title / label above it.

**Action:** add proper label like `"Router's external WAN IP / CIDR list"`
and shorter help text. Same field is referenced from:
- `pw2watchdog.advanced.direct_ip_ranges` (UCI option)
- `DIRECT_IP_RANGES` (env variable)
- `wd-preflight.sh` egress check
- `proxy_check()` direct-leak detection in `pw2watchdog.sh`

---

## P3 — `PW2WD_VERSION='v0.4.0'` while header says `0.4.1-dev` — DONE

**Status:** resolved (checked 2026-07-16) — all files consistently
report `v0.4.5-beta` via the `PW2WD_VERSION_MARKER` pattern. No
further action needed.

**Original note:**

Tech debt from the 0.4.1 deploy. Bump `PW2WD_VERSION` in
`pw2watchdog-env.sh` to `v0.4.1` before any further release.

---

## P4 — idea: reuse `wd-preflight.sh` code for health-monitor

_(captured 2026-06-23, no further analysis yet)_

The 6 checks in `root/usr/bin/wd-preflight.sh` (xray alive, PSW2_MANGLE
rules, ks daemon, ks.state standby/healthy, SOCKS responds, egress
sanity vs `direct_ip_ranges` + CF/vps4 whitelist) overlap heavily with
what the runtime health-monitor in `pw2watchdog.sh` does.

Idea: factor the probe logic into shared helpers and have both the
on-demand preflight and the long-running health-monitor call them, so
that "if preflight says READY, the monitor would also say healthy" by
construction. Investigate later.

---

## P5 — LuCI settings restored from 0.4.0 sysbackup, no 0.4.1 KS options

**Observed:** 2026-06-23 ~00:00 MSK, after PassWall2 reinstall and
sysbackup restore. The pw2watchdog LuCI Settings page is the 0.4.0
layout — it has no fields for the new killswitch options introduced
in the 0.4.1 rework (e.g. `pw2_proxy_port`, atomic-arm cache path,
LAN/VPS set bootstrap toggles, etc.).

**Status:** runtime works because watchdog auto-detects most values
from PassWall2 (and the missing `pw2_proxy_port` was manually patched
via `uci set` as part of P1 workaround). But the user has no way to
inspect or override the new options through the UI.

**Action when proper P1 fix lands:**
- Update LuCI view (Cbi/JSON model) to expose new fields
- Provide sensible defaults so first-run still produces standby/healthy
- Migrate old 0.4.0 UCI on first start: if `pw2_proxy_port` is empty,
  set to 1070; if `direct_ip_ranges` is empty, prompt user
- Bump `PW2WD_VERSION` to v0.4.1 (see P3) so the UI can detect old
  config and trigger migration

---

## P6 — wd-preflight reports ks.state=standby as OK while engine is dead — RESOLVED (v0.5.0 posture model)

**Status:** RESOLVED as a side effect of the v0.5.0 structural rewrite.
The `standby` state that made this check ambiguous no longer exists —
`ks.state` now holds `KS_POSTURE` (`drop`/`accept`/`disabled`/`unknown`),
which is derived structurally rather than tracked as an arm/disarm
flag. `wd-preflight.sh` check #4 was rewritten accordingly: `drop`
posture is OK (guard active) regardless of engine state — including
when the engine is dead, since a dead engine with `posture=drop` means
traffic is safely blocked, not leaking; `accept` posture is OK only
when `default_node=_direct` (by design) and flagged otherwise; a
missing/unparseable state file is FAIL. The dangerous
"looks-OK-but-is-actually-a-leak-window" combination this ticket
described cannot occur under the permanent model since there is no
standby state to misreport. See `root/usr/bin/wd-preflight.sh` check #4
for the current implementation.

**Original observation (pre-0.5.0):** 2026-06-23 ~01:25 MSK, after EMERGENCY STOP.
With xray killed, MANGLE empty (0 rules), watchdog daemon not
running and SOCKS dead, `wd-preflight.sh` still printed:

```
[FAIL] xray not running
[FAIL] PSW2_MANGLE rules=0 (expected >=10)
[FAIL] ks bg not running (pid=)
[ OK ] ks.state=standby healthy   <-- misleading
[FAIL] SOCKS proxy dead on 127.0.0.1:1070
[FAIL] egress matches direct range — DIRECT LEAK
```

**Why it is wrong:** `ks.state=standby` by itself only means "kill
switch is not armed". When the proxy engine is also dead, "standby"
is not a healthy state — it is an unprotected-leak state. The
preflight should not flag it as OK in that combination.

**Proposed fix in wd-preflight:**
- Treat `ks.state=standby` as OK only when `xray` is running AND
  MANGLE rules ≥ 10 AND SOCKS is reachable.
- Otherwise downgrade to FAIL with reason
  `ks.state=standby while engine dead — unprotected`.
- Keep `ks.state=disabled` OK only when `killswitch.mode=off` AND
  no proxy is expected to be active (or print INFO instead of OK).

Severity: medium — misleading green on the most critical check.


## P8 — WAN flap → PW2 MANGLE wipe → ISP IP leak

**Status:** root cause confirmed 2026-06-23 09:21 MSK. Fix landed in
`0.4.1-killswitch-rework`: hotplug script
`/etc/hotplug.d/iface/99-pw2wd-killswitch` + new dispatcher subcommand
`pw2watchdog.sh killswitch arm-forced [reason]`.

### Symptom
Real leak detected by host `wan_monitor.sh` on 2026-06-23 at 09:21:12,
duration 63 seconds, egress IP became the real ISP address. Killswitch
state was `standby` throughout because the watchdog main-loop healthcheck
saw nothing wrong — xray was running, MANGLE briefly had rules.

### Root cause
1. The OpenWrt WAN interface (uplink to upstream router) flaps multiple
   times per hour. Confirmed by repeated `odhcpd: No default route present`
   entries — observed ~11 occurrences/hour on 2026-06-23 morning. Trigger
   for the 09:21:12 leak: 09:20:40 odhcpd event, 32 s prior.
2. Each WAN ifdown/ifup fires netifd hotplug events. PassWall2 reacts by
   flushing `PSW2_MANGLE` and rebuilding it from scratch.
3. Between flush and rebuild there is a ~1-5 s window where LAN traffic
   has neither PW2 redirect nor any killswitch guard. Result: bare egress
   via WAN with real ISP IP.
4. The watchdog `transit-around` mechanism (DROP rule during planned node
   rotation) does not fire on WAN events — only on watchdog-initiated
   node switches.
5. Pre-fix the `pw2watchdog.sh killswitch arm` subcommand routed through
   `ks_apply` which respects hysteresis and grace — not suitable for
   immediate, unconditional arm in a hotplug context.

### Fix (landed)
- Added `pw2watchdog.sh killswitch arm-forced [reason]` subcommand that
  calls `ks_arm` directly (table ensure → cache build if missing →
  `nft -f`). Bypasses hysteresis and grace. Optional reason argument is
  written to `ks.state.reason` for traceability.
- Added `/etc/hotplug.d/iface/99-pw2wd-killswitch`. On `ifdown wan` it
  invokes `pw2watchdog.sh killswitch arm-forced wan_ifdown`. On
  `ifup wan` it does nothing — disarm remains owned by the main
  watchdog loop, which only releases the guard when the engine and
  proxy_check are both healthy.

### Open follow-ups (separate items, lower priority)
- **C1 (parallel investigation)**: why does the WAN flap ~11×/hour at
  all? Candidates: upstream router DHCP behaviour, Ethernet PHY between
  the two routers, STP/loop detection on the upstream, DHCP lease
  duration too short. Needs `/etc/config/network` review +
  `logread | grep -E "pppd|udhcpc|netifd"` + cable test.
- **C2**: `ks_apply` hysteresis covers the "engine briefly hiccupped"
  case but not the "MANGLE wiped externally" case. Consider lowering
  hysteresis or adding a separate fast-path detector for MANGLE-flush
  events even outside of hotplug (e.g., nft monitor).
- **C3 (v0.5.0 goal)**: evaluate "always-armed" KS posture (default-deny
  FORWARD with explicit accept rules in standby state) — eliminates the
  rebuild window entirely but is a larger refactor and any bug there
  becomes a LAN outage. Out of scope for 0.4.1.

Severity: critical — real, reproducible ISP leak in production.

---

## P4 — Adaptive baseline for `killswitch.min_pw2_rules` (planned 0.5.0) — OBSOLETE (field removed in v0.5.0)

**Status:** OBSOLETE. `killswitch.min_pw2_rules` and the whole
rule-count-threshold detection model it belongs to were removed
entirely in the v0.5.0 structural rewrite. The new killswitch does not
count PW2 mangle rules at all — it checks the resolved `default_node`
value directly (`_direct` → accept, anything else → drop), which is a
binary discovery, not a threshold to calibrate. This whole design
(baseline calibration, floor/threshold_pct UCI keys, `ks-recalibrate`
CLI) is superseded and will not be implemented. Kept below for
historical context only.

**Original status (pre-0.5.0):** design approved, implementation deferred to 0.5.0 (part of
preflight→health-monitor refactor).

### Problem
`killswitch.min_pw2_rules` is a hard threshold (default 5). When PW2
configuration changes (more/fewer nodes, additional sets, custom rules),
the actual rule count in `PSW2_MANGLE` shifts. Threshold either:
- too low → KS does not arm when mangle was partially flushed
- too high → KS arms on transient rebuild while PW2 is fine

### Design
Self-learning baseline measured at daemon start in a known-healthy
window:

1. **Calibration window** — at `ks_start_bg` or first `ks_apply` after
   engine reports alive AND SOCKS up AND uptime > `bg_grace`:
   - sample `ks_pw2_rule_count` 10 times at `bg_interval` step
   - take median value
   - write to `/var/lib/pw2watchdog/ks.baseline`:
     ```
     PW2_MANGLE_BASELINE=46
     PW2_MANGLE_BASELINE_TS=1718764800
     ```
2. **Health check** — `ks_pw2_mangle_healthy()` becomes:
   ```
   count=$(ks_pw2_rule_count)
   floor=$(ks_min_pw2_rules_floor)
   baseline=$(ks_baseline_count)
   threshold_pct=$(ks_baseline_threshold_pct)
   [ "$count" -ge "$floor" ] || return 1
   [ "$count" -ge "$((baseline * threshold_pct / 100))" ] || return 1
   ```
3. **Auto-recalibration** — when actual count stays above
   `baseline * recalibrate_pct/100` for 24 h, kick a new calibration
   pass. Logged to syslog.

### UCI changes
Rename and add (idempotent migration in `99-pw2watchdog`):
- `killswitch.min_pw2_rules` → `killswitch.min_pw2_rules_floor`
  (absolute minimum, default 3 — covers "PW2 disabled entirely" case)
- `killswitch.baseline_threshold_pct=60` (new)
- `killswitch.baseline_auto=1` (new — enable self-learning)
- `killswitch.baseline_recalibrate_pct=120` (new)

### CLI surface
- `pw2watchdog ks-recalibrate` — force a fresh calibration pass
- `pw2watchdog ks-baseline` — print current baseline + age + threshold

### LuCI changes
- Read-only field in KS section:
  `Current baseline: 46 rules (learned 2026-06-25 14:32)`
- Button `Recalibrate baseline` → triggers `pw2watchdog ks-recalibrate`
  via `ubus` or `fs.exec`
- Rename label `Min PW2 rules` → `Floor (min PW2 rules absolute)` with
  explainer

### Scope
~150 lines new code in `pw2watchdog-killswitch.sh`, ~30 lines in
`pw2watchdog.sh` (ubus surface), ~50 lines in LuCI. Part of P4 group
(preflight→health-monitor refactor) for 0.5.0.

### Why not now (0.4.2-beta)
Risks colliding with the in-flight KS hardening (P1 series). Better
to ship after baseline of "engine + SOCKS + mangle" detection is
proven stable on the live router for at least 2 weeks.

---

## P9 — Real WAN IP mirror in Killswitch section (UX, planned 0.4.5)

**Status:** deferred from the 0.4.4-beta curl-dependency-check track.
The `curl_path` mirror landed as read-only by design (one editable
source of truth in Advanced, read-only mirrors elsewhere). Real WAN IP
(`direct_ip_ranges`) is the next candidate for mirroring but the
constraints are different: required field, blocking validate, and
operators routinely edit it from the Killswitch context.

### Why a separate ticket
The `curl_path` pattern (DummyValue mirror + Configure in Advanced link)
does not transfer cleanly. Real WAN IP is something the operator
actively wants to edit when triaging a killswitch incident, not just
inspect. Two writable `form.Value` on one UCI key is a known CBI
footgun (last-rendered wins on save). Need to pick between:

- **A.** keep current single-section model, link from KS to Health
  Monitor field. Safest, worst UX.
- **B.** write a CBI-aware proxy field: KS shows a `form.Value` with
  `cfgvalue`/`write` overrides that read+write `proxyChk.direct_ip_ranges`.
  Editable from both places, single source of truth.
- **C.** move the field itself to a shared "required fields" subsection
  at the top of the page and remove duplication entirely.

### Acceptance criteria
- Operator can edit Real WAN IP from the Killswitch section without
  scrolling.
- The required-field validate still fires regardless of where the
  value is left blank.
- Save & Apply persists exactly one UCI key, no ambiguity in `uci show`.

---

## P10 — Negative test for 0.4.4-beta curl-missing path (validation, planned 0.4.5)

**Status:** open. Only happy path verified on the live router as of
release v0.4.4-beta. All curl-missing branches (`ks_apply` downgrade,
`ksDowngradeWarn` red banner, `proxy_check` graceful skip, live-204
probe `curl_missing` reason, `hmCurlMirror` / `ksCurlMirror` red pill)
are untested against an actual missing binary.

### Test plan
1. Snapshot ks.state and env.static.
2. `opkg remove curl` on the router.
3. `pw2watchdog.sh env-rescan`.
4. Verify:
   - env.static has `PW2_CURL_BIN=''`
   - ks.state shows `KS_EFFECTIVE_MODE='rules_only'` while configured
     stays `dual`
   - syslog has `curl: NOT FOUND` and the one-shot WARN about
     auto-downgrade (no per-tick spam)
   - `proxy_check skipped: curl_missing` in syslog, no false-positive
     `proxy down` event
   - LuCI Settings: ksDowngradeWarn red banner visible, both curl pills
     show red NOT FOUND state
5. `opkg install curl` (or set `curl_path` UCI override to a fresh
   install), click Re-check curl in the UI, verify everything
   re-greens within one rescan cycle.
6. `opkg install curl` again to leave the router in known-good state.

### Risk
Low. The router runs in a controlled lab; restoring curl is one opkg
command. Worth a focused 30 min session.

---

## P11 — Build `.ipk` artifact and attach to GitHub releases (release hygiene, planned 0.4.5)

**Status:** open, root cause confirmed 2026-07-16. Both CI workflows that
were supposed to deliver this (`.github/workflows/build-ipk.yml`,
`.github/workflows/deploy-feed.yml`) have **never once succeeded** across
the entire project history (v0.4.0 through v0.5.1-beta, 15+ runs) —
confirmed via `gh run list` / `gh api .../actions/jobs/<id>/logs`.
Every run fails with the same OpenWrt SDK error:
```
make[1]: *** No rule to make target 'package/luci-app-pw2watchdog/download'. Stop.
```
This is a classic feed-registration issue: `openwrt/gh-action-sdk@v9`
never recognises the repo-root `Makefile` as an indexed feed package
before the build step tries to `download` it.

Consequence: README's old "Option A — LuCI upload" and "Option B — opkg
feed" sections referenced a `.ipk` on the Releases page and a
`https://web3archi.github.io/openwrt-passwall2-watchdog/` opkg feed that
**have never existed** (zero release assets ever attached; no `gh-pages`
branch; the Pages URL 404s). README has been corrected (2026-07-16) to
only document the one method that actually works today: manual `rsync`
over SSH (previously "Option C", now the only option) — and that method
itself was ALSO incomplete as written (it copied `root/` but never
`luasrc/view/pw2watchdog/*.js` to `/www/luci-static/resources/view/pw2watchdog/`,
so the LuCI web UI would be missing); this has been fixed too.

Current releases ship source only; users must clone + manually copy files
(see README "Manual install" section), or `make package` locally with
their own OpenWrt SDK checkout. A pre-built `.ipk` per release would let
the operator `wget` + `opkg install` directly — that is still the goal
of this backlog item, just not yet achieved.

### Constraints
- Needs the OpenWrt SDK for ramips/mt7621 23.05.x to match the target.
- Cross-architecture: at minimum the `luci-app` is `all`-arch, but
  scripts depend on busybox utilities specific to OpenWrt.
- CI option: GitHub Actions with the `openwrt-sdk` Docker image. Adds
  ~3 min per push; gates on tag matching `v*-beta`. **Needs the feed-
  registration bug fixed first** — likely a missing/malformed feed
  manifest or wrong working-directory passed to `gh-action-sdk`.
- Manual option: build once per release in a local SDK checkout and
  attach via `gh release upload`.
- Lower-effort alternative floated but not yet decided: a local install/
  update helper script (`install.sh` or `make install ROUTER=<ip>`) that
  wraps the two `rsync` commands from the README, shipped in-repo. Would
  not need CI or SDK at all, and unblocks users sooner.

### Acceptance
- v0.4.5-beta release page shows `pw2watchdog_X.Y.Z-beta_all.ipk`
  as a downloadable asset.
- README upgrade section gets a one-liner: `wget <ipk> && opkg install <ipk>`.
- Until then: README must never claim an `.ipk`/opkg feed exists — keep
  it honest about the manual-copy-only reality (regression check for
  future release-notes edits).

---

## P12 — Health Monitor Details counters: broken / questionable / missing reset (planned 0.4.5)

**Status:** open. Observed by operator on the live router 2026-06-24
while reviewing Health Monitor Details (Overview page) and the
`/pw2widget.html` widget. Three independent issues in the same panel.

### Issue 12.1 — Detected leaks counter does not increment

The `detected_leaks` field stays at 0 even when the host-side
`/tmp/wan_monitor.sh` records real LEAK events on the same router. The
in-router detector is not reliable enough to be a counter.

The host-side monitor works by direct external IP polling from a
third host with the proxy off, comparing live egress IP against the
router's expected WAN IP. The watchdog cannot do the same from
inside the router (the only egress it sees is itself); it currently
infers a leak from `proxy_check_state` transitions which is too
indirect.

**Rethink needed.** Candidates:
- Reuse `wan_monitor.sh` logic on the router (poll an external IP
  echo via WAN interface explicitly, not via default route). Requires
  binding the curl/IP echo call to the WAN interface so the response
  carries the real WAN IP, not the proxied one.
- Pair with a remote endpoint (operator's host) that pushes back the
  observed egress IP via a tiny HTTP call. Adds external dependency.
- Drop the counter from the Details panel entirely and rely on the
  host monitor as ground truth.

### Issue 12.2 — Rotation transit counter is always 0

The `rotation_transit` field never increments. Either the
instrumentation point in `_restart_with_blackhole()` was never wired
to write the counter, or the counter is wired but the field is sourced
from a stale key in status.json.

**Decision needed before code:**
- If the counter would be useful for debugging future rotation
  incidents — fix the wiring (likely in `pw2watchdog.sh` around the
  `ks_arm` Plan C call from v0.4.3-beta) and add a unit test.
- If it duplicates information already in syslog `rotate_pre_arm`
  events — remove the field from the panel and the status.json
  schema entirely.

### Issue 12.3 — No reset button for the Details counters

All counters (`drops`, `flaps`, `detected_leaks`, `rotation_transit`,
etc.) are monotonic since the watchdog last restarted. No way to
clear them from the UI — the operator has to `/etc/init.d/pw2watchdog
restart` which also restarts the engine state machine.

**Acceptance criteria:**
- New "Reset counters" button in the Details panel + widget.
- ACL: add a write/exec permission for a dedicated dispatcher
  subcommand (e.g. `pw2watchdog.sh counters-reset`).
- Dispatcher zeros only the counter fields in the in-memory state and
  rewrites status.json atomically; does NOT touch ks.state,
  passwall2 state, scanner cache, or env.static.
- Last reset timestamp displayed next to the button.

### Why one ticket, three sub-issues

All three live in the same Details panel and the same status.json
schema. Fixing one without re-rendering the others would require
the operator to look at the page twice. Bundle for one focused
session in 0.4.5.

### Risk
Medium for 12.1 (architecturally non-trivial, may need a new
WAN-bound probe), low for 12.2 and 12.3.

---

## P13 — Fallback action = direct: KS interlock + traffic actually routing direct (planned 0.4.5)

**Status:** open, but the underlying mechanism this ticket describes
changed substantially in v0.5.0 — needs re-verification, not assumed
fixed. There is no more "KS armed during an incident" to interlock
with: the killswitch is now a permanent table whose posture follows
the resolved `default_node` value directly (`_direct` → accept,
anything else → drop), independent of `fallback_action`. If the
operator sets `fallback_action=direct` and PW2's `default_node` is
still a real node (not `_direct`), the killswitch will still drop
non-whitelisted transit exactly as before — the same interlock
question (issue 13.1) still applies, just phrased as "does
Fallback=direct actually flip `default_node` to `_direct`" rather
than "does it unset a KS arm flag". Re-test both issues on-router
before closing or re-scoping this ticket.

**Original status (pre-0.5.0):** open. Observed by operator on the live router 2026-06-25.
Two issues sharing the same underlying architectural cause: when
Fallback action is set to `direct`, the watchdog does not coordinate
with Killswitch and does not tear down the PassWall2 mangle path, so
"direct" only works for traffic that PW2 itself already classifies as
bypass-direct.

### Issue 13.1 — Setting Fallback action=direct does not auto-disable Killswitch

The two settings are logically mutually exclusive: a KS armed during
an incident drops traffic, while Fallback=direct asks for traffic to
leak intentionally as a last resort. Enabling Fallback=direct without
disabling KS yields a configuration where KS still wins (drops
whatever Fallback tried to release).

**Expected:** when the operator picks Fallback=direct in LuCI Settings,
the KS toggle is either auto-unchecked + greyed out with an inline
notice, or a hard-validate prevents Save & Apply with an explanation.

**Decision needed:** auto-unset vs blocking validate. Auto-unset is
friendlier but silently changes another field; blocking validate is
more explicit but more clicks.

### Issue 13.2 — Fallback=direct only releases traffic that PW2 already classifies as direct

With Fallback=direct AND KS off, on a proxy failure the operator's
whitelist rule (already meant to bypass proxy) does indeed flow
directly. But everything else — traffic that PW2 was supposed to
send through the proxy — fails with errors instead of falling back
to a plain WAN route.

### Architectural cause

PassWall2 owns the mangle / tproxy path. Even when the proxy engine
(xray / sing-box) is dead, the `inet passwall2` table keeps the
MARK + tproxy-redirect rules in place. Marked packets are still
redirected to the now-dead tproxy listener — connection reset or
timeout. Direct egress would require:

- temporarily flushing or bypassing the PW2 mangle rules
  (`nft flush chain inet passwall2 mangle_PW2_LOCAL` and similar)
  during the fallback window, OR
- inserting a higher-priority nftables rule that strips the PW2
  mark from all eligible traffic until proxy comes back, OR
- calling `passwall2 stop` (the official path) and accepting the
  re-config latency on hand-back.

None of these are currently implemented. The watchdog's Fallback
logic today only flips an internal state flag and updates UI.

### Acceptance criteria

- 13.1: Fallback=direct + KS=on is no longer a reachable
  configuration via the LuCI form. Either auto-unset on toggle or
  validate-blocked on Save.
- 13.2: While Fallback=direct is the active fallback state, all LAN
  traffic egresses via the WAN default route, not the PW2 tproxy
  listener. Verified by `curl -s ifconfig.me` from a LAN client
  returning the WAN public IP (not connection error).
- Hand-back path: when proxy recovers and Fallback exits, PW2 mangle
  path is restored without packet loss (same Plan C pattern as the
  0.3.x rotation transit-leak fix — reuse the playbook).

### Risk
Medium-high. Touching the PW2 mangle path directly is invasive; the
official `passwall2 stop/start` path is safer but has higher recovery
latency. Prototype both, measure latency on hand-back, pick the
lower-risk path. Add e2e test that flips xray off, expects direct
WAN egress within N seconds, flips xray back on, expects proxy egress
within M seconds.

### Workaround until fix

Keep Fallback action at the default (`drop` or whatever the
pre-existing safe value is). Fallback=direct is currently not usable
as a real failover, only as a "release my pre-classified whitelist"
shortcut — which is not what the label promises.

---

## P14 — Fallback action=rotate_all behaves inconsistently, especially with Killswitch enabled

**Status:** open. Reported by operator from live-router testing
2026-07-14. Not yet reproduced with instrumented logs / not yet
root-caused with certainty — the note below records the strongest
candidate mechanism found by reading the code, but this needs
confirmation on-router before it's treated as the fix.

**v0.5.0 note:** the killswitch mechanism this ticket references (arm/disarm races during PW2 restarts triggered by rotation steps, Plan C pre-arm/hand-back) no longer exists — the killswitch table is now permanent and independent of PW2 restarts, so the specific restart-timing race described below may no longer apply. The `rotate_all` behavior itself (whether it converges on a working node) is unrelated to the killswitch rewrite and should still be verified independently on-router before closing this ticket.

### Symptom (as reported)

With Fallback action = `rotate_all`, behavior does not fully match
intent — most noticeably when Killswitch is enabled (behavior differs
whether KS is on or off). With Fallback action = `blackhole`, behavior
is close to as-designed regardless of whether Killswitch is enabled.
No concrete repro steps, timestamps, or logs were captured yet — this
is an initial operator observation, not a confirmed diagnosis.

### Suspected root cause (needs on-router confirmation)

`set_default_node()` in `root/usr/bin/pw2watchdog.sh` decides whether
to protect a PassWall2 restart with the Plan C transit-leak fix
(`_restart_with_blackhole`, which pre-arms the independent killswitch
table `inet pw2wd_ks` via `ks_arm` *before* restarting PassWall2 — see
the v0.4.3-beta transit-leak fix) purely by checking:

```sh
if [ "${FALLBACK_ACTION:-blackhole}" = "blackhole" ] \
&& [ "${PW2_ENV_OK:-0}" -eq 1 ] \
&& [ -n "$PW2_NFTABLE_NAME" ] \
&& [ -n "$PW2_NFTCHAIN_MANGLE" ]; then
    use_blackhole=1
fi
```

When `FALLBACK_ACTION=rotate_all`, this condition is false, so every
node switch performed by `_rotate_all_step()` / `apply_fallback_policy()`
goes through `_restart_plain()` instead — a bare
`"$PASSWALL_INIT" restart` with **no KS pre-arm at all**. That is
exactly the ~30+ second leak window Plan C was built to close for the
`blackhole` path in 0.4.3-beta (see P1-DONE below) — it looks like it
was never extended to cover `rotate_all`'s repeated restarts. Relevant
code: `_rotate_all_step()` (~line 1338), `ROTATE_ROUND` / `ROTATE_OFFSET`
circular-buffer state (~lines 1324-1460), the `min_switch_interval`
bypass carved out specifically for `rotate_all` in `should_switch()`
(~line 1513-1518, "rotate_all is a failover action — never suppress it"),
and rotate_all's action/history logging (~lines 1926-1962).

If confirmed, this would mean: every rotation step under
`rotate_all` opens the same unprotected restart window that `blackhole`
closed, and it happens on a tight loop (once per cycle, up to
`rotate_max_rounds` times) rather than once — which would explain why
the effect is more visible with KS enabled (KS has nothing pre-armed
to rely on and falls back to purely reactive arming) than with KS
disabled (there's no protection expected in either fallback mode when
KS is off, so no regression is visible).

### What's not yet known

- No log capture yet showing whether `_restart_plain()` is actually the
  path taken during a live `rotate_all` incident (needs a router test
  with `killswitch.enabled=1`, `fallback_action=rotate_all`, and a
  forced all-candidates-dead scenario, then grep watchdog log for
  `transit pre-arm` — its absence during a rotate_all switch would
  confirm the theory).
- Whether the fix should be "route rotate_all restarts through
  `_restart_with_blackhole` too" (rename/refactor away from the
  `blackhole`-specific naming) or something narrower.
- Whether `_static_blackhole_insert`/`_static_blackhole_remove` churn
  (rotate_all removes a stale static blackhole on every step, per
  `apply_fallback_policy()`) has any secondary interaction with KS
  state beyond the missing pre-arm.

### Next steps

1. Reproduce on the live router: `fallback_action=rotate_all`,
   `killswitch.enabled=1`, force all candidates dead, capture full
   watchdog log across several rotation cycles.
2. Repeat with `killswitch.enabled=0` and compare — confirm the
   difference tracks the presence/absence of KS pre-arm, not something
   else (e.g. UCI candidate-list churn on every step).
3. Repeat with `fallback_action=blackhole` as a baseline for both KS
   states.
4. If confirmed: extend `set_default_node()`'s `use_blackhole` gate (or
   add an equivalent `use_ks_pre_arm` gate) to also cover
   `FALLBACK_ACTION=rotate_all`, so every PassWall2 restart triggered by
   a rotation step gets the same Plan C pre-arm/hand-back treatment.
5. Add an e2e test mirroring the P13 acceptance-criteria pattern: force
   a rotate_all cycle with KS on, assert no leak window opens (e.g. no
   successful WAN-egress curl during the restart) across at least 2
   rotation steps.

### Workaround until fixed

Prefer `blackhole` over `rotate_all` as the Fallback action if you rely
on Killswitch for leak protection. `rotate_all`'s extra behavior (trying
fresh candidates before giving up) is a nice-to-have on top of
blackhole/direct, not a substitute for it — until this is root-caused,
treat it as best-effort only when Killswitch is off.

### Risk

Low to fix once confirmed (same Plan C pattern already proven for
blackhole, just needs its gate widened). Medium risk in *verifying*
the root cause without a live router in the loop — do not ship a fix
based on code-reading alone; confirm with an on-router repro first.

---

## P1-DONE — Transit-leak window during node rotation (fixed in 0.4.3-beta)

**Status:** fix landed in 0.4.3-beta.

### Symptom
Real leak detected by host `wan_monitor.sh` on 2026-06-24 at 14:04:10 MSK,
duration ~6 s, egress IP became the upstream's WAN address. Trigger:
planned node rotation at 14:03:30 MSK from a dead LV node to a healthy
FI node.

### Root cause (timeline, UTC = MSK -3)
```
12:03:30  switch start: dead LV → FI (latency 339 ms)
12:03:33  transit DROP inserted in inet passwall2 PSW2_MANGLE (handle=1831)
12:03:39  socks probe fail port=1070 → fail_count=1
12:03:53  pw2_mangle_broken (PW2 restart flushed entire table — our DROP gone with it)
12:04:01  fail_count=3 → ks_arm: enter
12:04:05  ks_arm: nft -f ok, KS armed
12:04:10  host monitor: LEAK detected, real egress IP visible
```

The transit blackhole drop lived in `inet passwall2` table. PassWall2
`restart` flushes that table entirely — our DROP rule disappeared with
it. The reactive killswitch (`ks_apply` in the background loop) needed
`fail_count >= 3` (~30+ s of consecutive bad probes) before arming the
independent KS. That left a 30-something second window with no transit
guard at all.

### Fix (Plan C + Plan A fallback)
`_restart_with_blackhole()` in `pw2watchdog.sh`:

1. **Plan C (preferred):** when KS API is present and KS is enabled,
   call `ks_arm` BEFORE `passwall2 restart`. The KS table `inet pw2wd_ks`
   is independent of `inet passwall2` and survives the restart, so
   transit traffic stays blocked through the whole window.
2. After `pw2_wait_proxy_ready` returns, call `ks_apply` — the state
   machine re-evaluates rules+xray and disarms if the new node is
   healthy, or keeps armed otherwise. Race-safe handoff to the
   background loop.
3. **Plan A (legacy fallback):** when KS is missing/disabled, fall
   through to the original PSW2_MANGLE DROP insertion. Still leaks if
   the chain gets flushed mid-window, but unchanged behavior for those
   installs.

### Why not just lower `fail_count` threshold
`fail_count` is anti-flap protection. Setting it to 1 would arm and
disarm on every 1-second glitch. Proactive pre-arm during rotation is
the correct fix.

### Constraints respected
- No new UCI keys.
- No new dependencies.
- No new files.
- Reuses existing helpers `ks_arm`, `ks_state_load`, `ks_state_set`,
  `ks_apply`, `ks_enabled` from `pw2watchdog-killswitch.sh`.

### Verification after deploy
- `logread -e pw2watchdog | grep "transit pre-arm:"` — should show
  `KS armed (reason=rotate_pre_arm)` on the next planned rotation,
  then `handed back to KS state machine` after proxy is ready.
- `cat /var/run/pw2watchdog/ks.state` — during rotation: `armed`
  with `reason=rotate_pre_arm`; after proxy ready: `standby` if
  healthy.
- Host `wan_monitor.sh` running through the rotation window: no
  `LEAK` events expected.

## UI: "Сбросить счётчики" button is not localized (English-only UI) — DONE

**Status:** resolved in repo source (checked 2026-07-16) —
`overview.js` already renders `_('Reset counters')` in English.
The Russian text seen during 2026-07-15 field testing was from a
stale copy served on the router (LuCI view path confusion, see
HANDOFF notes), not the repo source. No code change needed —
just needs to reach the router via the next deploy (bundled with
v0.5.0 killswitch deploy).

## Design idea: structural fail-closed killswitch (default-deny) instead of reactive arm/disarm — SHIPPED in v0.5.0

Raised 2026-07-15 during directcheck v0.1 field testing. Not started,
design-only entry for future work -- do not conflate with the
directcheck validation run.

### Problem with current approach

`pw2watchdog-killswitch.sh` is reactive: it watches for risk windows
(WAN ifdown/ifup, node switch, PW2 restart, health-check failure) and
toggles a DROP rule (`ks_arm`/`ks_disarm`) around them. This is
fail-open by default -- if the watchdog doesn't correctly predict or
time a risk window, LAN traffic can reach WAN directly during the gap.
`docs/BACKLOG.md`'s own "transit pre-arm" entry above is a direct
consequence of this: PSW2_MANGLE gets flushed on `passwall2 restart`,
independent KS table survives, but there was still a ~30s window with
no guard because the arm call landed too late. This whole class of
race conditions (pre-arm timing, `fail_count` anti-flap thresholds,
rotate windows) exists *because* the deny rule is not permanent.

### Proposed fix

Flip the default: LAN -> WAN forwarding is DROP by default,
permanently, as a static nftables rule (ideally in `/etc/nftables.d/`
so it's active before PW2/xray even come up, not something
`pw2watchdog.sh` installs at runtime). Only `ct state
established,related` and explicitly allowed traffic gets through.
Legitimate proxied traffic never actually hits this rule in the first
place -- PW2 intercepts LAN packets in PREROUTING (REDIRECT/TPROXY) to
the local xray socket *before* the FORWARD chain is reached; the real
packet to the VPS is then locally originated by xray (OUTPUT chain,
not FORWARD). So a permanent FORWARD-chain default-deny only ever
catches packets that fell through PW2's interception by accident
(crashed xray, flushed mangle chain, broken redirect rule) -- i.e.
exactly the leaks we're trying to prevent -- with zero race window,
because the rule is never toggled off.

### Correction from initial sketch: PW2 "Direct" shunt rules exist

Initial version of this idea assumed `passwall2.@global[0].acl_enable
='0'` meant pure full-tunnel (no intentional bypass), which would have
made the allowlist trivial (permanent deny, no exceptions needed
beyond established/related). **This is wrong** -- confirmed
2026-07-15: intentional direct-bypass traffic exists via PW2's own
shunt rule engine ("Direct" action in PassWall2 rules), which is a
separate mechanism from the `acl_enable` toggle. A blanket
default-deny would break this bypass traffic unless we can
distinguish "PW2 decided this on purpose (Direct rule match)" from
"this fell through by accident (leak)" -- both look identical to the
FORWARD chain unless PW2 marks them differently.

### Two implementation paths, depending on how PW2 marks Direct traffic

**Path A (preferred, no duplication of PW2's rule data):** if PW2's
own mangle chain applies a distinct fwmark to packets matched by a
Direct shunt rule (separate from the proxy-redirect fwmark, which we
already know is `0x50535732` per `pw2watchdog-env: fwmark=...` in the
logs), then the permanent FORWARD rule becomes simply:

```
ct state established,related accept
meta mark == <pw2_direct_shunt_mark> accept
drop
```

No domain/IP list duplication needed at all -- we just trust PW2's own
marking decision. This is the clean win.

**Path B (fallback, more work): if no such distinguishing mark
exists**, we'd need our own allowlist that mirrors PW2's configured
Direct-shunt domains/IPs, resolved and periodically refreshed into a
dedicated nft set (reusing the same `whitelist_refresh` polling
pattern already implemented in `pw2watchdog-directcheck.sh`'s
`_directcheck_refresh_whitelist()`). More moving parts, but still
strictly simpler/safer than timing-based arm/disarm since it's just
list maintenance, not a race condition.

### Next investigative step (not yet done)

On the router, inspect PW2's actual nftables ruleset to determine
which path applies:

```
nft list table inet passwall2
nft list chain inet passwall2 PSW2_MANGLE
```

Look for: is there a second `meta mark set 0x...` rule distinct from
`0x50535732` applied specifically to rules with shunt action=Direct?
If yes -> Path A. If Direct-shunted packets simply skip marking
entirely (indistinguishable from "not yet processed") -> Path B.

### What this would let us remove/simplify (once validated)

Most of `ks_arm`/`ks_disarm`/`fail_count` anti-flap/pre-arm-before-
restart/rotate-window logic in `pw2watchdog-killswitch.sh` and the
`_restart_with_blackhole()` Plan C pre-arm hook in `pw2watchdog.sh`
becomes unnecessary for the "prevent direct leak" function specifically,
since the deny rule would be permanent rather than timed. Killswitch
state (`armed`/`standby`) might still be worth keeping for UI/status
reporting purposes, but the actual packet-blocking would no longer
depend on the watchdog correctly detecting and timing a risk window.

### Risks / things to verify before implementing

- Boot-time gap: rule must be loaded before LAN interface comes up,
  not installed by `pw2watchdog.sh` at runtime (which starts after
  boot) -- otherwise there's a fresh version of the same race this is
  meant to eliminate.
- DNS/NTP/LuCI/opkg on the router itself are OUTPUT/INPUT chain
  traffic (locally originated/destined), not FORWARD -- unaffected by
  this change either way.
- Must confirm Path A vs Path B before writing any nftables rules --
  do not guess the PW2 mark scheme.

### Investigation result (2026-07-15, from live `nft list table inet passwall2` dump)

Neither Path A nor Path B as originally sketched is needed -- there is
a third, simpler option, and it's already live/proven in production
traffic on this router.

**Finding:** PW2's `PSW2_MANGLE` chain does NOT use a distinct fwmark
to signal "Direct". Instead, for each rule-group chain it checks the
destination IP against specific nftables sets *before* doing anything
else, and simply `return`s (untouched, unmarked, no redirect) on a
match -- i.e. Direct is "whatever isn't caught by an earlier `ip daddr
@set return`", not a marked category:

```
ip protocol tcp ip daddr @passwall2_rulenode_RU_WHITELIST return   (4755 pkts / 285300 bytes seen -- live)
ip protocol tcp ip daddr @passwall2_rulenode_white       return   (500 pkts / 30000 bytes seen -- live)
ip protocol tcp ip daddr @passwall2_rulenode_default      redirect to :1041   (this is the PROXY branch)
```

(mirrored for udp, and ipv6 equivalents `_RU_WHITELIST6` /
`_white6`). The proxy fwmark `0x50535732` is only ever set on the
branch that falls through to the redirect/tproxy branch -- Direct
traffic never gets marked at all.

**Path C (actual winner): reference PW2's own live sets directly.**
No need to build or refresh our own domain/IP mirror (avoids Path B's
downside) and no fwmark trick needed (Path A doesn't apply). The
permanent FORWARD-chain rule can simply be:

```
ct state established,related accept
ip  daddr @passwall2_rulenode_RU_WHITELIST accept
ip  daddr @passwall2_rulenode_white        accept
ip6 daddr @passwall2_rulenode_RU_WHITELIST6 accept
ip6 daddr @passwall2_rulenode_white6        accept
drop
```

PW2 already keeps these sets resolved/refreshed via its own pipeline
-- we just point at them, zero duplication.

**Remaining risk: hardcoded set names are coupled to current PW2 rule
config.** `RU_WHITELIST` is a user-defined custom list name inside
PW2's rule-group config (not a fixed built-in name) -- if more
Direct-action custom lists get added later in PW2's UI, or this one
gets renamed, the killswitch rule silently stops covering it (bypass
traffic would then get dropped as a false leak, or worse, quietly
excluded from the a rule update). Fix: don't hardcode; at watchdog
config-reload time, enumerate PW2's rule-group configs via `uci show
passwall2` for any section with `option action 'direct'` (or
equivalent shunt action), derive the corresponding
`passwall2_rulenode_<listname>`/`<listname>6` set names, and generate
the allow-list portion of the nft rule dynamically -- same
"config-driven set discovery" pattern already used elsewhere in this
project (`ks_arm`'s `nft -a list set inet pw2wd_ks vps4`,
`directcheck`'s `_directcheck_refresh_whitelist()`).

Also noted: an unrelated mark `0x000000ff` appears in several chains
(`meta mark 0x000000ff ... return`) -- not part of the Direct/Proxy
decision, likely an unrelated internal skip-marker (e.g. loopback or
already-handled packet); not relevant to this design, no action
needed.

### Shipped as v0.5.0 (2026-07-16)

Path C was implemented as designed, with one refinement: instead of
hardcoding `passwall2_rulenode_*` set names directly, `pw2watchdog-killswitch.sh`
discovers the active PW2 node/section at every reconcile tick (never
hardcoded — reads `uci show passwall2`, falls back through
`node`/`tcp_node`/`udp_node`), derives the direct-bypass shunt group
names for that node, and finds the matching PW2 nft sets by substring
match against those group names — so a rename or a new custom shunt
list is picked up automatically on the next reconcile, no watchdog
config change required. VPS endpoint IPs are collected from every
`type=nodes` UCI section's `.address` field the same way. Because
nftables sets can't be referenced across tables, the killswitch
mirrors (periodic copy, not a live reference) the discovered
allow-list into its own `inet pw2wd_ks` table on each
`reconcile_interval` tick. The single terminal FORWARD rule is now:
ACCEPT only if the resolved `default_node` equals `_direct`
literally, DROP otherwise (`closed` and `use default node` shunt
options are both DROP, per explicit confirmation that only `_direct`
is a real bypass). See `pw2watchdog-killswitch.sh` public API
(`ks_reconcile`, `ks_active_node`, `ks_direct_group_names`,
`ks_collect_vps_ips`, `ks_find_pw2_sets_for_group`,
`ks_mirror_direct_elements`) and the v0.5.0-beta changelog entry in
[README.md](../README.md) for the full mechanism writeup.

Companion fix shipped in the same release: `pw2watchdog-directcheck.sh`
(bumped v0.1 → v0.1.1) now classifies a dirty exit-IP sample against
the killswitch's live posture (`ks.state` → `KS_POSTURE`) — an
`accept`-posture direct exit is tallied as an expected fallback
(`direct_count`), not a leak, while `drop`/unknown posture still
tallies as a real leak. Also fixed an idle-gap bug where
`total_leak_seconds` could balloon into the tens of thousands because
a dirty sample arriving after an untracked idle gap was folded into
the previous episode instead of closing it first.

---

## P13 — "Last node switch" showed a stale/mismatched node label (fixed 2026-07-16)

**Status:** fixed. Operator observed the Health page's "Last node switch"
field showing a node ("🇫🇷 Paris 2") that never appeared anywhere in the
History log — the actual switch history only showed a Sweden node.

### Root cause
`pw2watchdog.sh` had an unconditional `LAST_TARGET="$TARGET_NODE"`
assignment that ran on **every** watchdog cycle, including plain "stay"
cycles where `choose_target()` merely evaluated a candidate and then
rejected it (e.g. `suppressed_small_improvement`,
`suppressed_min_switch_interval`) — no switch ever happened. This
overwrote the label shown next to `last_switch` (a timestamp that is
correctly only updated on a genuine successful switch), producing a
label/timestamp pair that could point at two completely unrelated
events.

### Fix
- New state variable `PREV_NODE`, set **only** inside the
  genuine-switch-success branch (captures `$current` — the node being
  switched away from — right before `set_default_node` runs).
- Removed the buggy unconditional `LAST_TARGET=...` line entirely.
- New status.json fields `prev_node` / `prev_node_label` replace
  `last_target` / `last_target_label` as the source for this UI field
  (old fields left in place, still written, just unused by the UI now).
- Renamed the UI field from "Last node switch" to "Previous node" in
  both `luasrc/view/pw2watchdog/overview.js` (Details accordion row +
  Runtime status table) and `root/www/pw2widget.html` (Details table),
  showing the node we switched away from + when, defensively falling
  back to "never" if there's no prior node on record or it matches the
  current node.

---

## P14 — Killswitch status tile missing from the Health widget (fixed 2026-07-16)

**Status:** fixed. Operator noticed the "Killswitch disabled" badge
introduced in v0.5.1 (main-block tile on the LuCI Overview page) never
showed up in `/pw2widget.html` — only the Overview page had it. The
widget only ever showed a "Killswitch transitions" counter in its
Details table, never the enabled/enforcement-posture badge itself.

### Fix
Added `pickKsState(s)` to `root/www/pw2widget.html`, mirroring
`buildKsPostureCell()` / the main-block badge logic in `overview.js`
field-for-field (Disabled / Enforcing (drop-by-default) / Enforcing
(direct-allowed) / Unknown), and inserted a new "Killswitch" row in the
widget's main status table between "Watchdog" and "Proxy status" — so
both surfaces now agree.

---

## P15 — README claimed a working `.ipk`/opkg feed that never existed (fixed 2026-07-16)

**Status:** fixed. See [P11](#p11--build-ipk-artifact-and-attach-to-github-releases-release-hygiene-planned-045)
above for the full root-cause writeup (CI has never once succeeded).
README.md and README.ru.md "Installation" sections rewritten to only
describe the one method that actually works (manual `rsync` over SSH),
and that method's own instructions were fixed to also copy
`luasrc/view/pw2watchdog/*.js` to `/www/luci-static/resources/view/pw2watchdog/`
— previously missing, which would have left the LuCI web UI broken even
for users following the "working" instructions correctly.

---

## P17 — "Switch to next" button appears to re-search nodes instead of switching to the cached next candidate (open)

**Status:** open, reported 2026-07-16 by operator. Expected behavior:
clicking "Switch to next" should switch immediately to the candidate
already shown as "Next candidate" in the UI, since `cmd_switch_next()`
(root/usr/bin/pw2watchdog.sh, ~line 2643) is commented as using "the
scanner's cached latencies -- the exact same data already driving the
"Next candidate" field in the UI, so what the user sees before clicking
is what they get." Observed behavior: pressing the button took a long
time and the node that ended up active did not match the node that had
been shown as the next candidate beforehand -- looked like a fresh
full node search ran instead of a cheap cached-lookup switch.

### Not yet investigated -- candidate leads for whoever picks this up
- `cmd_switch_next()` calls `choose_target("$current")` to pick
  `BEST_ALT_NODE`/`BEST_NODE` -- need to confirm `choose_target()` truly
  only reads already-cached scanner state and never itself triggers a
  fresh measurement pass (a full re-scan would explain both the long
  wait and a different resulting node vs. what the UI displayed a
  moment earlier).
- `cmd_switch_next()` explicitly rejects fast if
  `${STATE_DIR}/scan.in_progress` exists (v0.5.3 hotfix, see comment at
  the top of the function) -- but there is a race window: if the
  scanner kicks off a scan *between* the moment the UI displayed "Next
  candidate" and the moment the button click actually reaches
  `cmd_switch_next()`, the guard would either reject the click outright
  (not matching "took a long time" -- it's designed to fail fast) or,
  if the scan finishes mid-flight, `choose_target()` could legitimately
  return a different, newer best candidate than what the UI showed
  before the click. Need to check timing/logs from an actual occurrence
  to tell which of these happened, rather than guessing.
- The CGI path (`root/www/cgi-bin/pw2switchnext`) backgrounds
  `pw2watchdog.sh switch-next` (since v0.5.4) -- worth confirming the UI
  isn't reading a stale "Next candidate" value that was itself computed
  before some other trigger (e.g. a periodic scanner sweep) updated the
  cache, independent of the switch-next code path itself.
- Do not assume root cause without fresh `logread` around an actual
  occurrence (look for `switch-next: manual override current=... target=...`
  and any `scan.in_progress`/scanner start-of-sweep log lines in the same
  window) -- per project convention, diagnose before touching logic.

---

## P16 — README.ru.md changelog banner/history stuck at v0.4.5-beta (open)

**Status:** open, noticed 2026-07-16 while fixing P15. `README.ru.md`'s
top version banner and the `<details>` changelog history below it were
never updated past `v0.4.5-beta` — the entire v0.4.2→v0.4.5 killswitch
rework, v0.5.0's permanent structural killswitch rewrite, v0.5.1's race
fix, and this release's (v0.5.2) fixes all exist only in the English
`README.md` changelog. The body sections further down (Installation,
UCI reference, etc.) ARE kept in sync in Russian — only the top-banner
"what's new" changelog history has drifted. Translating three-plus
versions of changelog text accurately needs a dedicated pass rather
than folding it into an unrelated bugfix commit — tracked here so it
doesn't get lost.

---

## P18 — Enabling Killswitch causes a sharp throughput drop, independent of active proxy node (open)

**Status:** open, reported 2026-07-17 by operator during the native
Xray Balancing test (see 2026-07-17 session — P18 is unrelated to that
test; it reproduces both with the old pw2watchdog chooser/scanner and
with Balancing, so the common factor is the killswitch enforcement
itself, not node-selection logic).

### Symptom
With Killswitch enabled (`pw2watchdog.killswitch.enabled=1`,
`posture=drop`), measured throughput drops sharply. This happens
regardless of which specific node/protocol is currently active —
operator confirmed it is not a slow-node problem.

### Reproduction (operator-confirmed)
- Killswitch enabled → speed degraded. Observed both:
  - before this session's Balancing migration, with the old
    `choose_target()`/scanner-based chooser engine, and
  - during/after the Balancing migration, with the chooser stopped
    and Xray-native `leastPing` doing the switching.
- Workaround that resolves it every time: disable Killswitch
  (`pw2watchdog.killswitch.enabled=0`) and set Fallback action to
  direct → speed normalizes immediately. Confirmed under both engine
  configurations above.

### Not yet investigated — candidate leads for whoever picks this up
- Root cause is NOT yet diagnosed — per project convention, do not
  guess or patch blindly. The fact that toggling `enabled` alone
  (independent of active node) changes throughput points at the
  nft/mangle enforcement path itself (`PSW2_MANGLE`/killswitch table
  rules, `ks_reconcile()`'s generated ruleset in
  `/var/run/pw2watchdog/ks_reconcile.nft`), not at proxy performance.
- Candidate suspects to check against a live capture before touching
  code: rule count/complexity in the generated nft table (large
  `direct_count` sets — operator's own `killswitch status` output this
  session showed `direct_count=22661` — iterating/matching against a
  ~22k-element set per packet could plausibly cost real throughput on
  MT7621's modest CPU), whether counters/logging are enabled per-rule,
  and whether the killswitch chain forces extra conntrack/ct-state
  work that the plain PassWall2 MANGLE chain doesn't do on its own.
- Needs a controlled A/B: same active node, same conditions, toggle
  only `pw2watchdog.killswitch.enabled` and capture `nft list ruleset`
  + a throughput test (e.g. iperf3 or a large curl download) in both
  states, to isolate which specific rule/set is responsible before
  proposing a fix.

### Related open question (context, not yet a separate backlog item)
Operator started a fresh WAN Monitor run in this session specifically
to check whether Killswitch is even necessary under the new
Xray-Balancing configuration — no direct leaks observed so far with
Killswitch disabled, but this needs at least a full day of WAN Monitor
log before drawing any conclusion. If it turns out leaks don't occur
in this configuration without Killswitch, that changes the priority of
P18 (workaround becomes viable long-term rather than just diagnostic)
but does not remove the throughput bug itself as a thing worth
understanding and fixing.


---

## P19 — 2026-07-17 OOM incident: root cause confirmed, no auto-recovery for 8+ hours, decision to roll back to clean OpenWrt+PW2 (informational, closes the OOM investigation thread)

**Status:** root cause confirmed via code + kernel log correlation. Operator
is rolling back the router to a clean OpenWrt + PW2 install without the
custom watchdog ("ВД") as a new stable baseline before any v0.6.0 preset
work starts. This entry preserves the diagnostic trail so it isn't lost.

### Timeline reconstruction (confirmed, not guessed)
- Router boot time: computed from `/proc/uptime` (48425.5s) captured at
  14:19 MSK → boot ≈ 00:52 MSK, 2026-07-17.
- `dmesg` shows `xray invoked oom-killer` at kernel-relative `19023.661s`
  → wall time ≈ 06:09 MSK, i.e. immediately after the outage window
  (05:57–06:01 MSK) already identified from the WAN Monitor log in this
  session. `Out of memory: Killed process 17495 (xray)` confirms the kill.
  Memory state at kill time: `Normal free:19972kB` out of
  `managed:250304kB` — essentially no headroom on this 256MB-class
  device (RT-AX53U/AX1800U).
- **This closes the earlier "did all 5 pool hosts go down?" question from
  the same day: no — the local Xray process was OOM-killed, all
  proxy-path checks failed simultaneously because they all go through
  one local Xray process, matching WAN Monitor's observed pattern
  exactly (no leaked IP ever appeared — see P17/session log, PW2's own
  fail-closed nft construction, confirmed separately by reading
  `app.sh`/`nftables.sh`: `del_firewall_rule()` only runs in `stop()`,
  never on Xray health).**

### New, more serious finding: no auto-recovery for 8+ hours
`monitor.sh` (PW2's own process watchdog, ~58s poll via `pgrep -f` +
`nohup` respawn, gated by `global.enabled=1` + `global_delay.start_daemon=1`
— both confirmed `1` on this router) should have restarted xray within
about a minute. Instead, at 14:19–14:27 MSK (8+ hours later), `ps` showed
**zero xray processes** and the operator's own `directcheck` bg-loop was
still logging continuous `probe FAILED (both endpoints unreachable/timeout)`
— i.e. the router had no working internet at all (proxy or direct) for
the whole intervening period. Root cause of the non-recovery itself is
still not fully isolated (most likely: repeated restart→OOM-kill cycles
that emptied the finite kernel dmesg ring buffer of earlier evidence, but
not proven with a live capture) — moot now given the clean-install
decision below, but worth re-testing memory headroom on the new baseline
before drawing conclusions from a single occurrence.

### Additional issues surfaced while manually recovering
- `/etc/init.d/passwall2 restart` printed `Error: no match countrycode
  found` — a real error, cause not investigated (candidate: a shunt rule
  or geoip/geosite reference to a country code missing from the current
  data set). Xray did come back up afterward regardless. Re-check if this
  recurs on the clean install; if so, this becomes its own ticket.
- Even 5+ seconds after the restart, a `curl` through the SOCKS port
  still failed — not chased further given the imminent clean reinstall;
  worth a longer warm-up wait if this recurs.
- `free` before restart: `available` was only **27732 kB** — dangerously
  low. After restart: `available` jumped to 91092 kB, and — notably —
  `shared` dropped from **102092 kB to 4228 kB**, a ~98MB swing that
  closely matches the `shmem:101888kB` seen in the OOM-time `dmesg` dump.
  This looks like something (unclear what — possibly stale tmpfs data
  tied to the dead xray/ACL state, not proven to be our own scripts) was
  pinning ~100MB of shared memory that only a full `stop()+start()`
  cycle released. **Recommend re-measuring `free`/`shared` on the clean
  baseline periodically (e.g. right after setup, then after a few hours
  idle) to see if this creep is inherent to stock PW2 on this hardware or
  was specific to the now-removed custom watchdog/leftover scripts.**
- `ps` showed **four** `pw2watchdog.sh daemon` processes running
  simultaneously (PIDs 3166/3183 from earlier in the session, plus two
  new ones 15017/15018 that appeared around the restart) — our own init
  script has no `procd_set_param`/`respawn` (noted earlier this session),
  so something (possibly a hotplug/procd trigger tied to the passwall2
  restart) spawned duplicates instead of the existing instances being
  cleanly reused or replaced. This is exactly the kind of fragility that
  motivated dropping the custom watchdog entirely — no further action
  needed here since it's being decommissioned, but recorded so the
  reason for the decision doesn't get lost.
- No swap, no zram installed (`opkg list-installed | grep zram` empty,
  `/proc/swaps` empty). Given the tight memory headroom observed, zram
  swap is a reasonable low-risk mitigation to consider once the clean
  baseline is stable — not urgent, not yet decided.

### Decision (2026-07-17, operator)
Roll back the router to a clean OpenWrt + PW2 install **without** the
custom watchdog ("ВД") as the new baseline. All v0.6.0 preset-addon work
(see `docs/SPEC_v0.6.0.md`) starts from this clean state. This backlog
entry documents the diagnostic trail that led to the decision; no further
action item here beyond re-measuring memory behavior on the new baseline
per the note above.
