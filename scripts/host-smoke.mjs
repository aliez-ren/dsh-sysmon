#!/usr/bin/env node
/**
 * Standalone verification for the dsh-sysmon host half.
 *
 * Imports `lib/index.js` directly (no Cordis, no DSH host), drives the sampler
 * for ~2.5 s the way the browser does, then checks the contract snapshot shape,
 * sampling invariants (CPU deltas, history ring, no scan without a request),
 * the kill helper and the two route handlers (as plain WHATWG Request/Response).
 *
 * Run: `node scripts/host-smoke.mjs`
 * Exit code 0 means every check passed; 1 lists the failures.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  collectOnce,
  createSampler,
  handleKillRequest,
  handleSnapshotRequest,
  killProcess,
} from '../lib/index.js'

const failures = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(label, fn) {
  try {
    fn()
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

function hasKeys(value, keys, label) {
  assert.ok(value !== null && typeof value === 'object', `${label} must be an object`)
  for (const key of keys) {
    assert.ok(key in value, `${label} is missing key "${key}"`)
  }
}

/** Wait until `/proc/<pid>` disappears; used by the kill probe. */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(`/proc/${pid}`)) return true
    await sleep(20)
  }
  return !fs.existsSync(`/proc/${pid}`)
}

function killProbePid() {
  // Above pid_max no process can exist, so ESRCH is guaranteed.
  const pidMax = Number.parseInt(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim(), 10)
  return (Number.isFinite(pidMax) ? pidMax : 4194304) + 7
}

// ---------------------------------------------------------------------------
// 1. Drive the sampler like the browser polls it
// ---------------------------------------------------------------------------

// A busy loop pins one core, which gives the process CPU math a known answer.
const burner = spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' })
await once(burner, 'spawn')

const sampler = createSampler()
sampler.start()
const polls = []
const pollTimer = setInterval(() => polls.push(sampler.getSnapshot()), 500)
const samplingStartedAt = Date.now()
await sleep(2500)
clearInterval(pollTimer)
sampler.stop()

const snapshot = polls.at(-1)
const samplingMs = Date.now() - samplingStartedAt
const stats = sampler.stats()
const burnerProc = snapshot.procs.find((proc) => proc.pid === burner.pid)

console.log('\n=== dsh-sysmon host smoke ===\n')
console.log(`sampled for ${samplingMs} ms, polls: ${polls.length}, ticks: ${stats.ticks}, proc scans: ${stats.scans}`)

// ---------------------------------------------------------------------------
// 2. Snapshot shape
// ---------------------------------------------------------------------------

check('snapshot is v:1 with a numeric ts and all top-level sections', () => {
  assert.equal(snapshot.v, 1)
  assert.ok(Number.isFinite(snapshot.ts) && snapshot.ts > 0, 'ts')
  hasKeys(
    snapshot,
    ['v', 'ts', 'host', 'load', 'cpu', 'mem', 'net', 'disk', 'pressure', 'counts', 'procs', 'hist'],
    'snapshot',
  )
})

check('host/load/cpu/mem/net/disk/pressure/counts/hist carry the contract keys', () => {
  hasKeys(snapshot.host, ['hostname', 'platform', 'arch', 'kernel', 'uptime', 'cpuModel', 'cores'], 'host')
  hasKeys(snapshot.load, ['one', 'five', 'fifteen', 'running', 'total', 'lastPid'], 'load')
  hasKeys(snapshot.cpu, ['usage', 'perCore', 'freqMHz'], 'cpu')
  hasKeys(
    snapshot.mem,
    ['total', 'used', 'free', 'available', 'buffers', 'cached', 'swapTotal', 'swapUsed'],
    'mem',
  )
  hasKeys(snapshot.net, ['rxBps', 'txBps', 'rxTotal', 'txTotal', 'ifaces'], 'net')
  hasKeys(snapshot.disk, ['readBps', 'writeBps', 'devices'], 'disk')
  hasKeys(snapshot.pressure, ['cpu10', 'io10', 'mem10'], 'pressure')
  hasKeys(snapshot.counts, ['total', 'running', 'sleeping', 'zombie', 'threads'], 'counts')
  hasKeys(
    snapshot.hist,
    ['step', 't', 'cpu', 'mem', 'rx', 'tx'],
    'hist',
  )
  for (const iface of snapshot.net.ifaces) hasKeys(iface, ['name', 'rxBps', 'txBps'], 'net.ifaces[]')
  for (const device of snapshot.disk.devices) hasKeys(device, ['name', 'readBps', 'writeBps'], 'disk.devices[]')
  assert.equal(snapshot.hist.step, 1000, 'hist.step must be the 1000 ms sampling interval')
})

