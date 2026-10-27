// quick.js — one-click copy buttons in the top bar.
//
// Each item in the `quick-items` setting (a JSON list of {icon, text}) is a
// small panel button showing its icon — a short label or an emoji. A click
// copies the text, pastes it at the cursor, or both (`quick-action`); the
// text itself is never shown.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Clip from './clipboard.js';

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
            // No key focus on click: the paste must reach the window that has it.
            const button = new St.Button({style_class: 'panel-button moni-quick-button', child: label, can_focus: false, track_hover: true});
            button.connect('clicked', () => this._use(item.text, button, label));
            this._box.add_child(button);
        }
    }

    // copy: clipboard only · paste: type it at the cursor and put the old
    // clipboard text back · both: paste and keep it on the clipboard.
    _use(text, button, label) {
        const clipboard = St.Clipboard.get_default();
        const action = this._settings.get_string('quick-action');
        const put = t => {
            this._onCopy?.(t);
            clipboard.set_text(St.ClipboardType.CLIPBOARD, t);
        };
        if (action === 'copy') {
            put(text);
        } else {
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, previous) => {
                if (this._destroyed)
                    return;
                put(text);
                this._later(150, () => {
                    this._vk ??= Clutter.get_default_backend().get_default_seat()
                        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                    Clip.typePaste(this._vk);
                    if (action === 'paste' && previous)
                        this._later(400, () => put(previous));
                });
            });
        }
        this._flash(button, label);
    }

    _later(ms, fn) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (!this._destroyed)
                fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The button shows ✓ for a moment.
    _flash(button, label) {
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
        this._vk = null;
        this._settings.disconnect(this._id);
        super.destroy();
    }
});

export function addToPanel(uuid, indicator) {
    Main.panel.addToStatusArea(`${uuid}-quick`, indicator, 0, 'right');
}
