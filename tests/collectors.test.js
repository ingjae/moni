// Smoke test for collectors.js under plain gjs:  gjs -m tests/collectors.test.js
import GLib from 'gi://GLib';
import * as C from '../src/collectors.js';

let failed = 0;
function check(name, cond, detail = '') {
    print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!cond)
        failed++;
}

// Pure parsers
const addrs = C.parseAddresses(
    '1: lo    inet 127.0.0.1/8 scope host lo\\\n' +
    '2: eno1    inet 192.168.33.101/24 brd 192.168.33.255 scope global dynamic eno1\\\n' +
    '3: eno1    inet6 fe80::1/64 scope link \\\n');
check('parseAddresses', addrs.length === 1 && addrs[0].iface === 'eno1' && addrs[0].address === '192.168.33.101');

const nv = C.parseNvidia('37, 1024, 4096, 55, 12.34, NVIDIA GeForce RTX 3050 Ti Laptop GPU\n');
check('parseNvidia', nv.util === 37 && nv.memTotal === 4096 * 1048576 && nv.name.startsWith('NVIDIA'));
check('parseNvidia [N/A] power', C.parseNvidia('5, 1, 2, 40, [N/A], X').power === null);

const d = C.describeRosProcess(
    ['/usr/bin/python3', '/opt/ros/jazzy/bin/ros2', 'bag', 'record', '-a', '-o', 'run1'], {ROS_DISTRO: 'jazzy'});
check('describe: rosbag', d.role === 'bag' && d.domain === '0' && d.distro === 'jazzy');
const n = C.describeRosProcess(
    ['/home/u/ws/install/nav2_controller/lib/nav2_controller/controller_server', '--ros-args', '-r', '__node:=controller_server'],
    {ROS_DOMAIN_ID: '42'});
check('describe: launched node', n.role === 'node' && n.name === 'controller_server' && n.pkg === 'nav2_controller' && n.domain === '42');
const py = C.describeRosProcess(['/usr/bin/python3', '-u', '/opt/ros/humble/lib/demo_nodes_py/talker'], {});
check('describe: python node', py.name === 'talker' && py.pkg === 'demo_nodes_py');
check('describe: daemon', C.describeRosProcess(['/usr/bin/python3', '/opt/ros/humble/bin/_ros2_daemon'], {}).role === 'daemon');

