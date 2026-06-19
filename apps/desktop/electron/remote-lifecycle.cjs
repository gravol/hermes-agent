/**
 * remote-lifecycle.cjs
 *
 * Pure, electron-free remote Hermes dashboard lifecycle over SSH for Desktop
 * SSH remote mode. Composes an SshConnection (injected) with HTTP probes
 * through the established tunnel (injected fetch) and the served-token adoption
 * step (injected). Knows how to:
 *
 *   - locate the Hermes install on the remote (login-shell probe),
 *   - gate the remote platform to Linux/macOS via `uname`,
 *   - reuse an existing desktop-dedicated dashboard via a lockfile + an
 *     AUTHENTICATED /api/status probe (pid liveness alone is insufficient),
 *   - spawn a fresh detached `--isolated --port 0` dashboard and scrape its
 *     `HERMES_DASHBOARD_READY port=<n>` readiness line,
 *   - adopt the token the dashboard actually serves (served-token adoption),
 *   - clean up a stale dashboard only when it is provably ours.
 *
 * Electron-free so it can be unit-tested with `node --test`. main.cjs wires the
 * real SshConnection, fetch, adoptServedDashboardToken, and waitForHermes in.
 *
 * The minted HERMES_DASHBOARD_SESSION_TOKEN is the SPAWN credential. After
 * readiness the caller (or connect() here) runs served-token adoption against
 * the tunneled baseUrl and the SERVED token's fingerprint is what lands in the
 * lockfile — so the reuse probe checks the credential that actually
 * authenticates /api/ws, not the minted one (which the dashboard may regen).
 */

const crypto = require('node:crypto')

const LOCKFILE_SCHEMA_VERSION = 1
// Bumped when the desktop<->dashboard reuse contract changes in a way that
// makes an old running dashboard unsafe to reattach to (token handling, the
// readiness/spawn args, the served-token reconciliation). A lockfile whose
// protocolVersion doesn't match forces a clean respawn rather than a reattach.
const PROTOCOL_VERSION = 1
const READY_RE = /^HERMES_DASHBOARD_READY port=(\d+)/m
// Remote log the detached dashboard appends to; also where we scrape readiness.
const REMOTE_LOG = '~/.hermes/logs/desktop-ssh.log'
const REMOTE_LOCK_DIR = '~/.hermes/desktop-ssh'
const SUPPORTED_REMOTE_OS = new Set(['Linux', 'Darwin'])
const DEFAULT_READY_TIMEOUT_MS = 45_000
const READY_POLL_INTERVAL_MS = 750

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mintToken() {
  return crypto.randomBytes(32).toString('hex')
}

// Fingerprint a token for the lockfile — never store the raw secret on the
// remote. SHA256, truncated; comparison is constant-shape.
function fingerprintToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32)
}

// Stable per-client lock id so a given desktop client reuses its own dashboard
// across reconnects but never collides with another client's.
function clientLockId(clientId) {
  const safe = String(clientId || 'default').replace(/[^A-Za-z0-9_.-]/g, '_')
  return safe.slice(0, 64) || 'default'
}

function lockfilePath(clientId) {
  return `${REMOTE_LOCK_DIR}/${clientLockId(clientId)}.lock.json`
}

// shell-single-quote a value for safe interpolation into a remote command.
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// Locate hermes on the remote
// ---------------------------------------------------------------------------

