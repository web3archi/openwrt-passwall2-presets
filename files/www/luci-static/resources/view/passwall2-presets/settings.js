'use strict';
'require form';
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

	uci.set('passwall2', MANUAL_NODE_SECTION, 'type', 'Socks');
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
		return uci.load('passwall2');
	},

	render: function() {
		var m = new form.Map('passwall2_presets', null,
			_('Settings for PassWall2 Presets.'));

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
			var tcpNode = uci.get('passwall2', '@global[0]', 'tcp_node');
			if (!tcpNode)
				return '';

			if (tcpNode === MANUAL_NODE_SECTION &&
			    uci.get('passwall2', MANUAL_SOCKS_SECTION, 'enabled') === '1')
				return 'manual';

			var bal = findBalancerSection();
			if (bal && tcpNode === bal.section['.name']) {
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

		function addFlag(name, title) {
			var o = s.option(form.Flag, name, title);
			o.rmempty = false;
			o.default = '1';
			return o;
		}

		// Order matches the Overview panel's own row order (see overview.js's
		// "Row order per user request 2026-07-22" comment) so the checkbox list reads
		// top-to-bottom exactly like the thing it's controlling.
		addFlag('show_watchdog_status', _('Watchdog status'));
		addFlag('show_xray_process', _('Xray process'));
		addFlag('show_probe_a', _('Probe A — exit IP via proxy'));
		addFlag('show_probe_c', _('Probe C — exit IP via direct path'));
		addFlag('show_probe_b', _('Probe B — blocked resource via proxy'));
		addFlag('show_probe_d', _('Probe D — unblocked resource via direct path'));
		addFlag('show_last_updated', _('Last updated'));
		addFlag('show_configured_nodes', _('Configured nodes'));
		addFlag('show_active_balancer', _('Active balancer'));

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
			wrapInDetails('#cbi-passwall2_presets-widget', _('Widget'), true);

			return mapEl;
		});
	}
});
