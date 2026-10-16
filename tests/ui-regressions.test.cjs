// Exercise real UI methods without a running Shell or recording the desktop.
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync('src/extension.js', 'utf8');
function method(name, next) {
    return source.slice(source.indexOf(`    ${name}(`), source.indexOf(`    ${next}(`)).trim().replace(/\/\/[^\n]*$/gm, '');
}
const captureSource = readFileSync('src/capture.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const notifications = [];
const ctx = vm.createContext({GLib: {get_user_cache_dir: () => '/tmp'}, Main: {notify: (...args) => notifications.push(args)}, logError: () => {}});
vm.runInContext(captureSource + '\nglobalThis.CaptureClass = Capture;', ctx);
(async () => {
    for (const outcome of ['success', 'false', 'throw']) {
        notifications.length = 0;
        const cap = Object.create(ctx.CaptureClass.prototype);
        const rec = cap._recording = {file: '/tmp/test.webm'};
        cap._onRecordingChanged = () => {};
        let resolve;
        cap._call = () => new Promise((r, j) => {resolve = () => outcome === 'throw' ? j(new Error('timeout')) : r([outcome === 'success']);});
        const pending = cap.stopRecording();
        assert.equal(cap.recording, rec);
        assert.equal(rec.stopping, true);
        await cap.stopRecording(); // duplicate stops do not issue another request
        resolve();
        await pending;
        assert.equal(cap.recording, outcome === 'success' ? null : rec);
        assert.equal(notifications[0][0], outcome === 'success' ? 'Recording saved' : 'Recording could not be finalized');
        if (outcome !== 'success') assert.equal(rec.stopping, false);
    }
    const chip = (width, alert = false) => ({box: {visible: true, has_style_class_name: () => alert, get_preferred_width: () => [width, width]}});
    const chips = {ros: chip(40), can: chip(30, true), cpu: chip(100), ip: chip(20)};
    const panel = {get_preferred_width: () => [0, 0], get_theme_node: () => ({get_length: () => 0})};
    const self = {_settings: {get_string: () => 'right'}, _chips: chips, _panel: panel, get_stage: () => true, get_parent: () => null, get_preferred_width: () => [0, 0]};
    const fit = method('_fitPanel', '_buildMenu');
    vm.runInNewContext(`const FIT_PRIORITY = ['ros','can','cpu','ip']; const obj = {${fit}}; obj._fitPanel.call(self);`, {self, Main: {panel: {width: 124, _rightBox: {get_children: () => []}, _centerBox: panel}}});
    assert.equal(chips.can.box.visible, true, 'CAN alert survives ordinary ROS chip');
    assert.equal(chips.ros.box.visible, false);
    assert.equal(chips.ip.box.visible, true, 'small chip fits after oversized chip');
    const update = method('_updatePanel', '_fitPanel');
    const state = {_state: {ros: {bags: [{eta: null, rate: 1}, {eta: 900}, {eta: 120}]}}, _ext: {capture: {}}, _chips: {rec: {box: {add_style_class_name() {}, remove_style_class_name() {}}, value: {}}}, _fitPanel() {}};
    vm.runInNewContext(`const obj = {${update}}; obj._updatePanel.call(state);`, {state, pct: () => '', fmtBytes: String, fmtDuration: s => `${s}s`, fmtCount: String});
    assert.equal(state._chips.rec.value.text, '120s', 'most urgent bag wins');
    console.log('ok    recording success/refusal/timeout, alert fitting, multiple bag ETA');
})().catch(e => {console.error(e); process.exitCode = 1;});
