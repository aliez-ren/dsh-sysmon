/**
 * dsh-sysmon — Host half: Linux `/proc` sampler plus authenticated snapshot and
 * kill routes.
 *
 * One sampler owns all state. Cheap probes (`/proc/stat`, `meminfo`, `net/dev`,
 * `diskstats`, `loadavg`, `uptime`, `pressure/*`) run on a 1000 ms timer and
 * feed a 90-sample history ring. The full `/proc/<pid>` walk runs only while a
 * snapshot was requested within the last 5 s, so an idle host does no process
 * enumeration.
 *
 * Every probe is defensive: missing files, permission errors and processes that
 * exit mid-scan degrade to `null` fields or are skipped — nothing is thrown out
 * of a probe or a route handler. Node builtins only; no npm dependencies.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'sysmon'
export const inject = ['connection']

/** Exact authenticated Fetch routes on the shared `/api` channel. */
const SNAPSHOT_PATH = '/api/sysmon.snapshot'
const KILL_PATH = '/api/sysmon.kill'

/** Signals the kill route is allowed to deliver. */
const KILL_SIGNALS = new Set(['TERM', 'KILL', 'STOP', 'CONT'])

const HIST_LIMIT = 90
const DEFAULT_INTERVAL_MS = 1000
const SCAN_WINDOW_MS = 5000
/** `/proc/stat` per-CPU fields: user nice system idle iowait irq softirq steal. */
const CPU_FIELDS = 8
const SECTOR_BYTES = 512
/**
 * Block devices skipped in the disk panel: loop/zram/ram pseudo devices and the
 * dm/md stacks, whose I/O is already counted on the disks underneath them.
 */
const SKIP_DISK = /^(loop|zram|ram|fd|sr|dm-|md)/
const DIGITS = /^\d+$/

// ---------------------------------------------------------------------------
// Guarded reads and small value helpers
// ---------------------------------------------------------------------------

/** Read one text file, returning `null` when it is missing or unreadable. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readTrimmed(file) {
  const text = readText(file)
  return text === null ? null : text.trim()
}

/** Round to `digits` decimals, mapping non-finite input to `null`. */
function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const confCache = new Map()

/** `getconf` value cached for the process lifetime, with a fallback default. */
function confValue(key, fallback) {
  let value = confCache.get(key)
  if (value !== undefined) return value
  value = fallback
  try {
    const out = execFileSync('getconf', [key], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const parsed = Number.parseInt(out, 10)
    if (Number.isFinite(parsed) && parsed > 0) value = parsed
  } catch {
    // `getconf` unavailable: keep the documented Linux default.
  }
  confCache.set(key, value)
  return value
}

let passwdUsers = null

/** uid → login name from `/etc/passwd`, parsed once and cached. */
function userMap() {
  if (passwdUsers !== null) return passwdUsers
  const map = new Map()
  const text = readText('/etc/passwd')
  if (text !== null) {
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue
      const fields = line.split(':')
      if (fields.length < 3) continue
      const uid = Number.parseInt(fields[2], 10)
      if (Number.isFinite(uid) && !map.has(uid)) map.set(uid, fields[0])
    }
  }
  passwdUsers = map
  return map
}

// ---------------------------------------------------------------------------
// Cheap probes
// ---------------------------------------------------------------------------

function cpuTotals(fields) {
  let total = 0
  for (let index = 1; index <= CPU_FIELDS; index += 1) total += Number(fields[index]) || 0
  return { total, idle: (Number(fields[4]) || 0) + (Number(fields[5]) || 0) }
}

/** `/proc/stat` aggregate and per-core jiffy counters, `null` when unreadable. */
function probeCpuTimes() {
  const text = readText('/proc/stat')
  if (text === null) return null
  let aggregate = null
  const cores = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu')) continue
    const fields = line.trim().split(/\s+/)
    const label = fields[0]
    if (label === 'cpu') aggregate = cpuTotals(fields)
    else if (DIGITS.test(label.slice(3))) cores.push(cpuTotals(fields))
  }
  if (aggregate === null) return null
  return { aggregate, cores }
}

