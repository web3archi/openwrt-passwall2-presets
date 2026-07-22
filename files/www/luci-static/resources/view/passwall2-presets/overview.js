'use strict';
'require view';
'require dom';
'require poll';
'require fs';
'require uci';

// Reads files/etc/passwall2-presets/observer_watchdog.sh's own status/log output —
// see docs/SPEC_v0.6.0.md §4 "Overview page" for the field list this mirrors, and
// docs/BACKLOG.md P7 for why node counts/probe fields are shaped the way they are
// (no live Xray API to query, which is also why there is deliberately no "currently
// active node" row here — see the removed "Currently working" row, 2026-07-22).
//
// This same view is also instantiated, unmodified, by the standalone chrome-less
// widget page at files/usr/share/ucode/luci/template/passwall2-presets/widget.ut —
// one render() implementation, two entry points (admin tab + standalone page), per
// the user's "duplicate the Overview tab, don't build a second thing" request.
//
// Badge colors follow the native luci-theme-bootstrap palette only (cascade.css):
//   - green  -> class "label success" (native, --success-color-high)
//   - yellow -> class "label warning" (native, --warn-color-high)
//   - grey   -> bare class "label"    (native default, --background-color-low)
//   - red    -> the bootstrap theme has no ".label.danger" variant (only
//     .btn/.alert-message/.cbi-tooltip get a "danger"/"error" modifier), so the
//     danger badge reuses the SAME native error CSS variables
//     (--error-color-high / --on-error-color) as an inline style on the base
//     ".label" class, rather than inventing a new color — see SPEC §4.

var STATUS_FILE = '/tmp/passwall2_presets/observer_watchdog.status';
var LOG_FILE = '/tmp/passwall2_presets/observer_watchdog.log';
var LOG_TAIL_LINES = 20;
var POLL_INTERVAL_SECONDS = 5;

// kind: 'ok' (green) | 'warn' (yellow) | 'bad' (red) | 'grey' (undetermined, default)
var WATCHDOG_STATES = {
	'ok':                    { text: _('OK'),                    kind: 'ok'   },
	'degraded':              { text: _('Degraded'),               kind: 'warn' },
	'down-in-grace':         { text: _('Down (grace period)'),    kind: 'warn' },
	'restarting':            { text: _('Restarting'),             kind: 'warn' },
	'restarted-confirming':  { text: _('Restarted, confirming'),  kind: 'warn' },
	'disabled':              { text: _('Disabled'),               kind: 'grey' }
};

function badge(text, kind) {
	var cls = 'label';
	var style = null;

	if (kind === 'ok')
		cls += ' success';
	else if (kind === 'warn')
		cls += ' warning';
	else if (kind === 'bad')
		style = 'background-color:var(--error-color-high);color:var(--on-error-color);';
	// kind === 'grey' or unset: bare ".label" already renders neutral/grey natively.

	return E('span', style ? { 'class': cls, 'style': style } : { 'class': cls }, [ text ]);
}

function fmtAgo(unixtime) {
	if (!unixtime)
		return _('never');
	var secs = Math.max(0, Math.floor(Date.now() / 1000) - unixtime);
	if (secs < 90)
		return secs + _('s ago');
	var mins = Math.floor(secs / 60);
	if (mins < 90)
		return mins + _('m ago');
	return Math.floor(mins / 60) + _('h ago');
}

// Same bucketing as fmtAgo(), but phrased as a plain duration (no "ago" suffix) --
// used for "how long has the exit IP been stable", where "ago" would read backwards.
function fmtDuration(unixtime) {
	if (!unixtime)
		return null;
	var secs = Math.max(0, Math.floor(Date.now() / 1000) - unixtime);
	if (secs < 90)
		return secs + _('s');
	var mins = Math.floor(secs / 60);
	if (mins < 90)
		return mins + _('m');
	return Math.floor(mins / 60) + _('h');
}

// Split a PW2 node's free-form "remarks" label into an optional leading flag emoji
// plus the rest of the text. This is intentionally generic, not a hardcoded country
// list: any Unicode flag emoji is exactly two "Regional Indicator Symbol" codepoints
// (U+1F1E6-U+1F1FF), matched here via the \p{Regional_Indicator} Unicode property
// escape, so it works for whatever countries happen to be in the user's own node set.
// Nodes whose remarks have no such prefix (confirmed to occur on this router, e.g. a
// plain "Финляндия" with no flag) just fall back to showing the raw text with no flag.
function splitNodeRemarks(remarks) {
	if (!remarks)
		return null;
	var m;
	try {
		m = remarks.match(/^(\p{Regional_Indicator}{2})\s*(.*)$/u);
	} catch (e) {
		m = null; // older browser without Unicode property escape support
	}
	if (m)
		return { flag: m[1], label: m[2].trim() || null };
	return { flag: null, label: remarks.trim() || null };
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '40%' }, [ label ]),
		E('td', { 'class': 'td left' }, [ value != null ? value : '-' ])
	]);
}

