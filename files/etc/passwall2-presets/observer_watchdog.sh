#!/bin/sh
# observer_watchdog.sh — RT-AX53UNekoBoxStyle Observer probe loop.
#
# Runs the four Observer probes (A/B/C/D — see docs/SPEC_v0.6.0.md §2-§4) and, when
# enabled, the Xray-death watchdog merged into Probe A (GREENLIT 2026-07-22, root cause
# of monitor.sh's unreliability documented in docs/SPEC_v0.6.0.md §0.2 / docs/BACKLOG.md
# P7 — Xray is never added to monitor.sh's own respawn watch list under a normal PW2
# start, so this fills a real gap rather than duplicating something that already works).
#
# Intended to run every ~30s via two cron lines 30s apart (crond's native granularity is
# 1 minute) — see files/etc/crontabs/root-observer-watchdog in this repo.
#
# No PW2 entity names (nodes/subscriptions/presets) are ever hardcoded here: the SOCKS
# port and the active balancer's node pool are discovered live from PW2's own UCI state
# every run. Probe B/D hosts and the active-balancer discovery have NO regional/entity
# defaults (per project policy — this targets more than just Russia); only the Probe A/C
# IP-checker URLs ship with defaults, since those are region-neutral utility endpoints.

PKG=passwall2_presets
STATE_DIR=/tmp/passwall2_presets
STATE_FILE=${STATE_DIR}/observer_watchdog.state
STATUS_FILE=${STATE_DIR}/observer_watchdog.status
LOG_FILE=${STATE_DIR}/observer_watchdog.log
LOCK_DIR=${STATE_DIR}/observer_watchdog.lock
LOG_MAX_BYTES=524288     # 512KB cap
LOCK_STALE_SECS=90       # a lock older than this is presumed abandoned (crash/kill),
                          # never trusted forever — see docs/BACKLOG.md P7 on why an
                          # unconditional "if lock exists, skip forever" design bit us
                          # once already (monitor.sh investigation, later disproven, but
                          # the lesson about not trusting an eternal lock stands)
RESTART_COOLDOWN=120     # internal safety constant (not yet a UI option, see BACKLOG P7
                          # follow-up note): minimum gap between two restart attempts for
                          # the SAME dead episode, to avoid thrashing on a persistent fault

mkdir -p "$STATE_DIR"

now() { date +%s; }

log() {
    printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"
    size=$(wc -c < "$LOG_FILE" 2>/dev/null)
    if [ -n "$size" ] && [ "$size" -gt "$LOG_MAX_BYTES" ]; then
        tail -c "$LOG_MAX_BYTES" "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
}

# ---- locking: atomic mkdir, with staleness recovery ----
acquire_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "$$" > "${LOCK_DIR}/pid"
        now > "${LOCK_DIR}/since"
        return 0
    fi
    lock_since=$(cat "${LOCK_DIR}/since" 2>/dev/null); lock_since=${lock_since:-0}
    age=$(( $(now) - lock_since ))
    if [ "$age" -gt "$LOCK_STALE_SECS" ]; then
        log "WARN stale lock (age ${age}s, pid $(cat ${LOCK_DIR}/pid 2>/dev/null)) — reclaiming"
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR" 2>/dev/null || return 1
        echo "$$" > "${LOCK_DIR}/pid"
        now > "${LOCK_DIR}/since"
        return 0
    fi
    return 1
}
release_lock() { rm -rf "$LOCK_DIR"; }

acquire_lock || exit 0   # a previous run is still active and not stale — skip silently
trap release_lock EXIT

# ---- config helpers ----
uci_get() { uci -q get "$1" 2>/dev/null; }
uci_get_list() { uci -q get "$1" 2>/dev/null; }   # list-type options: values whitespace-
                                                    # separated on one line on this router's
                                                    # uci -- don't assume one-per-line; count
                                                    # via `set -- $(...); echo $#`, not grep -c .

OBS_ENABLED=$(uci_get ${PKG}.main.enabled); OBS_ENABLED=${OBS_ENABLED:-0}
[ "$OBS_ENABLED" != "1" ] && exit 0

WATCHDOG_ENABLED=$(uci_get ${PKG}.main.watchdog_enabled); WATCHDOG_ENABLED=${WATCHDOG_ENABLED:-0}
GRACE_PERIOD=$(uci_get ${PKG}.main.grace_period); GRACE_PERIOD=${GRACE_PERIOD:-30}
XRAY_DEAD_ACTION=$(uci_get ${PKG}.main.xray_dead_action); XRAY_DEAD_ACTION=${XRAY_DEAD_ACTION:-restart}

# SOCKS port: discovered live from PW2's own config every run. observer.main.socks_port
# is only a manual-override fallback if live discovery ever comes back empty.
SOCKS_PORT=$(uci_get passwall2.@global[0].node_socks_port)
[ -z "$SOCKS_PORT" ] && SOCKS_PORT=$(uci_get ${PKG}.main.socks_port)

# ---- persisted state across runs (tmpfs) ----
LAST_IP=""
XRAY_DEAD_SINCE=""
LAST_RESTART_AT=""
LAST_STATUS="unknown"
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