check('first snapshot reports cpu.usage: null (client "sampling..." state)', () => {
  assert.equal(polls[0].cpu.usage, null)
})

check('cpu.usage is a number in [0, 100] after the second tick', () => {
  assert.ok(Number.isFinite(snapshot.cpu.usage), `cpu.usage = ${snapshot.cpu.usage}`)
  assert.ok(snapshot.cpu.usage >= 0 && snapshot.cpu.usage <= 100, `cpu.usage out of range: ${snapshot.cpu.usage}`)
  assert.ok(snapshot.cpu.perCore.length === os.cpus().length, `perCore.length ${snapshot.cpu.perCore.length} != ${os.cpus().length}`)
  for (const [index, core] of snapshot.cpu.perCore.entries()) {
    assert.ok(Number.isFinite(core) && core >= 0 && core <= 100, `perCore[${index}] = ${core}`)
  }
})

check('mem/net/disk values are plausible raw units', () => {
  assert.ok(snapshot.mem.total > 0, 'mem.total')
  assert.ok(
    Math.abs(snapshot.mem.total - os.totalmem()) / os.totalmem() < 0.05,
    `mem.total ${snapshot.mem.total} does not match os.totalmem() ${os.totalmem()}`,
  )
  assert.ok(snapshot.mem.used >= 0 && snapshot.mem.used <= snapshot.mem.total, 'mem.used')
  assert.ok(snapshot.net.rxTotal > 0 && snapshot.net.txTotal > 0, 'net totals')
  assert.ok(Number.isFinite(snapshot.net.rxBps) && snapshot.net.rxBps >= 0, 'net.rxBps')
  assert.ok(Number.isFinite(snapshot.disk.readBps) && snapshot.disk.readBps >= 0, 'disk.readBps')
  assert.ok(Array.isArray(snapshot.disk.devices) && snapshot.disk.devices.length > 0, 'disk.devices')
})

// ---------------------------------------------------------------------------
// 3. Process list
// ---------------------------------------------------------------------------

check('procs.length > 5 and every entry has the contract fields', () => {
  assert.ok(snapshot.procs.length > 5, `procs.length = ${snapshot.procs.length}`)
  for (const proc of snapshot.procs) {
    hasKeys(
      proc,
      ['pid', 'ppid', 'user', 'state', 'cpu', 'mem', 'rss', 'vsz', 'thr', 'time', 'cmd', 'args'],
      `proc ${proc.pid}`,
    )
    for (const field of ['pid', 'cpu', 'mem', 'rss', 'thr']) {
      assert.ok(Number.isFinite(proc[field]), `proc ${proc.pid}.${field} = ${proc[field]}`)
    }
    assert.ok(Number.isInteger(proc.pid) && proc.pid > 0, `pid ${proc.pid}`)
    assert.ok(proc.cpu >= 0, `proc ${proc.pid}.cpu negative`)
    assert.ok(proc.thr >= 1, `proc ${proc.pid}.thr = ${proc.thr}`)
    assert.ok(proc.rss >= 0, `proc ${proc.pid}.rss = ${proc.rss}`)
    assert.equal(typeof proc.cmd, 'string')
    assert.ok(proc.cmd.length > 0, `proc ${proc.pid}.cmd empty`)
    assert.equal(typeof proc.args, 'string')
    assert.ok(proc.args.length > 0, `proc ${proc.pid}.args empty`)
  }
  assert.equal(snapshot.counts.total, snapshot.procs.length, 'counts.total')
  assert.ok(snapshot.counts.threads >= snapshot.procs.length, 'counts.threads')
})

check('a synthetic single-core burner reports ~100 % of one core', () => {
  assert.ok(burnerProc, `burner pid ${burner.pid} missing from the scan`)
  assert.ok(burnerProc.cpu >= 25 && burnerProc.cpu <= 170, `burner cpu = ${burnerProc.cpu}`)
  const machine = snapshot.cpu.usage * snapshot.cpu.perCore.length
  console.log(`        burner pid ${burner.pid} = ${burnerProc.cpu} % of a core, machine = ${machine.toFixed(1)} % of all cores`)
  assert.ok(machine >= burnerProc.cpu * 0.5, `machine-wide ${machine.toFixed(1)} % misses the burner`)
})

