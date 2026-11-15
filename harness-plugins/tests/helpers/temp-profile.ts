import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../..')

export interface TempProfile {
  readonly home: string
  readonly aiRoot: string
  readonly planRoot: string
  readonly profileDir: string
  cleanup(): void
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function dshBin(): string {
  const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifest), 'lib', 'bin.js')
}

function copyPackage(nodeModules: string, name: string, source: string): void {
  if (!existsSync(join(source, 'dist', 'index.js'))) {
    throw new Error(`missing ${join(source, 'dist', 'index.js')}; run npm run build first`)
  }
  const target = join(nodeModules, name)
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true })
}

/** Copy a package that ships plain files instead of a compiled `dist`. */
function copyPlainPackage(nodeModules: string, name: string, source: string, entries: readonly string[]): void {
  const target = join(nodeModules, name)
  mkdirSync(target, { recursive: true })
  for (const entry of entries) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
}

export function installTempProfile(): TempProfile {
  const home = mkdtempSync(join(tmpdir(), 'kinship-dsh-home-'))
  const aiRoot = join(home, 'ai')
  const planRoot = join(aiRoot, 'data')
  const profileDir = join(home, 'profiles', 'kinship-test')
  const nodeModules = join(profileDir, 'node_modules')

  mkdirSync(join(aiRoot, 'agents'), { recursive: true })
  mkdirSync(planRoot, { recursive: true })
  mkdirSync(nodeModules, { recursive: true })
  writeFileSync(
    join(aiRoot, 'agents', 'main.md'),
    '# Kinship test persona\n\nPERSONA-MARKER\n',
    'utf8',
  )

  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-kinship-test',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'kinship-harness-plugins'],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')

  copyPackage(nodeModules, 'kinship-bridge', join(REPO_ROOT, 'packages/kinship-bridge'))
  copyPackage(nodeModules, 'kinship-plan', join(REPO_ROOT, 'packages/kinship-plan'))
  copyPackage(nodeModules, 'kinship-task-compat', join(REPO_ROOT, 'packages/kinship-task-compat'))
  copyPlainPackage(nodeModules, 'kinship-ui', join(REPO_ROOT, 'packages/kinship-ui'), ['package.json', 'index.js', 'client.js'])

  const bundle = join(nodeModules, 'kinship-harness-plugins')
  mkdirSync(join(bundle, 'presets'), { recursive: true })
  cpSync(join(REPO_ROOT, 'package.json'), join(bundle, 'package.json'))
  cpSync(join(REPO_ROOT, 'cordis.patch.yml'), join(bundle, 'cordis.patch.yml'))
  cpSync(join(REPO_ROOT, 'presets', 'kinship.patch.yml'), join(bundle, 'presets', 'kinship.patch.yml'))

  return {
    home,
    aiRoot,
    planRoot,
    profileDir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

export function runDsh(args: readonly string[], profile: TempProfile, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolveRun, reject) => {
    const child = spawn(process.execPath, [dshBin(), ...args], {
      cwd: profile.home,
      env: {
        ...process.env,
        DSH_HOME: profile.home,
        DSH_TELEMETRY_DISABLED: '1',
        KINSHIP_AI_ROOT: profile.aiRoot,
        KINSHIP_PLAN_ROOT: profile.planRoot,
        KINSHIP_BRIDGE_TOKEN: 'test-token',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh ${args.join(' ')} timed out\n${stderr}`))
    }, 120_000)
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
