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

var STATUS_FILE = '/tmp/passwall2_presets/observer_watchdog.status';
var LOG_FILE = '/tmp/passwall2_presets/observer_watchdog.log';
var LOG_TAIL_LINES = 20;

var WATCHDOG_STATES = {
	'ok':                    { text: _('OK'),                       color: '#3c8f3c' },
	'degraded':              { text: _('Degraded'),                 color: '#c98a10' },
	'down-in-grace':         { text: _('Down (grace period)'),      color: '#c94a1f' },
	'restarting':            { text: _('Restarting'),                color: '#c94a1f' },
	'restarted-confirming':  { text: _('Restarted, confirming'),    color: '#c98a10' },
	'disabled':              { text: _('Disabled'),                 color: '#888888' }
};

function badge(text, color) {
	return E('span', {
		'style': 'display: inline-block; padding: 1px 8px; border-radius: 4px; ' +
			'color: #fff; background-color: ' + color + '; font-size: 90%; white-space: nowrap;'
	}, [ text ]);
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
		{ text: status.watchdog_status || _('unknown'), color: '#888888' };
	var pa = status.probe_a || {};
	var pc = status.probe_c || {};
	var nodes = status.nodes || {};

	var table = E('table', { 'class': 'table' }, [
		row(_('Watchdog status'), badge(wd.text, wd.color)),
		row(_('Last updated'), fmtAgo(status.updated_at)),
		row(_('Xray process'), status.xray_alive == 1
			? badge(_('running'), '#3c8f3c')
			: badge(_('not running'), '#c94a1f')),
		row(_('Active balancer'), nodes.active_balancer || E('em', {}, [ _('not found') ])),
		row(_('Configured nodes'), nodes.total_configured || '0'),
		row(_('Currently working'), nodes.currently_working == 'unavailable_no_xray_api'
			? E('em', {}, [ _('unavailable — PassWall2 does not expose an Xray API to query this live') ])
			: (nodes.currently_working || '-')),
		row(_('Probe A — exit IP via proxy'), pa.enabled == 1
			? (pa.ok == 1 ? badge(pa.ip || '?', '#3c8f3c') : badge(_('unreachable'), '#c94a1f'))
			: E('em', {}, [ _('disabled') ])),
		row(_('Probe C — exit IP via direct path'), pc.enabled == 1
			? (pc.ip ? badge(pc.ip, '#3c8f3c') : badge(_('unreachable'), '#c94a1f'))
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
				? badge((item.host || '?') + ' (' + item.latency_ms + ' ms)', '#3c8f3c')
				: badge((item.host || '?') + ' — ' + _('unreachable'), '#c94a1f');
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
				this.eventsNode
			])
		]);

		poll.add(L.bind(this.poll_status, this));

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
