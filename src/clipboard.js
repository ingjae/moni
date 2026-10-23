// clipboard.js — clipboard history + favorites, Win+V / Maccy style.
//
// Watches the clipboard owner (Meta.Selection), keeps recent text in memory
// and starred items in GSettings. Picking an item puts it back on the
// clipboard and types the paste shortcut into the window that had focus.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MAX_TEXT = 100 * 1024;
const MAX_SHOWN = 40;
// Password managers mark secrets with this mimetype (KeePassXC, Bitwarden, …).
const SECRET_HINT = 'x-kde-passwordManagerHint';
// Terminals paste with Ctrl+Shift+V.
const TERMINALS = /terminal|kitty|alacritty|wezterm|tilix|terminator|konsole|foot|ghostty|xterm|guake|blackbox|ptyxis/i;

function preview(text) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

export const ClipboardIndicator = GObject.registerClass(
class MoniClipboardIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.5, 'Moni Clipboard', false);
        this._settings = settings;
        this._history = [];
        this._clipboard = St.Clipboard.get_default();
        this.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'}));

        this._buildMenu();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._readClipboard();
        });
        this._favId = this._settings.connect('changed::clipboard-favorites', () => this._rebuild());
        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._entry.text = '';
            this._rebuild();
            this._focusSearch();
        });
        // Typing anywhere in the list goes to the search box.
        this.menu.actor.connect('key-press-event', (_a, event) => {
            const ch = event.get_key_unicode();
            if (global.stage.get_key_focus() === this._entry.clutter_text || !ch || ch < ' ' ||
                (event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK)))
                return Clutter.EVENT_PROPAGATE;
            this._entry.text += ch;
            this._focusSearch();
            return Clutter.EVENT_STOP;
        });
        this._readClipboard();
    }

    _focusSearch() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.menu.isOpen) {
                global.stage.set_key_focus(this._entry.clutter_text);
                this._entry.clutter_text.set_cursor_position(-1);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    get _favorites() {
        return this._settings.get_strv('clipboard-favorites');
    }

    _readClipboard() {
        if (this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD).includes(SECRET_HINT))
            return;
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (!text || !text.trim() || text.length > MAX_TEXT || this._destroyed)
                return;
            this._history = [text, ...this._history.filter(t => t !== text)]
                .slice(0, this._settings.get_int('clipboard-size'));
            if (this.menu.isOpen)
                this._rebuild();
        });
    }

    _buildMenu() {
        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._entry = new St.Entry({
            hint_text: 'Type to search · Enter to paste', can_focus: true,
            x_expand: true, style_class: 'moni-clip-search',
        });
        this._entry.clutter_text.connect('text-changed', () => this._rebuild());
        this._entry.clutter_text.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            const first = this._items.find(i => i.visible);
            if ((key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) && first) {
                first.activate(event);
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Down && first) {
                first.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        searchItem.add_child(this._entry);
        this.menu.addMenuItem(searchItem);

        this._list = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({style_class: 'moni-clip-scroll', overlay_scrollbars: true});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_child(this._list.actor);
        const holder = new PopupMenu.PopupMenuSection();
        holder.actor.add_child(scroll);
        this.menu.addMenuItem(holder);
        holder.addMenuItem(this._list);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Clear history (keeps ★)', () => {
            this._history = [];
            this._rebuild();
        });
        this._items = [];
    }

    _rebuild() {
        this._list.removeAll();
        this._items = [];
        const q = this._entry.text.trim().toLowerCase();
        const favs = this._favorites;
        const match = t => !q || t.toLowerCase().includes(q);
        const shownFavs = favs.filter(match);
        const shownHist = this._history.filter(t => !favs.includes(t) && match(t)).slice(0, MAX_SHOWN);

        const header = text => {
            const h = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
            h.label.add_style_class_name('moni-clip-header');
            this._list.addMenuItem(h);
        };
        if (shownFavs.length) {
            header('★ Favorites');
            shownFavs.forEach(t => this._addItem(t, true));
        }
        header(shownHist.length || !shownFavs.length ? 'Recent' : 'Recent — nothing matches');
        shownHist.forEach(t => this._addItem(t, false));
        if (!shownHist.length && !shownFavs.length) {
            const empty = new PopupMenu.PopupMenuItem(q ? 'No match' : 'Copy something — it shows up here',
                {reactive: false, can_focus: false});
            empty.label.opacity = 150;
            this._list.addMenuItem(empty);
        }
    }

    _addItem(text, fav) {
        const item = new PopupMenu.PopupMenuItem(preview(text));
        item.label.x_expand = true;
        item.label.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        const star = new St.Button({
            style_class: 'moni-clip-star', can_focus: true,
            child: new St.Icon({icon_name: fav ? 'starred-symbolic' : 'non-starred-symbolic', icon_size: 16}),
        });
        star.connect('clicked', () => {
            // Rebuilding destroys this item, so wait until the click is over.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                const favs = this._favorites.filter(t => t !== text);
                this._settings.set_strv('clipboard-favorites', fav ? favs : [text, ...favs]);
                this._focusSearch();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        item.add_child(star);
        item.connect('activate', () => this._paste(text));
        this._list.addMenuItem(item);
        this._items.push(item);
    }

    // Put the text back on the clipboard, then type the paste shortcut into
    // whatever window gets focus back once the menu has closed.
    _paste(text) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        if (!this._settings.get_boolean('clipboard-paste'))
            return;
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._pasteId = 0;
            const win = global.display.focus_window;
            const terminal = TERMINALS.test(win?.get_wm_class() ?? '');
            this._vk ??= Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const keys = terminal
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];
            const t = GLib.get_monotonic_time();
            keys.forEach(k => this._vk.notify_keyval(t, k, Clutter.KeyState.PRESSED));
            [...keys].reverse().forEach(k => this._vk.notify_keyval(t, k, Clutter.KeyState.RELEASED));
            return GLib.SOURCE_REMOVE;
        });
    }

    toggle() {
        this.menu.toggle();
    }

    destroy() {
        this._destroyed = true;
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._selection.disconnect(this._ownerId);
        this._settings.disconnect(this._favId);
        this._vk = null;
        super.destroy();
    }
});

export function addToPanel(uuid, indicator) {
    Main.panel.addToStatusArea(`${uuid}-clipboard`, indicator, 0, 'right');
}
