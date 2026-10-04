import type {
  ArchiveKind,
  CdnKind,
  Game,
  GameChannel,
  LaunchSpec,
  PlatformBuild,
  PlatformId,
  PrereleaseFilter
} from './types'
import { isAllowedAssetUrl } from './urls'

const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHS = ['arm64', 'x64', 'ia32'] as const
const ARCHIVES = ['zip', 'tar.gz', 'tar.xz', 'dmg', 'file'] as const
const CDNS = ['openttd'] as const
const FILTERS = ['exclude', 'only', 'include'] as const
const GAME_KEYS = new Set([
  '$schema',
  'id',
  'name',
  'mark',
  'tagline',
  'website',
  'note',
  'accent',
  'cover',
  'icon',
  'screenshots',
  'tags',
  'web',
  'requires',
  'channels',
  'platforms'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pushUnknown(value: Record<string, unknown>, allowed: Set<string>, where: string, errors: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${where} has unknown property "${key}"`)
  }
}

function readString(
  value: unknown,
  where: string,
  errors: string[],
  pattern?: RegExp,
  max = 200
): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    errors.push(`${where} must be a short string`)
    return null
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${where} has the wrong shape`)
    return null
  }
  return value
}

function readName(value: unknown, where: string, errors: string[]): string | null {
  const name = readString(value, where, errors, undefined, 120)
  if (!name) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    errors.push(`${where} must be a file name, not a path`)
    return null
  }
  return name
}

function readHttps(value: unknown, where: string, errors: string[]): string | null {
  const url = readString(value, where, errors, undefined, 400)
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      errors.push(`${where} must be an https address`)
      return null
    }
  } catch {
    errors.push(`${where} must be an https address`)
    return null
  }
  return url
}

function readStringList(value: unknown, where: string, errors: string[], minimum: number): string[] | null {
  if (!Array.isArray(value) || value.length < minimum) {
    errors.push(`${where} needs at least ${minimum} entry`)
    return null
  }
  const items: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length < 2 || entry.length > 80) {
      errors.push(`${where} entries must be short strings`)
      return null
    }
    items.push(entry)
  }
  return items
}

function readLaunch(value: unknown, where: string, errors: string[]): LaunchSpec | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    errors.push(`${where} must be an object`)
    return undefined
  }
  pushUnknown(value, new Set(['app', 'binary', 'args', 'env']), where, errors)
  const launch: LaunchSpec = {}
  if (value.app !== undefined) {
    const app = readName(value.app, `${where}.app`, errors)
    if (app) launch.app = app
  }
  if (value.binary !== undefined) {
    const binary = readName(value.binary, `${where}.binary`, errors)
    if (binary) launch.binary = binary
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 20) {
      errors.push(`${where}.args must be a short list`)
    } else {
      const args: string[] = []
      for (const arg of value.args) {
        if (typeof arg !== 'string' || arg.length > 200 || arg.includes('\n')) {
          errors.push(`${where}.args has an unusable entry`)
          break
        }
        args.push(arg)
      }
      launch.args = args
    }
  }
  if (value.env !== undefined) {
    if (!isRecord(value.env)) {
      errors.push(`${where}.env must be an object`)
    } else {
      const env: Record<string, string> = {}
      for (const [key, entry] of Object.entries(value.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string' || entry.length > 200 || entry.includes('\n')) {
          errors.push(`${where}.env has an unusable entry`)
          break
        }
        env[key] = entry
      }
      launch.env = env
    }
  }
  if (!launch.app && !launch.binary) errors.push(`${where} needs an app or a binary`)
  return launch
}

function readPlatform(value: unknown, where: string, errors: string[]): PlatformBuild | null {
  const build = readBuild(value, where, errors, ['runtime'])
  if (!build || !isRecord(value) || value.runtime === undefined) return build
  const runtime = value.runtime
  const runtimeWhere = `${where}.runtime`
  const core = readBuild(runtime, runtimeWhere, errors, ['owner', 'repo', 'tag'])
  if (!core || !isRecord(runtime)) return null
  const owner = readString(runtime.owner, `${runtimeWhere}.owner`, errors, /^[A-Za-z0-9_.-]+$/, 80)
  const repo = readString(runtime.repo, `${runtimeWhere}.repo`, errors, /^[A-Za-z0-9_.-]+$/, 100)
  const tag = readString(runtime.tag, `${runtimeWhere}.tag`, errors, /^[A-Za-z0-9._-]+$/, 60)
  if (!owner || !repo || !tag) return null
  return { ...build, runtime: { owner, repo, tag, ...core } }
}

