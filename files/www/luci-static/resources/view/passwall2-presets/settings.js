'use strict';
'require form';
'require fs';
'require ui';
'require view';
'require uci';

// Settings tab — see docs/SPEC_v0.6.0.md §2/§4 "Settings tab" and docs/BACKLOG.md P8 for
// the full planned scope.
//
// This is a plain native form.Map bound to /etc/config/passwall2_presets, so the standard
// LuCI page-footer buttons work exactly like any other stock OpenWrt settings page — nothing
// custom is wired up. Per LuCI's own LuCI.view.handleSave/handleSaveApply/handleReset
// (luci.js), the default implementation already walks every ".cbi-map" on the page and
// calls its save()/reset() method, which is exactly what a form.Map needs; the footer then
// renders three buttons labeled "Save", "Save & Apply" and "Reset" (confirmed against
// luci.js's own addFooter() — there is no separate "Dismiss"/"Cancel" button in the page
// footer; "Reset" is the native equivalent — it re-renders the form and discards any
// unsaved edits).
//
// ---------------------------------------------------------------------------------------
// Preset A ("Best node") — read + write together, per docs/BACKLOG.md P8 Decision 1.
// ---------------------------------------------------------------------------------------
//
// Hard constraint carried over from the whole project ("если у нас только оболочка для
// ПВ2, наверное так правильнее"): no free-text custom-server fields anywhere. Every node
// picker below is populated exclusively from PW2's own already-configured `nodes` sections
// (uci.sections('passwall2', 'nodes')), discovered fresh on every render — nothing
// hardcoded, no entity/section names typed in by the user.
//
// EXCEPTION (per this session's explicit design decision): the addon's OWN managed
// infrastructure for "Manual with auto-restore" — a dedicated SOCKS Auto Switch server
// (`passwall2.pw2p_manual_socks`, type `socks`) wrapped in a Socks-type node
// (`passwall2.pw2p_manual_node`, type `nodes`) pointed at 127.0.0.1:<port> — uses FIXED
// literal section names. This is the addon's own persistent identity, not a reference to a
// user-created entity that must be discovered, so a fixed name is correct here (same
// exception already applied to `global 'global'` / `observer 'main'` in this config file).
//
// Single source of truth: there is NO stored "current strategy" anywhere in
// passwall2_presets. The `strategy` field below is virtual — its cfgvalue() derives the
// currently active strategy by reading live `passwall2` state every time the page renders,
// and its write() fans out directly into `passwall2` (never into passwall2_presets). This
// avoids ever having a UI that disagrees with what PassWall2 is actually doing.
//
// What this addon manages vs. what it doesn't:
//   - "Fastest" / "Most stable" switch the `balancingStrategy` (leastPing/leastLoad) of
//     whichever Xray `_balancing` node PW2 already has configured. This addon does NOT
//     create a Balancing node from scratch — that's still done once, by hand, on PW2's own
//     Node List page (native "Add a Balancing node" flow). If sing-box is in use instead of
//     Xray, a `_urltest` node is *detected* for display purposes, but writing its fields is
//     not implemented yet (its confirmed UCI field names differ from Xray's and haven't
//     been verified against this project's router) — validate() blocks Save with an
//     explanation rather than guessing field names.
//   - "Manual with auto-restore" maps to PW2's own SOCKS Auto Switch feature (confirmed
//     schema from this project's own router, `/usr/lib/lua/luci/model/cbi/passwall2/client/
//     socks_config.lua`): a Main node + an ordered list of backup nodes + a Restore Switch,
//     wrapped in the addon-owned socks/node pair described above.
//   - `fallback_direct_enabled` is a real, addon-owned flag stored on
//     `passwall2_presets.best_node` (SPEC §3) — but ticking it also asks the discovered
//     Xray Balancing node to set `fallback_node='_direct'` on save (with the issue #439 DNS
//     caveat spelled out in its description), so it does something real in PW2, not just in
//     this addon's own bookkeeping.
//
// "Manual with auto-restore" backup-node ordering uses form.DynamicList (not
// form.MultiValue): DynamicList renders as an add-one-at-a-time list of removable tags in
// the order they were added, which is the closest native CBI primitive to PW2's own ordered
// `autoswitch_backup_node` list — a checkbox MultiValue has no concept of order.
//
// Both new sections (Preset A, further below, and the pre-existing "Widget" section) are
// each wrapped in a native <details>/<summary> element matching the same style, so they
// read as the requested expandable/collapsible list without inventing any non-native
// widget: <details> is plain HTML5. Stock LuCI CBI has no generic "collapsible section"
// primitive (checked form.js — TypedSection/NamedSection have no collapse option, only
// per-field "optional" which is a different, unrelated mechanism).
//
// "Widget" section: every row currently shown on the Overview status panel gets one
// show/hide checkbox here (docs/BACKLOG.md P8, "не хардкодим" note — the *set* of fields is
// inherently fixed since they're this app's own known rows, but the show/hide *state* per
// field is fully UCI-backed and user-controlled, not a silently baked-in subset). This only
// affects the compact standalone widget page (admin/services/passwall2-presets/widget) —
// the full Overview tab always shows every row regardless of these settings (see
// overview.js's widgetVisible() helper).

var MANUAL_SOCKS_SECTION = 'pw2p_manual_socks';
var MANUAL_NODE_SECTION = 'pw2p_manual_node';
var CUSTOM_NODE_SECTION = 'pw2p_custom_socks_node';

// ---- Pool manager (docs/SPEC-pool-manager.md) ----
var POOL_STATS_FILE = '/overlay/passwall2-presets/pool-stats';
var POOL_CAP = 13;           // maximum, never a quota (operator 2026-11-23)
var POOL_MIN_ATTEMPTS = 2;   // cutoff constants mirror observer_watchdog.sh's census; the
var POOL_MIN_SUCCESS = 50;   // list is earned, not padded — fewer qualifiers render
var POOL_MAX_STREAK = 2;     // fewer rows (a streak of 3 excludes)
var POOL_STATS_RAW = '';

// Census-set membership (mirrors observer_watchdog.sh census_run): Xray nodes with
// allowlisted protocols, not RU-flagged, not this addon's own infrastructure.
function poolCandidateNodes() {
	return loadNodes().filter(function(n) {
		if (n.type !== 'Xray')
			return false;
		if (n.protocol !== 'vless' && n.protocol !== 'trojan')
			return false;
		if (isSpecialNode(n))
			return false;
		if (n.group === 'RU' || /🇷🇺/.test(n.remarks || ''))
			return false;
		return true;
	});
}

