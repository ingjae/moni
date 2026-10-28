// orca.js — Orca agent sessions, read through Orca's own CLI.
//
// Only GLib/Gio, so it runs (and is tested) under plain `gjs`. The panel
// side is in orcabar.js. One `orca-ide worktree ps --json` call returns every
// workspace with its agents; there is no push API, so it is polled.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Agent states Orca reports, most urgent first. `waiting` = a permission
// prompt or a question for you.
export const STATES = ['waiting', 'working', 'done', 'idle'];

// Never the bare `orca`: on Linux that is the GNOME screen reader.
export function cliPath() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'orca-ide']);
    return GLib.find_program_in_path('orca-ide') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

// Orca rewrites last-status.json here on every agent hook event.
export function hookDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'orca', 'agent-hooks']);
}

// argv → parsed `result`; rejects on a failed run or `ok: false`.
export function run(cli, args, cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new([cli, ...args, '--json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                const data = out ? JSON.parse(out) : null;
                if (!p.get_successful() || !data?.ok)
                    throw new Error(data?.error?.message ?? (err.trim() || `orca ${args[0]} failed`));
                resolve(data.result);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// The trailing "(a · b)" of a question message, nested parens included.
function splitOptions(message) {
    if (!message.endsWith(')'))
        return [message, null];
    let depth = 0;
    for (let i = message.length - 1; i >= 0; i--) {
        depth += message[i] === ')' ? 1 : message[i] === '(' ? -1 : 0;
        if (depth === 0) {
            const options = message.slice(i + 1, -1).split(' · ').map(o => o.trim()).filter(Boolean);
            return options.length > 1 ? [message.slice(0, i).trim(), options] : [message, null];
        }
    }
    return [message, null];
}

// What an agent waits on. Orca puts it in programStatus, e.g. kind
// "question" with "answer: Ship it? (Yes · No)" → {text, options}; anything
// else (a permission prompt) → {text, permission: true}.
export function readQuestion(agent) {
    if (agent.state !== 'waiting')
        return null;
    const status = agent.programStatus ?? {};
    const message = String(status.message ?? '').replace(/^\w+: /, '').trim();
    if (status.kind === 'question' || agent.toolName === 'AskUserQuestion') {
        const [text, options] = splitOptions(message);
        return options ? {text, options: options.slice(0, 4)} : {text};
    }
    return {text: message || (agent.toolName ? `Allow ${agent.toolName}?` : ''), permission: true};
}

const firstLine = t => String(t ?? '').trim().split('\n').find(l => l.trim())?.trim() ?? '';

// `worktree ps` result → sessions the panel can draw. A session's state is its
// most urgent agent's; no agent = idle.
export function parseSessions(result) {
    const rows = Array.isArray(result?.worktrees) ? result.worktrees : [];
    return rows.filter(w => w && !w.isArchived && typeof w.worktreeId === 'string').map(w => {
        const agents = (w.agents ?? []).filter(a => a && typeof a.state === 'string');
        const rank = a => (STATES.includes(a.state) ? STATES.indexOf(a.state) : 0);
        const lead = [...agents].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
        const state = lead ? (STATES.includes(lead.state) ? lead.state : 'waiting') : 'idle';
        const branch = String(w.branch ?? '').replace(/^refs\/heads\//, '');
        return {
            id: w.worktreeId,
            repo: String(w.repo ?? ''),
            // A repo's main checkout is called by the repo; extra worktrees by their own name.
            name: (w.isMainWorktree ? w.repo : w.displayName) || w.repo || branch,
            branch,
            path: String(w.path ?? ''),
            state,
            since: lead?.stateStartedAt ?? null,
            unread: !!w.unread,
            lastActivity: Math.max(w.lastActivityAt ?? 0, w.lastOutputAt ?? 0, ...agents.map(a => a.updatedAt ?? 0)),
            agentType: lead?.agentType ?? null,
            prompt: firstLine(lead?.prompt),
            reply: String(lead?.lastAssistantMessage ?? '').trim(),
            question: lead ? readQuestion(lead) : null,
            paneKey: lead?.paneKey ?? null,
            pr: w.linkedPR ?? null,
            comment: String(w.comment ?? ''),
            terminals: w.liveTerminalCount ?? 0,
        };
    });
}

// Chosen ids in their order (missing ones skipped); none chosen → the
// `count` most recently active.
export function pickShown(sessions, chosen, count) {
    if (chosen.length) {
        const byId = new Map(sessions.map(s => [s.id, s]));
        return chosen.map(id => byId.get(id)).filter(Boolean);
    }
    return byRecent(sessions).slice(0, count);
}

export const byRecent = sessions => [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);

// What changed since the last poll worth a bubble: finished, or now waiting
// on you. Sessions seen for the first time never fire.
export function transitions(previous, sessions) {
    const out = [];
    for (const s of sessions) {
        const was = previous.get(s.id);
        if (was && was !== s.state && (s.state === 'waiting' || (s.state === 'done' && was === 'working')))
            out.push({session: s, kind: s.state});
    }
    return out;
}

// The terminal to bring forward: the lead agent's pane, else the first one.
export function pickTerminal(terminals, paneKey) {
    const [tab, leaf] = String(paneKey ?? '').split(':');
    return terminals.find(t => t.tabId === tab && t.leafId === leaf) ?? terminals[0] ?? null;
}

export function ago(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60)
        return 'just now';
    if (s < 3600)
        return `${Math.floor(s / 60)} min`;
    if (s < 86400)
        return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d`;
}

export function readChosen(settings) {
    try {
        const ids = JSON.parse(settings.get_string('orca-sessions'));
        return Array.isArray(ids) ? ids.filter(i => typeof i === 'string') : [];
    } catch (e) {
        return [];
    }
}