function readBuild(value: unknown, where: string, errors: string[], extraKeys: string[]): PlatformBuild | null {
  if (!isRecord(value)) {
    errors.push(`${where} must be an object`)
    return null
  }
  pushUnknown(value, new Set(['asset', 'archive', 'launch', ...extraKeys]), where, errors)
  if (!isRecord(value.asset)) {
    errors.push(`${where}.asset must be an object`)
    return null
  }
  pushUnknown(value.asset, new Set(['include', 'exclude', 'prefer', 'arch']), `${where}.asset`, errors)
  const include = readStringList(value.asset.include, `${where}.asset.include`, errors, 1)
  const exclude =
    value.asset.exclude === undefined
      ? undefined
      : readStringList(value.asset.exclude, `${where}.asset.exclude`, errors, 0) ?? undefined
  const prefer =
    value.asset.prefer === undefined
      ? undefined
      : readStringList(value.asset.prefer, `${where}.asset.prefer`, errors, 0) ?? undefined

  let arch: PlatformBuild['asset']['arch']
  if (value.asset.arch !== undefined) {
    if (!isRecord(value.asset.arch)) {
      errors.push(`${where}.asset.arch must be an object`)
    } else {
      pushUnknown(value.asset.arch, new Set(ARCHS), `${where}.asset.arch`, errors)
      arch = {}
      for (const key of ARCHS) {
        if (value.asset.arch[key] === undefined) continue
        const tokens = readStringList(value.asset.arch[key], `${where}.asset.arch.${key}`, errors, 1)
        if (tokens) arch[key] = tokens
      }
    }
  }

  if (typeof value.archive !== 'string' || !ARCHIVES.includes(value.archive as ArchiveKind)) {
    errors.push(`${where}.archive must be zip, tar.gz, tar.xz, dmg, or file`)
    return null
  }
  const archive = value.archive as ArchiveKind
  const launch = readLaunch(value.launch, `${where}.launch`, errors)
  if (archive !== 'file' && !launch?.app && !launch?.binary) {
    errors.push(`${where}.launch is required unless the archive is a single file`)
  }
  if (!include) return null
  return {
    asset: { include, exclude, prefer, arch },
    archive,
    launch
  }
}

function readChannel(value: unknown, index: number, errors: string[]): GameChannel | null {
  const where = `channels[${index}]`
  if (!isRecord(value)) {
    errors.push(`${where} must be an object`)
    return null
  }
  pushUnknown(value, new Set(['id', 'label', 'description', 'source']), where, errors)
  const id = readString(value.id, `${where}.id`, errors, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 40)
  const label = readString(value.label, `${where}.label`, errors, undefined, 40)
  const description =
    value.description === undefined
      ? undefined
      : readString(value.description, `${where}.description`, errors, undefined, 140) ?? undefined
  if (!isRecord(value.source)) {
    errors.push(`${where}.source must be an object`)
    return null
  }
  const source = readSource(value.source, `${where}.source`, errors)
  if (!id || !label || !source) return null
  return { id, label, description, source }
}

function readSource(value: Record<string, unknown>, where: string, errors: string[]): GameChannel['source'] | null {
  if (value.type === 'itch') {
    pushUnknown(value, new Set(['type', 'page']), where, errors)
    const page = readHttps(value.page, `${where}.page`, errors)
    if (!page) return null
    if (!/^https:\/\/[a-z0-9-]+\.itch\.io\/[a-z0-9_-]+\/?$/i.test(page)) {
      errors.push(`${where}.page must look like https://creator.itch.io/game`)
      return null
    }
    return { type: 'itch', page: page.replace(/\/$/, '') }
  }
  let prerelease: PrereleaseFilter | undefined
  if (value.prerelease !== undefined) {
    if (!FILTERS.includes(value.prerelease as PrereleaseFilter)) {
      errors.push(`${where}.prerelease must be exclude, only, or include`)
    } else {
      prerelease = value.prerelease as PrereleaseFilter
    }
  }
  if (value.type === 'file-list') {
    pushUnknown(value, new Set(['type', 'page', 'prerelease']), where, errors)
    const page = readHttps(value.page, `${where}.page`, errors)
    if (!page) return null
    if (!isAllowedAssetUrl(page)) {
      errors.push(`${where}.page must be on a download host OGL knows`)
      return null
    }
    return { type: 'file-list', page, prerelease }
  }
  pushUnknown(value, new Set(['type', 'owner', 'repo', 'prerelease', 'cdn']), where, errors)
  if (value.type !== 'github-releases') errors.push(`${where}.type must be github-releases, itch, or file-list`)
  const owner = readString(value.owner, `${where}.owner`, errors, /^[A-Za-z0-9_.-]+$/, 80)
  const repo = readString(value.repo, `${where}.repo`, errors, /^[A-Za-z0-9_.-]+$/, 100)
  let cdn: CdnKind | undefined
  if (value.cdn !== undefined) {
    if (!CDNS.includes(value.cdn as CdnKind)) errors.push(`${where}.cdn must be openttd`)
    else cdn = value.cdn as CdnKind
  }
  if (!owner || !repo) return null
  return { type: 'github-releases', owner, repo, prerelease, ...(cdn ? { cdn } : {}) }
}

