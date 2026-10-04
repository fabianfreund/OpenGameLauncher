import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import extractZip from 'extract-zip'
import { extract as extractTar } from 'tar'
import { channelAccepts, nameMatches, pickAsset } from '../shared/assets'
import { openttdManifestUrl, readOpenttdManifest } from '../shared/cdn'
import { fileListUrl, fileVersion } from '../shared/file-list'
import { itchFileEndpoint, itchVersion } from '../shared/itch'
import { safeTag } from '../shared/urls'
import type {
  ArchiveKind,
  FileListSource,
  Game,
  GameBuild,
  InstallView,
  LaunchSpec,
  PlatformBuild,
  PlatformId,
  ProgressEvent,
  RuntimeSpec
} from '../shared/types'
import { cached as diskCached } from './cache'
import { catalog } from './catalog'
import { downloadFile } from './download'
import { listedFiles } from './file-list'
import { fetchRelease, fetchReleases, type RemoteAsset, type RemoteRelease } from './github'
import { itchUploads, resolveItchDownload } from './itch'
import { installStore, WEB_CHANNEL, type InstallRecord } from './install-store'

const execFileAsync = promisify(execFile)
const listeners = new Set<(event: ProgressEvent) => void>()
const jobs = new Map<string, AbortController>()
const releaseCache = new Map<string, { at: number; releases: RemoteRelease[] }>()
const cdnCache = new Map<string, Promise<RemoteAsset[]>>()

function jobKey(gameId: string, channelId: string): string {
  return `${gameId}:${channelId}`
}

function emit(event: ProgressEvent) {
  for (const listener of listeners) listener(event)
}