/** CPU bus busy percentage between two `/proc/stat` samples. */
function usageBetween(previous, current) {
  if (!previous || !current) return null
  const deltaTotal = current.total - previous.total
  const deltaIdle = current.idle - previous.idle
  if (!(deltaTotal > 0) || deltaIdle < 0) return null
  const usage = 100 * (1 - deltaIdle / deltaTotal)
  return round(Math.min(100, Math.max(0, usage)), 1)
}

/** Per-core `scaling_cur_freq` in MHz; falls back to `os.cpus()` speeds. */
function probeFreq(coreCount) {
  const values = []
  let readable = false
  for (let index = 0; index < coreCount; index += 1) {
    const text = readTrimmed(`/sys/devices/system/cpu/cpu${index}/cpufreq/scaling_cur_freq`)
    const kHz = text === null ? Number.NaN : Number(text)
    if (Number.isFinite(kHz) && kHz > 0) {
      readable = true
      values.push(Math.round(kHz / 1000))
    } else {
      values.push(null)
    }
  }
  if (readable) return values
  const cpus = os.cpus()
  if (cpus.length !== coreCount) return values
  return cpus.map((cpu) => (Number.isFinite(cpu.speed) && cpu.speed > 0 ? Math.round(cpu.speed) : null))
}

function emptyMemory() {
  return {
    total: null,
    used: null,
    free: null,
    available: null,
    buffers: null,
    cached: null,
    swapTotal: null,
    swapUsed: null,
  }
}

/** `/proc/meminfo` in bytes. */
function probeMemory() {
  const text = readText('/proc/meminfo')
  if (text === null) return null
  const values = new Map()
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const amount = Number.parseInt(line.slice(colon + 1), 10)
    if (Number.isFinite(amount)) values.set(line.slice(0, colon), amount * 1024)
  }
  const total = finiteNumber(values.get('MemTotal'))
  if (total === null) return null
  const free = finiteNumber(values.get('MemFree'))
  const available = finiteNumber(values.get('MemAvailable')) ?? free
  const swapTotal = finiteNumber(values.get('SwapTotal'))
  const swapFree = finiteNumber(values.get('SwapFree'))
  return {
    total,
    used: available === null ? null : Math.max(0, total - available),
    free,
    available,
    buffers: finiteNumber(values.get('Buffers')),
    cached: finiteNumber(values.get('Cached')),
    swapTotal,
    swapUsed: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
  }
}

function emptyNet() {
  return { rxBps: null, txBps: null, rxTotal: null, txTotal: null, ifaces: [] }
}

/** Cumulative interface byte counters from `/proc/net/dev` (`lo` excluded). */
function probeNet() {
  const text = readText('/proc/net/dev')
  if (text === null) return null
  let rxTotal = 0
  let txTotal = 0
  const ifaces = []
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const iface = line.slice(0, colon).trim()
    if (iface === '') continue
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    const rx = Number(fields[0])
    const tx = Number(fields[8])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    if (iface === 'lo') continue
    rxTotal += rx
    txTotal += tx
    ifaces.push({ name: iface, rx, tx })
  }
  return { rxTotal, txTotal, ifaces }
}

/** Whole-disk names from sysfs, or `null` when sysfs is unavailable. */
function wholeDisks() {
  try {
    return new Set(fs.readdirSync('/sys/block'))
  } catch {
    return null
  }
}

function emptyDisk() {
  return { readBps: null, writeBps: null, devices: [], filesystems: [] }
}

/** Cumulative whole-disk byte counters from `/proc/diskstats`. */
function probeDisk() {
  const text = readText('/proc/diskstats')
  if (text === null) return null
  const whole = wholeDisks()
  let readBytes = 0
  let writeBytes = 0
  const devices = []
  for (const line of text.trim().split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const disk = fields[2]
    if (SKIP_DISK.test(disk)) continue
    // Only whole disks are counted; partitions would double-count the same I/O.
    if (whole !== null ? !whole.has(disk) : /\d$/.test(disk)) continue
    const sectorsRead = Number(fields[5])
    const sectorsWritten = Number(fields[9])
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue
    const read = sectorsRead * SECTOR_BYTES
    const write = sectorsWritten * SECTOR_BYTES
    readBytes += read
    writeBytes += write
    devices.push({ name: disk, read, write })
  }
  return { readBytes, writeBytes, devices }
}