export function validateGame(input: unknown): { game: Game | null; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(input)) return { game: null, errors: ['Game file must be a JSON object'] }
  pushUnknown(input, GAME_KEYS, 'game', errors)

  const id = readString(input.id, 'id', errors, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 40)
  const name = readString(input.name, 'name', errors, undefined, 60)
  const tagline = readString(input.tagline, 'tagline', errors, undefined, 180)
  const accent = readString(input.accent, 'accent', errors, /^#[0-9a-fA-F]{6}$/, 7)
  const mark =
    input.mark === undefined ? undefined : readString(input.mark, 'mark', errors, /^[A-Z0-9]{1,3}$/, 3) ?? undefined
  const website = input.website === undefined ? undefined : readHttps(input.website, 'website', errors) ?? undefined
  const cover = input.cover === undefined ? undefined : readHttps(input.cover, 'cover', errors) ?? undefined
  const icon = input.icon === undefined ? undefined : readHttps(input.icon, 'icon', errors) ?? undefined
  let screenshots: string[] | undefined
  if (input.screenshots !== undefined) {
    if (!Array.isArray(input.screenshots) || input.screenshots.length > 12) {
      errors.push('screenshots must be a list of up to 12 images')
    } else {
      screenshots = []
      input.screenshots.forEach((entry, index) => {
        const url = readHttps(entry, `screenshots[${index}]`, errors)
        if (url) screenshots?.push(url)
      })
    }
  }
  const note =
    input.note === undefined ? undefined : readString(input.note, 'note', errors, undefined, 300) ?? undefined

  let tags: string[] | undefined
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 6) errors.push('tags must be a list of up to 6 words')
    else {
      tags = []
      input.tags.forEach((tag, index) => {
        const value = readString(tag, `tags[${index}]`, errors, undefined, 24)
        if (value) tags?.push(value)
      })
    }
  }

  let web: Game['web']
  if (input.web !== undefined) {
    if (!isRecord(input.web)) errors.push('web must be an object')
    else {
      pushUnknown(input.web, new Set(['url']), 'web', errors)
      const url = readHttps(input.web.url, 'web.url', errors)
      if (url) web = { url }
    }
  }

  let requires: Game['requires']
  if (input.requires !== undefined) {
    if (!isRecord(input.requires)) errors.push('requires must be an object')
    else {
      pushUnknown(input.requires, new Set(['name', 'url']), 'requires', errors)
      const name = readString(input.requires.name, 'requires.name', errors, undefined, 60)
      const url = input.requires.url === undefined ? undefined : readHttps(input.requires.url, 'requires.url', errors) ?? undefined
      if (name) requires = { name, ...(url ? { url } : {}) }
    }
  }

  const channels: GameChannel[] = []
  if (input.channels === undefined && web) {
    // Browser games need no channels.
  } else if (!Array.isArray(input.channels) || input.channels.length === 0) {
    errors.push('channels needs at least one entry')
  } else {
    const seen = new Set<string>()
    input.channels.forEach((channel, index) => {
      const parsed = readChannel(channel, index, errors)
      if (!parsed) return
      if (seen.has(parsed.id)) errors.push(`channels has a duplicate id "${parsed.id}"`)
      seen.add(parsed.id)
      channels.push(parsed)
    })
  }

  const platforms: Game['platforms'] = {}
  if (input.platforms === undefined && web) {
    // Browser games run everywhere.
  } else if (!isRecord(input.platforms) || Object.keys(input.platforms).length === 0) {
    errors.push('platforms needs at least one operating system')
  } else {
    pushUnknown(input.platforms, new Set(PLATFORMS), 'platforms', errors)
    for (const key of PLATFORMS) {
      if (input.platforms[key] === undefined) continue
      const parsed = readPlatform(input.platforms[key], `platforms.${key}`, errors)
      if (parsed) platforms[key as PlatformId] = parsed
    }
  }

  if (errors.length > 0 || !id || !name || !tagline || !accent) return { game: null, errors }
  if (!web && (channels.length === 0 || Object.keys(platforms).length === 0)) return { game: null, errors }

  return {
    game: { id, name, mark, tagline, website, note, accent, cover, icon, screenshots, tags, web, requires, channels, platforms },
    errors: []
  }
}

export function validateGames(inputs: unknown[]): { games: Game[]; errors: string[] } {
  const games: Game[] = []
  const errors: string[] = []
  inputs.forEach((input, index) => {
    const result = validateGame(input)
    const label =
      result.game?.id ?? (isRecord(input) && typeof input.id === 'string' ? input.id : `file ${index + 1}`)
    for (const error of result.errors) errors.push(`${label}: ${error}`)
    if (result.game) games.push(result.game)
  })
  return { games, errors }
}