// Parse the observer's append-only samples log (sid|ts|ok|ms, 24h window already pruned
// server-side). Returns per-sid aggregates for ranking + display.
function parsePoolStats(raw, nowSec) {
	var rec = {}, lines = (raw || '').split('\n');
	for (var i = 0; i < lines.length; i++) {
		var f = lines[i].split('|');
		if (f.length < 4 || !f[0])
			continue;
		var ts = +f[1];
		if (!ts || ts < nowSec - 86400)
			continue;
		if (!rec[f[0]])
			rec[f[0]] = { samples: [] };
		rec[f[0]].samples.push({ ts: ts, ok: f[2] === '1', ms: +f[3] || 0 });
	}
	var out = {};
	for (var sid in rec) {
		var s = rec[sid].samples;
		var oks = s.filter(function(x) { return x.ok; }).map(function(x) { return x.ms; })
			.sort(function(a, b) { return a - b; });
		var streak = 0, i2 = s.length - 1;
		while (i2 >= 0 && !s[i2].ok) { streak++; i2--; }
		var lastOk = null;
		for (i2 = s.length - 1; i2 >= 0; i2--)
			if (s[i2].ok) { lastOk = s[i2].ts; break; }
		var p = function(q) {
			if (!oks.length)
				return null;
			return oks[Math.min(oks.length - 1, Math.floor(q * oks.length))];
		};
		out[sid] = {
			attempts: s.length,
			success: s.length ? Math.round(100 * oks.length / s.length) : 0,
			p50: p(0.5), p90: p(0.9),
			streak: streak,
			since_ok: lastOk ? nowSec - lastOk : null,
			verdict_ok: !!(s.length && s[s.length - 1].ok)
		};
	}
	return out;
}

// Ranked suggestion list: cutoff-qualified nodes by score (p50 primary, success-rate
// tiebreak, active-fail-streak penalty), capped at POOL_CAP rows.
function rankPool(stats) {
	var cands = poolCandidateNodes().map(function(n) {
		var st = stats[n['.name']];
		return st ? { sid: n['.name'], remarks: n.remarks || n['.name'], st: st } : null;
	}).filter(function(x) { return !!x; })
	.filter(function(x) {
		return x.st.verdict_ok && x.st.attempts >= POOL_MIN_ATTEMPTS &&
			x.st.success >= POOL_MIN_SUCCESS && x.st.streak <= POOL_MAX_STREAK;
	});
	cands.sort(function(a, b) {
		var d = (a.st.p50 || 9e9) - (b.st.p50 || 9e9);
		if (d)
			return d;
		d = b.st.success - a.st.success;
		if (d)
			return d;
		return a.st.streak - b.st.streak;
	});
	return cands.slice(0, POOL_CAP);
}

// A node counts as "special" (never offered as a Main/Backup pick, never treated as *the*
// user-facing balancer target for display purposes beyond the balancer lookup itself) when
// its protocol starts with '_' — PW2's own convention for virtual/meta node types
// (_balancing, _urltest, _shunt, _iface, ...), or when it's this addon's own loopback
// SOCKS-wrapper node.
function isSpecialNode(n) {
	if (n.protocol && n.protocol.charAt(0) === '_')
		return true;
	if (n['.name'] === MANUAL_NODE_SECTION)
		return true;
	if (n['.name'] === CUSTOM_NODE_SECTION)
		return true;
	return false;
}

function nodeLabel(n) {
	return n.remarks || n['.name'];
}

function loadNodes() {
	return uci.sections('passwall2', 'nodes') || [];
}

function pickableNodes() {
	return loadNodes().filter(function(n) { return !isSpecialNode(n); });
}

// Finds the balancer PW2 already has configured, if any. Returns null if none exists yet —
// this addon never creates one; that's still a one-time manual step on PW2's own Node List
// page. Xray `_balancing` is checked first since it's the only kind this addon currently
// knows how to *write* to (confirmed field names from docs/SPEC_v0.6.0.md §3, itself sourced
// from a live 15.6h router audit) — a sing-box `_urltest` node is still detected and
// reported so the UI can explain *why* Fastest/Most stable are blocked, rather than staying
// silent about it.
function findBalancerSection() {
	var nodes = loadNodes();
	var xray = nodes.filter(function(n) { return n.protocol === '_balancing'; });
	if (xray.length)
		return { kind: 'xray_balancing', section: xray[0] };
	var st = nodes.filter(function(n) { return n.protocol === '_urltest'; });
	if (st.length)
		return { kind: 'singbox_urltest', section: st[0] };
	return null;
}

// Finds the shunt node PW2 uses as Main (or the first one — this setup has
// exactly one). Returns null when no shunt exists; the custom preset then
// falls back to taking the Main slot itself.
function findShuntSection() {
	var nodes = loadNodes();
	var shunts = nodes.filter(function(n) { return n.protocol === '_shunt'; });
	if (!shunts.length)
		return null;
	var mainNode = uci.get('passwall2', '@global[0]', 'node');
	for (var i = 0; i < shunts.length; i++)
		if (shunts[i]['.name'] === mainNode)
			return { section: shunts[i] };
	return { section: shunts[0] };
}

function computeDefaultSocksPort() {
	// Mirrors PW2's own default-port formula for a new socks section (confirmed from
	// socks_config.lua): (count of existing socks sections) + 1 + 1080.
	var count = (uci.sections('passwall2', 'socks') || []).length;
	return String(count + 1 + 1080);
}

// Writes/updates the addon-owned Manual-mode infrastructure (socks + wrapper node pair).
// Never deletes either section when switching away from Manual — see disableManualNode()
// below — so the user's backup-node configuration survives a round trip through
// Fastest/Most stable and back.
function ensureManualNodePair(mainId, backupIds, restoreOn) {
	if (!uci.get('passwall2', MANUAL_SOCKS_SECTION))
		uci.add('passwall2', 'socks', MANUAL_SOCKS_SECTION);

	var port = uci.get('passwall2', MANUAL_SOCKS_SECTION, 'port') || computeDefaultSocksPort();

	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'enabled', '1');
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'node', mainId);
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'port', port);
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'bind_local', '1');
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'enable_autoswitch', '1');
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'backup_node_add_mode', 'manual');
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'autoswitch_backup_node', backupIds || []);
	uci.set('passwall2', MANUAL_SOCKS_SECTION, 'autoswitch_restore_switch', restoreOn ? '1' : '0');

	if (!uci.get('passwall2', MANUAL_NODE_SECTION))
		uci.add('passwall2', 'nodes', MANUAL_NODE_SECTION);

	uci.set('passwall2', MANUAL_NODE_SECTION, 'type', 'Xray');
	uci.set('passwall2', MANUAL_NODE_SECTION, 'protocol', 'socks');
	uci.set('passwall2', MANUAL_NODE_SECTION, 'tls', '0');
	uci.set('passwall2', MANUAL_NODE_SECTION, 'transport', 'raw');
	uci.set('passwall2', MANUAL_NODE_SECTION, 'address', '127.0.0.1');
	uci.set('passwall2', MANUAL_NODE_SECTION, 'port', port);
	uci.set('passwall2', MANUAL_NODE_SECTION, 'remarks', _('PW2 Presets — Manual auto-restore'));
}

