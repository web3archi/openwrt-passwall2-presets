'use strict';
'require baseclass';
'require fs';

// Native "widget" slot on the stock Status > Overview page (auto-discovered by
// luci-mod-status's own view/status/index.js — every *.js file here gets its own
// card with title + hide/show, provided by that parent view, not invented here).
//
// Per docs/SPEC_v0.6.0.md §4 ("The same history is also shown in a standalone
// widget — but the widget renders just the raw list, with none of the page's
// surrounding info-panel/browser chrome."): this widget intentionally shows only
// the tail of the Observer's own log (its de-facto history/event feed) — the full
// status panel (node count, probes A-D, watchdog badge) lives on the dedicated
// Overview page at admin/services/passwall2-presets/overview, not duplicated here.

var LOG_FILE = '/tmp/passwall2_presets/observer_watchdog.log';
var LOG_TAIL_LINES = 6;

return baseclass.extend({
	title: _('PassWall2 Presets — Recent Events'),

	load: function() {
		return L.resolveDefault(fs.read(LOG_FILE), '');
	},

	render: function(logText) {
		var lines = (logText || '').split('\n').filter(function(l) { return l.trim() !== ''; });
		lines = lines.slice(-LOG_TAIL_LINES).reverse();

		if (lines.length === 0)
			return E('p', {}, [ _('No events recorded yet.') ]);

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
});