export function onDownload(listener: (event: ProgressEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function listInstalls(): Promise<InstallView[]> {
  const store = await installStore()
  return store.views()
}

export async function setAutoUpdate(gameId: string, channelId: string, enabled: boolean): Promise<void> {
  const store = await installStore()
  await store.setAutoUpdate(gameId, channelId, enabled)
}

async function releasesFor(owner: string, repo: string): Promise<RemoteRelease[]> {
  const key = `${owner}/${repo}`
  const cached = releaseCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.releases
  const releases = await fetchReleases(owner, repo)
  releaseCache.set(key, { at: Date.now(), releases })
  return releases
}

// A released version's file list never changes, so it is fetched once and kept.
function cdnAssets(tag: string): Promise<RemoteAsset[]> {
  const known = cdnCache.get(tag)
  if (known) return known
  const pending = diskCached('openttd', tag, 365 * 24 * 60 * 60 * 1000, async () => {
    const response = await fetch(openttdManifestUrl(tag), { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`OpenTTD's CDN returned ${response.status}`)
    const assets = readOpenttdManifest(await response.text(), tag)
    if (assets.length === 0) throw new Error('OpenTTD manifest lists no files')
    return assets
  }).catch(() => {
    cdnCache.delete(tag)
    return [] as RemoteAsset[]
  })
  cdnCache.set(tag, pending)
  return pending
}

export async function listBuilds(game: Game, channelId: string): Promise<GameBuild[]> {
  const channel = game.channels.find((item) => item.id === channelId)
  if (!channel) throw new Error('That channel is not on this game')
  const platform = game.platforms[process.platform as PlatformId]
  if (!platform) return []
  if (channel.source.type === 'itch') return itchBuilds(channel.source.page, platform)
  if (channel.source.type === 'file-list') return fileListBuilds(channel.source, platform)
  const source = channel.source
  const releases = (await releasesFor(source.owner, source.repo))
    .filter((release) => !release.draft && channelAccepts(source.prerelease, release.prerelease))
    .slice(0, source.cdn ? 12 : undefined)
  const cdn = source.cdn
    ? await Promise.all(releases.map((release) => cdnAssets(release.tag)))
    : null
  const builds: GameBuild[] = []
  for (const [index, release] of releases.entries()) {
    const asset = pickAsset(platform.asset, process.arch, cdn?.[index] ?? release.assets)
    if (!asset) continue
    builds.push({
      tag: release.tag,
      title: release.title,
      publishedAt: release.publishedAt,
      prerelease: release.prerelease,
      notes: release.notes,
      asset
    })
  }
  return builds
}

// itch.io only lists the current uploads, so an itch channel has exactly one version.
async function itchBuilds(page: string, platform: PlatformBuild): Promise<GameBuild[]> {
  const uploads = await itchUploads(page)
  const asset = pickAsset(
    platform.asset,
    process.arch,
    uploads.map((upload) => ({ name: upload.name, url: itchFileEndpoint(page, upload.id), size: upload.size }))
  )
  if (!asset) return []
  const tag = itchVersion(asset.name)
  return [{ tag, title: tag, publishedAt: '', prerelease: false, notes: '', asset }]
}

// A download page lists every version's files together, so they are grouped by the version in the file name.
async function fileListBuilds(source: FileListSource, platform: PlatformBuild): Promise<GameBuild[]> {
  const versions = new Map<string, { prerelease: boolean; publishedAt: string; assets: RemoteAsset[] }>()
  for (const file of await listedFiles(source.page)) {
    const version = fileVersion(file.name)
    if (!version || !channelAccepts(source.prerelease, version.prerelease)) continue
    const entry = versions.get(version.tag) ?? { prerelease: version.prerelease, publishedAt: '', assets: [] }
    if (file.publishedAt > entry.publishedAt) entry.publishedAt = file.publishedAt
    entry.assets.push({ name: file.name, url: fileListUrl(source.page, file.name), size: file.size })
    versions.set(version.tag, entry)
  }
  const builds: GameBuild[] = []
  for (const [tag, entry] of versions) {
    const asset = pickAsset(platform.asset, process.arch, entry.assets)
    if (asset) builds.push({ tag, title: tag, publishedAt: entry.publishedAt, prerelease: entry.prerelease, notes: '', asset })
  }
  return builds
    .sort(
      (left, right) =>
        right.publishedAt.localeCompare(left.publishedAt) || right.tag.localeCompare(left.tag, undefined, { numeric: true })
    )
    .slice(0, 12)
}

// Mac apps are bundle folders; everything else must be a file, so a folder named like the binary is skipped.
async function findNamed(root: string, name: string, kind: 'app' | 'binary'): Promise<string | null> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const entries = await readdir(current.dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name)
      if (nameMatches(entry.name, name) && (kind === 'app' ? entry.isDirectory() : !entry.isDirectory())) return full
      if (entry.isDirectory() && current.depth < 4) queue.push({ dir: full, depth: current.depth + 1 })
    }
  }
  return null
}

async function clearQuarantine(directory: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', directory])
  } catch {
    // Quarantine is absent on files that were never downloaded by a browser.
  }
}

async function findApps(root: string, depth = 0): Promise<string[]> {
  const apps: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    if (entry.name.endsWith('.app')) apps.push(full)
    else if (depth < 3) apps.push(...(await findApps(full, depth + 1)))
  }
  return apps
}

// Finds the programs and libraries (Mach-O files) in a bundle, wherever the project put them.
async function findMachO(root: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await findMachO(full)))
    else if (entry.isFile()) {
      const handle = await open(full, 'r').catch(() => null)
      if (!handle) continue
      try {
        const magic = (await handle.read(Buffer.alloc(4), 0, 4, 0)).buffer.toString('hex')
        if (['cffaedfe', 'cefaedfe', 'cafebabe', 'feedfacf', 'feedface'].includes(magic)) found.push(full)
      } finally {
        await handle.close()
      }
    }
  }
  return found
}

