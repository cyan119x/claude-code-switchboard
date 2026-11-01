import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { SwitchboardMod } from '../types'

// Switchboard: the Mods pane (/mods) lists every mod, installed or loaded here, each with a switch and,
// for a mod that draws a pane or a band, an eye.
//
// Off is off in every chat: an installed mod is switched with the app's own CLI (`claude plugin disable`,
// written to ~/.claude/settings.json), a mod loaded from a plugin folder is refused at load. Hidden keeps a
// mod running but out of sight: its band pieces are left out of the stack above the prompt and its panes do
// not open. Hidden and the folder mods' off list live in ~/.claude/switchboard.json, shared by every chat.
// Each chat with Switchboard reads both every 3 seconds and reloads its plugins when the switches changed.

const PANE = 'mods'
const SELF = 'switchboard'
const POLL_MS = 3000

const mods = atom({ plugin: 'switchboard', key: 'mods' } as const, [] as SwitchboardMod[])
const hidden = atom({ plugin: 'switchboard', key: 'hidden' } as const, [] as string[])
const notice = atom({ plugin: 'switchboard', key: 'notice' } as const, '')
const busy = atom({ plugin: 'switchboard', key: 'busy' } as const, '')

// Names, lines and icons for some known mods; any other mod reads from its plugin.json.
const KNOWN: Record<string, { title: string; description: string; hint?: string; icon: string }> = {
  ember: { title: 'Ember', description: 'Cache timer, limits and Keep warm above the prompt', icon: 'flame' },
  backstage: { title: 'Backstage', description: 'A card per subagent and background task', icon: 'sliders' },
  handoff: { title: 'Handoff', description: 'Moves a long chat to a fresh one', hint: '/handoff to show it', icon: 'arrow' },
  'blast-radius': { title: 'Blast Radius', description: 'Holds risky shell commands for a look first', icon: 'alert' },
  'screen-share': {
    title: 'Screen-Share Mode',
    description: 'Hides emails, phones and amounts',
    hint: '/screen-share to hide private data',
    icon: 'shield',
  },
  'brain-dump': { title: 'Brain-Dump Shaper', description: 'Turns long rambling prompts into clear briefs', icon: 'pencil' },
  'cache-tax': { title: 'Cache Clock', description: 'Counts down until the cache goes cold', icon: 'clock' },
}

// A mod whose band is the point of it shows no eye.
const NO_EYE = new Set(['screen-share'])

type Shared = { hidden: string[]; off: string[] }
type Seen = { name: string; root: string; provenance: string }

// Modules that joined this load, as plugin.register reported them: the mods loaded from a plugin folder
// (no marketplace) are known only this way. A reload of Switchboard re-registers every module, so this fills again.
const seen = new Map<string, Seen>()
// Which plugin opened which pane, so a hidden mod's open pane can be blanked.
const paneOwner = new Map<string, string>()

let settingsSnapshot = ''
let sharedSnapshot = ''
let stopPoll: (() => void) | null = null

// ---------------------------------------------------------------------------------------------------------
// Files

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function sharedPath($: EngineInterface): Promise<string> {
  return `${await home($)}/.claude/switchboard.json`
}

async function readJson(path: string, $: EngineInterface): Promise<unknown> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

async function readShared($: EngineInterface): Promise<Shared> {
  const raw = (await readJson(await sharedPath($), $)) as { hidden?: unknown; off?: unknown } | undefined
  return { hidden: strings(raw?.hidden), off: strings(raw?.off) }
}

async function writeShared($: EngineInterface, shared: Shared): Promise<void> {
  const text = `${JSON.stringify({ hidden: [...new Set(shared.hidden)].sort(), off: [...new Set(shared.off)].sort() }, null, 2)}\n`
  await $.fs.write(await sharedPath($), text)
  sharedSnapshot = JSON.stringify(await readShared($))
}

