#!/usr/bin/env node
/**
 * Stage this library for the CDN.
 *
 *   node scripts/build-library.mjs [--out .library-dist] [--version <id>]
 *
 * Writes:
 *   <out>/objects/<hash>/<path>   every library file, content-addressed (hard links)
 *   <out>/index/<version>.json    per folder: lookup key → hash (or "hash:path")
 *   <out>/latest.json             { formatVersion, version }
 *
 * Content-addressed object keys never change meaning, so they are cached forever
 * and a publish uploads only files whose bytes changed. The index format is read
 * by `@eb/ldraw-parser` (src/part-library.ts) — bump FORMAT_VERSION on both sides.
 *
 * Our own parts live in custom_parts/ (same layout as parts/, e.g. custom_parts/s/)
 * and are looked up by id exactly like parts/ files. A custom id that also exists
 * in parts/, p/ or models/ fails the build rather than silently hiding either file.
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FORMAT_VERSION = 1
const HASH_LENGTH = 8
// three's LDrawLoader search order; the first folder wins a name clash.
const FOLDERS = ['parts', 'p', 'models']
const CUSTOM_FOLDER = 'custom_parts'
const ALL_FOLDERS = [...FOLDERS, CUSTOM_FOLDER]
const FILE_RE = /\.(?:dat|ldr|mpd|png)$/i

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (flag) => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const outDir = path.resolve(root, argValue('--out') ?? '.library-dist')
const version =
  argValue('--version') ?? execSync('git rev-parse --short=12 HEAD', { cwd: root }).toString().trim()

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && FILE_RE.test(entry.name)) yield full
  }
}

/** Library-relative paths in lookup precedence order: parts/, p/, models/, custom_parts/, then root files. */
function* libraryFiles() {
  for (const folder of ALL_FOLDERS) {
    if (!fs.existsSync(path.join(root, folder))) continue
    for (const full of walk(path.join(root, folder))) {
      yield path.relative(root, full).split(path.sep).join('/')
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && FILE_RE.test(entry.name)) yield entry.name
  }
}

/** Folder and lookup key; the key mirrors normalizeLibraryKey in @eb/ldraw-parser. */
function locate(relPath) {
  const lower = relPath.toLowerCase()
  const folder = ALL_FOLDERS.find((name) => lower.startsWith(`${name}/`)) ?? ''
  return { folder, key: folder ? lower.slice(folder.length + 1) : lower }
}

function linkOrCopy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.linkSync(from, to)
  } catch {
    fs.copyFileSync(from, to)
  }
}

const entries = []
const pathByKey = new Map()
const shadowed = []
const customClashes = []
for (const relPath of libraryFiles()) {
  const { folder, key } = locate(relPath)
  const earlier = pathByKey.get(key)
  if (earlier) {
    const line = `${relPath} (same id as ${earlier})`
    if (folder === CUSTOM_FOLDER || locate(earlier).folder === CUSTOM_FOLDER) customClashes.push(line)
    else shadowed.push(line)
    continue
  }
  pathByKey.set(key, relPath)
  entries.push({ relPath, folder, key })
}

if (customClashes.length > 0) {
  console.error(`${customClashes.length} custom part(s) share an id with another library file; rename them:`)
  for (const line of customClashes) console.error(`  ${line}`)
  process.exit(1)
}

fs.rmSync(outDir, { recursive: true, force: true })

const folders = {}
let count = 0
for (const { relPath, folder, key } of entries) {
  const source = path.join(root, relPath)
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, HASH_LENGTH)
  const impliedPath = folder ? `${folder}/${key}` : key
  folders[folder] ??= {}
  folders[folder][key] = relPath === impliedPath ? hash : `${hash}:${relPath}`
  linkOrCopy(source, path.join(outDir, 'objects', hash, relPath))
  count += 1
}

fs.mkdirSync(path.join(outDir, 'index'), { recursive: true })
fs.writeFileSync(
  path.join(outDir, 'index', `${version}.json`),
  JSON.stringify({ formatVersion: FORMAT_VERSION, version, folders }),
)
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ formatVersion: FORMAT_VERSION, version }))

console.log(`Staged ${count} files as version ${version} in ${path.relative(root, outDir)}/`)
if (shadowed.length > 0) {
  console.log(`${shadowed.length} file(s) hidden by an earlier folder with the same name:`)
  for (const line of shadowed) console.log(`  ${line}`)
}
