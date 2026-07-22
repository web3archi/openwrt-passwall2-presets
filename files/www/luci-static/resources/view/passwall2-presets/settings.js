'use strict';
'require form';
'require view';

// Settings tab skeleton — see docs/SPEC_v0.6.0.md §4 "Settings tab" and
// docs/BACKLOG.md P8 for the full planned scope. Preset A strategy read/write
// (Fastest / Most stable / Manual with auto-restore) and the
// fallback_direct_enabled toggle are NOT implemented yet — this first pass
// only wires up the "Widget" field-visibility list.
//
// This is a plain native form.Map bound to /etc/config/passwall2_presets, so
// the standard LuCI page-footer buttons work exactly like any other stock
// OpenWrt settings page — nothing custom is wired up. Per LuCI's own
// LuCI.view.handleSave/handleSaveApply/handleReset (luci.js), the default
// implementation already walks every ".cbi-map" on the page and calls its
// save()/reset() method, which is exactly what a form.Map needs; the footer
// then renders three buttons labeled "Save", "Save & Apply" and "Reset"
// (confirmed against luci.js's own addFooter() — there is no separate
// "Dismiss"/"Cancel" button in the page footer; "Reset" is the native
// equivalent — it re-renders the form and discards any unsaved edits).
//
// "Widget" section: every row currently shown on the Overview status panel
// gets one show/hide checkbox here (docs/BACKLOG.md P8, "не хардкодим" note —
// the *set* of fields is inherently fixed since they're this app's own known
// rows, but the show/hide *state* per field is fully UCI-backed and
// user-controlled, not a silently baked-in subset). This only affects the
// compact standalone widget page (admin/services/passwall2-presets/widget) —
// the full Overview tab always shows every row regardless of these settings
// (see overview.js's widgetVisible() helper).
//
// Wrapped in a native <details>/<summary> element so it reads as the
// expandable/collapsible list that was asked for, without inventing any
// non-native widget: <details> is plain HTML5. Stock LuCI CBI has no generic
// "collapsible section" primitive (checked form.js — TypedSection/NamedSection
// have no collapse option, only per-field "optional" which is a different,
// unrelated mechanism), so <details> wrapping a real CBI section, moved into
// place after render() without touching its DOM/instance bindings, is the
// closest native-HTML equivalent. The section's own title is left blank
// (passed as null) so the <summary> is the only visible heading — otherwise
// TypedSection would render its own duplicate "Widget" <h3> right below it.

return view.extend({
	render: function() {
		var m = new form.Map('passwall2_presets', null,
			_('Settings for PassWall2 Presets. More sections (preset/strategy ' +
			  'configuration) will be added here in a later pass.'));

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
		// "Row order per user request 2026-07-22" comment) so the checkbox
		// list reads top-to-bottom exactly like the thing it's controlling.
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
			var sectionEl = mapEl.querySelector('#cbi-passwall2_presets-widget');
			if (sectionEl && sectionEl.parentNode) {
				var details = E('details', { 'open': '' }, [
					E('summary', {}, [ _('Widget') ])
				]);
				sectionEl.parentNode.insertBefore(details, sectionEl);
				details.appendChild(sectionEl);
			}
			return mapEl;
		});
	}
});
