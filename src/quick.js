// quick.js — one-click copy buttons in the top bar.
//
// Each item in the `quick-items` setting (a JSON list of {icon, text}) is a
// small panel button showing its icon — a short label or an emoji. A click
// puts the text on the clipboard; the text itself is never shown.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// Valid items only; a broken setting shows nothing instead of throwing.
export function readItems(settings) {
    try {
        const items = JSON.parse(settings.get_string('quick-items'));
        return Array.isArray(items)
            ? items.filter(i => typeof i?.icon === 'string' && i.icon.trim() && typeof i.text === 'string' && i.text)
            : [];
    } catch (e) {
        return [];
    }
}

export const QuickIndicator = GObject.registerClass(
class MoniQuickIndicator extends PanelMenu.Button {
    _init(settings, onCopy) {
        super._init(0.5, 'Moni Quick Copy', true);
        this._settings = settings;
        this._onCopy = onCopy;
        // The holder is not a button itself: each item is a full panel
        // button, so the whole highlighted area copies.
        this.remove_style_class_name('panel-button');
        this.reactive = false;
        this.track_hover = false;
        this.can_focus = false;
        this._box = new St.BoxLayout({style_class: 'moni-quick'});
        this.add_child(this._box);
        this._id = settings.connect('changed::quick-items', () => this._rebuild());
        this._rebuild();
    }

    _rebuild() {
        this._box.destroy_all_children();
        for (const item of readItems(this._settings)) {
            const label = new St.Label({text: item.icon.trim(), y_align: Clutter.ActorAlign.CENTER});
            const button = new St.Button({style_class: 'panel-button moni-quick-button', child: label, can_focus: true, track_hover: true});
            button.connect('clicked', () => this._copy(item.text, button, label));
            this._box.add_child(button);
        }
    }

    // Copied: the button shows ✓ for a moment.
    _copy(text, button, label) {
        this._onCopy?.(text);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        const icon = label.text;
        label.text = '✓';
        button.add_style_class_name('moni-quick-done');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            if (!this._destroyed) {
                label.text = icon;
                button.remove_style_class_name('moni-quick-done');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        this._settings.disconnect(this._id);
        super.destroy();
    }
});

export function addToPanel(uuid, indicator) {
    Main.panel.addToStatusArea(`${uuid}-quick`, indicator, 0, 'right');
}
