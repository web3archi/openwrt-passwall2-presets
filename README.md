# openwrt-passwall2-presets

*[Русская версия](README.ru.md)*

A preset addon for PassWall2 on OpenWrt (Asus RT-AX53U / mt7621) — a thin
layer of UCI presets and a lightweight observer on top of PW2's **native**
mechanisms (Balancing/URLTest, Shunt rules), rather than a separate
parallel switching daemon/killswitch, as in the project's previous
iteration.

## Status

The project is currently in the architecture/spec stage. Coding starts
only once the addon's full picture is settled (see
`docs/SPEC_v0.6.0.md`).

- **Current spec:** [`docs/SPEC_v0.6.0.md`](docs/SPEC_v0.6.0.md) —
  architecture (Presets Engine / Observer / LuCI pages), preset catalog
  (Wave 1: best-node preset + Shunt-based bypass, Wave 2: fixed IP,
  Wave 3: HAProxy/SOCKS Auto Switch — optional, for more powerful
  hardware).
- **Diagnostic archive:** [`docs/LEGACY_BACKLOG.md`](docs/LEGACY_BACKLOG.md) —
  the full backlog from the previous project
  ([openwrt-passwall2-watchdog](https://github.com/web3archi/openwrt-passwall2-watchdog),
  now archived) — contains verified diagnostic facts about PW2/Xray
  behavior on this hardware (fail-closed-by-construction nftables, OOM
  incidents, `monitor.sh` behavior) that remain relevant regardless of
  the addon's architecture change.
- **Project backlog:** [`docs/BACKLOG.md`](docs/BACKLOG.md) — decisions
  and findings specific to this repository, starting fresh from this
  project's own P1.

## Why a new repository instead of continuing the old one

The previous project (`openwrt-passwall2-watchdog`) implemented a
separate parallel node-selection daemon plus a killswitch. Based on
operational experience (duplicate processes, fragile OOM recovery, no
`respawn` integration with procd), the decision was made not to continue
that architecture and instead move to thin presets on top of PW2's own
mechanisms. The old repository has been archived and set to private;
its history is kept as reference material.

## Language policy

All code, comments, commit messages, and documentation in this
repository are written in English. The README is the exception: it is
maintained in English (this file) with a Russian translation kept in
sync at [`README.ru.md`](README.ru.md). See `docs/BACKLOG.md` for the
rationale.
