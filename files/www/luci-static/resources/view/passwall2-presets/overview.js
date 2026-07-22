'use strict';
'require view';
'require dom';
'require poll';
'require fs';

// Reads files/etc/passwall2-presets/observer_watchdog.sh's own status/log output —
// see docs/SPEC_v0.6.0.md §4 "Overview page" for the field list this mirrors, and
// docs/BACKLOG.md P7 for why node counts/probe fields are shaped the way they are
// (no live Xray API to query, so nodes.currently_working is a documented limitation,
// not a bug).
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

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '40%' }, [ label ]),
		E('td', { 'class': 'td left' }, [ value != null ? value : '-' ])
	]);
}

function parseStatus(raw) {
	try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
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

	var table = E('table', { 'class': 'table' }, [
		row(_('Watchdog status'), badge(wd.text, wd.kind)),
		row(_('Last updated'), fmtAgo(status.updated_at)),
		row(_('Xray process'), status.xray_alive == 1
			? badge(_('running'), 'ok')
			: badge(_('not running'), 'bad')),
		row(_('Active balancer'), nodes.active_balancer || E('em', {}, [ _('not found') ])),
		row(_('Configured nodes'), nodes.total_configured || '0'),
		row(_('Currently working'), nodes.currently_working == 'unavailable_no_xray_api'
			? E('em', {}, [ _('unavailable — PassWall2 does not expose an Xray API to query this live') ])
			: (nodes.currently_working || '-')),
		row(_('Probe A — exit IP via proxy'), pa.enabled == 1
			? (pa.ok == 1 ? badge(pa.ip || '?', 'ok') : badge(_('unreachable'), 'bad'))
			: E('em', {}, [ _('disabled') ])),
		row(_('Probe C — exit IP via direct path'), pc.enabled == 1
			? (pc.ip ? badge(pc.ip, 'ok') : badge(_('unreachable'), 'bad'))
			: E('em', {}, [ _('disabled') ]))
	]);

	[
		[ 'probe_b', _('Probe B — blocked resource via proxy') ],
		[ 'probe_d', _('Probe D — unblocked resource via direct path') ]
	].forEach(function(spec) {
		var items = Array.isArray(status[spec[0]]) ? status[spec[0]] : [];
		var label = spec[1];

		if (items.length === 0) {
			table.appendChild(row(label, E('em', {}, [ _('not configured') ])));
			return;
		}

		items.forEach(function(item) {
			var val = (item.status == 'reachable')
				? badge((item.host || '?') + ' (' + item.latency_ms + ' ms)', 'ok')
				: badge((item.host || '?') + ' — ' + _('unreachable'), 'bad');
			table.appendChild(row(label, val));
			label = '';
		});
	});

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
		return Promise.all([
			L.resolveDefault(fs.read(STATUS_FILE), null),
			L.resolveDefault(fs.read(LOG_FILE), '')
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

		var container = E([
			E('h2', {}, [ _('PassWall2 Presets — Overview') ]),
			E('p', { 'class': 'cbi-value-description' }, [
				_('Live status from the Observer probe loop (see files/etc/passwall2-presets/' +
				  'observer_watchdog.sh). Read-only — the Settings tab for editing probes and ' +
				  'the watchdog is planned but not built yet; edit /etc/config/passwall2_presets ' +
				  'on the router directly for now.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Status') ]),
				this.panelNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Recent events') ]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title', 'for': 'pw2p-events-toggle' }, [
						_('Show recent events')
					]),
					E('div', { 'class': 'cbi-value-field' }, [ eventsToggle ])
				]),
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
