#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = os.homedir()

const usage = `Usage: node scripts/install.mjs [options]

Installs review-until-clean for local ODW + common agent harness skill dirs.

Options:
  --dry-run              Print actions without writing files.
  --link                 Symlink skill dirs instead of copying. Falls back to copy on failure.
  --no-harness           Only install ~/.odw/workflows and ~/.agents/skills.
  --harness-dir <path>   Extra harness skills directory to receive review-until-clean.
  -h, --help             Show this help.
`

const args = process.argv.slice(2)
const extraHarnessDirs = []
let dryRun = false
let link = false
let installHarnesses = true

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--dry-run') dryRun = true
  else if (arg === '--link') link = true
  else if (arg === '--no-harness') installHarnesses = false
  else if (arg === '--harness-dir') {
    const value = args[++i]
    if (!value) fail('--harness-dir requires a path')
    extraHarnessDirs.push(value)
  } else if (arg === '-h' || arg === '--help') {
    console.log(usage)
    process.exit(0)
  } else {
    fail(`Unknown option: ${arg}`)
  }
}

const workflowSrc = path.join(root, 'workflows', 'review-and-correct.js')
const skillSrc = path.join(root, 'skills', 'review-until-clean')

const workflowDest = path.join(home, '.odw', 'workflows', 'review-and-correct.js')
const sharedSkillDest = path.join(home, '.agents', 'skills', 'review-until-clean')

const defaultHarnessSkillDirs = [
  path.join(home, '.codex', 'skills'),
  path.join(home, '.claude', 'skills'),
  path.join(home, '.cursor', 'skills'),
]

const harnessSkillDirs = installHarnesses
  ? [...defaultHarnessSkillDirs, ...extraHarnessDirs.map(expandHome)]
  : []

await assertExists(workflowSrc)
await assertExists(skillSrc)

await copyFile(workflowSrc, workflowDest)
await installSkill(skillSrc, sharedSkillDest)
for (const dir of harnessSkillDirs) {
  await installSkill(skillSrc, path.join(dir, 'review-until-clean'))
}

log('Done.')
log('ODW workflow: ' + workflowDest)
log('Shared skill: ' + sharedSkillDest)
if (harnessSkillDirs.length) log('Harness skill dirs: ' + harnessSkillDirs.join(', '))

async function copyFile(src, dest) {
  log(`${dryRun ? 'Would copy' : 'Copying'} ${src} -> ${dest}`)
  if (dryRun) return
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
}

async function installSkill(src, dest) {
  if (link) {
    const linked = await linkDir(src, dest)
    if (linked) return
    log(`Symlink failed; copying ${src} -> ${dest}`)
  } else {
    log(`${dryRun ? 'Would copy' : 'Copying'} ${src} -> ${dest}`)
  }
  if (dryRun) return
  await copyDir(src, dest)
}

async function linkDir(src, dest) {
  log(`${dryRun ? 'Would link' : 'Linking'} ${src} -> ${dest}`)
  if (dryRun) return true
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rm(dest, { recursive: true, force: true })
    await fs.symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    log(`Link failed: ${error.message}`)
    return false
  }
}

async function copyDir(src, dest) {
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(from, to)
    else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(from)
      await fs.symlink(target, to)
    } else if (entry.isFile()) await fs.copyFile(from, to)
  }
}

async function assertExists(target) {
  try {
    await fs.access(target)
  } catch {
    fail(`Missing required path: ${target}`)
  }
}

function expandHome(value) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return path.resolve(value)
}

function log(message) {
  console.log(message)
}

function fail(message) {
  console.error(message)
  console.error(usage)
  process.exit(1)
}