// Turns the Manual infrastructure off without deleting it (preserves the user's Main/backup
// picks for next time they switch back to Manual).
function disableManualSocks() {
	if (uci.get('passwall2', MANUAL_SOCKS_SECTION))
		uci.set('passwall2', MANUAL_SOCKS_SECTION, 'enabled', '0');
}

return view.extend({
	load: function() {
		// passwall2 itself is not the config this page's form.Map is bound to (that's
		// passwall2_presets) — it has to be preloaded explicitly so uci.get()/uci.sections()
		// calls against it during render() (node pickers, balancer discovery, current-
		// strategy detection) have data to read, and so uci.set()/uci.add() calls during
		// save() land in the right changeset.
		return Promise.all([
			uci.load('passwall2'),
			fs.read_direct(POOL_STATS_FILE).catch(function() { return null; })
		]).then(function(res) {
			POOL_STATS_RAW = res[1] || '';
		});
	},

	// Ghost-checkbox fix (operator decision 2026-11-24): every Save & Apply and every
	// Reset ends in a full page reload. luci.js never reloads after save/apply
	// (verified in /www/luci-static/resources/luci.js — no location.reload anywhere in
	// the save chain), so a long-lived tab keeps its pre-Apply DOM: its NEXT Apply
	// re-writes stale checkbox state back into uci (the kill-switch re-ticked exactly
	// that way, live-verified), and any redraw shows the page-load-time snapshot.
	// Reload keeps the DOM equal to the committed uci state — a stale tab can never
	// write old values again. Plain "Save" deliberately stays stock: its chain is
	// shared by Save & Apply, and reloading inside it would abort the apply halfway.
	handleSaveApply: function(ev, mode) {
		return Promise.resolve(this.super('handleSaveApply', ev, mode)).then(function() { location.reload(); });
	},
	handleReset: function(ev) {
		return Promise.resolve(this.super('handleReset', ev)).then(function() { location.reload(); });
	},

	render: function() {
		var m = new form.Map('passwall2_presets', null,
			_('Settings for PassWall2 Presets.'));
		// --- Addon master switch (operator request 2026-11-24: the on/off at the very top) ---
		// Mirrors + writes passwall2_presets.main.enabled — the same option the observer
		// gates its whole run on (probes, census, killswitch automation, watchdog): 0 =
		// the addon observes nothing and never touches PassWall2. Placed above all preset
		// sections on purpose — one glance answers "is my addon doing anything".
		if (!uci.get('passwall2_presets', 'main'))
			uci.add('passwall2_presets', 'observer', 'main');
		var sMain = m.section(form.NamedSection, 'main', 'observer', null);
		sMain.addremove = false;
		var obsEnable = sMain.option(form.Flag, 'enabled', _('Observer enabled'));
		obsEnable.rmempty = false;
		obsEnable.default = '1';
		obsEnable.description = _('The master switch for the whole addon: unticked, the ' +
			'observer runs nothing (no probes, no node census, no kill-switch automation, ' +
			'no watchdog restarts) and PassWall2 behaves exactly as configured by hand. ' +
			'Ticked, the background observer polls the chain and maintains the features ' +
			'below. The Observer status on the Overview page reflects this switch.');

		// --- Custom SOCKS5 (fixed final exit) ----------------------------------------
		// Native PW2 chaining: our SOCKS node carries chain_proxy='1' plus
		// preproxy_node=<balancing section>, so PW2 dials the SOCKS5 connection
		// THROUGH whichever node the balancer has currently picked (util_xray.lua
		// gen_outbound preproxy branch; a _balancing preproxy is supported there).
		// The Balancing node keeps working and switching first hops; this node is
		// only the last mile. All state lives in passwall2 (the node section is
		// the single source of truth); these fields are virtual, like Strategy.
		// The form needs a passwall2_presets section to attach to; create it on
		// demand so the page also works where the config predates this feature.
		if (!uci.get('passwall2_presets', 'custom_socks'))
			uci.add('passwall2_presets', 'preset', 'custom_socks');
		var sCustom = m.section(form.NamedSection, 'custom_socks', 'preset', null);
		sCustom.addremove = false;

		var customEnable = sCustom.option(form.Flag, 'custom_socks_enabled',
			_('Route traffic through this SOCKS5'));
		customEnable.rmempty = false;
		customEnable.default = '0';
		customEnable.description = _('When ticked and applied, PassWall2 exits through ' +
			'this SOCKS5 server while the Balancing node keeps working as the first ' +
			'hop: the SOCKS5 connection is dialed THROUGH whichever node the ' +
			'Balancing pool has currently picked (native PassWall2 Preproxy ' +
			'chaining, one layer). Unticking restores the Balancing node as the ' +
			'exit. The checkbox mirrors what PassWall2 is actually doing right ' +
			'now. Requires the Preset A Balancing node (see below).');
		customEnable.cfgvalue = function() {
			// Reality: active when the custom node is the live exit — as the
			// shunt's default (through the Balancing node, the normal case) or
			// as the Main node itself (no-shunt fallback).
			var mainNode = uci.get('passwall2', '@global[0]', 'node');
			var shunt = findShuntSection();
			if (shunt && mainNode === shunt.section['.name'] &&
			    shunt.section.default_node === CUSTOM_NODE_SECTION)
				return '1';
			if (mainNode === CUSTOM_NODE_SECTION)
				return '1';
			return '0';
		};
		customEnable.write = function(section_id, value) {
			var shunt = findShuntSection();
			var bal = findBalancerSection();
			var balName = bal ? bal.section['.name'] : null;

			if (value !== '1') {
				// OFF: hand the exit back. Restore what the preset replaced, or
				// the Balancing node when nothing was remembered — without the
				// flag everything runs as before (balancer exit).
				if (shunt && shunt.section.default_node === CUSTOM_NODE_SECTION) {
					var prevNode = uci.get('passwall2_presets', 'custom_socks',
						'prev_default_node');
					var prevTag = uci.get('passwall2_presets', 'custom_socks',
						'prev_default_proxy_tag');
					uci.set('passwall2', shunt.section['.name'], 'default_node',
						prevNode || (balName || '_direct'));
					if (prevTag)
						uci.set('passwall2', shunt.section['.name'],
							'default_proxy_tag', prevTag);
					else
						uci.unset('passwall2', shunt.section['.name'],
							'default_proxy_tag');
				}
				var mainNode = uci.get('passwall2', '@global[0]', 'node');
				if (mainNode === CUSTOM_NODE_SECTION && balName) {
					uci.set('passwall2', '@global[0]', 'node', balName);
					uci.set('passwall2', '@global[0]', 'tcp_node', balName);
					uci.set('passwall2', '@global[0]', 'udp_node', balName);
				}
				return;
			}

			var hostOpt = this.map.lookupOption('custom_socks_host', section_id)[0];
			var portOpt = this.map.lookupOption('custom_socks_port', section_id)[0];
			var userOpt = this.map.lookupOption('custom_socks_user', section_id)[0];
			var passOpt = this.map.lookupOption('custom_socks_pass', section_id)[0];
			var host = (hostOpt && hostOpt.formvalue(section_id)) || '';
			var port = (portOpt && portOpt.formvalue(section_id)) || '';
			var user = (userOpt && userOpt.formvalue(section_id)) || '';
			var pass = (passOpt && passOpt.formvalue(section_id)) || '';

			if (!host || !/^\d+$/.test(port) || +port < 1 || +port > 65535 ||
			    !findBalancerSection()) {
				ui.addNotification(null, E('p', _('SOCKS5 host/port missing or no ' +
					'Balancing node - the preset was NOT enabled. Fill the host and ' +
					'port, then tick the checkbox again.')), 'error');
				return;
			}

			if (!uci.get('passwall2', CUSTOM_NODE_SECTION))
				uci.add('passwall2', 'nodes', CUSTOM_NODE_SECTION);

			uci.set('passwall2', CUSTOM_NODE_SECTION, 'type', 'Xray');
			uci.set('passwall2', CUSTOM_NODE_SECTION, 'protocol', 'socks');
			uci.set('passwall2', CUSTOM_NODE_SECTION, 'address', host);
			uci.set('passwall2', CUSTOM_NODE_SECTION, 'port', port);
			if (user)
				uci.set('passwall2', CUSTOM_NODE_SECTION, 'username', user);
			else
				uci.unset('passwall2', CUSTOM_NODE_SECTION, 'username');
			if (pass)
				uci.set('passwall2', CUSTOM_NODE_SECTION, 'password', pass);
			else
				uci.unset('passwall2', CUSTOM_NODE_SECTION, 'password');
			uci.set('passwall2', CUSTOM_NODE_SECTION, 'tls', '0');
			uci.set('passwall2', CUSTOM_NODE_SECTION, 'transport', 'raw');
			uci.set('passwall2', CUSTOM_NODE_SECTION, 'remarks',
				_('PW2 Presets — Custom SOCKS5'));

			if (shunt) {
				// Normal case: keep the shunt as Main (it preserves the direct
				// rules), point its default at our node and chain the dial
				// through the Balancing node. Remember what was replaced.
				if (shunt.section.default_node !== CUSTOM_NODE_SECTION) {
					uci.set('passwall2_presets', 'custom_socks', 'prev_default_node',
						shunt.section.default_node || '');
					uci.set('passwall2_presets', 'custom_socks',
						'prev_default_proxy_tag',
						shunt.section.default_proxy_tag || '');
				}
				uci.set('passwall2', shunt.section['.name'], 'default_node',
					CUSTOM_NODE_SECTION);
				uci.set('passwall2', shunt.section['.name'], 'default_proxy_tag',
					balName);
				uci.set('passwall2', '@global[0]', 'node', shunt.section['.name']);
				uci.set('passwall2', '@global[0]', 'tcp_node',
					shunt.section['.name']);
				uci.set('passwall2', '@global[0]', 'udp_node',
					shunt.section['.name']);
			} else {
				// No shunt: the custom node becomes the Main exit, dialed through
				// the Balancing node via the node's own preproxy fields.
				uci.set('passwall2', CUSTOM_NODE_SECTION, 'chain_proxy', '1');
				uci.set('passwall2', CUSTOM_NODE_SECTION, 'preproxy_node', balName);
				uci.set('passwall2', '@global[0]', 'node', CUSTOM_NODE_SECTION);
				uci.set('passwall2', '@global[0]', 'tcp_node', CUSTOM_NODE_SECTION);
				uci.set('passwall2', '@global[0]', 'udp_node', CUSTOM_NODE_SECTION);
			}
		};

		var customHost = sCustom.option(form.Value, 'custom_socks_host',
			_('SOCKS5 host'));
		customHost.cfgvalue = function() {
			return uci.get('passwall2', CUSTOM_NODE_SECTION, 'address') || '';
		};
		customHost.write = function() {};

		var customPort = sCustom.option(form.Value, 'custom_socks_port',
			_('SOCKS5 port'));
		customPort.datatype = 'port';
		customPort.cfgvalue = function() {
			return uci.get('passwall2', CUSTOM_NODE_SECTION, 'port') || '';
		};
		customPort.write = function() {};

		var customUser = sCustom.option(form.Value, 'custom_socks_user',
			_('Username (optional)'));
		customUser.cfgvalue = function() {
			return uci.get('passwall2', CUSTOM_NODE_SECTION, 'username') || '';
		};
		customUser.write = function() {};

		var customPass = sCustom.option(form.Value, 'custom_socks_pass',
			_('Password (optional)'));
		customPass.password = true;
		customPass.cfgvalue = function() {
			return uci.get('passwall2', CUSTOM_NODE_SECTION, 'password') || '';
		};
		customPass.write = function() {};

		// --- Pool manager (docs/SPEC-pool-manager.md §4/§5) ------------------------------
		// Passive census + ranked seating. The ranked list renders from the stats the
		// observer's census accumulates; the checkboxes ONLY seat on Save & Apply — nothing
		// here ever reseats or rolls back by itself (operator mandate 2026-11-22).
		var bal = findBalancerSection();
		var balName = (bal && bal.kind === 'xray_balancing') ? bal.section['.name'] : null;
		var currentPool = balName ? (uci.get('passwall2', balName, 'balancing_node') || []) : [];
		var currentFallback = balName ? uci.get('passwall2', balName, 'fallback_node') : null;
		POOL_CAP = parseInt(uci.get('passwall2_presets', 'pool', 'pool_size'), 10) || 13;
		var poolStats = parsePoolStats(POOL_STATS_RAW, Math.floor(Date.now() / 1000));
		var ranked = rankPool(poolStats);
		// Proposal slate (operator mandate 2026-11-23): the checkboxes PRE-TICK the
		// best cutoff-qualified nodes of the rolling 24h census window — a proposal to
		// review, not a mirror of the current pool. Seating still happens ONLY on
		// Save & Apply (passive mandate unchanged). Zero qualified data -> the live
		// pool stays pre-ticked (no surprise empty reseat).
		var proposedSids = ranked.map(function(r) { return r.sid; });
		var proposalActive = proposedSids.length > 0;
		var poolRows = ranked.slice(0);
		// Currently-seated nodes outside the qualified suggestion list stay visible (marked)
		// so a Save can never silently drop a seat the operator cannot see (SPEC §4).
		(currentPool || []).concat(currentFallback ? [ currentFallback ] : []).forEach(function(sid) {
			if (!sid)
				return;
			var known = poolRows.some(function(r) { return r.sid === sid; });
			if (!known) {
				var n = loadNodes().filter(function(x) { return x['.name'] === sid; })[0];
				if (n)
					poolRows.push({ sid: sid, remarks: n.remarks || sid, st: null });
			}
		});

		if (!uci.get('passwall2_presets', 'pool'))
			uci.add('passwall2_presets', 'pool', 'pool');
		var sPool = m.section(form.NamedSection, 'pool', 'pool', null);
		sPool.addremove = false;

		// Banner: what the pre-ticks mean vs the live pool. Explicit because ANY Save
		// & Apply on this page seats the slate (a widget-flag change included) — the
		// banner states the diff so the review is informed, never surprised.
		var pn = sPool.option(form.DummyValue, 'proposal_note', _('Suggested slate'));
		pn.cfgvalue = function() {
			var add = 0, rem = 0, i;
			for (i = 0; i < proposedSids.length; i++)
				if ((currentPool || []).indexOf(proposedSids[i]) < 0)
					add++;
			for (i = 0; i < (currentPool || []).length; i++)
				if (proposedSids.indexOf(currentPool[i]) < 0)
					rem++;
			var t = proposalActive
				? _('Pre-ticked: the best ' + proposedSids.length + ' nodes of the last 24h census window (cutoff-qualified, cap 13). ')
				: _('No qualified slate yet — the live PassWall2 pool is kept pre-ticked. ');
			if (proposalActive && (add || rem))
				t += _('Applying seats +' + add + ' new and drops -' + rem + ' of the current pool. Review the ticks, then Save & Apply.');
			else
				t += _('Nothing seats until you Save & Apply.');
			return t;
		};

		function fmtMs(v) { return (v == null) ? '—' : (v + ' ms'); }
		function fmtAgo(s) { return (s == null) ? '—' : (Math.floor(s / 60) + ' m'); }

		// Force-balancer: a MIRROR (cfgvalue reads live shunt state), never a stored flag.
		// Writes ONLY the shunt's default_node — never @global node/tcp/udp (the 2026-11-22
		// drift class). Restore-on-untick only-if-current-is-ours (never clobbers).
		var shunt = findShuntSection();
		// Census switch (operator request 2026-11-24: an explicit probe on/off). Mirrors
		// and writes pool.enabled — the same gate observer_watchdog.sh's census step runs
		// under (SPEC-pool-manager.md §1): off = no periodic node probes at all (the
		// ranked list keeps rendering its last collected stats), on = the round-robin
		// sweep resumes at the next cron tick. Deliberately INDEPENDENT of the addon
		// master switch and the observer: killing monitoring noise for A/B latency
		// measurements (as done live 2026-11-24) does not require dropping the probes.
		var cenEnable = sPool.option(form.Flag, 'enabled', _('Census enabled'));
		cenEnable.rmempty = false;
		cenEnable.default = '1';
		cenEnable.description = _('Unticked, the periodic one-node-per-minute probe sweep ' +
			'is fully off (quiet router, honest A/B latency tests). The ranked list on this ' +
			'page keeps showing the last collected statistics until the census is ticked ' +
			'back on. Ticked, the sweep resumes at the next observer tick.');
		var probeEvery = sPool.option(form.Value, 'probe_interval',
			_('Probe every N minutes'));
		probeEvery.rmempty = false;
		probeEvery.placeholder = '5';
		probeEvery.description = _('One node probe every N minutes (default 5). Lower = faster ' +
			'statistics fill but more router load; raise it if the chain feels noisy. No ceiling.');
		var sizeOpt = sPool.option(form.Value, 'pool_size',
			_('Suggested pool size'));
		sizeOpt.rmempty = false;
		sizeOpt.placeholder = '13';
		sizeOpt.description = _('How many ranked nodes the suggestion list offers ' +
			'(default 13). A maximum, never a quota - fewer qualifying nodes render ' +
			'fewer rows. Raise it when stronger hardware allows a bigger live pool.');

		var fBal = sPool.option(form.Flag, 'force_balancer',
			_('Force the shunt default through the Balancing node'));
		fBal.rmempty = false;
		fBal.default = '0';
		fBal.cfgvalue = function() {
			return (shunt && balName && shunt.section.default_node === balName) ? '1' : '0';
		};
		fBal.description = (shunt && balName) ?
			_('Tick to point the shunt default_node at the Balancing node. Untick restores ' +
			'the remembered previous target, if it is still ours. Never touches the Main ' +
			'node / tcp_node / udp_node.') :
			_('Inert: no shunt node or no Xray Balancing node found. This addon never creates ' +
			'either — configure them on PassWall2 own Node List page.');
		fBal.write = function(section_id, value) {
			if (!shunt || !balName)
				return;
			// Mutual exclusion with the Custom SOCKS preset (live-verified 2026-11-24):
			// sections save in insertion order, so this runs AFTER custom_socks has
			// pointed default_node at its own node — and would silently clobber it
			// (observed: pool.prev_default_node remembered 'pw2p_custom_socks_node',
			// the preset unticked itself on the very same Apply). When the custom
			// preset is enabled in this same save, IT owns the shunt exit (and dials
			// through the Balancing node as its first hop anyway) — do not touch.
			var ce = this.map.lookupOption('custom_socks_enabled', 'custom_socks');
			if (ce && ce[0] && ce[0].formvalue('custom_socks') === '1')
				return;
			var cur = uci.get('passwall2', shunt.section['.name'], 'default_node');
			if (value === '1') {
				if (cur !== balName)
						uci.set('passwall2_presets', 'pool', 'prev_default_node', cur || '');
				uci.set('passwall2', shunt.section['.name'], 'default_node', balName);
			} else {
				var prev = uci.get('passwall2_presets', 'pool', 'prev_default_node');
				if (cur === balName && prev)
					uci.set('passwall2', shunt.section['.name'], 'default_node', prev);
			}
		};

		// Seating: fallback is a single-select dropdown (native at-most-one, the 2026-11-23
		// resolution of the two-checkbox mutex); pool rows are checkboxes whose write() is a
		// no-op — the dropdown's write() rebuilds the whole seating from every checkbox state
		// in one pass (formvalue reads live DOM at save time).
		var seatOptions = [];
		poolRows.forEach(function(r, idx) {
			var title = (idx + 1) + '. ' + (r.remarks || r.sid) +
				(r.st ? ' — p50 ' + fmtMs(r.st.p50) + ' · ' + r.st.success + '% · streak ' + r.st.streak
						: ' — awaiting census data');
			if ((currentPool || []).indexOf(r.sid) >= 0 && proposedSids.indexOf(r.sid) < 0)
				title += ' · [current pool]';
			var o = sPool.option(form.Flag, 'seat_' + r.sid, title);
			o.rmempty = false;
			o.default = '0';
			o.cfgvalue = function() {
				if (proposalActive)
					return proposedSids.indexOf(r.sid) >= 0 ? '1' : '0';
				return (currentPool || []).indexOf(r.sid) >= 0 ? '1' : '0';
			};
			o.write = function() {};   // never persisted: seating lands in passwall2 below
			o.description = r.st ?
				_('Attempts (24h): ' + r.st.attempts + ' · success: ' + r.st.success + '%' +
					' · p50/p90: ' + fmtMs(r.st.p50) + ' / ' + fmtMs(r.st.p90) +
					' · since ok: ' + fmtAgo(r.st.since_ok)) :
				_('Seated in the PassWall2 pool: live-tested by PassWall2 itself (its own ' +
				'observatory probes every pool member each probeInterval) - the census ranks ' +
				'candidates only, so this row carries no census statistics.');
			seatOptions.push({ opt: o, sid: r.sid });
		});

		var fb = sPool.option(form.ListValue, 'fallback_node', _('Fallback node (one)'));
		fb.rmempty = false;
		fb.value('', _('— none (blackhole) —'));
		poolRows.forEach(function(r) {
			fb.value(r.sid, r.remarks || r.sid);
		});
		fb.cfgvalue = function() {
			return (currentFallback && poolRows.some(function(r) { return r.sid === currentFallback; })) ? currentFallback : '';
		};
		fb.description = _('When every pool node is down, PassWall2 routes through this one ' +
			'node. A fallback that is ALSO a pool member degrades to blackhole silently ' +
			'(util_xray.lua gen_balancer), so the dropdown choice is always removed from the ' +
			'pool on save.');
		fb.write = function(section_id, value) {
			if (!balName)
				return;
			var chosen = [];
			seatOptions.forEach(function(s) {
				if (s.opt.formvalue(section_id) === '1')
					chosen.push(s.sid);
			});
			if (value && chosen.indexOf(value) >= 0)
				chosen.splice(chosen.indexOf(value), 1);   // fallback sits OUTSIDE the pool
			uci.set('passwall2', balName, 'balancing_node', chosen);
			if (value)
				uci.set('passwall2', balName, 'fallback_node', value);
			else
				uci.remove('passwall2', balName, 'fallback_node');
		};

		// --- Preset A: "Best node" ------------------------------------------------------
		var sBest = m.section(form.NamedSection, 'best_node', 'preset', null);
		sBest.addremove = false;

		var strategy = sBest.option(form.ListValue, 'strategy', _('Strategy'));
		strategy.value('', _('— not currently set via this addon —'));
		strategy.value('fast', _('Fastest'));
		strategy.value('stable', _('Most stable'));
		strategy.value('manual', _('Manual with auto-restore'));
		strategy.default = '';
		strategy.rmempty = false;
		strategy.description = _('Fastest and Most stable switch the strategy of the ' +
			'Balancing/URLTest node you already set up on PassWall2\'s own Node List page ' +
			'(this addon never creates that node itself). Manual with auto-restore is ' +
			'PassWall2\'s own SOCKS Auto Switch feature: an explicitly pinned Main node ' +
			'plus an ordered backup list, instead of an algorithm picking the winner.');

		strategy.cfgvalue = function(section_id) {
			// PW2 26.7.16 routes by the global `node` key (tcp_node/udp_node are
			// legacy here); fall back to them for older configs.
			var mainNode = uci.get('passwall2', '@global[0]', 'node') ||
				uci.get('passwall2', '@global[0]', 'tcp_node');
			if (!mainNode)
				return '';

			if (mainNode === MANUAL_NODE_SECTION &&
			    uci.get('passwall2', MANUAL_SOCKS_SECTION, 'enabled') === '1')
				return 'manual';

			var bal = findBalancerSection();
			var shunt = findShuntSection();
			var balancerUnderneath = !!(
				mainNode === CUSTOM_NODE_SECTION ||
				(shunt && mainNode === shunt.section['.name'] &&
					(shunt.section.default_node === CUSTOM_NODE_SECTION ||
					 (bal && shunt.section.default_node === bal.section['.name']))));

			// The Balancing node keeps running underneath all of the above, so
			// its live strategy is what is actually running — show it instead
			// of a blank "not set via this addon".
			if (balancerUnderneath && bal && bal.kind === 'xray_balancing') {
				var bsC = bal.section.balancingStrategy;
				if (bsC === 'leastPing') return 'fast';
				if (bsC === 'leastLoad') return 'stable';
			}

			if (bal && mainNode === bal.section['.name']) {
				if (bal.kind === 'xray_balancing') {
					var bs = bal.section.balancingStrategy;
					if (bs === 'leastPing') return 'fast';
					if (bs === 'leastLoad') return 'stable';
				}
			}
			return '';
		};

		strategy.validate = function(section_id, value) {
			if (value === '')
				return true;

			var bal = findBalancerSection();

			if (value === 'fast' || value === 'stable') {
				if (!bal)
					return _('No Balancing/URLTest node found in PassWall2 yet — add one ' +
						'on PassWall2\'s own Node List page first (a Balancing node, for ' +
						'Xray nodes, or a URLTest node, for sing-box nodes), then come ' +
						'back here to pick a strategy for it.');
				if (bal.kind === 'singbox_urltest')
					return _('A sing-box URLTest node was found, but this addon does not ' +
						'yet write to it — only Xray Balancing is currently supported for ' +
						'Fastest/Most stable. Adjust it on PassWall2\'s own page for now.');
			}

			if (value === 'manual') {
				var mainOpt = this.map.lookupOption('manual_main_node', section_id)[0];
				var mainId = mainOpt ? mainOpt.formvalue(section_id) : null;
				if (!mainId)
					return _('Pick a Main node before switching to Manual with auto-restore.');
			}

			return true;
		};

		strategy.write = function(section_id, value) {
			if (value === '')
				return;

			var fbOpt = this.map.lookupOption('fallback_direct_enabled', section_id)[0];
			var fallbackOn = fbOpt ? (fbOpt.formvalue(section_id) === '1') : false;

			if (value === 'manual') {
				var mainOpt = this.map.lookupOption('manual_main_node', section_id)[0];
				var backupOpt = this.map.lookupOption('manual_backup_nodes', section_id)[0];
				var restoreOpt = this.map.lookupOption('manual_restore_switch', section_id)[0];

				var mainId = mainOpt.formvalue(section_id);
				var backupIds = backupOpt.formvalue(section_id) || [];
				var restoreOn = (restoreOpt.formvalue(section_id) === '1');

				ensureManualNodePair(mainId, backupIds, restoreOn);

				uci.set('passwall2', '@global[0]', 'node', MANUAL_NODE_SECTION);
				uci.set('passwall2', '@global[0]', 'tcp_node', MANUAL_NODE_SECTION);
				uci.set('passwall2', '@global[0]', 'udp_node', MANUAL_NODE_SECTION);
				return;
			}

			// value is 'fast' or 'stable' — validate() already guaranteed a writable Xray
			// Balancing node exists.
			var bal = findBalancerSection();
			var balName = bal.section['.name'];

			uci.set('passwall2', balName, 'balancingStrategy',
				value === 'fast' ? 'leastPing' : 'leastLoad');

			if (value === 'fast') {
				uci.unset('passwall2', balName, 'expected');
			} else {
				// "stable": only fill these in if unset, so any prior manual tuning done
				// through PW2's own native pages survives repeated Save & Apply here.
				if (!bal.section.expected)
					uci.set('passwall2', balName, 'expected', '1');
				if (!bal.section.tolerance)
					uci.set('passwall2', balName, 'tolerance', '10');
			}

			// fallback_direct_enabled fan-out (see file header) — ON is an explicit,
			// unambiguous user action, so it always wins. OFF only clears fallback_node if
			// it's still exactly '_direct', so it never clobbers a real node the user picked
			// by hand on PW2's own page.
			if (fallbackOn) {
				uci.set('passwall2', balName, 'fallback_node', '_direct');
			} else if (bal.section.fallback_node === '_direct') {
				uci.unset('passwall2', balName, 'fallback_node');
			}

			uci.set('passwall2', '@global[0]', 'tcp_node', balName);
			uci.set('passwall2', '@global[0]', 'udp_node', balName);

			disableManualSocks();
		};

		var nodes = pickableNodes();

		var mainNode = sBest.option(form.ListValue, 'manual_main_node', _('Main node'));
		mainNode.depends('strategy', 'manual');
		mainNode.description = _('The node PassWall2 keeps using as long as it stays ' +
			'healthy. Picked from PassWall2\'s own configured nodes.');
		nodes.forEach(function(n) { mainNode.value(n['.name'], nodeLabel(n)); });
		mainNode.cfgvalue = function() {
			return uci.get('passwall2', MANUAL_SOCKS_SECTION, 'node') || '';
		};
		mainNode.write = function() {};
		mainNode.remove = function() {};

		var backupNodes = sBest.option(form.DynamicList, 'manual_backup_nodes',
			_('Backup nodes (in order)'));
		backupNodes.depends('strategy', 'manual');
		backupNodes.description = _('Ordered fallback chain, used in this order if the ' +
			'Main node fails.');
		nodes.forEach(function(n) { backupNodes.value(n['.name'], nodeLabel(n)); });
		backupNodes.cfgvalue = function() {
			return uci.get('passwall2', MANUAL_SOCKS_SECTION, 'autoswitch_backup_node') || [];
		};
		backupNodes.write = function() {};
		backupNodes.remove = function() {};

		var restoreSwitch = sBest.option(form.Flag, 'manual_restore_switch',
			_('Restore Switch'));
		restoreSwitch.depends('strategy', 'manual');
		restoreSwitch.description = _('Automatically switch back to the Main node once ' +
			'it is healthy again.');
		restoreSwitch.default = '1';
		restoreSwitch.cfgvalue = function() {
			var v = uci.get('passwall2', MANUAL_SOCKS_SECTION, 'autoswitch_restore_switch');
			return (v == null) ? '1' : v;
		};
		restoreSwitch.write = function() {};
		restoreSwitch.remove = function() {};

		var fallbackDirect = sBest.option(form.Flag, 'fallback_direct_enabled',
			_('Allow Direct as last-resort fallback (Fastest/Most stable only)'));
		fallbackDirect.rmempty = false;
		fallbackDirect.default = '0';
		fallbackDirect.description = _('If every node in the Balancing pool is down, let ' +
			'PassWall2 fall back to a Direct connection instead of blocking traffic. ' +
			'Caveat (PassWall2 issue #439): DNS resolution can leak via your ISP resolver ' +
			'while in this fallback state — only enable if you accept that trade-off. Has ' +
			'no effect while Manual with auto-restore is selected.');

		// --- Widget (field visibility) ---------------------------------------------------
		var s = m.section(form.TypedSection, 'widget', null);
		s.anonymous = true;
		s.addremove = false;

		function addFlag(name, title, description) {
			var o = s.option(form.Flag, name, title);
			o.rmempty = false;
			o.default = '1';
			if (description)
				o.description = description;
			return o;
		}

		// Probe visibility flags double as the probe's RUN switch (operator decision
		// 2026-11-24): the checkbox mirrors the probe's own gate (ip_via_proxy.enabled
		// and friends) and writes BOTH — "the row shows" == "the probe runs". Unticked:
		// the probe stops entirely (no traffic, no CPU), not just hidden; the
		// observer's next cron tick picks the change up. Probes only — every other row
		// above stays a pure visibility switch.
		var PROBE_GATES = {
			show_probe_a: 'ip_via_proxy',
			show_probe_b: 'blocked_via_proxy',
			show_probe_c: 'ip_direct',
			show_probe_d: 'unblocked_direct'
		};
		function addProbeFlag(name, title, description) {
			var o = addFlag(name, title, description);
			o.cfgvalue = function(section_id) {
				return uci.get('passwall2_presets', PROBE_GATES[name], 'enabled') || '0';
			};
			o.write = function(section_id, value) {
				uci.set('passwall2_presets', section_id, name, value);
				if (!uci.get('passwall2_presets', PROBE_GATES[name]))
					uci.add('passwall2_presets', 'probe', PROBE_GATES[name]);
				uci.set('passwall2_presets', PROBE_GATES[name], 'enabled', value);
			};
			o.description = (o.description || '') + ' ' +
				_('This checkbox also switches the probe itself: unticked, the probe stops ' +
				'running entirely, not just hidden from the widget.');
			return o;
		}

		// Order matches the Overview panel's own row order (see overview.js's
		// "Row order per user request 2026-07-22" comment) so the checkbox list reads
		// top-to-bottom exactly like the thing it's controlling.
		addFlag('show_watchdog_status', _('Watchdog status'),
			_('The Observer watchdog\'s verdict on the proxy chain, driven by Probe A ' +
			'plus a live check of the Xray process. OK — the chain answers and ' +
			'Xray is alive; Degraded — a probe failed while Xray still runs (not ' +
			'necessarily a chain failure); Down (grace period) — the chain is down ' +
			'and the watchdog is waiting out its grace period before acting; ' +
			'Restarting / Restarted, confirming — the automatic repair attempt ' +
			'itself; Disabled — the Observer is switched off in ' +
			'/etc/config/passwall2_presets.'));
		addFlag('show_xray_process', _('Xray process'),
			_('Whether the Xray core process is actually running, checked live by the ' +
			'watchdog on every pass (about once per arming window, 15 s by default). Running alone does not ' +
			'prove traffic flows — the probes below answer that.'));
		addProbeFlag('show_probe_a', _('Probe A — exit IP via proxy'),
			_('The public exit IP your traffic presents to the outside world while ' +
			'going through the proxy. The row also shows how long this exit IP has ' +
			'held steady and, when the IP matches one of the active balancer node\'s ' +
			'own addresses, that node\'s flag and label from its PassWall2 remarks — ' +
			'so you can see at a glance which node you are riding.'));
		addProbeFlag('show_probe_c', _('Probe C — exit IP via direct path'),
			_('The exit IP seen without the proxy: your plain ISP address, fetched ' +
			'around the chain. Compare with Probe A — if both show the same IP, your ' +
			'traffic is leaving by the direct path and the proxy is not in the loop. ' +
			'Stays disabled until you set up a direct/shunt rule that routes the ' +
			'IP-checker host outside the proxy (see the README how-to) and enable ' +
			'the ip_direct probe in /etc/config/passwall2_presets.'));
		addProbeFlag('show_probe_b', _('Probe B — blocked resource via proxy'),
			_('Checks that a resource you listed as blocked actually comes back ' +
			'through the proxy, with its latency. Rows show not configured until you ' +
			'add hosts to the blocked_via_proxy probe in ' +
			'/etc/config/passwall2_presets (no defaults on purpose — block lists ' +
			'differ per region). If Probe A looks fine but B fails, your current ' +
			'node cannot reach that resource: wrong exit country or a dead pool ' +
			'member.'));
		addProbeFlag('show_probe_d', _('Probe D — unblocked resource via direct path'),
			_('Fetches a known-open resource without the proxy — the baseline that ' +
			'plain internet still works. Rows show not configured until you add ' +
			'hosts to the unblocked_direct probe in /etc/config/passwall2_presets. ' +
			'If D fails while A works, the proxy is fine and the problem is the ' +
			'router\'s own direct connectivity (or the D target itself).'));
		addFlag('show_last_updated', _('Last updated'),
			_('Age of the Observer\'s last refresh, read from its status file (the ' +
			'watchdog runs about once per arming window, 15 s by default; the page itself re-polls every 5 ' +
			'seconds). If it stops advancing while the page is open, the watchdog ' +
			'script has stopped — check the recent events list on the Overview ' +
			'tab.'));
		addFlag('show_configured_nodes', _('Configured nodes'),
			_('How many nodes PassWall2 currently has configured — the pool your Best ' +
			'node strategy picks from. A snapshot from the Observer\'s last refresh, ' +
			'not a live count.'));
		addFlag('show_active_balancer', _('Active balancer'),
			_('Which Balancing node is currently set as the Main node — the same node ' +
			'the Strategy field above switches between Fastest, Most stable and ' +
			'Manual. Not found means no Balancing node exists yet: create one on ' +
			'PassWall2\'s own Node List page (this addon never creates it for you).'));

		// Kill-switch (docs/SPEC-killswitch.md). Self-created on demand like custom_socks
		// above. The section name 'killswitch' must match the config template, the live
		// router config and observer_watchdog.sh's reads — do not rename.
		if (!uci.get('passwall2_presets', 'killswitch'))
			uci.add('passwall2_presets', 'killswitch', 'killswitch');
		var sKs = m.section(form.NamedSection, 'killswitch', 'killswitch', null);
		sKs.addremove = false;

		var ksEnable = sKs.option(form.Flag, 'enabled', _('Enable the kill-switch'));
		ksEnable.rmempty = false;
		ksEnable.default = '1';
		ksEnable.description = _('While PassWall2 is down or its rules are absent (boot, ' +
			'crash, watchdog restart), the Observer raises an nftables drop on ' +
			'LAN-to-WAN forwarding: traffic is BLOCKED instead of leaking out through ' +
			'your provider IP (silence over leak). Honest limits, accepted on ' +
			'2026-10-04: after an unscheduled PassWall2 crash the wall takes up to one ' +
			'window (the field below) to arm, so a short leak is possible; a small boot ' +
			'sliver exists before the init script runs, but the WAN has no address ' +
			'there yet; DNS names may still reach your ISP resolver during down ' +
			'windows (traffic does not, names do); and the router\'s own traffic is ' +
			'not covered — PassWall2 must be able to reach its nodes to recover. With ' +
			'a healthy chain the wall is absent and everything works as before. ' +
			'Unticking removes the protection entirely — the Observer then only ' +
			'reports and restarts, as it did before the kill-switch existed.');

		var ksWindow = sKs.option(form.Value, 'window', _('Arming window (seconds)'));
		ksWindow.rmempty = false;
		ksWindow.default = '15';
		ksWindow.placeholder = '15';
		ksWindow.description = _('The Observer polling window in seconds; the reaction ' +
			'delay after an unscheduled PassWall2 crash is bounded by this. Realized ' +
			'as sleep-offset cron lines (busybox crond granularity is one minute), ' +
			'regenerated by Save & Apply and at every boot. Minimum 15, maximum 60.');
		ksWindow.validate = function(section_id, value) {
			if (!/^\d+$/.test(value || ''))
				return _('Enter a whole number of seconds');
			var v = +value;
			if (v < 15)
				return _('Minimum is 15 seconds (one-minute crond grid)');
			if (v > 60)
				return _('Maximum is 60 seconds (one cron line per minute)');
			return true;
		};

		return m.render().then(function(mapEl) {
			function wrapInDetails(id, title, openByDefault) {
				var sectionEl = mapEl.querySelector(id);
				if (!sectionEl || !sectionEl.parentNode)
					return;
				var details = E('details', openByDefault ? { 'open': '' } : {}, [
					E('summary', {}, [ title ])
				]);
				sectionEl.parentNode.insertBefore(details, sectionEl);
				details.appendChild(sectionEl);
			}

			// Preset A above Widget, per the Settings tab layout this was designed against.
			wrapInDetails('#cbi-passwall2_presets-best_node', _('Best node (Preset A)'), true);
			wrapInDetails('#cbi-passwall2_presets-widget', _('Widget'), false);
			wrapInDetails('#cbi-passwall2_presets-custom_socks', _('Custom SOCKS5'), true);
			wrapInDetails('#cbi-passwall2_presets-pool', _('Pool manager'), false);
			wrapInDetails('#cbi-passwall2_presets-killswitch', _('Kill-switch'), false);

			return mapEl;
		});
	}
});