// Apple silicon kills code whose signature does not match. Some projects bundle libraries they changed
// after signing, so the download never starts. Those apps carry no developer identity, only a local
// (ad-hoc) signature, and get a fresh one. An app signed by a real developer is left alone.
// Libraries outside the usual folders (SuperTux keeps them in Resources) are not covered by the bundle's
// signature check or by signing the bundle, so each file is checked and signed on its own first.
async function repairSignatures(directory: string): Promise<void> {
  if (process.platform !== 'darwin') return
  for (const bundle of await findApps(directory)) {
    const details = await execFileAsync('codesign', ['-dv', bundle]).then(
      (result) => `${result.stdout}${result.stderr}`,
      (error: { stderr?: string }) => error.stderr ?? ''
    )
    const hasDeveloper = /TeamIdentifier=(?!not set)\S+/.test(details)
    if (hasDeveloper) continue
    let repaired = false
    for (const file of await findMachO(bundle)) {
      const valid = await execFileAsync('codesign', ['--verify', '--strict', file]).then(() => true, () => false)
      if (valid) continue
      await execFileAsync('codesign', ['--force', '--sign', '-', file]).catch(() => undefined)
      repaired = true
    }
    if (!repaired) {
      try {
        await execFileAsync('codesign', ['--verify', '--deep', '--strict', bundle])
        continue
      } catch {
        // Falls through to the repair below.
      }
    }
    await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', bundle]).catch(() => undefined)
  }
}

// SDL 3 from the SDL project's own release, for apps that left it out.
const SDL3 = { owner: 'libsdl-org', repo: 'SDL', tag: 'release-3.4.16', inside: 'SDL3.xcframework/macos-arm64_x86_64/SDL3.framework' }
let sdl3Job: Promise<string> | null = null

function sdl3Framework(): Promise<string> {
  sdl3Job ??= (async () => {
    const directory = path.join(app.getPath('userData'), 'runtimes', 'sdl3', safeTag(SDL3.tag))
    const framework = path.join(directory, 'SDL3.framework')
    if (existsSync(framework)) return framework
    const release = await fetchRelease(SDL3.owner, SDL3.repo, SDL3.tag)
    const image = release.assets.find((asset) => /^SDL3-[\d.]+\.dmg$/.test(asset.name))
    if (!image) throw new Error('The SDL 3 release has no Mac download')
    const incoming = `${directory}.incoming`
    const mount = path.join(incoming, 'mount')
    await rm(incoming, { recursive: true, force: true })
    await mkdir(mount, { recursive: true })
    try {
      const file = path.join(incoming, 'SDL3.dmg')
      await downloadFile(image.url, file, () => undefined, AbortSignal.timeout(10 * 60 * 1000))
      await attachDmg(file, mount)
      try {
        await mkdir(directory, { recursive: true })
        await execFileAsync('ditto', [path.join(mount, SDL3.inside), framework])
      } finally {
        await execFileAsync('hdiutil', ['detach', mount, '-force']).catch(() => undefined)
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    } finally {
      await rm(incoming, { recursive: true, force: true })
    }
    return framework
  })()
  sdl3Job.catch(() => (sdl3Job = null))
  return sdl3Job
}

// Some Mac builds ship SDL 2 as a thin layer over SDL 3 (sdl2-compat) but leave SDL 3 out, and then stop
// at start with "Failed loading SDL3 library". OGL adds SDL 3 where that layer looks for it. The app's
// signature no longer matches after that, so it gets a local one.
async function addMissingSdl3(directory: string): Promise<void> {
  if (process.platform !== 'darwin') return
  for (const bundle of await findApps(directory)) {
    const frameworks = path.join(bundle, 'Contents', 'Frameworks')
    const names = await readdir(frameworks).catch(() => [] as string[])
    if (names.some((name) => /^(lib)?SDL3\b/.test(name))) continue
    let needed = false
    for (const name of names.filter((item) => /^libSDL2.*\.dylib$/.test(item))) {
      needed ||= (await readFile(path.join(frameworks, name))).includes('Failed loading SDL3 library')
    }
    if (!needed) continue
    await execFileAsync('ditto', [await sdl3Framework(), path.join(frameworks, 'SDL3.framework')])
    await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', bundle])
  }
}

// Some images show a license agreement on attach. hdiutil reads the answer from stdin, so it gets a Y.
function attachDmg(file: string, mount: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let errors = ''
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()))
    child.stdin.end('Y\n')
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(errors.trim() || `The disk image could not be opened (${code})`))
    )
  })
}

