export type PlatformId = 'darwin' | 'win32' | 'linux'
export type ArchId = 'arm64' | 'x64' | 'ia32'
export type PrereleaseFilter = 'exclude' | 'only' | 'include'
export type ArchiveKind = 'zip' | 'tar.gz' | 'tar.xz' | 'dmg' | 'file'
export type CdnKind = 'openttd'

export type AssetRule = {
  include: string[]
  exclude?: string[]
  prefer?: string[]
  arch?: Partial<Record<ArchId, string[]>>
}

export type LaunchSpec = {
  app?: string
  binary?: string
  args?: string[]
  env?: Record<string, string>
}

// An engine the game file runs inside, such as LÖVE for .love files. Shared between games.
export type RuntimeSpec = {
  owner: string
  repo: string
  tag: string
  asset: AssetRule
  archive: ArchiveKind
  launch?: LaunchSpec
}

export type PlatformBuild = {
  asset: AssetRule
  archive: ArchiveKind
  launch?: LaunchSpec
  runtime?: RuntimeSpec
}

export type GithubSource = {
  type: 'github-releases'
  owner: string
  repo: string
  prerelease?: PrereleaseFilter
  cdn?: CdnKind
}

// A free itch.io page. OGL reads the uploads listed on it; the version comes from the file name.
export type ItchSource = {
  type: 'itch'
  page: string
}

// A download page that lists the project's files, one per table row, on a host OGL knows.
// The version comes from the file name.
export type FileListSource = {
  type: 'file-list'
  page: string
  prerelease?: PrereleaseFilter
}

export type GameChannel = {
  id: string
  label: string
  description?: string
  source: GithubSource | ItchSource | FileListSource
}

export type OriginalGame = {
  name: string
  url?: string
}

export type Game = {
  id: string
  name: string
  mark?: string
  tagline: string
  website?: string
  note?: string
  accent: string
  cover?: string
  icon?: string
  screenshots?: string[]
  tags?: string[]
  web?: { url: string }
  requires?: OriginalGame
  channels: GameChannel[]
  platforms: Partial<Record<PlatformId, PlatformBuild>>
}

export type BuildAsset = {
  name: string
  url: string
  size: number
}

export type GameBuild = {
  tag: string
  title: string
  publishedAt: string
  prerelease: boolean
  notes: string
  asset: BuildAsset
}

export type GameArt = {
  cover?: string
  icon?: string
  screenshots: string[]
}

export type PlatformInfo = {
  platform: string
  arch: string
  version: string
  hostLabel: string
}

export type CatalogSource = 'remote' | 'cache' | 'bundled'

export type CatalogSnapshot = {
  games: Game[]
  source: CatalogSource
  error?: string
}

export type InstallView = {
  gameId: string
  channelId: string
  tag: string
  installedAt: string
  autoUpdate: boolean
}

export type DownloadPhase = 'downloading' | 'extracting' | 'error' | 'done'

export type ProgressEvent = {
  gameId: string
  channelId: string
  tag: string
  gameName: string
  phase: DownloadPhase
  received: number
  total: number
  message?: string
}

// Where a game's mods come from. Each type has a provider in src/main/mods.ts.
export type ModSource =
  | { type: 'openttd-content'; kind: 'newgrf' }
  | { type: 'endless-sky-plugins' }
  | { type: 'openrct2-plugins' }
  | { type: 'simutrans-paksets' }

// What a game calls its mods, and where the player switches them on afterwards.
export type ModSupport = {
  label: string
  hint?: string
  // Hand-picked well-known mods, best first. Shown as the first category.
  popular?: string[]
  source: ModSource
}

export type Mod = {
  id: string
  name: string
  description: string
  authors: string[]
  version: string
  updatedAt: string
  size: number
  category: string
  tags: string[]
  // icon: small square for the list. image: a preview, shown large and used as the icon when there is none.
  icon?: string
  image?: string
  url?: string
  license?: string
}

// outdated: the files on disk are an older version than the one listed.
export type InstalledMod = {
  id: string
  outdated: boolean
}

export type ModProgress = {
  gameId: string
  modId: string
  phase: 'downloading' | 'done' | 'error'
  received: number
  total: number
  message?: string
}

// What OGL knows about the original game's files for one game.
export type OriginalState = {
  installed: boolean
  // The Steam account name used last time, to fill the form in.
  username: string
}

// code: SteamCMD waits for a Steam Guard code. confirm: it waits for a tap in the Steam app.
export type OriginalPhase = 'preparing' | 'signing-in' | 'code' | 'confirm' | 'checking' | 'downloading'

export type OriginalProgress = {
  gameId: string
  phase: OriginalPhase
  received: number
  total: number
}

export type LauncherUpdate =
  | { state: 'dev' }
  | { state: 'unconfigured' }
  | { state: 'checking' }
  | { state: 'none'; version: string }
  // manual: this build cannot install the update itself, so the player downloads it.
  | { state: 'available'; version: string; manual?: boolean }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  // version: the update is known, so the player can still download it by hand.
  | { state: 'error'; message: string; version?: string }

export type OglConfig = {
  repository: {
    owner: string
    name: string
  }
  catalog: {
    branch: string
    directory: string
  }
}