async function enabledPlugins($: EngineInterface): Promise<Record<string, unknown>> {
  const value = await $.settings.read({ key: 'enabledPlugins' })
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// ---------------------------------------------------------------------------------------------------------
// Finding the mods

type Source = { name: string; id?: string; root: string; isOn: boolean }

/** Installed plugins (any scope), each with the folder its code is read from and whether it is enabled. */
async function installed($: EngineInterface): Promise<Source[]> {
  const base = `${await home($)}/.claude/plugins`
  const list = (await readJson(`${base}/installed_plugins.json`, $)) as { plugins?: Record<string, { installPath?: string }[]> } | undefined
  const markets = ((await readJson(`${base}/known_marketplaces.json`, $)) ?? {}) as Record<string, { installLocation?: string }>
  const enabled = await enabledPlugins($)
  const out: Source[] = []

  for (const [id, installs] of Object.entries(list?.plugins ?? {})) {
    const [name = id, market = ''] = id.split('@')
    let root = installs[0]?.installPath ?? ''
    // A marketplace that is a folder serves its plugins from that folder, not from the install copy.
    const location = markets[market]?.installLocation
    if (location) {
      const catalog = (await readJson(`${location}/.claude-plugin/marketplace.json`, $)) as
        | { plugins?: { name?: string; source?: unknown }[] }
        | undefined
      const entry = catalog?.plugins?.find(plugin => plugin.name === name)
      if (typeof entry?.source === 'string' && entry.source.startsWith('./')) root = `${location}/${entry.source.slice(2)}`
    }
    out.push({ name, id, root, isOn: enabled[id] === true })
  }
  return out
}

async function describe($: EngineInterface, source: Source): Promise<SwitchboardMod | null> {
  const hooks = (await readJson(`${source.root}/hooks/hooks.json`, $)) as { modules?: unknown } | undefined
  const modules = strings(hooks?.modules)
  // Only mods: a plugin with a hooks module. Skills, agents and MCP plugins are left to /plugin.
  if (modules.length === 0) return null

  const manifest = ((await readJson(`${source.root}/.claude-plugin/plugin.json`, $)) ?? {}) as { description?: unknown }
  let code = ''
  for (const module of modules) {
    try {
      code += String(await $.fs.read(`${source.root}/hooks/${module.replace(/^\.\//, '')}`))
    } catch {
      // A module that cannot be read only costs the hint and the eye.
    }
  }

  const commands = [...code.matchAll(/command\.register\(\s*\{[^}]*?name:\s*['"]([\w-]+)['"]/gs)].map(match => match[1] ?? '')
  const hasUi = /ui\.open|['"]AbovePrompt['"]/.test(code) && !NO_EYE.has(source.name)
  const known = KNOWN[source.name]
  const first = String(manifest.description ?? '').split(/(?<=[.;:])\s/)[0] ?? ''

  return {
    name: source.name,
    ...(source.id ? { id: source.id } : {}),
    title: known?.title ?? source.name.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
    description: known?.description ?? first.replace(/[.;:]$/, ''),
    hint: known?.hint ?? (commands[0] ? `/${commands[0]}${hasUi ? ' to open' : ''}` : ''),
    icon: known?.icon ?? 'puzzle',
    isOn: source.isOn,
    hasUi,
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const shared = await readShared($)
  const sources = await installed($)
  const names = new Set(sources.map(source => source.name))

  // Folder mods: loaded now (seen), or switched off here and remembered in the store.
  const remembered = ((await $.store.get('folderMods')) ?? {}) as Record<string, string>
  for (const one of seen.values()) {
    if (one.provenance.endsWith('@builtin') || names.has(one.name)) continue
    remembered[one.name] = one.root
  }
  await $.store.set('folderMods', remembered)
  for (const [name, root] of Object.entries(remembered)) {
    if (names.has(name)) continue
    if (!seen.has(name) && !shared.off.includes(name)) continue
    sources.push({ name, root, isOn: !shared.off.includes(name) })
  }

  const list: SwitchboardMod[] = []
  for (const source of sources) {
    if (source.name === SELF) continue
    const mod = await describe($, source)
    if (mod) list.push(mod)
  }
  await update($, mods, () => list)
  await update($, hidden, () => shared.hidden)
}

// ---------------------------------------------------------------------------------------------------------
// Switching

async function reloadPlugins($: EngineInterface): Promise<void> {
  settingsSnapshot = JSON.stringify(await enabledPlugins($))
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    $.ui.toast('Switchboard: run /reload-plugins to apply the change in this chat.')
  }
}

async function setOn($: EngineInterface, mod: SwitchboardMod, isOn: boolean): Promise<void> {
  await update($, busy, () => mod.name)
  try {
    if (mod.id) {
      const cli = await $.env.get('CLAUDE_CODE_EXECPATH')
      if (!cli) throw new Error('the Claude Code CLI path is unknown')
      const run = await $.process.run([cli, 'plugin', isOn ? 'enable' : 'disable', mod.id, '--scope', 'user'], { timeoutMs: 60_000 })
      if (run.exitCode !== 0) throw new Error((run.stderr || run.stdout).trim().split('\n').pop() ?? `exit ${run.exitCode}`)
    } else {
      const shared = await readShared($)
      await writeShared($, { ...shared, off: isOn ? shared.off.filter(name => name !== mod.name) : [...shared.off, mod.name] })
    }
    await update($, notice, () => `${mod.title} is ${isOn ? 'on' : 'off'} in every chat.`)
    await refresh($)
    await reloadPlugins($)
  } catch (error) {
    await update($, notice, () => `Could not switch ${mod.title}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, busy, () => '')
  }
}

async function setHidden($: EngineInterface, mod: SwitchboardMod, isHidden: boolean): Promise<void> {
  const shared = await readShared($)
  const next = isHidden ? [...shared.hidden, mod.name] : shared.hidden.filter(name => name !== mod.name)
  await writeShared($, { ...shared, hidden: next })
  await update($, hidden, () => [...new Set(next)])
  await update($, notice, () => `${mod.title} is ${isHidden ? 'hidden' : 'shown again'} in every chat.`)
}

/** Every 3 seconds: a switch made in another chat reaches this one. */
async function poll($: EngineInterface): Promise<void> {
  const shared = JSON.stringify(await readShared($))
  if (shared !== sharedSnapshot) {
    const before = JSON.parse(sharedSnapshot || '{"off":[]}') as Shared
    sharedSnapshot = shared
    const now = JSON.parse(shared) as Shared
    await update($, hidden, () => now.hidden)
    if (JSON.stringify(before.off) !== JSON.stringify(now.off)) {
      await refresh($)
      await reloadPlugins($)
      return
    }
  }
  const settings = JSON.stringify(await enabledPlugins($))
  if (settings !== settingsSnapshot) {
    await refresh($)
    await reloadPlugins($)
    return
  }
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) await refresh($)
}

// ---------------------------------------------------------------------------------------------------------
// Drawing

const BLANK = '⠀'
const STACK = 'band-stack'
const INK = '<style>.i{stroke:#5f5e5a}.f{fill:#5f5e5a}@media (prefers-color-scheme: dark){.i{stroke:#c3c2b7}.f{fill:#c3c2b7}}</style>'

const ICON_PATHS: Record<string, string> = {
  flame: '<path class="i" d="M8 14c-2.8 0-4.5-1.9-4.5-4.3C3.5 6.8 6.4 5.5 6.6 2c2.2 1.4 4.3 4.1 4.3 6.1 .6-.5.9-1.2 1-1.9 .9 1.1 1.6 2.3 1.6 3.6C13.5 12.2 11 14 8 14z"/>',
  sliders: '<path class="i" d="M5 2v12M11 2v12"/><path class="i" d="M3 10h4M9 5h4"/>',
  arrow: '<path class="i" d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/>',
  alert: '<path class="i" d="M8 2.2 14.2 13H1.8L8 2.2z"/><path class="i" d="M8 6.5v3"/><circle class="f" cx="8" cy="11.3" r=".7"/>',
  shield: '<path class="i" d="M8 1.8 13 3.6v4c0 3.2-2.1 5.4-5 6.6-2.9-1.2-5-3.4-5-6.6v-4L8 1.8z"/>',
  pencil: '<path class="i" d="M10.8 2.4 13.6 5.2 5.6 13.2 2.4 13.6 2.8 10.4 10.8 2.4z"/>',
  clock: '<circle class="i" cx="8" cy="8" r="6"/><path class="i" d="M8 4.5V8l2.4 1.6"/>',
  puzzle: '<path class="i" d="M3 5h3a2 2 0 1 1 4 0h3v3a2 2 0 1 0 0 4v2H3V5z"/>',
}

function iconSvg(icon: string, isOn: boolean): string {
  const body = ICON_PATHS[icon] ?? ICON_PATHS.puzzle
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="${isOn ? 1 : 0.45}">${INK}${body}</svg>`
}

function toggleSvg(isOn: boolean, isBusy: boolean): string {
  const track = isOn ? '<rect width="44" height="26" rx="13" fill="#2f9e4f"/>' : '<rect class="t" width="44" height="26" rx="13"/>'
  const knob = `<circle cx="${isOn ? 31 : 13}" cy="13" r="10" fill="#fff" stroke="rgba(0,0,0,.08)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="26" viewBox="0 0 44 26" opacity="${isBusy ? 0.5 : 1}"><style>.t{fill:#dddcd6}@media (prefers-color-scheme: dark){.t{fill:#4b4a46}}</style>${track}${knob}</svg>`
}

function eyeSvg(isHidden: boolean, isOn: boolean): string {
  const eye = '<path class="i" d="M4.5 13s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5z"/><circle class="i" cx="13" cy="13" r="2.4"/>'
  const slash = isHidden ? '<path class="i" d="M5.5 5.5 20.5 20.5"/>' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="26" viewBox="0 0 26 26" fill="none" stroke-width="1.4" stroke-linecap="round" opacity="${isOn ? 1 : 0.4}">${INK}<style>.b{stroke:#e4e3de}@media (prefers-color-scheme: dark){.b{stroke:#46453f}}</style><rect class="b" x=".5" y=".5" width="25" height="25" rx="6"/>${eye}${slash}</svg>`
}

type Owned = { type?: unknown; props?: { key?: unknown; group?: { plugin?: unknown } }; children?: unknown }

function ownerOf(piece: unknown): string | undefined {
  if (typeof piece !== 'object' || piece === null) return undefined
  const props = (piece as Owned).props
  if (typeof props?.group?.plugin === 'string') return props.group.plugin
  return typeof props?.key === 'string' ? props.key : undefined
}

function stackPieces(rest: unknown): unknown[] {
  if (rest === null || rest === undefined || rest === false) return []
  const node = rest as Owned
  if (typeof rest === 'object' && node.type === 'Box' && node.props?.key === STACK && Array.isArray(node.children)) {
    return node.children
  }
  return [rest]
}

export const register: Register = on => {
  // A folder mod switched off is refused when it loads. Installed mods are off through settings instead.
  on('plugin.register', async ($, e, next) => {
    seen.set(e.name, { name: e.name, root: e.root, provenance: e.provenance })
    if (e.name !== SELF && !e.provenance.endsWith('@builtin')) {
      const shared = await readShared($)
      if (shared.off.includes(e.name)) return { refuse: 'switched off in Switchboard (/mods)' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // immediate: the pane opens while a turn runs, instead of waiting in the queue behind it.
    await $.command.register({ name: 'mods', description: 'See every mod, switch one off or hide its panel', immediate: true })
    settingsSnapshot = JSON.stringify(await enabledPlugins($))
    sharedSnapshot = JSON.stringify(await readShared($))
    await refresh($)
    stopPoll?.()
    stopPoll = $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    return result
  })

  on('command.run', { command: 'mods' }, async $ => {
    await refresh($)
    await update($, notice, () => '')
    await $.ui.open({ id: PANE, title: 'Mods', focus: true })
    return { text: 'Opened the Mods pane.' }
  })

  // A hidden mod's pane does not open (it is told the pane waits, unplaced), and one already open is blanked.
  on('ui.open', async ($, e, next) => {
    const owner = next.origin.plugin
    paneOwner.set(e.id, owner)
    if (owner !== SELF && (await read($, hidden)).includes(owner)) {
      return { value: { isPlaced: false, reason: 'hidden in Switchboard (/mods)' } }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const owner = paneOwner.get(e.requestId)
    if (e.requestId === PANE || owner === undefined || !(await read($, hidden)).includes(owner)) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Hidden in Switchboard. Open /mods to show it.</Text>
  })

  // Above the prompt: the pieces of hidden mods are left out; everything else is passed on as it came.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const list = await read($, hidden)
    if (list.length === 0) return rest
    const pieces = stackPieces(rest)
    const kept = pieces.filter(piece => {
      const owner = ownerOf(piece)
      return owner === undefined || !list.includes(owner)
    })
    if (kept.length === pieces.length) return rest
    const { Box } = $.ui.resolve(e)
    return Box({ key: STACK, flexDirection: 'column', rowGap: 'sm', children: kept as never[] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? (ui.Svg as typeof ui.Box) : undefined
    const list = await read($, mods)
    const hiddenList = await read($, hidden)
    const message = await read($, notice)
    const working = await read($, busy)

    // A Svg drawing with a chrome-less Button over it: the desktop Button draws only its label, so the picture
    // is the Svg and the press is a label of blank cells spanning it (the same overlay Ember uses).
    const pressable = (key: string, svg: string, alt: string, blanks: number, onPress: () => void): RenderElement =>
      Box({
        key,
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
        children: [
          Svg!({ source: svg, alt, width: blanks === 4 ? 44 : 30, height: 26 } as never),
          Box({
            key: `${key}-press`,
            position: 'absolute',
            top: 0,
            left: -2,
            right: -2,
            bottom: 0,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            children: [Button({ key: `${key}-btn`, label: BLANK.repeat(blanks), plain: true, onPress })],
          }),
        ],
      })

    const row = (mod: SwitchboardMod): RenderElement => {
      const isHidden = hiddenList.includes(mod.name)
      const isBusy = working === mod.name
      const switchIt = () => void setOn($, mod, !mod.isOn)
      const hideIt = () => void setHidden($, mod, !isHidden)

      const controls: RenderElement[] = Svg
        ? [
            mod.hasUi
              ? pressable(`eye-${mod.name}`, eyeSvg(isHidden, mod.isOn), isHidden ? `Show ${mod.title}` : `Hide ${mod.title}`, 3, hideIt)
              : Box({ key: `eye-${mod.name}`, width: 4, flexShrink: 0 }),
            pressable(`switch-${mod.name}`, toggleSvg(mod.isOn, isBusy), `${mod.title} ${mod.isOn ? 'on' : 'off'}`, 4, switchIt),
          ]
        : [
            ...(mod.hasUi ? [Button({ key: `eye-${mod.name}`, label: isHidden ? 'Show' : 'Hide', onPress: hideIt })] : []),
            Button({ key: `switch-${mod.name}`, label: mod.isOn ? 'On' : 'Off', onPress: switchIt }),
          ]

      return Box({
        key: `mod-${mod.name}`,
        flexDirection: 'row',
        alignItems: 'flex-start',
        columnGap: 'md',
        paddingY: 'sm',
        children: [
          ...(Svg
            ? [Box({ key: `icon-${mod.name}`, flexShrink: 0, paddingTop: 'xs', children: [Svg({ source: iconSvg(mod.icon, mod.isOn), alt: '', width: 16, height: 16 } as never)] })]
            : []),
          Box({
            key: `text-${mod.name}`,
            flexDirection: 'column',
            flexGrow: 1,
            flexShrink: 1,
            children: [
              Text({ bold: true, dimColor: !mod.isOn, wrap: 'truncate-end', children: mod.title }),
              ...(mod.description ? [Text({ dimColor: true, wrap: 'truncate-end', children: mod.description })] : []),
              ...(mod.hint ? [Text({ dimColor: true, italic: true, wrap: 'truncate-end', children: mod.hint })] : []),
            ],
          }),
          Box({ key: `controls-${mod.name}`, flexDirection: 'row', alignItems: 'center', columnGap: 'sm', flexShrink: 0, children: controls }),
        ],
      })
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {list.length === 0 && <Text dimColor>No mods installed yet.</Text>}
        {list.map(row)}
        <Box key="note" flexDirection="column" marginTop={1} paddingLeft={Svg ? 4 : 0}>
          {message !== '' && <Text color={message.startsWith('Could not') ? '#c4453c' : '#2f9e4f'}>{message}</Text>}
          <Text dimColor>Off means off in every chat. Hidden keeps it on but out of sight. Changes apply within 3 seconds.</Text>
          <Text dimColor>New mods appear here by themselves.</Text>
        </Box>
      </Box>
    )
  })
}
