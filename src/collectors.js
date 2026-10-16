// collectors.js — every number Moni shows comes from here.
//
// Only GLib/Gio: no Shell imports, so this file runs (and is tested) under
// plain `gjs`. Everything is read from /proc and /sys; the only subprocesses
// are `ip` (every 10 s) and `nvidia-smi` (only while the dGPU is awake).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const decoder = new TextDecoder();
const CLK_TCK = 100;
const PAGE = 4096;
const ARPHRD_CAN = 280;

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch (e) {
        return null;
    }
}

function readInt(path, fallback = null) {
    const t = readText(path);
    const n = t === null ? NaN : parseInt(t, 10);
    return Number.isNaN(n) ? fallback : n;
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function listDir(path) {
    const out = [];
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch (e) {
        return out;
    }
    let name;
    while ((name = dir.read_name()) !== null)
        out.push(name);
    dir.close();
    return out;
}

function readLink(path) {
    try {
        return GLib.file_read_link(path);
    } catch (e) {
        return null;
    }
}

function basename(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}

// Turns monotonically increasing counters into per-second rates.
class Rate {
    constructor() {
        this._prev = null;
        this._t = 0;
    }

    update(values) {
        const now = GLib.get_monotonic_time() / 1e6;
        const prev = this._prev, dt = now - this._t;
        this._prev = values;
        this._t = now;
        if (!prev || dt <= 0)
            return values.map(() => 0);
        return values.map((v, i) => Math.max(0, (v - prev[i]) / dt));
    }
}

// ── CPU / memory / system ───────────────────────────────────────────────

export class CpuSampler {
    constructor() {
        this._prev = null;
    }

    sample() {
        const text = readText('/proc/stat');
        if (!text)
            return null;
        const cur = [];
        for (const line of text.split('\n')) {
            if (!line.startsWith('cpu'))
                break;
            const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
            cur.push([f[3] + f[4], f.reduce((a, b) => a + b, 0)]);
        }
        const prev = this._prev;
        this._prev = cur;
        if (!prev || prev.length !== cur.length)
            return null;
        const pct = cur.map(([idle, total], i) => {
            const dt = total - prev[i][1];
            return dt > 0 ? 100 * (1 - (idle - prev[i][0]) / dt) : 0;
        });
        return {total: pct[0], cores: pct.slice(1)};
    }
}

export function readMemory() {
    const text = readText('/proc/meminfo');
    if (!text)
        return null;
    const m = {};
    for (const line of text.split('\n')) {
        const [k, v] = line.split(':');
        if (v)
            m[k] = parseInt(v, 10) * 1024;
    }
    const total = m.MemTotal, avail = m.MemAvailable ?? m.MemFree;
    return {
        total,
        used: total - avail,
        percent: 100 * (total - avail) / total,
        swapTotal: m.SwapTotal ?? 0,
        swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
    };
}

export function readSystem() {
    const load = (readText('/proc/loadavg') ?? '').split(' ').slice(0, 3);
    return {
        host: GLib.get_host_name(),
        uptime: parseFloat(readText('/proc/uptime') ?? '0'),
        load,
        kernel: (readText('/proc/sys/kernel/osrelease') ?? '').trim(),
    };
}

let cpuTempPath;
export function readCpuTemp() {
    if (cpuTempPath === undefined) {
        cpuTempPath = null;
        const hwmons = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal'];
        for (const h of listDir('/sys/class/hwmon')) {
            const name = (readText(`/sys/class/hwmon/${h}/name`) ?? '').trim();
            if (hwmons.includes(name) && exists(`/sys/class/hwmon/${h}/temp1_input`)) {
                cpuTempPath = `/sys/class/hwmon/${h}/temp1_input`;
                break;
            }
        }
        const zones = ['x86_pkg_temp', 'cpu-thermal', 'CPU-therm', 'cpu_thermal', 'acpitz'];
        for (const z of cpuTempPath ? [] : listDir('/sys/class/thermal')) {
            const type = (readText(`/sys/class/thermal/${z}/type`) ?? '').trim();
            if (zones.includes(type)) {
                cpuTempPath = `/sys/class/thermal/${z}/temp`;
                break;
            }
        }
    }
    const v = cpuTempPath ? readInt(cpuTempPath) : null;
    return v === null ? null : v / 1000;
}

export function readBattery() {
    for (const name of listDir('/sys/class/power_supply')) {
        if (!name.startsWith('BAT'))
            continue;
        const base = `/sys/class/power_supply/${name}`;
        let watts = readInt(`${base}/power_now`);
        if (watts === null) {
            const i = readInt(`${base}/current_now`), v = readInt(`${base}/voltage_now`);
            watts = i !== null && v !== null ? i * v / 1e6 : null;
        }
        return {
            percent: readInt(`${base}/capacity`, 0),
            status: (readText(`${base}/status`) ?? '').trim(),
            watts: watts === null ? null : watts / 1e6,
        };
    }
    return null;
}

// ── Network ─────────────────────────────────────────────────────────────

const physical = new Map();
function isPhysicalIface(name) {
    if (!physical.has(name)) {
        physical.set(name,
            exists(`/sys/class/net/${name}/device`) &&
            readInt(`/sys/class/net/${name}/type`) !== ARPHRD_CAN);
    }
    return physical.get(name);
}

// Sums traffic over physical NICs only, so docker/veth/tailscale/vcan
// traffic is not counted twice.
export class NetSampler {
    constructor() {
        this._rate = new Rate();
    }

    sample() {
        let rx = 0, tx = 0;
        for (const line of (readText('/proc/net/dev') ?? '').split('\n').slice(2)) {
            const idx = line.indexOf(':');
            if (idx < 0 || !isPhysicalIface(line.slice(0, idx).trim()))
                continue;
            const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
            rx += f[0];
            tx += f[8];
        }
        const [r, t] = this._rate.update([rx, tx]);
        return {rx: r, tx: t};
    }
}

export function defaultRouteIface() {
    let best = null, bestMetric = Infinity;
    for (const line of (readText('/proc/net/route') ?? '').split('\n').slice(1)) {
        const f = line.split('\t');
        if (f[1] === '00000000' && Number(f[6]) < bestMetric) {
            best = f[0];
            bestMetric = Number(f[6]);
        }
    }
    return best;
}

export function readWifi() {
    for (const line of (readText('/proc/net/wireless') ?? '').split('\n').slice(2)) {
        const m = line.match(/^\s*(\S+):\s+\S+\s+([\d.]+)\s+(-?[\d.]+)/);
        if (m)
            return {iface: m[1], quality: Math.min(100, parseFloat(m[2]) / 70 * 100), dbm: parseFloat(m[3])};
    }
    return null;
}

export function parseAddresses(out) {
    const list = [];
    for (const line of out.split('\n')) {
        const m = line.match(/^\d+:\s+(\S+)\s+(inet6?)\s+([0-9a-fA-F.:]+)\/(\d+).*?scope (\S+)/);
        if (!m || m[1] === 'lo' || m[5] !== 'global')
            continue;
        list.push({iface: m[1].replace(/@.*/, ''), family: m[2] === 'inet' ? 4 : 6, address: m[3], prefix: Number(m[4])});
    }
    return list;
}

export function queryAddresses(cancellable, callback) {
    try {
        const proc = Gio.Subprocess.new(['ip', '-o', 'addr', 'show'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                callback(parseAddresses(out ?? ''));
            } catch (e) {
                callback(null);
            }
        });
    } catch (e) {
        callback(null);
    }
}