save_state() {
    cat > "$STATE_FILE" <<EOF
LAST_IP="${PROBE_A_IP}"
XRAY_DEAD_SINCE="${XRAY_DEAD_SINCE}"
LAST_RESTART_AT="${LAST_RESTART_AT}"
LAST_STATUS="${STATUS}"
EOF
}

# ================= Probe A — IP via proxy (leak monitor + watchdog death signal) =====
PROBE_A_ENABLED=$(uci_get ${PKG}.ip_via_proxy.enabled); PROBE_A_ENABLED=${PROBE_A_ENABLED:-0}
PROBE_A_IP=""
PROBE_A_OK=0

if [ "$PROBE_A_ENABLED" = "1" ] && [ -n "$SOCKS_PORT" ]; then
    for url in $(uci_get_list ${PKG}.ip_via_proxy.ip_check_url); do
        [ -z "$url" ] && continue
        candidate=$(curl -s -m 5 --socks5-hostname 127.0.0.1:${SOCKS_PORT} "$url" 2>/dev/null | tr -d ' \t\n\r')
        case "$candidate" in
            *[0-9]*.[0-9]*.[0-9]*.[0-9]*|*:*:*)
                PROBE_A_IP="$candidate"; PROBE_A_OK=1; break ;;
        esac
    done
fi

if [ "$PROBE_A_OK" = "1" ] && [ -n "$LAST_IP" ] && [ "$LAST_IP" != "$PROBE_A_IP" ]; then
    log "PROBE-A exit IP changed: ${LAST_IP} -> ${PROBE_A_IP}"
fi

# ================= Watchdog state machine (Probe A + pgrep xray + grace period) ======
XRAY_ALIVE=0
busybox pgrep -f xray >/dev/null 2>&1 && XRAY_ALIVE=1
# "xray" substring match (no fixed path) is intentional: PW2 has been observed running
# it from both /tmp/etc/passwall2/bin/xray and /var/etc/passwall2/bin/xray depending on
# code path — matching on the process name, not one specific path, is the more robust
# (and less "hardcoded") discovery here, and mirrors PW2's own monitor.sh convention of
# `busybox pgrep -f "$cmd_check"`.

STATUS="disabled"
if [ "$WATCHDOG_ENABLED" = "1" ]; then
    if [ "$PROBE_A_OK" = "1" ]; then
        if [ "$LAST_STATUS" = "restarting" ] || [ "$LAST_STATUS" = "restarted-confirming" ]; then
            if [ "$LAST_STATUS" = "restarted-confirming" ]; then
                STATUS="ok"
                log "WATCHDOG: recovery confirmed (Probe A healthy after restart)"
            else
                STATUS="restarted-confirming"
            fi
        else
            STATUS="ok"
        fi
        XRAY_DEAD_SINCE=""
    else
        if [ "$XRAY_ALIVE" = "1" ]; then
            # Probe A failed but Xray itself is running — not our failure mode (could be
            # the IP-checker services themselves, or a routing issue unrelated to Xray).
            STATUS="degraded"
            XRAY_DEAD_SINCE=""
        else
            [ -z "$XRAY_DEAD_SINCE" ] && XRAY_DEAD_SINCE=$(now) && log "WATCHDOG: Probe A failed + xray not running — grace period started (${GRACE_PERIOD}s)"
            age=$(( $(now) - XRAY_DEAD_SINCE ))
            if [ "$age" -lt "$GRACE_PERIOD" ]; then
                STATUS="down-in-grace"
            elif [ "$XRAY_DEAD_ACTION" != "restart" ]; then
                STATUS="down-in-grace"   # action=none: keep reporting, never act (opt-in toggle, §0.3 item 2)
            else
                cooldown_ok=1
                if [ -n "$LAST_RESTART_AT" ]; then
                    since_restart=$(( $(now) - LAST_RESTART_AT ))
                    [ "$since_restart" -lt "$RESTART_COOLDOWN" ] && cooldown_ok=0
                fi
                if [ "$cooldown_ok" = "1" ]; then
                    log "WATCHDOG: down ${age}s (grace ${GRACE_PERIOD}s expired) -> /etc/init.d/passwall2 restart"
                    LAST_RESTART_AT=$(now)
                    /etc/init.d/passwall2 restart >/dev/null 2>&1 &
                    STATUS="restarting"
                else
                    log "WATCHDOG: still down ${age}s, last restart attempt ${since_restart}s ago (cooldown ${RESTART_COOLDOWN}s) — not retrying yet"
                    STATUS="down-in-grace"
                fi
            fi
        fi
    fi
fi