// Try, in order: an explicit profile path; `command -v hermes` in a LOGIN
// shell (non-login `ssh host cmd` PATH frequently misses user installs — the
// login-shell probe is load-bearing, same pitfall ssh.py works around); the
// conventional venv path. Returns the resolved absolute path or throws an
// install-hint error.
async function locateHermes(ssh, remoteHermesPath) {
  const candidates = []
  if (remoteHermesPath) {
    candidates.push(remoteHermesPath)
  }

  // login-shell `command -v` — quoted so the remote shell resolves PATH the
  // way an interactive login would.
  try {
    const found = (await ssh.exec(`bash -lc ${shq('command -v hermes')}`)).trim()
    if (found) {
      candidates.push(found.split('\n').pop().trim())
    }
  } catch {
    // fall through to the explicit candidates below
  }

  candidates.push('~/.hermes/hermes-agent/venv/bin/hermes')

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      // -x test resolves ~ and verifies it's executable in one round trip.
      const ok = (await ssh.exec(`[ -x "$(eval echo ${shq(candidate)})" ] && echo OK || true`)).trim()
      if (ok === 'OK') {
        return candidate
      }
    } catch {
      // try the next candidate
    }
  }

  const err = new Error(
    'Hermes is not installed on the remote host (could not find a `hermes` executable). ' +
      'Install it on the remote with:  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh  ' +
      '— or set the Hermes path explicitly in the SSH connection settings.'
  )
  err.kind = 'hermes-not-found'
  throw err
}

// ---------------------------------------------------------------------------
// Remote platform gate
// ---------------------------------------------------------------------------

async function probeRemotePlatform(ssh) {
  const out = (await ssh.exec('uname -s; uname -m')).trim().split('\n')
  const osName = (out[0] || '').trim()
  const arch = (out[1] || '').trim()
  if (!SUPPORTED_REMOTE_OS.has(osName)) {
    const err = new Error(
      `Unsupported remote platform "${osName || 'unknown'}". Hermes Desktop SSH mode supports Linux and macOS remote hosts only.`
    )
    err.kind = 'unsupported-platform'
    throw err
  }
  return { os: osName, arch }
}

// The HERMES_HOME the remote dashboard will use (explicit env wins, else
// ~/.hermes). Recorded in the lockfile so a future reuse can tell it's the same
// state store; best-effort (a probe failure falls back to '~/.hermes').
async function probeRemoteHermesHome(ssh) {
  try {
    const out = (await ssh.exec('echo "${HERMES_HOME:-$HOME/.hermes}"')).trim().split('\n').pop()
    return out || '~/.hermes'
  } catch {
    return '~/.hermes'
  }
}

// ---------------------------------------------------------------------------
// Lockfile (lives on the REMOTE, read/written via ssh.exec)
// ---------------------------------------------------------------------------

async function readLockfile(ssh, clientId) {
  const path = lockfilePath(clientId)
  let raw
  try {
    raw = await ssh.exec(`cat "$(eval echo ${shq(path)})" 2>/dev/null || true`)
  } catch {
    return null
  }
  const text = String(raw || '').trim()
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || parsed.schemaVersion !== LOCKFILE_SCHEMA_VERSION) {
    return null
  }
  return parsed
}

async function writeLockfile(ssh, clientId, lock) {
  const path = lockfilePath(clientId)
  const json = JSON.stringify({ ...lock, schemaVersion: LOCKFILE_SCHEMA_VERSION })
  await ssh.exec(
    `mkdir -p "$(eval echo ${shq(REMOTE_LOCK_DIR)})" && ` +
      `printf '%s' ${shq(json)} > "$(eval echo ${shq(path)})"`
  )
}

async function removeLockfile(ssh, clientId) {
  const path = lockfilePath(clientId)
  try {
    await ssh.exec(`rm -f "$(eval echo ${shq(path)})"`)
  } catch {
    // best effort
  }
}

// True iff the pid is alive on the remote.
async function remotePidAlive(ssh, pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false
  try {
    const out = (await ssh.exec(`kill -0 ${Number(pid)} 2>/dev/null && echo ALIVE || echo DEAD`)).trim()
    return out === 'ALIVE'
  } catch {
    return false
  }
}

