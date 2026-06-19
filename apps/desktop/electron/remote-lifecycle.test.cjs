/**
 * Tests for electron/remote-lifecycle.cjs.
 *
 * Run with: node --test electron/remote-lifecycle.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * Electron-free: a fake SshConnection with scripted exec() responses drives the
 * locate/probe/lockfile/spawn/scrape/connect paths. No real ssh, no real
 * dashboard.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LOCKFILE_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  buildSpawnCommand,
  cleanupStale,
  clientLockId,
  connect,
  fingerprintToken,
  locateHermes,
  lockfilePath,
  pidIsOurDashboard,
  probeRemotePlatform,
  readLockfile,
  remotePidAlive,
  scrapeReadyPort,
  spawnRemoteDashboard,
  writeLockfile
} = require('./remote-lifecycle.cjs')

// A fake SshConnection whose exec() is matched against an ordered list of
// [regex|fn, response|fn] rules. First match wins; unmatched commands return ''.
function fakeSsh(rules = []) {
  const calls = []
  return {
    calls,
    async exec(cmd) {
      calls.push(cmd)
      for (const [matcher, resp] of rules) {
        const hit = typeof matcher === 'function' ? matcher(cmd) : matcher.test(cmd)
        if (hit) {
          const out = typeof resp === 'function' ? resp(cmd) : resp
          if (out instanceof Error) throw out
          return out
        }
      }
      return ''
    }
  }
}

// --- locateHermes -----------------------------------------------------------

test('locateHermes prefers the explicit profile path when executable', async () => {
  const ssh = fakeSsh([[/\[ -x .*\/opt\/hermes/, 'OK']])
  assert.equal(await locateHermes(ssh, '/opt/hermes'), '/opt/hermes')
})

test('locateHermes falls back to the login-shell command -v probe', async () => {
  const ssh = fakeSsh([
    [/command -v hermes/, '/home/u/.local/bin/hermes\n'],
    [/\[ -x .*\.local\/bin\/hermes/, 'OK']
  ])
  assert.equal(await locateHermes(ssh, ''), '/home/u/.local/bin/hermes')
})

test('locateHermes tries the conventional venv path last', async () => {
  const ssh = fakeSsh([[/\[ -x .*venv\/bin\/hermes/, 'OK']])
  assert.equal(await locateHermes(ssh, ''), '~/.hermes/hermes-agent/venv/bin/hermes')
})

test('locateHermes throws a hermes-not-found error with an install hint', async () => {
  const ssh = fakeSsh([]) // nothing is executable
  await assert.rejects(() => locateHermes(ssh, ''), err => {
    assert.equal(err.kind, 'hermes-not-found')
    assert.match(err.message, /install/i)
    return true
  })
})

test('locateHermes uses a login shell for the command -v probe', async () => {
  const ssh = fakeSsh([[/command -v hermes/, '/x/hermes'], [/\[ -x/, 'OK']])
  await locateHermes(ssh, '')
  assert.ok(ssh.calls.some(c => /bash -lc/.test(c)), 'must probe in a login shell (PATH pitfall)')
})

// --- probeRemotePlatform ----------------------------------------------------

test('probeRemotePlatform accepts Linux and macOS', async () => {
  assert.deepEqual(await probeRemotePlatform(fakeSsh([[/uname/, 'Linux\nx86_64']])), {
    os: 'Linux',
    arch: 'x86_64'
  })
  assert.deepEqual(await probeRemotePlatform(fakeSsh([[/uname/, 'Darwin\narm64']])), {
    os: 'Darwin',
    arch: 'arm64'
  })
})

test('probeRemotePlatform rejects unsupported remote platforms', async () => {
  await assert.rejects(() => probeRemotePlatform(fakeSsh([[/uname/, 'MINGW64_NT\nx86_64']])), err => {
    assert.equal(err.kind, 'unsupported-platform')
    return true
  })
})

// --- lockfile ---------------------------------------------------------------

test('clientLockId sanitizes and bounds the id', () => {
  assert.equal(clientLockId('a/b c'), 'a_b_c')
  assert.equal(clientLockId(''), 'default')
  assert.ok(clientLockId('x'.repeat(200)).length <= 64)
})

test('lockfilePath nests under the remote desktop-ssh dir', () => {
  assert.match(lockfilePath('client1'), /\.hermes\/desktop-ssh\/client1\.lock\.json$/)
})

test('readLockfile returns null for missing, empty, malformed, or wrong-schema', async () => {
  assert.equal(await readLockfile(fakeSsh([[/cat/, '']]), 'c'), null)
  assert.equal(await readLockfile(fakeSsh([[/cat/, 'not json']]), 'c'), null)
  assert.equal(await readLockfile(fakeSsh([[/cat/, JSON.stringify({ schemaVersion: 999 })]]), 'c'), null)
  const good = { schemaVersion: LOCKFILE_SCHEMA_VERSION, pid: 1, port: 2 }
  assert.deepEqual(await readLockfile(fakeSsh([[/cat/, JSON.stringify(good)]]), 'c'), good)
})

test('writeLockfile mkdir -ps and stamps the schema version', async () => {
  const ssh = fakeSsh([])
  await writeLockfile(ssh, 'c', { pid: 7, port: 9 })
  const cmd = ssh.calls.join('\n')
  assert.match(cmd, /mkdir -p/)
  assert.match(cmd, new RegExp(`"schemaVersion":${LOCKFILE_SCHEMA_VERSION}`))
})

test('remotePidAlive maps kill -0 ALIVE/DEAD', async () => {
  assert.equal(await remotePidAlive(fakeSsh([[/kill -0/, 'ALIVE']]), 123), true)
  assert.equal(await remotePidAlive(fakeSsh([[/kill -0/, 'DEAD']]), 123), false)
  assert.equal(await remotePidAlive(fakeSsh([]), null), false)
})

test('pidIsOurDashboard requires hermes + dashboard + --isolated in the cmdline', async () => {
  const ours = 'env H=1 /x/hermes dashboard --isolated --no-open --host 127.0.0.1 --port 0'
  assert.equal(await pidIsOurDashboard(fakeSsh([[/cmdline|ps -o/, ours]]), 5), true)
  // a different hermes process (gateway) is NOT ours to kill
  assert.equal(await pidIsOurDashboard(fakeSsh([[/cmdline|ps -o/, '/x/hermes gateway']]), 5), false)
  // an unrelated process is never ours
  assert.equal(await pidIsOurDashboard(fakeSsh([[/cmdline|ps -o/, 'sshd: u@pts/0']]), 5), false)
})

test('cleanupStale kills ONLY a provably-ours pid, always drops the lockfile', async () => {
  // not ours → no kill, lockfile removed
  const notOurs = fakeSsh([[/cmdline|ps -o/, '/x/hermes gateway']])
  await cleanupStale(notOurs, 'c', 5)
  assert.ok(!notOurs.calls.some(c => /kill 5\b/.test(c)), 'must not kill a pid that is not our dashboard')
  assert.ok(notOurs.calls.some(c => /rm -f/.test(c)))

  // ours → killed + lockfile removed
  const ours = fakeSsh([[/cmdline|ps -o/, '/x/hermes dashboard --isolated']])
  await cleanupStale(ours, 'c', 9)
  assert.ok(ours.calls.some(c => /kill 9\b/.test(c)))
  assert.ok(ours.calls.some(c => /rm -f/.test(c)))
})

// --- spawn command + readiness scrape --------------------------------------

test('buildSpawnCommand uses --isolated --port 0 --no-open and a detached setsid', () => {
  const cmd = buildSpawnCommand('/x/hermes', 'work', 'tok_secret_value')
  assert.match(cmd, /--isolated/)
  assert.match(cmd, /--no-open/)
  assert.match(cmd, /--host 127\.0\.0\.1 --port 0/)
  assert.match(cmd, /--profile/)
  assert.match(cmd, /work/)
  assert.match(cmd, /setsid/)
  assert.match(cmd, /<\/dev\/null/)
  assert.match(cmd, /echo \$!/)
})

test('spawnRemoteDashboard writes a sentinel then returns the echoed pid', async () => {
  const ssh = fakeSsh([
    [/printf '%s\\\\n'/, ''], // sentinel write
    [/setsid/, '4242\n'] // spawn → pid
  ])
  const { pid, sentinel } = await spawnRemoteDashboard(ssh, { hermesPath: '/x/hermes', profile: '', token: 'tk' })
  assert.equal(pid, 4242)
  assert.match(sentinel, /^HERMES_SSH_SPAWN_/)
})

test('spawnRemoteDashboard rejects when no pid is returned', async () => {
  const ssh = fakeSsh([[/setsid/, 'not-a-pid']])
  await assert.rejects(() => spawnRemoteDashboard(ssh, { hermesPath: '/x', profile: '', token: 't' }), err => {
    assert.equal(err.kind, 'spawn-failed')
    return true
  })
})

test('scrapeReadyPort parses the READY line that follows the sentinel', async () => {
  const ssh = fakeSsh([[/awk/, 'some noise\nHERMES_DASHBOARD_READY port=51234\n']])
  const port = await scrapeReadyPort(ssh, 'SENT', { timeoutMs: 1000 })
  assert.equal(port, 51234)
})

test('scrapeReadyPort times out and reports a dead spawn', async () => {
  // never emits a READY line
  const ssh = fakeSsh([[/awk/, 'still starting...']])
  await assert.rejects(() => scrapeReadyPort(ssh, 'SENT', { timeoutMs: 60 }), err => {
    assert.equal(err.kind, 'ready-timeout')
    return true
  })
  // dead process before announcement → spawn-failed
  await assert.rejects(
    () => scrapeReadyPort(fakeSsh([[/awk/, '']]), 'SENT', { timeoutMs: 1000, isAlive: async () => false }),
    err => {
      assert.equal(err.kind, 'spawn-failed')
      return true
    }
  )
})

// --- connect() orchestration ------------------------------------------------

function connectDeps(ssh, over = {}) {
  return {
    ssh,
    clientId: 'client1',
    profile: '',
    forward: async () => {},
    cancelForward: async () => {},
    pickLocalPort: async () => 50001,
    waitForHermes: async () => {},
    probeStatus: async () => true,
    adoptServedToken: async (_baseUrl, spawn) => spawn || 'served-token',
    rememberLog: () => {},
    readyTimeoutMs: 2000,
    ...over
  }
}

test('connect() spawns fresh when there is no lockfile, adopts the served token', async () => {
  const ssh = fakeSsh([
    [/uname/, 'Linux\nx86_64'],
    [/\[ -x/, 'OK'],
    [/cat .*lock\.json/, ''], // no lockfile
    [/printf '%s\\\\n'/, ''],
    [/setsid/, '777\n'],
    [/kill -0 777/, 'ALIVE'],
    [/awk/, 'HERMES_DASHBOARD_READY port=51999\n']
  ])
  const result = await connect(connectDeps(ssh, { adoptServedToken: async () => 'the-served-token' }))
  assert.equal(result.reused, false)
  assert.equal(result.remotePort, 51999)
  assert.equal(result.localPort, 50001)
  assert.equal(result.pid, 777)
  assert.equal(result.token, 'the-served-token')
  assert.equal(result.baseUrl, 'http://127.0.0.1:50001')
  assert.equal(result.tokenFingerprint, fingerprintToken('the-served-token'))
})

test('connect() reuses a healthy dashboard when fingerprint + probe pass', async () => {
  const reuseToken = 'stored-token'
  const lock = {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    pid: 333,
    port: 40000,
    tokenFingerprint: fingerprintToken(reuseToken)
  }
  const ssh = fakeSsh([
    [/uname/, 'Linux\nx86_64'],
    [/\[ -x/, 'OK'],
    [/cat .*lock\.json/, JSON.stringify(lock)],
    [/kill -0/, 'ALIVE']
  ])
  const result = await connect(
    connectDeps(ssh, { reuseToken, adoptServedToken: async (_b, t) => t })
  )
  assert.equal(result.reused, true)
  assert.equal(result.pid, 333)
  assert.equal(result.remotePort, 40000)
  // never spawned
  assert.ok(!ssh.calls.some(c => /setsid/.test(c)), 'reuse path must not spawn a new dashboard')
})

test('connect() respawns when the lockfile protocolVersion is incompatible', async () => {
  const reuseToken = 'stored-token'
  // alive pid, matching fingerprint, but a protocolVersion we no longer accept
  const lock = {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION + 99,
    pid: 333,
    port: 40000,
    tokenFingerprint: fingerprintToken(reuseToken)
  }
  const ssh = fakeSsh([
    [/uname/, 'Linux\nx86_64'],
    [/\[ -x/, 'OK'],
    [/cat .*lock\.json/, JSON.stringify(lock)],
    [/kill -0 333/, 'ALIVE'],
    [/cmdline|ps -o/, ''], // not provably ours → not killed, lockfile dropped
    [/setsid/, '901\n'],
    [/kill -0 901/, 'ALIVE'],
    [/awk/, 'HERMES_DASHBOARD_READY port=44100\n']
  ])
  const result = await connect(connectDeps(ssh, { reuseToken, adoptServedToken: async () => 'fresh' }))
  assert.equal(result.reused, false, 'incompatible protocol must force a fresh spawn, not a reattach')
  assert.equal(result.pid, 901)
})

test('connect() fresh spawn writes hermesHome + protocolVersion into the lockfile', async () => {
  const writes = []
  const ssh = fakeSsh([
    [/uname/, 'Linux\nx86_64'],
    [/\[ -x/, 'OK'],
    [/cat .*lock\.json/, ''], // no lockfile
    [/HERMES_HOME/, '/home/jonny/.hermes\n'], // probeRemoteHermesHome
    [/printf '%s\\\\n'/, ''],
    [/setsid/, '700\n'],
    [/kill -0 700/, 'ALIVE'],
    [/awk/, 'HERMES_DASHBOARD_READY port=45500\n'],
    [/printf '%s' '/, c => { writes.push(c); return '' }] // writeLockfile printf
  ])
  await connect(connectDeps(ssh, { adoptServedToken: async () => 'fresh' }))
  const lockWrite = writes.find(c => c.includes('schemaVersion')) || ''
  assert.match(lockWrite, new RegExp(`"protocolVersion":${PROTOCOL_VERSION}`))
  assert.match(lockWrite, /"hermesHome":"\/home\/jonny\/\.hermes"/)
})

test('connect() respawns when the lockfile pid is dead (killed dashboard)', async () => {
  const lock = { schemaVersion: LOCKFILE_SCHEMA_VERSION, pid: 333, port: 40000, tokenFingerprint: fingerprintToken('t') }
  const ssh = fakeSsh([
    [/uname/, 'Linux\nx86_64'],
    [/\[ -x/, 'OK'],
    [/cat .*lock\.json/, JSON.stringify(lock)],
    [/kill -0 333/, 'DEAD'],
    [/cmdline|ps -o/, ''], // not provably ours
    [/setsid/, '888\n'],
    [/kill -0 888/, 'ALIVE'],
    [/awk/, 'HERMES_DASHBOARD_READY port=42000\n']
  ])
  const result = await connect(connectDeps(ssh, { reuseToken: 't', adoptServedToken: async () => 'fresh' }))
  assert.equal(result.reused, false)
  assert.equal(result.pid, 888)
  assert.equal(result.remotePort, 42000)
})

test('connect() respawns when the dashboard is wedged (alive pid, probe fails)', async () => {
  const reuseToken = 'stored'
  const lock = {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    pid: 333,
    port: 40000,
    tokenFingerprint: fingerprintToken(reuseToken)
  }
  const ssh = fakeSsh([
    [/uname/, 'Linux\nx86_64'],
    [/\[ -x/, 'OK'],
    [/cat .*lock\.json/, JSON.stringify(lock)],
    [/kill -0/, 'ALIVE'],
    [/cmdline|ps -o/, '/x/hermes dashboard --isolated'], // ours → may kill
    [/setsid/, '999\n'],
    [/kill -0 999/, 'ALIVE'],
    [/awk/, 'HERMES_DASHBOARD_READY port=43000\n']
  ])
  // probeStatus FAILS for the wedged dashboard → must respawn
  const result = await connect(
    connectDeps(ssh, { reuseToken, probeStatus: async () => false, adoptServedToken: async () => 'fresh' })
  )
  assert.equal(result.reused, false)
  assert.equal(result.pid, 999)
  assert.equal(result.remotePort, 43000)
})

test('connect() aborts on an unsupported remote platform before doing anything else', async () => {
  const ssh = fakeSsh([[/uname/, 'SunOS\nsun4v']])
  await assert.rejects(() => connect(connectDeps(ssh)), err => {
    assert.equal(err.kind, 'unsupported-platform')
    return true
  })
  assert.ok(!ssh.calls.some(c => /setsid/.test(c)))
})