/** Filesystem types that hold real, user-visible capacity. */
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'ntfs', 'ntfs3', 'exfat', 'zfs', 'fuseblk', 'ubifs', 'overlay'])
const MAX_FILESYSTEMS = 12

/**
 * Mounted filesystem capacity from `/proc/mounts` + `statfs`. Bind mounts that
 * share one device collapse to their first mount; container overlay mounts are
 * kept only at `/`.
 */
function probeFilesystems() {
  const text = readText('/proc/mounts')
  if (text === null) return []
  const seenDevices = new Set()
  const entries = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3) continue
    const source = fields[0]
    const mount = fields[1]
    const fstype = fields[2]
    if (!REAL_FS.has(fstype)) continue
    if (fstype === 'overlay' && mount !== '/') continue
    if (fstype !== 'zfs' && fstype !== 'overlay' && !source.startsWith('/dev/')) continue
    let deviceId
    let stat
    try {
      deviceId = fs.statSync(mount).dev
      stat = fs.statfsSync(mount)
    } catch {
      continue
    }
    if (seenDevices.has(deviceId)) continue
    const bsize = Number(stat.bsize)
    const blocks = Number(stat.blocks)
    const bfree = Number(stat.bfree)
    const bavail = Number(stat.bavail)
    if (![bsize, blocks, bfree, bavail].every(Number.isFinite) || bsize <= 0 || blocks <= 0) continue
    const total = blocks * bsize
    const free = Math.max(0, bfree * bsize)
    const available = Math.max(0, bavail * bsize)
    const used = Math.max(0, total - free)
    const usedPct = used + available > 0 ? (used / (used + available)) * 100 : null
    seenDevices.add(deviceId)
    entries.push({
      mount,
      device: source,
      fstype,
      total,
      used,
      available,
      usedPct: usedPct === null ? null : round(usedPct, 1),
    })
  }
  entries.sort((left, right) => {
    if (left.mount === '/') return -1
    if (right.mount === '/') return 1
    return left.mount.localeCompare(right.mount)
  })
  return entries.slice(0, MAX_FILESYSTEMS)
}

function emptyLoad() {
  return { one: null, five: null, fifteen: null, running: null, total: null, lastPid: null }
}

/** `/proc/loadavg` average queue lengths and task counters. */
function probeLoad() {
  const text = readTrimmed('/proc/loadavg')
  if (text === null) return null
  const fields = text.split(/\s+/)
  const tasks = (fields[3] ?? '').split('/')
  return {
    one: finiteNumber(Number(fields[0])),
    five: finiteNumber(Number(fields[1])),
    fifteen: finiteNumber(Number(fields[2])),
    running: finiteNumber(Number.parseInt(tasks[0], 10)),
    total: finiteNumber(Number.parseInt(tasks[1], 10)),
    lastPid: finiteNumber(Number.parseInt(fields[4], 10)),
  }
}

function emptyPressure() {
  return { cpu10: null, io10: null, mem10: null }
}

/** PSI `some avg10` percentages; `null` where the kernel exposes no file. */
function probePressure() {
  const someAvg10 = (name) => {
    const text = readTrimmed(`/proc/pressure/${name}`)
    if (text === null) return null
    const match = /(?:^|\s)some\s+avg10=([0-9.]+)/.exec(text)
    return match === null ? null : finiteNumber(Number(match[1]))
  }
  return { cpu10: someAvg10('cpu'), io10: someAvg10('io'), mem10: someAvg10('mem') }
}

/** Byte-per-second delta between two cumulative counters. */
function rate(current, previous, dtSec) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || !(dtSec > 0)) return null
  const delta = current - previous
  return round(delta >= 0 ? delta / dtSec : 0, 1)
}

// ---------------------------------------------------------------------------
// Process scan
// ---------------------------------------------------------------------------