check('sum(procs.cpu) roughly tracks the machine-wide CPU usage', () => {
  const sum = snapshot.procs.reduce((total, proc) => total + proc.cpu, 0)
  const expected = snapshot.cpu.usage * snapshot.cpu.perCore.length
  console.log(`        sum(procs.cpu) = ${sum.toFixed(1)} %, usage x cores = ${expected.toFixed(1)} %`)
  // Loose band: the two windows are offset and both are bursty, but a unit
  // error (USER_HZ, wall time, or percent scaling) would leave this band.
  assert.ok(burnerProc !== undefined && sum >= burnerProc.cpu * 0.8, `process CPU sum ${sum.toFixed(1)} misses the burner`)
  assert.ok(sum > 0 && sum <= snapshot.cpu.perCore.length * 100 * 1.5, `process CPU sum ${sum.toFixed(1)} implausible`)
  assert.ok(sum >= expected * 0.1 && sum <= expected * 10, `process CPU sum ${sum.toFixed(1)} vs machine ${expected.toFixed(1)}`)
})

burner.kill('SIGKILL')
await once(burner, 'exit')

// ---------------------------------------------------------------------------
// 4. History ring
// ---------------------------------------------------------------------------

check('hist.cpu has >= 2 samples after 2 s and all series stay aligned', () => {
  assert.ok(snapshot.hist.cpu.length >= 2, `hist.cpu.length = ${snapshot.hist.cpu.length}`)
  for (const key of ['t', 'cpu', 'mem', 'rx', 'tx']) {
    assert.equal(snapshot.hist[key].length, snapshot.hist.cpu.length, `hist.${key} length`)
  }
  assert.ok(snapshot.hist.cpu.every((value) => Number.isFinite(value)), 'hist.cpu values')
})

await checkAsync('history ring is capped at 90 samples', async () => {
  // Fake clock: 120 ticks with a real gap so /proc/stat deltas stay non-zero.
  let fake = Date.now()
  const capped = createSampler({ now: () => fake, intervalMs: 1000 })
  for (let index = 1; index <= 120; index += 1) {
    fake += 1000
    capped.tick()
    await sleep(6)
  }
  const state = capped.stats()
  const result = capped.getSnapshot()
  assert.equal(state.scans, 0, `a sampler that was never polled scanned ${state.scans} times`)
  assert.equal(result.hist.cpu.length, 90, `hist.cpu.length = ${result.hist.cpu.length}`)
  assert.equal(result.hist.t.length, 90, 'hist.t length')
  assert.equal(result.hist.t.at(-1), 120, `newest t = ${result.hist.t.at(-1)}`)
  assert.equal(result.hist.t[0], 31, `oldest t = ${result.hist.t[0]}`)
})

// ---------------------------------------------------------------------------
// 5. Kill helper
// ---------------------------------------------------------------------------

console.log('\n--- kill helper ---')
const sleepChild = spawn('sleep', ['60'], { stdio: 'ignore' })
await once(sleepChild, 'spawn')
const sleepPid = sleepChild.pid

await checkAsync('killProcess(pid, "TERM") reports success and the child dies within 2 s', async () => {
  const result = killProcess(sleepPid, 'TERM')
  assert.deepEqual(result, { status: 200, body: { ok: true } })
  const exited = Promise.race([
    once(sleepChild, 'exit'),
    sleep(2000).then(() => {
      throw new Error(`pid ${sleepPid} survived SIGTERM for 2 s`)
    }),
  ])
  await exited
  assert.ok(await waitGone(sleepPid, 500), `pid ${sleepPid} still has a /proc entry`)
})

check('killProcess refuses pid 1, the host pid and malformed input', () => {
  for (const pid of [1, process.pid, 0, -1, 1.5, Number.NaN, '1234', null, undefined]) {
    const result = killProcess(pid)
    assert.equal(result.status, 400, `pid ${String(pid)} should be refused`)
    assert.equal(result.body.ok, false)
    assert.equal(typeof result.body.error, 'string')
  }
  for (const signal of ['HUP', 'sighup', 15, true]) {
    const result = killProcess(sleepPid, signal)
    assert.equal(result.status, 400, `signal ${String(signal)} should be refused`)
    assert.equal(result.body.ok, false)
  }
})

