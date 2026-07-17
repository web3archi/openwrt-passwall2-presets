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