// PM2 log parsing (formats taken from PM2 7.1.1)
const local = sec => { const d = new Date(Date.now() - sec * 1000); const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const pm2log = [
    `${local(30)}: PM2 log: App [api:0] starting in -fork mode-`,
    `${local(29)}: PM2 log: App [bridge:1] starting in -fork mode-`,
    `${local(20)}: PM2 log: Stopping app:bridge id:1`,
    `${local(20)}: PM2 log: App [bridge:1] exited with code [0] via signal [SIGINT]`,
    `${local(10)}: PM2 log: App [tele:2] starting in -fork mode-`,
    ...[9, 8, 7].flatMap(t => [`${local(t)}: PM2 log: App [tele:2] exited with code [1] via signal [SIGINT]`,
        `${local(t)}: PM2 log: App [tele:2] starting in -fork mode-`]),
    `${local(6)}: PM2 log: Script /x/tele.js had too many unstable restarts (3). Stopped. "errored"`,
    '2020-01-01T10:00:00: PM2 log: App [old:3] starting in -fork mode-',
    ...[1, 2, 3].map(i => `2020-01-01T10:00:0${i}: PM2 log: App [old:3] exited with code [1] via signal [SIGINT]`),
].join('\n');
const pm = C.parsePm2Log(pm2log, new Map());
check('pm2: stop is not a crash', pm.get('bridge:1').state === 'stopped' && pm.get('bridge:1').crashes.length === 0);
check('pm2: errored + restarts + crash loop', pm.get('tele:2').state === 'errored' && pm.get('tele:2').restarts === 3 && pm.get('tele:2').crashes.length === 3);
check('pm2: old crashes are not a loop', pm.get('old:3').crashes.length === 0);
const manual = C.parsePm2Log(`${pm2log}\n${local(5)}: PM2 log: App [tele:2] starting in -fork mode-`, new Map()).get('tele:2');
check('pm2: manual restart after errored is not counted', manual.restarts === 3 && manual.state === 'online');
check('pm2: no daemon -> hidden', new C.Pm2Monitor('/nonexistent').scan() === null);

// Docker Engine list (fields from Docker 29, API 1.52)
const dl = C.parseDockerList(JSON.stringify([
    {Id: 'a'.repeat(64), Names: ['/api'], Image: 'nginx', State: 'running', Status: 'Up 3 days (unhealthy)'},
    {Id: 'b'.repeat(64), Names: ['/job'], Image: 'x', State: 'exited', Status: 'Exited (137) 2 hours ago'},
]));
check('docker: name, health', dl[0].name === 'api' && dl[0].health === 'unhealthy' && dl[0].state === 'running');
check('docker: exit code', dl[1].exitCode === 137 && dl[1].health === null);
check('docker: compact status', C.compactDockerStatus('Up 36 seconds (unhealthy)') === 'Up 36s unhealthy' &&
    C.compactDockerStatus('Exited (100) 6 months ago') === 'Exited (100) 6mo' &&
    C.compactDockerStatus('Up About a minute (health: starting)') === 'Up 1m starting');
check('docker: no socket -> hidden', new C.DockerMonitor(['/nonexistent.sock']).socket === null);

// Live readers on this machine
const cpu = new C.CpuSampler();
cpu.sample();
GLib.usleep(200000);
const c = cpu.sample();
check('cpu', c && c.total >= 0 && c.total <= 100 && c.cores.length > 0, `${c?.total.toFixed(1)}% x${c?.cores.length}`);
const m = C.readMemory();
check('memory', m && m.used > 0 && m.used < m.total, `${m?.percent.toFixed(1)}%`);
const net = new C.NetSampler();
net.sample();
check('net', typeof net.sample().rx === 'number');
check('fs /', C.fsUsage('/')?.size > 0, `${C.fsUsage('/')?.percent.toFixed(1)}%`);
check('mounts', C.listMounts().some(x => x.mount === '/'));
check('diskio', typeof new C.DiskIoSampler().sample().read === 'number');
print(`info  cpuTemp=${C.readCpuTemp()} battery=${JSON.stringify(C.readBattery())} wifi=${JSON.stringify(C.readWifi())} route=${C.defaultRouteIface()}`);
print(`info  gpu=${new C.GpuSampler().kind} can=${JSON.stringify(new C.CanMonitor().sample())}`);
print(`info  devices=${JSON.stringify(C.listSensorDevices())}`);

// ROS radar + cost of a scan
const radar = new C.RosRadar();
let t0 = GLib.get_monotonic_time();
radar.scan();
const cold = (GLib.get_monotonic_time() - t0) / 1000;
t0 = GLib.get_monotonic_time();
const r = radar.scan();
const warm = (GLib.get_monotonic_time() - t0) / 1000;
check('ros radar', Array.isArray(r.nodes), `${r.nodes.length} procs, domains=${r.domains} cold=${cold.toFixed(1)}ms warm=${warm.toFixed(1)}ms`);

// Cost of one regular tick (everything except ROS/IP/GPU subprocess)
const io = new C.DiskIoSampler(), can = new C.CanMonitor();
t0 = GLib.get_monotonic_time();
for (let i = 0; i < 100; i++) {
    cpu.sample(); C.readMemory(); net.sample(); io.sample(); can.sample(); C.readCpuTemp();
}
check('tick cost', true, `${((GLib.get_monotonic_time() - t0) / 100 / 1000).toFixed(2)} ms/tick`);

const loop = new GLib.MainLoop(null, false);
let pending = 3;
const done = () => --pending || loop.quit();
C.queryAddresses(null, a => { check('ip addr (async)', Array.isArray(a), a?.map(x => `${x.iface}=${x.address}`).join(' ')); done(); });
new C.GpuSampler().poll(null, g => { check('gpu poll (async)', g !== undefined, JSON.stringify(g)); done(); });
const dk = new C.DockerMonitor();
if (dk.socket) {
    const t1 = GLib.get_monotonic_time();
    dk.poll(null, l => {
        check('docker poll (async)', l === null || Array.isArray(l),
            `${((GLib.get_monotonic_time() - t1) / 1000).toFixed(1)} ms · ${l?.map(x => `${x.name}=${x.state}`).join(' ') ?? 'no access'}`);
        done();
    });
} else {
    done();
}
loop.run();

print(failed ? `\n${failed} FAILED` : '\nall passed');
if (failed)
    imports.system.exit(1);