check('killProcess answers 404/ESRCH for a pid that vanished', () => {
  const result = killProcess(killProbePid(), 'TERM')
  assert.equal(result.status, 404)
  assert.deepEqual(result.body.ok, false)
})

// ---------------------------------------------------------------------------
// 6. Route handlers (WHATWG Request/Response, no Cordis)
// ---------------------------------------------------------------------------

console.log('\n--- route handlers ---')
const snapshotRequest = new Request('http://localhost/api/sysmon.snapshot', { method: 'GET' })
const snapshotResponse = handleSnapshotRequest(sampler, snapshotRequest)
const served = await snapshotResponse.json()

check('GET /api/sysmon.snapshot answers 200 JSON with cache-control: no-store', () => {
  assert.equal(snapshotResponse.status, 200)
  assert.equal(snapshotResponse.headers.get('cache-control'), 'no-store')
  assert.match(snapshotResponse.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(served.v, 1)
  assert.ok(served.procs.length > 5)
})

await checkAsync('the snapshot route rejects POST with a JSON 405', async () => {
  const response = handleSnapshotRequest(
    sampler,
    new Request('http://localhost/api/sysmon.snapshot', { method: 'POST', body: '{}' }),
  )
  assert.equal(response.status, 405)
  assert.equal((await response.json()).error, 'method not allowed')
})

await checkAsync('the kill route rejects GET with a JSON 405 and bad bodies with 400', async () => {
  const wrongMethod = await handleKillRequest(new Request('http://localhost/api/sysmon.kill', { method: 'GET' }))
  assert.equal(wrongMethod.status, 405)
  assert.equal((await wrongMethod.json()).ok, false)

  const badJson = await handleKillRequest(
    new Request('http://localhost/api/sysmon.kill', { method: 'POST', body: 'not json' }),
  )
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).ok, false)

  const denied = await handleKillRequest(
    new Request('http://localhost/api/sysmon.kill', {
      method: 'POST',
      body: JSON.stringify({ pid: 1, signal: 'TERM' }),
    }),
  )
  assert.equal(denied.status, 400)
  assert.equal((await denied.json()).ok, false)
})

