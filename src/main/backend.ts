import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import * as net from 'net'
import { app } from 'electron'
import { DEFAULT_BACKEND_HOST, DEFAULT_BACKEND_PORT } from '../shared/backendDefaults'

// Default port matches backend/app/config.py. Use a Vonvon-specific high port
// instead of 8000 so packaged builds don't silently attach to unrelated local
// services that happen to occupy the old default.
const BACKEND_PORT = parseInt(process.env.VONVON_BACKEND_PORT || String(DEFAULT_BACKEND_PORT), 10)
const BACKEND_HOST = DEFAULT_BACKEND_HOST

let backendProc: ChildProcess | null = null

function resolveHermesHome(): string {
  return process.env.HERMES_HOME || join(app.getPath('home'), '.vonvon', '.hermes')
}

/**
 * Locate the backend source directory (contains app/main.py).
 *  - Dev:       <repo>/backend
 *  - Packaged:  process.resourcesPath/backend  (added via extraResources)
 */
function resolveBackendDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'backend'),
    join(process.resourcesPath || '', 'backend'),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'app', 'main.py'))) return dir
  }
  return null
}

/**
 * Resolve the Python runtime that should run uvicorn.
 *
 * Priority:
 *  1. Packaged bundled runtime: Resources/backend-runtime/bin/python3
 *     (a python-build-standalone install with backend + hermes-agent
 *      preinstalled — shipped via electron-builder extraResources)
 *  2. Dev venv: <repo>/backend/.venv/bin/{uvicorn,python}
 *
 * Returns null if no runtime is available.
 */
function resolveUvicorn(backendDir: string): { cmd: string; args: string[] } | null {
  // 1. Packaged bundled runtime
  const bundledPy = join(process.resourcesPath || '', 'backend-runtime', 'bin', 'python3')
  if (existsSync(bundledPy)) {
    return { cmd: bundledPy, args: ['-m', 'uvicorn'] }
  }

  // 2. Dev venv
  const venvUvicorn = join(backendDir, '.venv', 'bin', 'uvicorn')
  if (existsSync(venvUvicorn)) {
    return { cmd: venvUvicorn, args: [] }
  }
  const venvPython = join(backendDir, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) {
    return { cmd: venvPython, args: ['-m', 'uvicorn'] }
  }
  return null
}

/** Probe whether something is already listening on the backend port. */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (inUse: boolean) => {
      socket.destroy()
      resolve(inUse)
    }
    socket.setTimeout(300)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/**
 * Spawn the FastAPI backend (uvicorn). Idempotent: if already running (either
 * managed by us or externally bound to the port), this is a no-op.
 *
 * Set VONVON_SKIP_BACKEND=1 to disable auto-start (e.g. when running uvicorn
 * yourself in another terminal).
 */
export async function startBackend(): Promise<void> {
  const isDev = !app.isPackaged
  if (process.env.VONVON_SKIP_BACKEND === '1') {
    console.log('[backend] VONVON_SKIP_BACKEND=1, skipping auto-start')
    return
  }
  if (backendProc && !backendProc.killed) {
    return
  }
  if (await isPortInUse(BACKEND_PORT, BACKEND_HOST)) {
    console.log(`[backend] port ${BACKEND_PORT} already in use, assuming external backend`)
    return
  }

  const backendDir = resolveBackendDir()
  if (!backendDir) {
    console.error('[backend] could not locate backend/ directory; auto-start aborted')
    return
  }

  const runner = resolveUvicorn(backendDir)
  if (!runner) {
    console.error(
      `[backend] no .venv found at ${backendDir}/.venv. ` +
        'Run `cd backend && python3.11 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]" -e ./hermes-agent` first.'
    )
    return
  }

  const args = [
    ...runner.args,
    'app.main:app',
    '--host',
    BACKEND_HOST,
    '--port',
    String(BACKEND_PORT),
  ]
  if (isDev) {
    args.push('--reload', '--reload-dir', join(backendDir, 'app'))
  }

  const hermesHome = resolveHermesHome()
  console.log(
    `[backend] spawning: ${runner.cmd} ${args.join(' ')} (cwd=${backendDir}, HERMES_HOME=${hermesHome})`
  )
  const child = spawn(runner.cmd, args, {
    cwd: backendDir,
    env: { ...process.env, PYTHONUNBUFFERED: '1', HERMES_HOME: hermesHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backendProc = child

  child.stdout?.on('data', (buf: Buffer) => {
    process.stdout.write(`[backend] ${buf.toString()}`)
  })
  child.stderr?.on('data', (buf: Buffer) => {
    // uvicorn writes startup logs to stderr, treat as info
    process.stderr.write(`[backend] ${buf.toString()}`)
  })
  child.on('exit', (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`)
    if (backendProc === child) backendProc = null
  })
  child.on('error', (err) => {
    console.error('[backend] spawn error:', err)
  })
}

/** Terminate the managed backend process. Safe to call multiple times. */
export function stopBackend(): void {
  const child = backendProc
  if (!child || child.killed) return
  backendProc = null
  try {
    child.kill('SIGTERM')
  } catch (err) {
    console.error('[backend] kill error:', err)
  }
  // Force kill if it hasn't exited within 3s
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }, 3000)
}