# ================= Probe B — blocked resource via proxy (user-supplied, no defaults) =
PROBE_B_ENABLED=$(uci_get ${PKG}.blocked_via_proxy.enabled); PROBE_B_ENABLED=${PROBE_B_ENABLED:-0}
PROBE_B_JSON="[]"
if [ "$PROBE_B_ENABLED" = "1" ] && [ -n "$SOCKS_PORT" ]; then
    items=""
    for host in $(uci_get_list ${PKG}.blocked_via_proxy.host); do
        [ -z "$host" ] && continue
        t=$(curl -s -o /dev/null -w '%{time_total}' -m 5 --socks5-hostname 127.0.0.1:${SOCKS_PORT} "https://${host}/" 2>/dev/null)
        if [ -n "$t" ] && [ "$t" != "0.000000" ]; then
            ms=$(awk -v t="$t" 'BEGIN{printf "%d", t*1000}')
            items="${items}{\"host\":\"${host}\",\"status\":\"reachable\",\"latency_ms\":${ms}},"
        else
            items="${items}{\"host\":\"${host}\",\"status\":\"unreachable\"},"
        fi
    done
    [ -n "$items" ] && PROBE_B_JSON="[${items%,}]"
fi

# ================= Probe C — IP via direct/shunt path =================================
PROBE_C_ENABLED=$(uci_get ${PKG}.ip_direct.enabled); PROBE_C_ENABLED=${PROBE_C_ENABLED:-0}
PROBE_C_IP=""
if [ "$PROBE_C_ENABLED" = "1" ]; then
    for url in $(uci_get_list ${PKG}.ip_direct.ip_check_url); do
        [ -z "$url" ] && continue
        candidate=$(curl -s -m 5 "$url" 2>/dev/null | tr -d ' \t\n\r')
        case "$candidate" in
            *[0-9]*.[0-9]*.[0-9]*.[0-9]*|*:*:*) PROBE_C_IP="$candidate"; break ;;
        esac
    done
fi

# ================= Probe D — unblocked resource via direct path (baseline WAN check) ==
PROBE_D_ENABLED=$(uci_get ${PKG}.unblocked_direct.enabled); PROBE_D_ENABLED=${PROBE_D_ENABLED:-0}
PROBE_D_JSON="[]"
if [ "$PROBE_D_ENABLED" = "1" ]; then
    items=""
    for host in $(uci_get_list ${PKG}.unblocked_direct.host); do
        [ -z "$host" ] && continue
        t=$(curl -s -o /dev/null -w '%{time_total}' -m 5 "https://${host}/" 2>/dev/null)
        if [ -n "$t" ] && [ "$t" != "0.000000" ]; then
            ms=$(awk -v t="$t" 'BEGIN{printf "%d", t*1000}')
            items="${items}{\"host\":\"${host}\",\"status\":\"reachable\",\"latency_ms\":${ms}},"
        else
            items="${items}{\"host\":\"${host}\",\"status\":\"unreachable\"},"
        fi
    done
    [ -n "$items" ] && PROBE_D_JSON="[${items%,}]"
fi

# ================= Node count (fallback — see docs/BACKLOG.md P7) ======================
# KNOWN LIMITATION, flagged rather than faked: PW2 does not expose an Xray API inbound
# (confirmed 2026-07-22, docs/BACKLOG.md P7), so there is no live "currently healthy"
# node count available anywhere in UCI — that state only exists transiently inside
# Xray's own process memory. We can only report the size of the active balancer's
# *configured* node pool (discovered dynamically — no section name hardcoded below),
# not how many of those are presently passing Xray's own health check.
ACTIVE_BALANCER=$(uci show passwall2 2>/dev/null | grep "\.protocol='_balancing'$" | grep -v '^passwall2\.@' | head -1 | cut -d. -f2)
TOTAL_NODES=""
if [ -n "$ACTIVE_BALANCER" ]; then
    # NOTE: don't count via `grep -c .` (counts lines) -- on this router's uci version,
    # `uci -q get` on a list-type option returns all values on ONE line, space-separated,
    # not one-per-line (confirmed on the router 2026-07-22: a 27-entry balancing_node list
    # counted as "1" until this fix). `set --` + `$#` counts whitespace-separated tokens
    # via the shell's own word-splitting, so it's correct regardless of uci's line format.
    set -- $(uci_get_list passwall2.${ACTIVE_BALANCER}.balancing_node)
    TOTAL_NODES=$#
fi

# ================= Write status file for the Overview page / widget ===================
cat > "$STATUS_FILE" <<EOF
{
  "updated_at": $(now),
  "watchdog_status": "${STATUS}",
  "probe_a": {"enabled": ${PROBE_A_ENABLED}, "ok": ${PROBE_A_OK}, "ip": "${PROBE_A_IP}"},
  "probe_b": ${PROBE_B_JSON},
  "probe_c": {"enabled": ${PROBE_C_ENABLED}, "ip": "${PROBE_C_IP}"},
  "probe_d": ${PROBE_D_JSON},
  "xray_alive": ${XRAY_ALIVE},
  "nodes": {"active_balancer": "${ACTIVE_BALANCER}", "total_configured": "${TOTAL_NODES}", "currently_working": "unavailable_no_xray_api"}
}
EOF

[ "$STATUS" != "$LAST_STATUS" ] && [ "$LAST_STATUS" != "unknown" ] && log "STATUS ${LAST_STATUS} -> ${STATUS}"

save_state