// Copies the app bundles out of a disk image, so the image never stays mounted.
async function extractDmg(file: string, into: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Disk images only open on a Mac')
  const mount = path.join(into, '.mount')
  await mkdir(mount, { recursive: true })
  await attachDmg(file, mount)
  try {
    for (const entry of await readdir(mount, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue
      await execFileAsync('ditto', [path.join(mount, entry.name), path.join(into, entry.name)])
    }
  } finally {
    await execFileAsync('hdiutil', ['detach', mount, '-force']).catch(() => undefined)
    await rm(mount, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function unpack(archive: ArchiveKind, archivePath: string, into: string): Promise<void> {
  if (archive === 'file') return
  if (archive === 'zip') await extractZip(archivePath, { dir: into })
  else if (archive === 'tar.gz') await extractTar({ file: archivePath, cwd: into })
  else if (archive === 'tar.xz') await execFileAsync('tar', ['-xJf', archivePath, '-C', into])
  else if (archive === 'dmg') await extractDmg(archivePath, into)
  await rm(archivePath, { force: true })
}

async function locate(
  archive: ArchiveKind,
  launch: LaunchSpec | undefined,
  archivePath: string,
  root: string
): Promise<{ executable: string; kind: InstallRecord['kind'] }> {
  if (archive === 'file') return { executable: archivePath, kind: 'binary' }
  const wanted =
    process.platform === 'darwin' && launch?.app
      ? { name: launch.app, kind: 'app' as const }
      : launch?.binary
        ? { name: launch.binary, kind: 'binary' as const }
        : launch?.app
          ? { name: launch.app, kind: 'app' as const }
          : null
  if (!wanted) throw new Error('This game does not say which file to launch')
  const found = await findNamed(root, wanted.name, wanted.kind)
  if (!found) {
    const entries = await readdir(root)
    const preview = entries.slice(0, 8).join(', ') || 'empty'
    throw new Error(`Couldn't find ${wanted.name} in the archive. Top level: ${preview}`)
  }
  return { executable: found, kind: wanted.kind }
}

const runtimeJobs = new Map<string, Promise<{ executable: string; kind: InstallRecord['kind'] }>>()

// Downloads an engine such as LÖVE once per version and shares it between games.
function ensureRuntime(spec: RuntimeSpec): Promise<{ executable: string; kind: InstallRecord['kind'] }> {
  const directory = path.join(app.getPath('userData'), 'runtimes', `${spec.owner}-${spec.repo}`, safeTag(spec.tag))
  const running = runtimeJobs.get(directory)
  if (running) return running
  const job = (async () => {
    const marker = path.join(directory, '.ogl-runtime.json')
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8')) as { executable: string; kind: InstallRecord['kind'] }
      return { executable: path.join(directory, saved.executable), kind: saved.kind }
    } catch {
      // Not downloaded yet.
    }
    const release = await fetchRelease(spec.owner, spec.repo, spec.tag)
    const asset = pickAsset(spec.asset, process.arch, release.assets)
    if (!asset) throw new Error(`${spec.repo} ${spec.tag} has no build for this machine`)
    const name = path.basename(asset.name)
    const incoming = `${directory}.incoming`
    await rm(incoming, { recursive: true, force: true })
    const archivePath = path.join(incoming, name)
    await downloadFile(asset.url, archivePath, () => undefined, AbortSignal.timeout(10 * 60 * 1000))
    await unpack(spec.archive, archivePath, incoming)
    const found = await locate(spec.archive, spec.launch, archivePath, incoming)
    if (found.kind === 'binary' && process.platform !== 'win32') await chmod(found.executable, 0o755)
    await clearQuarantine(incoming)
    await addMissingSdl3(incoming)
    await repairSignatures(incoming)
    const relative = path.relative(incoming, found.executable)
    await writeFile(path.join(incoming, '.ogl-runtime.json'), JSON.stringify({ executable: relative, kind: found.kind }))
    await rm(directory, { recursive: true, force: true })
    await mkdir(path.dirname(directory), { recursive: true })
    await rename(incoming, directory)
    return { executable: path.join(directory, relative), kind: found.kind }
  })()
  runtimeJobs.set(directory, job)
  job.catch(() => undefined).finally(() => runtimeJobs.delete(directory))
  return job
}

function requireGame(gameId: string): Game {
  const game = catalog.game(gameId)
  if (!game) throw new Error('That game is not in the catalog')
  return game
}

export async function installGame(gameId: string, channelId: string, tag: string): Promise<void> {
  const key = jobKey(gameId, channelId)
  if (jobs.has(key)) throw new Error('That game is already installing')
  const game = requireGame(gameId)
  const platform = game.platforms[process.platform as PlatformId]
  if (!platform) throw new Error('This game has no build for this system')
  const builds = await listBuilds(game, channelId)
  const build = builds.find((item) => item.tag === tag)
  if (!build) throw new Error('That version has no build for this machine')
  const channel = game.channels.find((item) => item.id === channelId)

  const controller = new AbortController()
  jobs.set(key, controller)
  const store = await installStore()
  const base = { gameId, channelId, tag, gameName: game.name, received: 0, total: build.asset.size }
  const directory = path.join(app.getPath('userData'), 'games', game.id, channelId, safeTag(tag))
  const incoming = `${directory}.incoming`

  try {
    await rm(incoming, { recursive: true, force: true })
    const archiveName = path.basename(build.asset.name)
    if (archiveName !== build.asset.name || archiveName.includes('..')) {
      throw new Error('The release file name is not usable')
    }
    const archivePath = path.join(incoming, archiveName)
    let lastEmit = 0
    const url = channel?.source.type === 'itch' ? await resolveItchDownload(build.asset.url) : build.asset.url
    await downloadFile(
      url,
      archivePath,
      (received, total) => {
        const now = Date.now()
        if (now - lastEmit < 100 && received !== total) return
        lastEmit = now
        emit({ ...base, phase: 'downloading', received, total })
      },
      controller.signal
    )
    emit({ ...base, phase: 'extracting', received: build.asset.size, total: build.asset.size })

    await unpack(platform.archive, archivePath, incoming)
    const found = await locate(platform.archive, platform.launch, archivePath, incoming)
    const { executable, kind } = found
    const runtime = platform.runtime ? await ensureRuntime(platform.runtime) : undefined

    // Files a runtime opens, such as .love, are data rather than programs.
    if (kind === 'binary' && !runtime && process.platform !== 'win32') await chmod(executable, 0o755)
    await clearQuarantine(incoming)
    await addMissingSdl3(incoming)
    await repairSignatures(incoming)
    const relative = path.relative(incoming, executable)
    await rm(directory, { recursive: true, force: true })
    await rename(incoming, directory)

    await store.saveInstall({
      gameId,
      channelId,
      tag,
      directory,
      executable: path.join(directory, relative),
      kind,
      args: platform.launch?.args ?? [],
      installedAt: new Date().toISOString(),
      autoUpdate: store.prefersAutoUpdate(gameId, channelId),
      ...(runtime ? { runtime } : {})
    })
    emit({ ...base, phase: 'done', received: build.asset.size, total: build.asset.size })
  } catch (error) {
    await rm(incoming, { recursive: true, force: true }).catch(() => undefined)
    if (controller.signal.aborted) {
      emit({ ...base, phase: 'done' })
      throw new Error('Download cancelled')
    }
    const message = error instanceof Error ? error.message : 'Install failed'
    emit({ ...base, phase: 'error', message })
    throw new Error(message)
  } finally {
    jobs.delete(key)
  }
}

export async function uninstallGame(gameId: string, channelId: string): Promise<void> {
  if (jobs.has(jobKey(gameId, channelId))) throw new Error('Wait for the install to finish first')
  const store = await installStore()
  if (channelId === WEB_CHANNEL) return store.removeWeb(gameId)
  const record = store.find(gameId, channelId)
  if (!record) return
  const root = path.join(app.getPath('userData'), 'games')
  const relative = path.relative(root, record.directory)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    await rm(record.directory, { recursive: true, force: true })
  }
  await store.removeInstall(gameId, channelId)
}

export async function showInstallFolder(gameId: string, channelId: string): Promise<string | null> {
  const store = await installStore()
  return store.find(gameId, channelId)?.executable ?? null
}

export function cancelInstall(gameId: string, channelId: string): void {
  jobs.get(jobKey(gameId, channelId))?.abort()
}

function launchLogFile(gameId: string, channelId: string): string {
  return path.join(app.getPath('userData'), 'logs', `${safeTag(gameId)}-${safeTag(channelId)}.log`)
}

async function bundleExecutable(bundle: string): Promise<string> {
  const directory = path.join(bundle, 'Contents', 'MacOS')
  const entries = await readdir(directory, { withFileTypes: true })
  const executable = entries.find((entry) => entry.isFile() || entry.isSymbolicLink())
  if (!executable) throw new Error(`Couldn't find the executable inside ${path.basename(bundle)}`)
  return path.join(directory, executable.name)
}

export function launchLog(gameId: string, channelId: string): string | null {
  const file = launchLogFile(gameId, channelId)
  return existsSync(file) ? file : null
}

// Each launch starts a fresh log: what OGL ran, then everything the game prints. The app bundle is not touched.
export async function launchGame(gameId: string, channelId: string): Promise<void> {
  const store = await installStore()
  const record = store.find(gameId, channelId)
  if (!record) throw new Error('Install the game first')

  // Arguments come from the current catalog, so a changed game file applies without reinstalling.
  const launch = catalog.game(gameId)?.platforms[process.platform as PlatformId]?.launch
  const args = launch?.args ?? record.args
  const environment = launch?.env
  const log = launchLogFile(gameId, channelId)
  const viaOpen = (target: string[]) => ['-n', '--stdout', log, '--stderr', log, ...target]
  const withArgs = args.length > 0 ? ['--args', ...args] : []
  const runtime = record.runtime
  const command = runtime
    ? process.platform === 'darwin' && runtime.kind === 'app'
      ? { file: 'open', args: viaOpen(['-a', runtime.executable, record.executable, ...withArgs]) }
      : { file: runtime.executable, args: [record.executable, ...args] }
    : process.platform === 'darwin' && record.kind === 'app'
      ? environment
        ? { file: await bundleExecutable(record.executable), args, environment }
        : { file: 'open', args: viaOpen([record.executable, ...withArgs]) }
      : { file: record.executable, args: args }
  const cwd = path.dirname(record.executable)

  await mkdir(path.dirname(log), { recursive: true })
  await writeFile(
    log,
    [
      `OGL launch ${new Date().toISOString()}`,
      `game: ${gameId} (${channelId}) ${record.tag}`,
      `executable: ${record.executable}`,
      ...(runtime ? [`runtime: ${runtime.executable}`] : []),
      `arguments: ${args.length > 0 ? args.join(' ') : '(none)'}`,
      `working directory: ${cwd}`,
      '--- game output ---',
      ''
    ].join('\n')
  )

  const output = command.file === 'open' ? null : openSync(log, 'a')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        cwd,
        detached: true,
        ...(command.environment ? { env: { ...process.env, ...command.environment } } : {}),
        stdio: output === null ? 'ignore' : ['ignore', output, output]
      })
      child.once('error', () => reject(new Error('The installed files are missing. Install the game again.')))
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  } finally {
    if (output !== null) closeSync(output)
  }
}

export async function autoUpdateInstalled(): Promise<void> {
  const store = await installStore()
  for (const record of store.list()) {
    if (!record.autoUpdate) continue
    const game = catalog.game(record.gameId)
    if (!game) continue
    try {
      const builds = await listBuilds(game, record.channelId)
      const latest = builds[0]
      if (!latest || latest.tag === record.tag) continue
      await installGame(record.gameId, record.channelId, latest.tag)
    } catch (error) {
      console.error(error)
    }
  }
}