await checkAsync('POST /api/sysmon.kill terminates a real child and answers { ok: true }', async () => {
  const victim = spawn('sleep', ['60'], { stdio: 'ignore' })
  await once(victim, 'spawn')
  const response = await handleKillRequest(
    new Request('http://localhost/api/sysmon.kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: victim.pid, signal: 'TERM' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  await once(victim, 'exit')
  assert.ok(await waitGone(victim.pid, 500), `pid ${victim.pid} still has a /proc entry`)
})

// ---------------------------------------------------------------------------
// 7. `apply()` wiring against a fake Cordis context
// ---------------------------------------------------------------------------

console.log('\n--- apply() wiring (fake ctx) ---')
await checkAsync('apply() registers both exact routes and disposal releases them', async () => {
  const routes = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    connection: {
      fetch: {
        register(route) {
          assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  try {
    const snapshotRoute = routes.get('/api/sysmon.snapshot')
    const killRoute = routes.get('/api/sysmon.kill')
    assert.ok(snapshotRoute, 'snapshot route not registered')
    assert.ok(killRoute, 'kill route not registered')
    assert.deepEqual([...snapshotRoute.methods].sort(), ['GET', 'POST'])
    assert.deepEqual([...killRoute.methods].sort(), ['GET', 'POST'])
    assert.equal(snapshotRoute.requestBody, 'buffered')
    assert.equal(killRoute.requestBody, 'buffered')

    const served = await snapshotRoute.fetch(new Request('http://localhost/api/sysmon.snapshot'))
    assert.equal(served.status, 200)
    const body = await served.json()
    assert.equal(body.v, 1)
    assert.ok(body.procs.length > 5, 'route snapshot has no processes')

    const denied = await killRoute.fetch(
      new Request('http://localhost/api/sysmon.kill', { method: 'POST', body: JSON.stringify({ pid: 1 }) }),
    )
    assert.equal(denied.status, 400)
  } finally {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') await dispose()
    }
  }
  assert.equal(routes.size, 0, 'routes survived disposal')
})

// ---------------------------------------------------------------------------
// 8. `comm` containing spaces and parentheses
// ---------------------------------------------------------------------------

console.log('\n--- comm parsing ---')
const bashCandidates = ['/run/current-system/sw/bin/bash', '/bin/bash', '/usr/bin/bash']
let bashPath = null
for (const candidate of bashCandidates) {
  try {
    bashPath = fs.realpathSync(candidate)
    break
  } catch {
    bashPath = null
  }
}

if (bashPath === null) {
  console.log('  skip  no shell binary available for the comm edge case')
} else {
  const dir = fs.mkdtempSync('/tmp/sysmon-comm-')
  const weird = path.join(dir, 'a b)c')
  fs.copyFileSync(bashPath, weird)
  fs.chmodSync(weird, 0o755)
  const child = spawn(weird, ['-c', 'sleep 60; true'], { stdio: 'ignore' })
  await once(child, 'spawn')
  await sleep(100)
  check('comm with spaces and parentheses does not shift the stat fields', () => {
    const probe = collectOnce()
    const found = probe.procs.find((proc) => proc.pid === child.pid)
    assert.ok(found, `pid ${child.pid} missing from the scan`)
    assert.equal(found.cmd, 'a b)c', `cmd = ${found.cmd}`)
    assert.equal(found.state, 'S', `state = ${found.state}`)
    assert.ok(found.thr >= 1, 'thread count')
  })
  child.kill('SIGKILL')
  await once(child, 'exit')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 9. Cost of a tick and of a full process scan
// ---------------------------------------------------------------------------

const perf = createSampler()
perf.start()
const tickTimes = []
for (let index = 0; index < 5; index += 1) {
  const start = performance.now()
  perf.tick()
  tickTimes.push(performance.now() - start)
  await sleep(20)
}
const scanStart = performance.now()
perf.getSnapshot()
const scanMs = performance.now() - scanStart
perf.stop()
const avgTick = tickTimes.reduce((total, value) => total + value, 0) / tickTimes.length


// ---------------------------------------------------------------------------
// 10. Compact human summary, then the full JSON sample
// ---------------------------------------------------------------------------

const mb = (bytes) => (bytes === null ? 'n/a' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`)
const pct = (value) => (value === null ? 'n/a' : `${value.toFixed(1)} %`)
const top = [...snapshot.procs].sort((left, right) => right.cpu - left.cpu).slice(0, 5)

console.log('\n=== summary ===')
console.log(`host      ${snapshot.host.hostname}  ${snapshot.host.platform}/${snapshot.host.arch}  kernel ${snapshot.host.kernel}`)
console.log(`uptime    ${(snapshot.host.uptime / 3600).toFixed(1)} h   load ${snapshot.load.one}/${snapshot.load.five}/${snapshot.load.fifteen}`)
console.log(`cpu       ${pct(snapshot.cpu.usage)} of ${snapshot.cpu.perCore.length} cores   freq ${snapshot.cpu.freqMHz[0]} MHz   psi ${snapshot.pressure.cpu10}%`)
console.log(`mem       ${mb(snapshot.mem.used)} / ${mb(snapshot.mem.total)} used   available ${mb(snapshot.mem.available)}   swap ${mb(snapshot.mem.swapUsed)}`)
console.log(`net       rx ${(snapshot.net.rxBps / 1024).toFixed(1)} KiB/s   tx ${(snapshot.net.txBps / 1024).toFixed(1)} KiB/s   ifaces ${snapshot.net.ifaces.map((iface) => iface.name).join(',')}`)
console.log(`disk      read ${(snapshot.disk.readBps / 1024).toFixed(1)} KiB/s   write ${(snapshot.disk.writeBps / 1024).toFixed(1)} KiB/s   ${snapshot.disk.devices.map((device) => device.name).join(',')}`)
console.log(`procs     ${snapshot.counts.total} total, ${snapshot.counts.running} running, ${snapshot.counts.sleeping} sleeping, ${snapshot.counts.zombie} zombie, ${snapshot.counts.threads} threads`)
console.log(`hist      ${snapshot.hist.cpu.length} samples, step ${snapshot.hist.step} ms, newest t=${snapshot.hist.t.at(-1)}s`)
console.log(`cost      cheap tick avg ${avgTick.toFixed(2)} ms   full process scan ${scanMs.toFixed(1)} ms (${snapshot.procs.length} processes)`)
console.log(`top cpu   ${top.map((proc) => `${proc.cmd}(${proc.pid})=${proc.cpu}%`).join('  ')}`)

console.log('\n=== full JSON sample ===')
console.log(JSON.stringify(snapshot))

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) FAILED:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