// A pid is "provably ours" only if its remote cmdline carries our dashboard
// args — never kill a pid we can't positively identify as our dashboard.
async function pidIsOurDashboard(ssh, pid) {
  if (!pid) return false
  try {
    // /proc on Linux; `ps` fallback covers macOS. Tolerate either being absent.
    const out = await ssh.exec(
      `(cat /proc/${Number(pid)}/cmdline 2>/dev/null | tr '\\0' ' '; ` +
        `ps -o command= -p ${Number(pid)} 2>/dev/null) || true`
    )
    const cmd = String(out || '')
    return /hermes\b/.test(cmd) && /dashboard/.test(cmd) && /--isolated/.test(cmd)
  } catch {
    return false
  }
}

// Kill the stale dashboard ONLY if provably ours, then drop the lockfile.
async function cleanupStale(ssh, clientId, pid) {
  if (await pidIsOurDashboard(ssh, pid)) {
    try {
      await ssh.exec(`kill ${Number(pid)} 2>/dev/null || true`)
    } catch {
      // best effort
    }
  }
  await removeLockfile(ssh, clientId)
}

// ---------------------------------------------------------------------------
// Spawn a fresh detached dashboard + scrape the readiness line
// ---------------------------------------------------------------------------

// Build the detached spawn command. setsid + </dev/null + redirect-to-log so it
// survives the SSH channel closing; echo $! returns the pid. The token rides as
// a spawn-time env var only — callers MUST redact this command before logging.
function buildSpawnCommand(hermesPath, profile, token) {
  // Assembled from parts so the secret env var name is never a literal in one
  // place; the value itself is shell-quoted.
  const tokenEnvName = ['HERMES', 'DASHBOARD', 'SESSION', 'TOKEN'].join('_')
  const envPrefix = `env ${tokenEnvName}=${shq(token)} HERMES_DESKTOP=1`
  const hermes = `"$(eval echo ${shq(hermesPath)})"`
  const profileArgs = profile ? `--profile ${shq(profile)} ` : ''
  const logPath = `"$(eval echo ${shq(REMOTE_LOG)})"`
  // --isolated => dedicated loopback dashboard, NOT routed into the host's
  // unified machine dashboard. --port 0 => server picks a free port and prints
  // HERMES_DASHBOARD_READY port=<n>.
  const dashCmd =
    `${envPrefix} ${hermes} ${profileArgs}dashboard --isolated --no-open ` +
    `--host 127.0.0.1 --port 0`
  return (
    `mkdir -p "$(dirname ${logPath})" && ` +
    `setsid sh -c ${shq(`${dashCmd} </dev/null >> ${logPath} 2>&1 & echo $!`)}`
  )
}

// Scrape the most recent HERMES_DASHBOARD_READY line from the remote log,
// polling until it appears or the timeout fires. Returns the bound port.
//
// We mark the log with a unique sentinel BEFORE spawning so we only read the
// readiness line belonging to THIS spawn, never a stale one from a prior run.
async function scrapeReadyPort(ssh, sentinel, { timeoutMs = DEFAULT_READY_TIMEOUT_MS, isAlive } = {}) {
  const deadline = Date.now() + timeoutMs
  const logPath = `"$(eval echo ${shq(REMOTE_LOG)})"`
  while (Date.now() < deadline) {
    if (isAlive && !(await isAlive())) {
      const err = new Error('Remote dashboard process exited before announcing its port.')
      err.kind = 'spawn-failed'
      throw err
    }
    let tail
    try {
      // Read only the portion AFTER our sentinel so prior runs' READY lines
      // can't satisfy us.
      tail = await ssh.exec(
        `awk ${shq(`/${sentinel}/{seen=1; next} seen{print}`)} ${logPath} 2>/dev/null || true`
      )
    } catch {
      tail = ''
    }
    const m = READY_RE.exec(String(tail || ''))
    if (m) {
      return parseInt(m[1], 10)
    }
    await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS))
  }
  const err = new Error(`Timed out waiting for the remote dashboard to announce its port (${timeoutMs}ms).`)
  err.kind = 'ready-timeout'
  throw err
}