function parseStatus(raw) {
	try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// True on the full Overview tab (always show every row). On the standalone
// widget page (window.PW2P_WIDGET set by widget.ut before instantiating this
// same view — see that file), reads the matching Settings > Widget checkbox
// from the passwall2_presets UCI config instead. Falls back to "shown" if the
// option is missing (e.g. on an older config that predates this feature),
// same default as the UCI template ships.
function widgetVisible(option) {
	if (window.PW2P_WIDGET !== true)
		return true;
	var v = uci.get('passwall2_presets', 'widget', option);
	return (v == null) || (v == '1');
}

function renderPanel(raw) {
	var status = parseStatus(raw);

	if (!status) {
		return E('p', { 'class': 'alert-message warning' }, [
			_('No status data yet at %s — the Observer has not run yet, or is disabled ' +
			  '(config observer \'main\', option enabled, in /etc/config/passwall2_presets).')
				.format(STATUS_FILE)
		]);
	}

	var wd = WATCHDOG_STATES[status.watchdog_status] ||
		{ text: status.watchdog_status || _('unknown'), kind: 'grey' };
	var pa = status.probe_a || {};
	var pc = status.probe_c || {};
	var nodes = status.nodes || {};

	// Probe A value: exit-IP badge, then (if the watchdog script matched the observed
	// exit IP against a node's own `address` field in the active balancer's pool — see
	// docs/BACKLOG.md P7) that node's flag + label parsed from its PW2 "remarks" field,
	// then "unchanged for Xm" — how long the exit IP has held steady, computed by the
	// watchdog script itself (ip_since). No match on either -> that slot is just omitted,
	// never guessed.
	var probeAValue;
	if (pa.enabled != 1) {
		probeAValue = E('em', {}, [ _('disabled') ]);
	} else if (pa.ok != 1) {
		probeAValue = badge(_('unreachable'), 'bad');
	} else {
		var since = fmtDuration(pa.ip_since);
		var node = splitNodeRemarks(pa.node_remarks);
		probeAValue = E('span', {}, [
			badge(pa.ip || '?', 'ok'),
			node ? E('span', { 'style': 'margin-left:.5em' }, [
				(node.flag ? node.flag + ' ' : '') + (node.label || '')
			]) : '',
			since ? E('span', { 'class': 'cbi-value-description', 'style': 'margin-left:.5em' }, [
				_('unchanged for %s').format(since)
			]) : ''
		]);
	}

	var table = E('table', { 'class': 'table' }, []);

	if (widgetVisible('show_watchdog_status'))
		table.appendChild(row(_('Watchdog status'), badge(wd.text, wd.kind)));
	if (widgetVisible('show_xray_process'))
		table.appendChild(row(_('Xray process'), status.xray_alive == 1
			? badge(_('running'), 'ok')
			: badge(_('not running'), 'bad')));
	if (widgetVisible('show_probe_a'))
		table.appendChild(row(_('Probe A — exit IP via proxy'), probeAValue));
	if (widgetVisible('show_probe_c'))
		table.appendChild(row(_('Probe C — exit IP via direct path'), pc.enabled == 1
			? (pc.ip ? badge(pc.ip, 'ok') : badge(_('unreachable'), 'bad'))
			: E('em', {}, [ _('disabled') ])));

	var tail = [];
	[
		[ 'probe_b', _('Probe B — blocked resource via proxy'), 'show_probe_b' ],
		[ 'probe_d', _('Probe D — unblocked resource via direct path'), 'show_probe_d' ]
	].forEach(function(spec) {
		if (!widgetVisible(spec[2]))
			return;

		var items = Array.isArray(status[spec[0]]) ? status[spec[0]] : [];
		var label = spec[1];

		if (items.length === 0) {
			tail.push(row(label, E('em', {}, [ _('not configured') ])));
			return;
		}

		items.forEach(function(item) {
			var val = (item.status == 'reachable')
				? badge((item.host || '?') + ' (' + item.latency_ms + ' ms)', 'ok')
				: badge((item.host || '?') + ' — ' + _('unreachable'), 'bad');
			tail.push(row(label, val));
			label = '';
		});
	});

	// Row order per user request 2026-07-22: watchdog -> xray -> probes A/C/B/D ->
	// last updated -> node counters, moved out of the probe_b/probe_d block above so
	// they land after ALL probe rows regardless of how many probe_b/probe_d rows exist.
	tail.forEach(function(r) { table.appendChild(r); });
	if (widgetVisible('show_last_updated'))
		table.appendChild(row(_('Last updated'), fmtAgo(status.updated_at)));
	if (widgetVisible('show_configured_nodes'))
		table.appendChild(row(_('Configured nodes'), nodes.total_configured || '0'));
	if (widgetVisible('show_active_balancer'))
		table.appendChild(row(_('Active balancer'), nodes.active_balancer || E('em', {}, [ _('not found') ])));

	return table;
}

function renderEvents(logText) {
	var lines = (logText || '').split('\n').filter(function(l) { return l.trim() !== ''; });
	lines = lines.slice(-LOG_TAIL_LINES).reverse();

	if (lines.length === 0)
		return E('p', { 'class': 'cbi-value-description' }, [ _('No events recorded yet.') ]);

	var list = E('ul', {
		'style': 'font-family: monospace; font-size: 90%; margin: 0; padding-left: 1.2em;'
	});

	lines.forEach(function(line) {
		var m = line.match(/^(\S+ \S+)\s+(.*)$/);
		list.appendChild(E('li', {}, [
			m ? E('strong', {}, [ m[1] + '  ' ]) : '',
			m ? m[2] : line
		]));
	});

	return list;
}

return view.extend({
	load: function() {
		// The passwall2_presets UCI config (for widgetVisible()'s Settings > Widget
		// checkboxes) is only loaded on the standalone widget page -- the full
		// Overview tab never needs it, since it always shows every row. Avoids an
		// unnecessary extra ubus round-trip on every 5s poll of the main tab.
		return Promise.all([
			L.resolveDefault(fs.read(STATUS_FILE), null),
			L.resolveDefault(fs.read(LOG_FILE), ''),
			(window.PW2P_WIDGET === true) ? uci.load('passwall2_presets') : null
		]);
	},

	poll_status: function() {
		return this.load().then(L.bind(function(data) {
			dom.content(this.panelNode, renderPanel(data[0]));
			dom.content(this.eventsNode, renderEvents(data[1]));
		}, this));
	},

	render: function(data) {
		this.panelNode = E('div', {}, [ renderPanel(data[0]) ]);
		this.eventsNode = E('div', {}, [ renderEvents(data[1]) ]);

		// Neat top-of-page action button opening the compact standalone widget in
		// its own window (per user request). Only rendered on the full Overview
		// tab -- window.PW2P_WIDGET is set by widget.ut, so this stays absent when
		// this same view is instantiated *as* the widget page itself.
		// Default: empty fragment, not null -- E()'s array-append path does NOT
		// skip a literal null/undefined array entry (it stringifies it into a
		// text node instead, per dom.append() in luci.js), so this stays a
		// no-op in the container's E([...]) call below when left unassigned.
		var actions = E([]);
		if (window.PW2P_WIDGET !== true) {
			var openWidgetBtn = E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': function(ev) {
					ev.preventDefault();
					// Same window.open() feature string the widget.ut page's own
					// auto-resize logic expects (it checks window.opener, so this
					// must NOT pass 'noopener') -- see widget.ut for that side.
					window.open(
						L.url('admin/services/passwall2-presets/widget'),
						'pw2p',
						'width=1,height=1,resizable=yes,scrollbars=yes'
					);
				}
			}, [ _('Open widget') ]);

			actions = E('div', { 'style': 'margin-bottom:1em' }, [ openWidgetBtn ]);
		}

		// Recent events: hidden by default, shown only while the checkbox is
		// checked (per user request) — the checkbox only toggles the wrapper's
		// display; the underlying poll_status() keeps refreshing the content
		// underneath regardless, so it's already current the moment it's shown.
		var eventsToggle = E('input', {
			'type': 'checkbox',
			'id': 'pw2p-events-toggle',
			'change': L.bind(function(ev) {
				this.eventsWrap.style.display = ev.target.checked ? '' : 'none';
			}, this)
		});

		this.eventsWrap = E('div', { 'style': 'display:none' }, [ this.eventsNode ]);

		// Reuses the exact same .table/.tr/.td row markup as the Status panel above
		// (the row() helper), instead of the .cbi-value/.cbi-value-title flex-form
		// convention -- that convention is correct on its own terms (verified against
		// the theme's own cascade.css: .cbi-value is display:flex, title column is a
		// genuine flex:0 0 180px right-aligned box), but mixing it with the plain-table
		// rows above it on the same page is what read as "misaligned" (title column
		// starts well right of the Status rows' left edge, and .td's own native
		// vertical-align:middle -- which the flex form doesn't have -- is what the
		// checkbox needs to stop sitting above the label). One consistent row style
		// for the whole page, not a second invented one.
		var toggleLabel = E('label', { 'for': 'pw2p-events-toggle' }, [ _('Show recent events') ]);
		var toggleTable = E('table', { 'class': 'table' }, [
			row(toggleLabel, eventsToggle)
		]);

		var container = E([
			actions,
			E('div', { 'class': 'cbi-section' }, [
				this.panelNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Recent events') ]),
				toggleTable,
				this.eventsWrap
			])
		]);

		poll.add(L.bind(this.poll_status, this), POLL_INTERVAL_SECONDS);

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