/**
 * Parse one `/proc/<pid>/stat` line. `comm` may contain spaces and parentheses,
 * so it is delimited by the first `(` and the last `)`.
 */
function parseStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close <= open) return null
  const pid = Number.parseInt(text.slice(0, open), 10)
  if (!Number.isFinite(pid)) return null
  const comm = text.slice(open + 1, close)
  const fields = text.slice(close + 1).trim().split(/\s+/)
  if (fields.length < 22) return null
  const safe = (index) => {
    const value = Number(fields[index])
    return Number.isSafeInteger(value) ? value : 0
  }
  return {
    pid,
    comm,
    state: fields[0],
    ppid: safe(1),
    utime: safe(11),
    stime: safe(12),
    threads: safe(17),
    starttime: safe(19),
    vsize: safe(20),
    rss: safe(21),
  }
}

function readProcStat(pid) {
  const text = readText(`/proc/${pid}/stat`)
  return text === null ? null : parseStat(text)
}

/** NUL-separated argv of one process, `null` when the command line is empty. */
function readCmdline(pid) {
  const text = readText(`/proc/${pid}/cmdline`)
  if (text === null || text === '') return null
  const argv = text.split('\0').filter((part) => part !== '')
  return argv.length === 0 ? null : argv
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

class Sampler {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.histLimit = options.histLimit ?? HIST_LIMIT
    this.scanWindowMs = options.scanWindowMs ?? SCAN_WINDOW_MS
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.clockTicksValue = options.hz ?? null
    this.pageSizeValue = options.pageSize ?? null

    this.startedAt = this.now()
    this.timer = null
    this.uptime = null
    const cpus = os.cpus()
    this.host = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      kernel: os.release(),
      cpuModel: cpus[0]?.model ?? null,
      cores: cpus.length,
    }

    this.cpu = { usage: null, perCore: [], freqMHz: [] }
    this.memory = emptyMemory()
    this.net = emptyNet()
    this.disk = emptyDisk()
    this.filesystems = []
    this.pressure = emptyPressure()
    this.load = emptyLoad()
    this.counts = { total: 0, running: 0, sleeping: 0, zombie: 0, threads: 0 }
    this.procs = []
    this.hist = { t: [], cpu: [], mem: [], rx: [], tx: [] }

    this.prevCpuTimes = null
    this.prevNet = null
    this.prevDisk = null
    this.prevDiskTotal = null
    this.prevProbeAt = 0
    this.procPrev = new Map()
    this.lastScanAt = 0
    this.lastRequestAt = 0
    this.tickCount = 0
    this.scanCount = 0
  }

  /** Linux clock ticks per second (`USER_HZ`), read once. */
  clockTicks() {
    if (this.clockTicksValue === null) this.clockTicksValue = confValue('CLK_TCK', 100)
    return this.clockTicksValue
  }

  /** Page size in bytes, read once. */
  pageSize() {
    if (this.pageSizeValue === null) this.pageSizeValue = confValue('PAGESIZE', 4096)
    return this.pageSizeValue
  }

  /** Baseline sample plus a 1000 ms timer; the timer never keeps the process alive. */
  start() {
    if (this.timer !== null) return
    this.tick(this.now())
    this.timer = setInterval(() => this.tick(this.now()), this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** One sampling pass: cheap probes always, process scan only while requested. */
  tick(now = this.now()) {
    const dtSec = this.prevProbeAt > 0 ? Math.max(0, (now - this.prevProbeAt) / 1000) : 0

    const cpuTimes = probeCpuTimes()
    if (cpuTimes !== null) {
      const perCore = cpuTimes.cores.map((core, index) =>
        usageBetween(this.prevCpuTimes?.cores[index], core),
      )
      this.cpu = {
        usage: usageBetween(this.prevCpuTimes?.aggregate, cpuTimes.aggregate),
        perCore,
        freqMHz: probeFreq(cpuTimes.cores.length),
      }
      this.prevCpuTimes = cpuTimes
    } else {
      this.cpu = { usage: null, perCore: [], freqMHz: [] }
      this.prevCpuTimes = null
    }

    this.memory = probeMemory() ?? emptyMemory()
    this.load = probeLoad() ?? emptyLoad()
    this.pressure = probePressure() ?? emptyPressure()
    this.uptime = finiteNumber(Number.parseFloat(readTrimmed('/proc/uptime') ?? '')) ?? os.uptime()

    const net = probeNet()
    if (net !== null) {
      const ifaces = net.ifaces.map((iface) => {
        const before = this.prevNet?.ifaces.get(iface.name)
        return {
          name: iface.name,
          rxBps: rate(iface.rx, before?.rx, dtSec),
          txBps: rate(iface.tx, before?.tx, dtSec),
        }
      })
      this.net = {
        rxBps: rate(net.rxTotal, this.prevNet?.rxTotal, dtSec),
        txBps: rate(net.txTotal, this.prevNet?.txTotal, dtSec),
        rxTotal: net.rxTotal,
        txTotal: net.txTotal,
        ifaces,
      }
      this.prevNet = {
        rxTotal: net.rxTotal,
        txTotal: net.txTotal,
        ifaces: new Map(net.ifaces.map((iface) => [iface.name, { rx: iface.rx, tx: iface.tx }])),
      }
    } else {
      this.net = emptyNet()
      this.prevNet = null
    }

    this.filesystems = probeFilesystems()

    const disk = probeDisk()
    if (disk !== null) {
      const devices = disk.devices.map((device) => {
        const before = this.prevDisk?.get(device.name)
        return {
          name: device.name,
          readBps: rate(device.read, before?.read, dtSec),
          writeBps: rate(device.write, before?.write, dtSec),
        }
      })
      devices.sort((left, right) => (right.readBps + right.writeBps) - (left.readBps + left.writeBps))
      this.disk = {
        readBps: rate(disk.readBytes, this.prevDiskTotal?.read, dtSec),
        writeBps: rate(disk.writeBytes, this.prevDiskTotal?.write, dtSec),
        devices: devices.slice(0, 12),
      }
      this.prevDiskTotal = { read: disk.readBytes, write: disk.writeBytes }
      this.prevDisk = new Map(disk.devices.map((device) => [device.name, { read: device.read, write: device.write }]))
    } else {
      this.disk = emptyDisk()
      this.prevDisk = null
      this.prevDiskTotal = null
    }

    this.prevProbeAt = now
    this.tickCount += 1
    this.recordHistory(now)

    if (now - this.lastRequestAt <= this.scanWindowMs) this.scanProcesses(now)
  }

  /** Append one history point and drop the oldest past the ring limit. */
  recordHistory(now) {
    if (this.cpu.usage === null) return
    const total = this.memory.total
    const used = this.memory.used
    // `hist.mem` is used-percent, matching the 0-100 scale of `hist.cpu`.
    const memPercent = total !== null && used !== null ? round((used / total) * 100, 1) : null
    const hist = this.hist
    hist.t.push(Math.round((now - this.startedAt) / 1000))
    hist.cpu.push(this.cpu.usage)
    hist.mem.push(memPercent)
    hist.rx.push(this.net.rxBps)
    hist.tx.push(this.net.txBps)
    const excess = hist.t.length - this.histLimit
    if (excess > 0) {
      hist.t.splice(0, excess)
      hist.cpu.splice(0, excess)
      hist.mem.splice(0, excess)
      hist.rx.splice(0, excess)
      hist.tx.splice(0, excess)
    }
  }

  /** Walk `/proc/<pid>` for kernel state, cumulative CPU, RSS and command lines. */
  scanProcesses(now = this.now()) {
    let entries = null
    try {
      entries = fs.readdirSync('/proc')
    } catch {
      entries = null
    }
    if (entries === null) {
      this.procs = []
      this.counts = { total: 0, running: 0, sleeping: 0, zombie: 0, threads: 0 }
      this.lastScanAt = now
      this.scanCount += 1
      return
    }

    const dtSec = this.lastScanAt > 0 ? Math.max(0, (now - this.lastScanAt) / 1000) : 0
    const hz = this.clockTicks()
    const pageBytes = this.pageSize()
    const totalMemory = this.memory.total
    const users = userMap()
    const previous = this.procPrev
    const current = new Map()
    const procs = []
    const counts = { total: 0, running: 0, sleeping: 0, zombie: 0, threads: 0 }

    for (const entry of entries) {
      if (!DIGITS.test(entry)) continue
      const pid = Number(entry)
      const stat = readProcStat(pid)
      if (stat === null) continue

      let uid = -1
      try {
        uid = fs.statSync(`/proc/${pid}`).uid
      } catch {
        // The uid is cosmetic; keep the process with an unknown user.
      }

      const ticks = stat.utime + stat.stime
      const before = previous.get(pid)
      let cpu = 0
      if (before !== undefined && before.starttime === stat.starttime && dtSec > 0) {
        const delta = ticks - before.ticks
        cpu = delta > 0 ? (delta / (dtSec * hz)) * 100 : 0
        if (!Number.isFinite(cpu)) cpu = 0
      }
      current.set(pid, { ticks, starttime: stat.starttime })

      const rss = Math.max(0, stat.rss) * pageBytes
      const argv = readCmdline(pid)
      procs.push({
        pid,
        ppid: stat.ppid,
        user: uid >= 0 ? users.get(uid) ?? String(uid) : null,
        state: stat.state,
        cpu: round(cpu, 2),
        mem: totalMemory !== null && totalMemory > 0 ? round((rss / totalMemory) * 100, 1) : null,
        rss,
        vsz: stat.vsize,
        thr: stat.threads,
        time: round(ticks / hz, 1),
        cmd: argv !== null ? path.basename(argv[0]) || stat.comm : stat.comm,
        args: argv !== null ? argv.join(' ') : `[${stat.comm}]`,
      })

      if (stat.state === 'R') counts.running += 1
      else if (stat.state === 'Z') counts.zombie += 1
      else if (stat.state === 'S' || stat.state === 'D' || stat.state === 'I') counts.sleeping += 1
      counts.threads += stat.threads
    }

    counts.total = procs.length
    this.procPrev = current
    this.procs = procs
    this.counts = counts
    this.lastScanAt = now
    this.scanCount += 1
  }

  /**
   * Mark a snapshot request and return cached samples plus the process list.
   * The first request primes the cheap baseline and performs an initial scan.
   */
  getSnapshot() {
    const now = this.now()
    this.lastRequestAt = now
    if (this.prevProbeAt === 0) this.tick(now)
    if (this.lastScanAt === 0 || now - this.lastScanAt >= this.intervalMs * 2) this.scanProcesses(now)
    return this.buildSnapshot(now)
  }

  buildSnapshot(now) {
    const hist = this.hist
    return {
      v: 1,
      ts: now,
      host: {
        hostname: this.host.hostname,
        platform: this.host.platform,
        arch: this.host.arch,
        kernel: this.host.kernel,
        uptime: this.uptime,
        cpuModel: this.host.cpuModel,
        cores: this.host.cores,
      },
      load: { ...this.load },
      cpu: {
        usage: this.cpu.usage,
        perCore: this.cpu.perCore.slice(),
        freqMHz: this.cpu.freqMHz.slice(),
      },
      mem: { ...this.memory },
      net: {
        rxBps: this.net.rxBps,
        txBps: this.net.txBps,
        rxTotal: this.net.rxTotal,
        txTotal: this.net.txTotal,
        ifaces: this.net.ifaces.map((iface) => ({ ...iface })),
      },
      disk: {
        readBps: this.disk.readBps,
        writeBps: this.disk.writeBps,
        devices: this.disk.devices.map((device) => ({ ...device })),
        filesystems: this.filesystems.map((entry) => ({ ...entry })),
      },
      pressure: { ...this.pressure },
      counts: { ...this.counts },
      procs: this.procs.map((proc) => ({ ...proc })),
      hist: {
        step: this.intervalMs,
        t: hist.t.slice(),
        cpu: hist.cpu.slice(),
        mem: hist.mem.slice(),
        rx: hist.rx.slice(),
        tx: hist.tx.slice(),
      },
    }
  }

  /** Sampling counters, used by the standalone verification script. */
  stats() {
    return {
      ticks: this.tickCount,
      scans: this.scanCount,
      lastTickAt: this.prevProbeAt,
      lastScanAt: this.lastScanAt,
      lastRequestAt: this.lastRequestAt,
      history: this.hist.cpu.length,
      timerRunning: this.timer !== null,
    }
  }
}

/** Create an independent sampler; sampling starts on the first `start()` or `getSnapshot()`. */
export { probeFilesystems }

export function createSampler(options = {}) {
  return new Sampler(options)
}

/** One-shot synchronous sample (used by verification scripts). */
export function collectOnce() {
  return createSampler().getSnapshot()
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

/**
 * Validate and deliver one signal.
 * @returns `{ status, body }` with the JSON payload the route answers.
 */
export function killProcess(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { status: 400, body: { ok: false, error: 'pid must be an integer greater than 1' } }
  }
  if (pid === process.pid) {
    return { status: 400, body: { ok: false, error: 'refusing to signal the dsh host process' } }
  }
  let name = 'TERM'
  if (signal !== undefined && signal !== null) {
    if (typeof signal !== 'string') {
      return { status: 400, body: { ok: false, error: 'signal must be a string' } }
    }
    name = signal.toUpperCase()
  }
  if (!KILL_SIGNALS.has(name)) {
    return {
      status: 400,
      body: { ok: false, error: `signal must be one of ${[...KILL_SIGNALS].join(', ')}` },
    }
  }
  try {
    process.kill(pid, `SIG${name}`)
    return { status: 200, body: { ok: true } }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { status: 404, body: { ok: false, error: `no such process: ${pid}` } }
    }
    if (error?.code === 'EPERM') {
      return { status: 400, body: { ok: false, error: `permission denied for pid ${pid}` } }
    }
    return { status: 400, body: { ok: false, error: messageOf(error) } }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function pathnameOf(request) {
  try {
    return new URL(request.url).pathname
  } catch {
    return ''
  }
}

/** `GET /api/sysmon.snapshot`; always answers JSON, never throws. */
export function handleSnapshotRequest(sampler, request) {
  try {
    if (pathnameOf(request) !== SNAPSHOT_PATH) return json({ error: 'not found' }, 404)
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
    return json(sampler.getSnapshot())
  } catch (error) {
    return json({ error: messageOf(error) }, 500)
  }
}

/** `POST /api/sysmon.kill`; always answers JSON, never throws. */
export async function handleKillRequest(request) {
  try {
    if (pathnameOf(request) !== KILL_PATH) return json({ ok: false, error: 'not found' }, 404)
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
    let payload
    try {
      payload = JSON.parse(await request.text())
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ ok: false, error: 'body must be a JSON object' }, 400)
    }
    const result = killProcess(payload.pid, payload.signal)
    return json(result.body, result.status)
  } catch (error) {
    return json({ ok: false, error: messageOf(error) }, 500)
  }
}

// ---------------------------------------------------------------------------
// Cordis plugin
// ---------------------------------------------------------------------------

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * Register the two authenticated routes and own the sampler through effects.
 * @param ctx - host context carrying the `connection` service.
 */
export function apply(ctx) {
  const sampler = createSampler()
  ctx.effect(() => {
    sampler.start()
    return () => sampler.stop()
  }, 'sysmon: sampler')

  // Both sibling methods are registered so an unsupported method is answered
  // with our JSON 405 instead of the channel's plain-text 404 fallback.
  ctx.effect(
    () =>
      connectionOf(ctx).fetch.register({
        path: SNAPSHOT_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => handleSnapshotRequest(sampler, request),
      }),
    'sysmon: snapshot route',
  )
  ctx.effect(
    () =>
      connectionOf(ctx).fetch.register({
        path: KILL_PATH,
        methods: ['POST', 'GET'],
        requestBody: 'buffered',
        fetch: (request) => handleKillRequest(request),
      }),
    'sysmon: kill route',
  )
}