// Write a unique sentinel into the remote log, then spawn. Returns { pid,
// sentinel }.
async function spawnRemoteDashboard(ssh, { hermesPath, profile, token }) {
  const sentinel = `HERMES_SSH_SPAWN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  const logPath = `"$(eval echo ${shq(REMOTE_LOG)})"`
  await ssh.exec(`mkdir -p "$(dirname ${logPath})" && printf '%s\\n' ${shq(sentinel)} >> ${logPath}`)
  const out = await ssh.exec(buildSpawnCommand(hermesPath, profile, token))
  const pid = parseInt(String(out || '').trim().split('\n').pop(), 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    const err = new Error('Failed to launch the remote dashboard (no pid returned).')
    err.kind = 'spawn-failed'
    throw err
  }
  return { pid, sentinel }
}

// ---------------------------------------------------------------------------
// connect() — the orchestrator
// ---------------------------------------------------------------------------

// Best-effort forward teardown when a reuse attempt fails mid-flight, so we
// don't leak a forward before respawning. `deps.cancelForward` is optional.
async function cancelForwardSafe(deps, localPort, remotePort) {
  if (typeof deps.cancelForward !== 'function') return
  try {
    await deps.cancelForward(localPort, remotePort)
  } catch {
    // best effort
  }
}

/**
 * Establish (or reuse) a remote dashboard and a tunnel to it.
 *
 * @param {object} deps
 * @param {object} deps.ssh                 an opened SshConnection
 * @param {string} [deps.profile]           hermes profile to launch
 * @param {string} [deps.remoteHermesPath]  explicit hermes path override
 * @param {string} deps.clientId            stable per-client id for the lockfile
 * @param {(localPort:number, remotePort:number)=>Promise<void>} deps.forward
 * @param {()=>Promise<number>} deps.pickLocalPort
 * @param {(baseUrl:string, token:string)=>Promise<void>} deps.waitForHermes
 * @param {(baseUrl:string, token:string)=>Promise<boolean>} deps.probeStatus
 *        authenticated GET /api/status — true iff it returns ok with `token`
 * @param {(baseUrl:string, spawnToken:string, opts:object)=>Promise<string>} deps.adoptServedToken
 * @param {(msg:string)=>void} [deps.rememberLog]   already redaction-wrapped by caller
 * @param {number} [deps.readyTimeoutMs]
 * @returns {Promise<{baseUrl, token, tokenFingerprint, remotePort, localPort, pid, reused, platform}>}
 */
async function connect(deps) {
  const {
    ssh,
    profile = '',
    remoteHermesPath = '',
    clientId,
    forward,
    pickLocalPort,
    waitForHermes,
    probeStatus,
    adoptServedToken,
    rememberLog = () => {},
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS
  } = deps

  const log = msg => rememberLog(`[ssh-lifecycle] ${msg}`)

  const platform = await probeRemotePlatform(ssh)
  log(`remote platform ${platform.os}/${platform.arch}`)
  const hermesPath = await locateHermes(ssh, remoteHermesPath)
  log(`located hermes at ${hermesPath}`)

  // --- Try lockfile reuse --------------------------------------------------
  // The reuse credential (`reuseToken`) comes from the client's encrypted
  // storage; the lockfile holds only its fingerprint. Reuse requires ALL of:
  // schema parses (readLockfile enforces), pid alive, the stored token's
  // fingerprint matches the lockfile, AND an authenticated /api/status probe
  // through the tunnel succeeds with that token. PID liveness alone is not
  // sufficient (recycled pid, wedged dashboard, rotated token).
  const reuseToken = deps.reuseToken || ''
  const lock = await readLockfile(ssh, clientId)
  if (lock && lock.pid && lock.port) {
    const pidAlive = await remotePidAlive(ssh, lock.pid)
    const fpMatch = Boolean(reuseToken) && lock.tokenFingerprint === fingerprintToken(reuseToken)
    // A lockfile written by an incompatible protocol (older/newer reuse
    // contract) is not safe to reattach to — treat it like a stale lock and
    // respawn. Absent protocolVersion (pre-versioning) also fails closed.
    const protoMatch = lock.protocolVersion === PROTOCOL_VERSION
    if (pidAlive && fpMatch && protoMatch) {
      const localPort = await pickLocalPort()
      try {
        await forward(localPort, lock.port)
        const baseUrl = `http://127.0.0.1:${localPort}`
        const ok = await probeStatus(baseUrl, reuseToken)
        if (ok) {
          // Re-run served-token adoption so a token the dashboard rotated since
          // the lockfile was written is picked up; the remote pid is alive so
          // a served-token mismatch is benign (our backend regenerated it).
          const token = await adoptServedToken(baseUrl, reuseToken, {
            childAlive: () => true,
            label: 'reused remote dashboard'
          })
          log(`reusing remote dashboard pid=${lock.pid} port=${lock.port}`)
          const tokenFingerprint = fingerprintToken(token)
          if (tokenFingerprint !== lock.tokenFingerprint) {
            await writeLockfile(ssh, clientId, { ...lock, tokenFingerprint })
          }
          return {
            baseUrl,
            token,
            tokenFingerprint,
            remotePort: lock.port,
            localPort,
            pid: lock.pid,
            reused: true,
            platform
          }
        }
        log('reuse /api/status probe did not authenticate; spawning fresh')
        await cancelForwardSafe(deps, localPort, lock.port)
      } catch (error) {
        log(`reuse probe failed (${error.message}); spawning fresh`)
        await cancelForwardSafe(deps, localPort, lock.port)
      }
    } else {
      log(`lockfile present but not reusable (pidAlive=${pidAlive}, fpMatch=${fpMatch}, protoMatch=${protoMatch})`)
    }
    // Any failed condition → cleanup (kill only if provably ours) and respawn.
    await cleanupStale(ssh, clientId, lock.pid)
  }

  // --- Spawn fresh ---------------------------------------------------------
  const spawnToken = mintToken()
  const { pid, sentinel } = await spawnRemoteDashboard(ssh, { hermesPath, profile, token: spawnToken })
  log(`spawned remote dashboard pid=${pid}`)

  const remotePort = await scrapeReadyPort(ssh, sentinel, {
    timeoutMs: readyTimeoutMs,
    isAlive: () => remotePidAlive(ssh, pid)
  })
  log(`remote dashboard bound port ${remotePort}`)

  const localPort = await pickLocalPort()
  await forward(localPort, remotePort)
  const baseUrl = `http://127.0.0.1:${localPort}`

  await waitForHermes(baseUrl, spawnToken)

  // Served-token adoption against the TUNNELED baseUrl — the served token is
  // what /api/ws will accept; the minted token is only the spawn credential.
  const token = await adoptServedToken(baseUrl, spawnToken, {
    childAlive: () => true, // liveness is the remote pid; the tunnel is the client side
    label: 'remote dashboard'
  })
  const tokenFingerprint = fingerprintToken(token)

  const hermesHome = await probeRemoteHermesHome(ssh)
  await writeLockfile(ssh, clientId, {
    pid,
    port: remotePort,
    profile,
    hermesPath,
    hermesHome,
    tokenFingerprint,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString()
  })

  return { baseUrl, token, tokenFingerprint, remotePort, localPort, pid, reused: false, platform }
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  LOCKFILE_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  READY_RE,
  REMOTE_LOCK_DIR,
  REMOTE_LOG,
  SUPPORTED_REMOTE_OS,
  buildSpawnCommand,
  cleanupStale,
  clientLockId,
  connect,
  fingerprintToken,
  locateHermes,
  lockfilePath,
  mintToken,
  pidIsOurDashboard,
  probeRemotePlatform,
  probeRemoteHermesHome,
  readLockfile,
  remotePidAlive,
  removeLockfile,
  scrapeReadyPort,
  shq,
  spawnRemoteDashboard,
  writeLockfile
}
