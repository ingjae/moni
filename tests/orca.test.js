// Orca session parsing:  gjs -m tests/orca.test.js
import * as O from '../src/orca.js';

let failed = 0;
function check(name, cond, detail = '') {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!cond)
        failed++;
}

const agent = (state, extra = {}) => ({state, agentType: 'claude', paneKey: 'tab1:leaf1', updatedAt: 1000, stateStartedAt: 900, ...extra});
const ps = {
    worktrees: [
        {worktreeId: 'r1::/w/moni', repo: 'moni', displayName: 'main', isMainWorktree: true, branch: 'refs/heads/main',
            lastActivityAt: 5000, agents: [agent('done'), agent('working', {prompt: '\n  fix it\nmore', updatedAt: 6000})], unread: false, liveTerminalCount: 2},
        {worktreeId: 'r2::/w/sched-ui', repo: 'w_schedule', displayName: 'issue85-ui', isMainWorktree: false, branch: 'refs/heads/issue85',
            lastActivityAt: 9000, agents: [], unread: true},
        {worktreeId: 'r3::/w/hub', repo: 'w_hub', displayName: 'main', isMainWorktree: true, branch: 'main', lastActivityAt: 7000,
            agents: [agent('waiting', {toolName: 'AskUserQuestion', toolInput: null,
                programStatus: {state: 'blocked', kind: 'question', message: 'answer: Ship it (today)? (Yes · No (wait 2 (two)))'}})]},
        {worktreeId: 'r4::/w/old', repo: 'old', isArchived: true, agents: []},
        {worktreeId: 'r5::/w/x', repo: 'x', displayName: 'main', isMainWorktree: true, lastActivityAt: 1,
            agents: [agent('something-new')]},
    ],
};
const sessions = O.parseSessions(ps);
const byId = Object.fromEntries(sessions.map(s => [s.id, s]));

check('archived dropped', sessions.length === 4 && !byId['r4::/w/old']);
check('main worktree named by repo', byId['r1::/w/moni'].name === 'moni');
check('extra worktree named by display name', byId['r2::/w/sched-ui'].name === 'issue85-ui');
check('branch without refs/heads', byId['r1::/w/moni'].branch === 'main');
check('most urgent agent wins', byId['r1::/w/moni'].state === 'working' && byId['r1::/w/moni'].prompt === 'fix it');
check('last activity includes agents', byId['r1::/w/moni'].lastActivity === 6000);
check('no agents = idle', byId['r2::/w/sched-ui'].state === 'idle' && byId['r2::/w/sched-ui'].unread);
check('unknown state treated as waiting', byId['r5::/w/x'].state === 'waiting');
const q = byId['r3::/w/hub'].question;
check('question options, nested parens', q.text === 'Ship it (today)?' && q.options.join('|') === 'Yes|No (wait 2 (two))', JSON.stringify(q));
const qa = m => O.readQuestion(agent('waiting', {programStatus: {kind: 'question', message: m}}));
check('question without options', qa('answer: Free text?').text === 'Free text?' && !qa('answer: Free text?').options);
check('one parenthesis is not options', !qa('answer: Use (the) default?').options && !qa('answer: Pick (a)').options);
check('options capped at 4', qa('answer: Q (a · b · c · d · e)').options.length === 4);
const perm = O.readQuestion(agent('waiting', {toolName: 'Bash', programStatus: {kind: 'permission', message: 'approve: Bash rm -rf build'}}));
check('permission prompt', perm.permission && perm.text === 'Bash rm -rf build');
check('permission without message', O.readQuestion(agent('waiting', {toolName: 'Edit'})).text === 'Allow Edit?');
check('not waiting = no question', O.readQuestion(agent('working')) === null);
check('garbage input', O.parseSessions(null).length === 0 && O.parseSessions({worktrees: [null, {}]}).length === 0);

check('pick: most recent first', O.pickShown(sessions, [], 2).map(s => s.name).join() === 'issue85-ui,w_hub');
check('pick: chosen order, missing skipped', O.pickShown(sessions, ['r3::/w/hub', 'gone', 'r1::/w/moni'], 2).map(s => s.name).join() === 'w_hub,moni');

const prev = new Map([['r1::/w/moni', 'waiting'], ['r3::/w/hub', 'working'], ['r2::/w/sched-ui', 'idle']]);
const ev = O.transitions(prev, [
    {id: 'r1::/w/moni', state: 'done'}, {id: 'r3::/w/hub', state: 'waiting'}, {id: 'r2::/w/sched-ui', state: 'done'}, {id: 'new', state: 'waiting'},
]);
check('transitions: waiting and working→done only', ev.map(e => `${e.session.id}:${e.kind}`).join() === 'r3::/w/hub:waiting');
check('transitions: working→done', O.transitions(new Map([['a', 'working']]), [{id: 'a', state: 'done'}])[0]?.kind === 'done');

const terms = [{tabId: 't0', leafId: 'l0', handle: 'h0'}, {tabId: 'tab1', leafId: 'leaf1', handle: 'h1'}];
check('terminal by pane', O.pickTerminal(terms, 'tab1:leaf1').handle === 'h1');
check('terminal fallback', O.pickTerminal(terms, null).handle === 'h0' && O.pickTerminal([], 'x') === null);

check('ago', O.ago(0, 30e3) === 'just now' && O.ago(0, 5 * 60e3) === '5 min' && O.ago(0, 3 * 3600e3) === '3 h' && O.ago(0, 2 * 86400e3) === '2 d');

if (failed)
    throw new Error(`${failed} failed`);