// TCP connect time to host:port — a ping that needs no raw socket.
export function probeLatency(host, port, cancellable, callback) {
    const client = new Gio.SocketClient({timeout: 3});
    const t0 = GLib.get_monotonic_time();
    client.connect_to_host_async(host, port, cancellable, (c, res) => {
        try {
            const conn = c.connect_to_host_finish(res);
            const ms = (GLib.get_monotonic_time() - t0) / 1000;
            conn.close(null);
            callback(ms);
        } catch (e) {
            callback(null);
        }
    });
}

// ── Storage ─────────────────────────────────────────────────────────────

export function fsUsage(path) {
    try {
        const info = Gio.File.new_for_path(path)
            .query_filesystem_info('filesystem::size,filesystem::free', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        return {size, free, used: size - free, percent: size ? 100 * (size - free) / size : 0};
    } catch (e) {
        return null;
    }
}

const REAL_FS = new Set(['ext4', 'ext3', 'btrfs', 'xfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'f2fs', 'zfs']);
export function listMounts() {
    const seen = new Set(), out = [];
    for (const line of (readText('/proc/mounts') ?? '').split('\n')) {
        const [dev, raw, fs] = line.split(' ');
        if (!REAL_FS.has(fs) || seen.has(dev) || /^\/(snap|var\/snap|boot)(\/|$)/.test(raw))
            continue;
        seen.add(dev);
        const mount = raw.replace(/\\040/g, ' ');
        const u = fsUsage(mount);
        if (u)
            out.push({mount, ...u});
    }
    return out;
}

export class DiskIoSampler {
    constructor() {
        this._rate = new Rate();
        this._phys = new Map();
    }

    sample() {
        let rd = 0, wr = 0;
        for (const line of (readText('/proc/diskstats') ?? '').split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length < 10)
                continue;
            if (!this._phys.has(f[2]))
                this._phys.set(f[2], exists(`/sys/block/${f[2]}/device`));
            if (!this._phys.get(f[2]))
                continue;
            rd += Number(f[5]) * 512;
            wr += Number(f[9]) * 512;
        }
        const [r, w] = this._rate.update([rd, wr]);
        return {read: r, write: w};
    }
}

// ── GPU ─────────────────────────────────────────────────────────────────

const JETSON_LOAD = [
    '/sys/devices/gpu.0/load',
    '/sys/devices/platform/gpu.0/load',
    '/sys/devices/platform/17000000.ga10b/load',
    '/sys/devices/platform/17000000.gv11b/load',
    '/sys/devices/platform/bus@0/17000000.gpu/load',
];

export class GpuSampler {
    constructor() {
        this.kind = null;
        this._busy = false;
        const nv = listDir('/proc/driver/nvidia/gpus');
        if (nv.length && GLib.find_program_in_path('nvidia-smi')) {
            this.kind = 'nvidia';
            this._pm = `/sys/bus/pci/devices/${nv[0]}/power/runtime_status`;
            return;
        }
        for (const card of listDir('/sys/class/drm')) {
            if (/^card\d+$/.test(card) && exists(`/sys/class/drm/${card}/device/gpu_busy_percent`)) {
                this.kind = 'amd';
                this._dev = `/sys/class/drm/${card}/device`;
                return;
            }
        }
        this._jetson = JETSON_LOAD.find(exists);
        if (this._jetson)
            this.kind = 'jetson';
    }

    poll(cancellable, callback) {
        if (this.kind === 'nvidia')
            this._pollNvidia(cancellable, callback);
        else if (this.kind === 'amd')
            callback(this._readAmd());
        else if (this.kind === 'jetson')
            callback({name: 'Jetson iGPU', util: readInt(this._jetson, 0) / 10});
    }

    // On hybrid laptops the dGPU runtime-suspends. Running nvidia-smi would
    // wake it up and burn battery, so we report "sleeping" instead.
    _pollNvidia(cancellable, callback) {
        if ((readText(this._pm) ?? '').trim() === 'suspended') {
            callback({name: 'NVIDIA', sleeping: true, util: 0});
            return;
        }
        if (this._busy)
            return;
        this._busy = true;
        try {
            const proc = Gio.Subprocess.new(['nvidia-smi',
                '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,name',
                '--format=csv,noheader,nounits'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                this._busy = false;
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    callback(parseNvidia(out ?? ''));
                } catch (e) {
                    callback(null);
                }
            });
        } catch (e) {
            this._busy = false;
            callback(null);
        }
    }

    _readAmd() {
        const d = this._dev;
        const hw = listDir(`${d}/hwmon`)[0];
        const temp = hw ? readInt(`${d}/hwmon/${hw}/temp1_input`) : null;
        const power = hw ? readInt(`${d}/hwmon/${hw}/power1_average`) : null;
        return {
            name: 'AMD GPU',
            util: readInt(`${d}/gpu_busy_percent`, 0),
            memUsed: readInt(`${d}/mem_info_vram_used`),
            memTotal: readInt(`${d}/mem_info_vram_total`),
            temp: temp === null ? null : temp / 1000,
            power: power === null ? null : power / 1e6,
        };
    }
}

export function parseNvidia(out) {
    const line = out.split('\n')[0];
    if (!line)
        return null;
    const f = line.split(',').map(s => s.trim());
    const num = s => (Number.isNaN(parseFloat(s)) ? null : parseFloat(s));
    return {
        util: num(f[0]) ?? 0,
        memUsed: num(f[1]) === null ? null : num(f[1]) * 1048576,
        memTotal: num(f[2]) === null ? null : num(f[2]) * 1048576,
        temp: num(f[3]),
        power: num(f[4]),
        name: f.slice(5).join(','),
    };
}

// ── ROS 2 node radar ────────────────────────────────────────────────────
//
// Moni never joins the DDS graph. A process is a ROS 2 participant when its
// environment has ROS_DISTRO *and* it has librcl.so mapped into memory.
// Classification is cached per PID, so a steady-state scan only reads
// /proc/<pid>/stat for the ROS processes themselves.

function readStat(pid) {
    const t = readText(`/proc/${pid}/stat`);
    if (!t)
        return null;
    const f = t.slice(t.lastIndexOf(')') + 2).split(' ');
    return {utime: Number(f[11]), stime: Number(f[12]), start: Number(f[19]), rss: Number(f[21])};
}

function parseEnv(text) {
    const env = {};
    for (const kv of text.split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0 && /^(ROS_|RMW_)/.test(kv))
            env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
}

export function describeRosProcess(argv, env) {
    let exe = argv[0] ?? '';
    let rest = argv.slice(1);
    if (/^python[\d.]*$/.test(basename(exe))) {
        while (rest.length && rest[0].startsWith('-'))
            rest = rest.slice(1);
        exe = rest[0] ?? exe;
        rest = rest.slice(1);
    }
    const base = basename(exe);
    const nodeArg = argv.find(a => a.startsWith('__node:='));
    const pkg = exe.match(/\/lib\/([^/]+)\/[^/]+$/)?.[1] ?? null;
    let role = 'node', name = nodeArg ? nodeArg.slice(8) : base;
    if (base === 'ros2') {
        const words = rest.filter(a => !a.startsWith('-'));
        role = words[0] === 'bag' && words[1] === 'record' ? 'bag'
            : words[0] === 'launch' ? 'launch'
                : words[0] === 'daemon' ? 'daemon' : 'cli';
        const topic = words.find(w => w.startsWith('/'));
        name = role === 'launch' ? `ros2 launch ${words.slice(1, 3).join(' ')}`
            : `ros2 ${words.slice(0, 2).join(' ')}${topic ? ` ${topic}` : ''}`;
    } else if (base === '_ros2_daemon') {
        role = 'daemon';
        name = 'ros2 daemon';
    } else if (/component_container/.test(base)) {
        role = 'container';
    }
    return {
        role, name, pkg,
        domain: env.ROS_DOMAIN_ID || '0',
        distro: env.ROS_DISTRO ?? null,
        rmw: env.RMW_IMPLEMENTATION ?? null,
    };
}

// `ros2 bag record -o X` writes into X; without -o it creates
// rosbag2_<timestamp>/ in its cwd. Returns null until the directory exists.
function bagOutputDir(pid, argv) {
    const cwd = readLink(`/proc/${pid}/cwd`) ?? '/';
    const i = argv.findIndex(a => a === '-o' || a === '--output');
    if (i >= 0 && argv[i + 1]) {
        const out = argv[i + 1];
        const dir = out.startsWith('/') ? out : `${cwd}/${out}`;
        return exists(dir) ? dir : null;
    }
    const newest = listDir(cwd).filter(n => n.startsWith('rosbag2_')).sort().pop();
    return newest ? `${cwd}/${newest}` : null;
}

function dirSize(path) {
    let total = 0;
    for (const name of listDir(path)) {
        try {
            total += Gio.File.new_for_path(`${path}/${name}`)
                .query_info('standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_size();
        } catch (e) {}
    }
    return total;
}

export class RosRadar {
    constructor() {
        this._procs = new Map();
        this._t = 0;
    }

    scan() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = now - this._t;
        this._t = now;
        const uptime = parseFloat(readText('/proc/uptime') ?? '0');
        const alive = new Set();
        const procs = [];

        for (const pid of listDir('/proc')) {
            if (!/^\d+$/.test(pid))
                continue;
            alive.add(pid);
            let p = this._procs.get(pid);
            if (p?.state === 'no')
                continue;
            const stat = readStat(pid);
            if (!stat)
                continue;
            if (!p) {
                const env = readText(`/proc/${pid}/environ`);
                if (!env || !env.includes('ROS_DISTRO=')) {
                    this._procs.set(pid, {state: 'no'});
                    continue;
                }
                p = {state: 'maybe', env: parseEnv(env)};
                this._procs.set(pid, p);
            }
            if (p.state === 'maybe') {
                // rclpy can take a second to import; give young processes time.
                const maps = readText(`/proc/${pid}/maps`);
                if (maps && maps.includes('/librcl.so')) {
                    const argv = (readText(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
                    Object.assign(p, describeRosProcess(argv, p.env), {state: 'ros', argv});
                } else if (uptime - stat.start / CLK_TCK > 20) {
                    this._procs.set(pid, {state: 'no'});
                    continue;
                } else {
                    continue;
                }
            }
            const ticks = stat.utime + stat.stime;
            p.cpu = p.ticks !== undefined && dt > 0 ? 100 * (ticks - p.ticks) / CLK_TCK / dt : 0;
            p.ticks = ticks;
            p.rss = stat.rss * PAGE;
            if (p.role === 'bag')
                this._sampleBag(pid, p);
            procs.push({pid: Number(pid), ...p, env: undefined, argv: undefined, state: undefined});
        }
        for (const pid of this._procs.keys()) {
            if (!alive.has(pid))
                this._procs.delete(pid);
        }

        procs.sort((a, b) => b.cpu - a.cpu);
        return {
            nodes: procs,
            bags: procs.filter(n => n.role === 'bag'),
            domains: [...new Set(procs.filter(n => n.role !== 'daemon').map(n => n.domain))].sort(),
            distro: procs.find(n => n.distro)?.distro ?? null,
            rmw: procs.find(n => n.rmw)?.rmw ?? null,
        };
    }

    // Rate = growth of the bag directory, so page-cache buffering does not
    // hide writes the way /proc/<pid>/io write_bytes would.
    _sampleBag(pid, p) {
        p.dir ??= bagOutputDir(pid, p.argv);
        p.rateTracker ??= new Rate();
        p.written = p.dir ? dirSize(p.dir) : 0;
        p.rate = p.rateTracker.update([p.written])[0];
        const fs = fsUsage(p.dir ?? readLink(`/proc/${pid}/cwd`) ?? '/');
        p.free = fs?.free ?? null;
        p.eta = fs && p.rate > 64 * 1024 ? fs.free / p.rate : null;
    }
}

// ── CAN bus ─────────────────────────────────────────────────────────────

export class CanMonitor {
    constructor() {
        this._rates = new Map();
    }

    sample() {
        const out = [];
        for (const name of listDir('/sys/class/net')) {
            const base = `/sys/class/net/${name}`;
            if (readInt(`${base}/type`) !== ARPHRD_CAN)
                continue;
            const stat = k => readInt(`${base}/statistics/${k}`, 0);
            if (!this._rates.has(name))
                this._rates.set(name, new Rate());
            const [rxFps, txFps] = this._rates.get(name).update([stat('rx_packets'), stat('tx_packets')]);
            const up = (parseInt(readText(`${base}/flags`) ?? '0', 16) & 1) === 1;
            const oper = (readText(`${base}/operstate`) ?? '').trim();
            out.push({
                name, up, rxFps, txFps,
                // Real controllers drop carrier on BUS-OFF; vcan reports "unknown".
                state: !up ? 'DOWN' : oper === 'down' ? 'NO-CARRIER' : 'UP',
                virtual: !exists(`${base}/device`),
                errors: stat('rx_errors') + stat('tx_errors'),
                dropped: stat('rx_dropped') + stat('tx_dropped'),
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }
}

// ── Sensor devices ──────────────────────────────────────────────────────

const SERIAL_RE = /^(ttyUSB|ttyACM|ttyTHS)\d+$/;

function prettifyId(id) {
    return id.replace(/^(usb|pci)-/, '').replace(/-if\d+(-port\d+)?$/, '').replace(/_/g, ' ');
}

export function listSensorDevices() {
    const byId = new Map();
    for (const link of listDir('/dev/serial/by-id')) {
        const target = readLink(`/dev/serial/by-id/${link}`);
        if (target)
            byId.set(basename(target), prettifyId(link));
    }
    const out = [];
    for (const name of listDir('/dev')) {
        if (SERIAL_RE.test(name)) {
            const product = readText(`/sys/class/tty/${name}/device/../product`) ??
                readText(`/sys/class/tty/${name}/device/../../product`);
            out.push({dev: name, kind: 'serial', label: byId.get(name) ?? product?.trim() ?? 'serial port'});
        } else if (/^video\d+$/.test(name)) {
            // One camera exposes several nodes; index 0 is the capture node.
            if (readInt(`/sys/class/video4linux/${name}/index`, 0) !== 0)
                continue;
            out.push({dev: name, kind: 'camera', label: (readText(`/sys/class/video4linux/${name}/name`) ?? 'camera').trim()});
        }
    }
    for (const name of listDir('/dev/input')) {
        // Keyboards with media keys also get a js node; real gamepads have axes.
        const abs = readText(`/sys/class/input/${name}/device/capabilities/abs`);
        if (/^js\d+$/.test(name) && abs && /[1-9a-f]/.test(abs))
            out.push({dev: `input/${name}`, kind: 'joystick', label: (readText(`/sys/class/input/${name}/device/name`) ?? 'joystick').trim()});
    }
    return out.sort((a, b) => a.dev.localeCompare(b.dev, undefined, {numeric: true}));
}
