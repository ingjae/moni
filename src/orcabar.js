// orcabar.js — Orca sessions on the left of the top bar.
//
// One chip per session: a status dot and the session name. Hover shows a
// card with the last request and reply, click brings that terminal forward
// in Orca. When a session finishes or starts waiting on you, a bubble drops
// from its chip; a question can be answered right there (`orca-answer`).

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as O from './orca.js';

export const cliPath = O.cliPath;

const LABEL = {waiting: 'Needs you', working: 'Working', done: 'Done', idle: 'Idle'};
// Fallback polling; Orca's hook status file triggers a read right away.
const BUSY_POLL = 3, IDLE_POLL = 10, MIN_GAP = 1500, NUDGE_DELAY = 250;
const HOVER_DELAY = 350, CARD_WIDTH = 320;

const orcaWindow = () => global.get_window_actors().map(a => a.meta_window).find(w => w.get_wm_class() === 'orca');
const plain = t => String(t ?? '').replace(/[`*#>|]/g, '').replace(/\s+/g, ' ').trim();
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

function label(text, style, wrap = false) {
    const l = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.ellipsize = 0;
    }
    return l;
}

function dot(state, unread) {
    const d = new St.Widget({style_class: `moni-orca-dot moni-orca-${state}${unread && state === 'done' ? ' moni-orca-unread' : ''}`,
        y_align: Clutter.ActorAlign.CENTER});
    if (state === 'working')
        d.ease({opacity: 200, duration: 1100, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
    return d;
}

export const OrcaBar = GObject.registerClass(
class MoniOrcaBar extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'Moni Orca', false);
        this._settings = settings;
        this._cli = O.cliPath();
        this._sessions = [];
        this._states = new Map();
        this._bubbles = new Map();
        this._cancel = new Gio.Cancellable();
        // The holder is not a button: each chip is.
        this.remove_style_class_name('panel-button');
        this.reactive = false;
        this.track_hover = false;
        this.can_focus = false;
        this._box = new St.BoxLayout({style_class: 'moni-orca'});
        this.add_child(this._box);
        this.visible = false;
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._ids = ['changed::orca-sessions', 'changed::orca-count'].map(sig => settings.connect(sig, () => this._render(true)));
        this._ids.push(settings.connect('changed::style', () => this._render(true)));
        this.menu.connect('open-state-changed', (_m, open) => open && this._hideCard());
        // Orca rewrites this file on every agent hook event (state changes
        // included), so a change means "read now" instead of up to 3 s later.
        try {
            this._monitor = Gio.File.new_for_path(O.hookDir()).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', (_m, file, other) => {
                if ([file, other].some(f => f?.get_basename() === 'last-status.json'))
                    this._pollSoon();
            });
        } catch (e) {
            this._monitor = null;
        }
        this._lastPoll = 0;
        this._poll();
    }

    // ── data ──────────────────────────────────────────────────────────────
    async _poll() {
        this._timer = 0;
        this._polling = true;
        let sessions = [];
        if (this._cli && orcaWindow()) {
            try {
                sessions = O.parseSessions(await O.run(this._cli, ['worktree', 'ps'], this._cancel));
                this._failures = 0;
            } catch (e) {
                if (this._destroyed)
                    return;
                // One failed read must not wipe the bar and its bubbles.
                this._failures = (this._failures ?? 0) + 1;
                if (this._failures < 3)
                    sessions = this._sessions;
            }
        }
        this._polling = false;
        this._lastPoll = Date.now();
        if (this._destroyed)
            return;
        const events = O.transitions(this._states, sessions);
        this._states = new Map(sessions.map(s => [s.id, s.state]));
        this._sessions = sessions;
        this._render();
        events.forEach(e => this._bubble(e.session, e.kind));
        this._dropStaleBubbles();
        const busy = sessions.some(s => s.state === 'working' || s.state === 'waiting');
        this._schedule((busy ? BUSY_POLL : IDLE_POLL) * 1000);
        if (this._soon) {
            this._soon = false;
            this._pollSoon();
        }
    }

    _schedule(ms) {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._dueAt = Date.now() + ms;
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, ms, () => {
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Something changed (an answer, an Orca hook event): read again soon,
    // but never twice within MIN_GAP and without a second polling loop.
    _pollSoon() {
        if (this._polling) {
            this._soon = true;
            return;
        }
        const ms = Math.max(NUDGE_DELAY, MIN_GAP - (Date.now() - this._lastPoll));
        if (!this._timer || this._dueAt > Date.now() + ms)
            this._schedule(ms);
    }

    // ── chips ─────────────────────────────────────────────────────────────
    _render(force = false) {
        const shown = O.pickShown(this._sessions, O.readChosen(this._settings), this._settings.get_int('orca-count'));
        const hidden = this._sessions.length - shown.length;
        const sig = JSON.stringify([shown.map(s => [s.id, s.name, s.state, s.unread]), hidden]);
        this.visible = this._sessions.length > 0;
        if (this._hover && !this._sessions.some(s => s.id === this._hover.session.id))
            this._hideCard();
        else if (this._hover)
            this._hover.session = this._sessions.find(s => s.id === this._hover.session.id);
        if (sig === this._sig && !force)
            return;
        this._sig = sig;
        this._hideCard();
        this._box[this._settings.get_string('style') === 'mono' ? 'add_style_class_name' : 'remove_style_class_name']('moni-style-mono');
        this._box.destroy_all_children();
        this._chips = new Map();
        for (const s of shown) {
            const content = new St.BoxLayout({style_class: 'moni-orca-chip-box'});
            content.add_child(dot(s.state, s.unread));
            content.add_child(label(s.name, 'moni-orca-name'));
            const chip = new St.Button({style_class: 'panel-button moni-orca-chip', child: content, can_focus: false, track_hover: true});
            chip.connect('clicked', () => this._go(this._find(s.id)));
            chip.connect('notify::hover', () => this._onHover(chip, s.id));
            this._box.add_child(chip);
            this._chips.set(s.id, chip);
        }
        this._more = null;
        if (hidden > 0) {
            this._more = new St.Button({style_class: 'panel-button moni-orca-chip moni-orca-more', can_focus: false,
                child: new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'moni-orca-more-icon'})});
            this._more.connect('clicked', () => this._openList());
            this._box.add_child(this._more);
        }
    }

    _find(id) {
        return this._sessions.find(s => s.id === id);
    }

    // Every session, most recent first.
    _openList() {
        this.menu.removeAll();
        for (const s of O.byRecent(this._sessions)) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'moni-orca-item'});
            item.add_child(dot(s.state, s.unread));
            const name = label(s.name, 'moni-orca-item-name');
            name.x_expand = true;
            item.add_child(name);
            if (s.branch && s.branch !== s.name)
                item.add_child(label(s.branch, 'moni-orca-item-branch'));
            item.add_child(label(O.ago(s.lastActivity), 'moni-orca-item-time'));
            item.connect('activate', () => this._go(s));
            this.menu.addMenuItem(item);
        }
        this.menu.sourceActor = this._more;
        this.menu.toggle();
    }

    // ── hover card ────────────────────────────────────────────────────────
    _onHover(chip, id) {
        if (this._hoverTimer)
            GLib.source_remove(this._hoverTimer);
        this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, chip.hover ? HOVER_DELAY : 150, () => {
            this._hoverTimer = 0;
            const s = this._find(id);
            if (chip.hover && s && !this._bubbles.has(id) && !this.menu.isOpen)
                this._showCard(chip, s);
            else if (!chip.hover && !this._hover?.actor.hover)
                this._hideCard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showCard(chip, s) {
        this._hideCard();
        const actor = this._card(s, null);
        actor.connect('notify::hover', () => !actor.hover && !chip.hover && this._hideCard());
        if (!this._place(actor, chip, 0))
            this._retryLayout(() => this._hover?.actor === actor && this._place(actor, chip, 0));
        this._hover = {actor, session: s};
    }

    _hideCard() {
        this._hover?.actor.destroy();
        this._hover = null;
    }

    // ── bubbles ───────────────────────────────────────────────────────────
    _bubble(s, kind) {
        if (!this._settings.get_boolean('orca-bubbles') || !this._notifications.get_boolean('show-banners'))
            return;
        this._closeBubble(s.id);
        if (this._hover?.session.id === s.id)
            this._hideCard();
        const actor = this._card(s, kind);
        this._bubbles.set(s.id, {actor, session: s, kind});
        this._layoutBubbles();
    }

    _closeBubble(id) {
        const b = this._bubbles.get(id);
        if (!b)
            return;
        if (this._typing?.card === b.actor)
            this._stopTyping();
        this._bubbles.delete(id);
        b.actor.destroy();
        this._layoutBubbles();
    }

    // Bubbles stay until dismissed or answered, or until the session moves
    // on: a waiting one stops waiting, a finished one starts working again.
    _dropStaleBubbles() {
        for (const [id, b] of [...this._bubbles]) {
            const s = this._find(id);
            if (!s || (b.kind === 'waiting' ? s.state !== 'waiting' : s.state === 'working' || s.state === 'waiting'))
                this._closeBubble(id);
        }
    }

    // Under its chip (or the list button); later bubbles stack below.
    _layoutBubbles() {
        let offset = 0, placed = true;
        for (const b of this._bubbles.values()) {
            const anchor = this._chips?.get(b.session.id) ?? this._more ?? this;
            placed = this._place(b.actor, anchor, offset) && placed;
            offset += b.actor.height + 8;
        }
        if (!placed)
            this._retryLayout(() => this._layoutBubbles());
    }

    // A chip rebuilt in this poll has no position until the next layout.
    _retryLayout(fn) {
        if (this._layoutTimer)
            return;
        this._layoutTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._layoutTimer = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _place(actor, anchor, offset) {
        if (!actor.get_parent())
            Main.layoutManager.addTopChrome(actor);
        // A NaN position (anchor not laid out yet) leaves the card
        // unallocated for good, so wait for a real one.
        const [x] = anchor.get_transformed_position();
        if (!Number.isFinite(x)) {
            actor.opacity = 0;
            return false;
        }
        const monitor = Main.layoutManager.primaryMonitor;
        // Height for the card's width, so wrapped text is not cut off.
        actor.set_size(CARD_WIDTH, actor.get_preferred_height(CARD_WIDTH)[1]);
        actor.set_position(
            Math.round(Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - CARD_WIDTH - 8))),
            Math.round(Main.panel.height + 6 + offset));
        actor.opacity = 255;
        return true;
    }

    // ── card (hover and bubble share it) ──────────────────────────────────
    _card(s, kind) {
        const card = new St.BoxLayout({style_class: 'moni-orca-card', vertical: true, reactive: true, track_hover: true});
        const head = new St.BoxLayout({style_class: 'moni-orca-card-head'});
        head.add_child(dot(s.state, s.unread));
        const title = label(s.name, 'moni-orca-card-title');
        title.x_expand = true;
        head.add_child(title);
        const time = s.state === 'working' && s.since ? s.since : s.lastActivity;
        head.add_child(label(O.ago(time), 'moni-orca-card-time'));
        card.add_child(head);
        card.add_child(label([LABEL[s.state], s.repo !== s.name ? s.repo : '', s.branch !== s.name ? s.branch : '', s.pr ? `PR #${s.pr.number ?? s.pr}` : '']
            .filter(Boolean).join(' · '), 'moni-orca-card-sub'));

        if (s.state === 'waiting' && s.question?.text) {
            card.add_child(label(clip(plain(s.question.text), 200), 'moni-orca-card-question', true));
        } else {
            if (s.prompt)
                card.add_child(label(clip(plain(s.prompt), 90), 'moni-orca-card-prompt'));
            if (s.reply)
                card.add_child(label(clip(plain(s.reply), kind ? 140 : 240), 'moni-orca-card-body', true));
        }
        if (!kind && s.comment)
            card.add_child(label(clip(plain(s.comment), 90), 'moni-orca-card-prompt'));

        if (kind) {
            const actions = new St.BoxLayout({style_class: 'moni-orca-actions', x_align: Clutter.ActorAlign.END});
            const button = (text, primary, fn) => {
                const b = new St.Button({label: text, style_class: `moni-orca-action${primary ? ' moni-orca-primary' : ''}`, can_focus: false});
                b.connect('clicked', fn);
                actions.add_child(b);
            };
            const q = s.question;
            const answerable = kind === 'waiting' && this._settings.get_boolean('orca-answer') && s.agentType === 'claude';
            if (answerable && q?.options) {
                // Choices stacked full width, numbered like the prompt they answer.
                const choices = new St.BoxLayout({style_class: 'moni-orca-choices', vertical: true});
                q.options.forEach((o, i) => {
                    const b = new St.Button({style_class: 'moni-orca-action moni-orca-choice', can_focus: false, x_expand: true,
                        child: new St.Label({text: `${i + 1}   ${clip(o, 40)}`, x_align: Clutter.ActorAlign.START, x_expand: true})});
                    b.connect('clicked', () => this._answer(s, i + 1));
                    choices.add_child(b);
                });
                card.add_child(choices);
            } else if (answerable && q?.permission)
                button('Allow', false, () => this._answer(s, 1));
            // A text field: a typed answer to a question (Claude Code's
            // "Type something" choice), or the next prompt for a finished one.
            if (this._settings.get_boolean('orca-answer') && (kind === 'done' || (answerable && !q?.permission))) {
                const field = new St.Entry({style_class: 'moni-orca-entry', can_focus: true, x_expand: true,
                    hint_text: kind === 'done' ? 'Next prompt…' : 'Type an answer…'});
                field.clutter_text.connect('button-press-event', () => {
                    this._startTyping(card, field);
                    return Clutter.EVENT_PROPAGATE;
                });
                field.clutter_text.connect('key-press-event', (_a, event) => {
                    if (event.get_key_symbol() !== Clutter.KEY_Escape)
                        return Clutter.EVENT_PROPAGATE;
                    this._stopTyping();
                    return Clutter.EVENT_STOP;
                });
                field.clutter_text.connect('activate', () => {
                    const text = field.text.trim();
                    if (text)
                        this._reply(s, text, kind === 'waiting', q?.options ? q.options.length + 1 : 0);
                });
                // While typing, a click outside the bubble ends it.
                card.connect('captured-event', (_a, event) => {
                    if (this._typing?.card === card && event.type() === Clutter.EventType.BUTTON_PRESS) {
                        const [x, y] = event.get_coords();
                        const [cx, cy] = card.get_transformed_position();
                        if (x < cx || y < cy || x > cx + card.width || y > cy + card.height)
                            this._stopTyping();
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                card.add_child(field);
            }
            button(kind === 'waiting' ? 'Open' : 'Show', true, () => this._go(s));
            if (kind === 'done')
                button('Dismiss', false, () => this._closeBubble(s.id));
            card.add_child(actions);
        } else {
            card.connect('button-release-event', () => {
                this._go(s);
                return Clutter.EVENT_STOP;
            });
        }
        return card;
    }

    // ── actions ───────────────────────────────────────────────────────────
    async _terminal(s) {
        const r = await O.run(this._cli, ['terminal', 'list', '--worktree', `id:${s.id}`], this._cancel);
        return O.pickTerminal(r?.terminals ?? [], s.paneKey);
    }

    // That session's terminal tab, then the Orca window to the front.
    async _go(s) {
        if (!s)
            return;
        this._hideCard();
        this._closeBubble(s.id);
        try {
            const t = await this._terminal(s);
            if (t)
                await O.run(this._cli, ['terminal', 'switch', '--terminal', t.handle], this._cancel);
        } catch (e) {
            console.warn(`moni: orca: ${e.message}`);
        }
        if (!this._destroyed)
            orcaWindow()?.activate(global.get_current_time());
    }

    // Claude Code picks an option by its number key.
    // The top bar gets no keys on X11 without a grab, so typing in a
    // bubble holds one until Enter, Escape or a click elsewhere.
    _startTyping(card, field) {
        if (this._typing)
            return;
        const grab = Main.pushModal(card, {actionMode: Shell.ActionMode.POPUP});
        if (!grab)
            return;
        this._typing = {card, grab};
        global.stage.set_key_focus(field.clutter_text);
    }

    _stopTyping() {
        if (!this._typing)
            return;
        const {grab} = this._typing;
        this._typing = null;
        global.stage.set_key_focus(null);
        Main.popModal(grab);
    }

    // A finished session gets a new prompt. A question gets its "Type
    // something" choice, then the text and Enter as plain keys: Orca refuses
    // a prompt (text + Enter in one send) while the agent waits.
    async _reply(s, text, waiting, choice) {
        this._closeBubble(s.id);
        const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        try {
            const t = await this._terminal(s);
            const send = args => O.run(this._cli, ['terminal', 'send', '--terminal', t.handle, ...args], this._cancel);
            if (t && !waiting) {
                await send(['--text', text, '--enter']);
            } else if (t) {
                if (choice) {
                    await send(['--text', String(choice)]);
                    await pause(300);
                }
                await send(['--text', text]);
                await pause(150);
                await send(['--enter']);
            }
        } catch (e) {
            console.warn(`moni: orca: ${e.message}`);
        }
        if (!this._destroyed)
            this._pollSoon();
    }

    async _answer(s, n) {
        this._closeBubble(s.id);
        try {
            const t = await this._terminal(s);
            if (t)
                await O.run(this._cli, ['terminal', 'send', '--terminal', t.handle, '--text', String(n)], this._cancel);
        } catch (e) {
            console.warn(`moni: orca: ${e.message}`);
        }
        if (!this._destroyed)
            this._pollSoon();
    }

    destroy() {
        this._destroyed = true;
        this._stopTyping();
        this._cancel.cancel();
        this._monitor?.cancel();
        for (const t of [this._timer, this._hoverTimer, this._layoutTimer])
            if (t)
                GLib.source_remove(t);
        this._hideCard();
        for (const id of [...this._bubbles.keys()])
            this._closeBubble(id);
        this._ids.forEach(id => this._settings.disconnect(id));
        super.destroy();
    }
});

// Right after Activities, so the left of the bar is Orca's.
export function addToPanel(uuid, bar) {
    Main.panel.addToStatusArea(`${uuid}-orca`, bar, 1, 'left');
}
