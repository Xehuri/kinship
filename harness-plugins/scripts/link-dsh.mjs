#!/usr/bin/env node
/**
 * Link the installed dsh package scope into this workspace's node_modules.
 *
 * The workspace declares dsh packages as peers. For local typecheck/build/test
 * we resolve them from the exact installation the harness runs, without
 * copying or symlinking into any DSH_HOME profile.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_DSH_PACKAGES =
  '/mnt/d/tools/node-v24.22.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const source = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES
if (!existsSync(source)) {
  console.error(`link-dsh: dsh package scope not found: ${source}`)
  console.error('Set DSH_PACKAGES_DIR to <dsh-install>/node_modules/@deepseek-ai')
  process.exit(1)
}

const scope = join(process.cwd(), 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })

let linked = 0
let present = 0
for (const name of readdirSync(source)) {
  const target = join(source, name)
  const link = join(scope, name)
  if (existsSync(link) || isSymlink(link)) {
    present += 1
    continue
  }
  symlinkSync(target, link, 'dir')
  linked += 1
}

const cliLink = join(scope, 'dsh')
const cliTarget = join(source, '..', '..')
if (existsSync(cliLink) || isSymlink(cliLink)) {
  present += 1
} else {
  symlinkSync(cliTarget, cliLink, 'dir')
  linked += 1
}

console.log(`link-dsh: ${String(linked)} linked, ${String(present)} already present (${source})`)

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) !== ''
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
