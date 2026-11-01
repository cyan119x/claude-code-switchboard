/** One mod as the Mods pane lists it. */
export type SwitchboardMod = {
  /** The plugin's name (plugin.json). */
  name: string
  /** `<name>@<marketplace>` for an installed plugin, switched with `claude plugin enable/disable`; absent otherwise. */
  id?: string
  title: string
  description: string
  /** The dim line under the description: its slash command, or empty. */
  hint: string
  icon: string
  isOn: boolean
  /** Draws a pane or a band above the prompt, so it can be hidden. */
  hasUi: boolean
}

declare module 'claude-code' {
  interface PluginState {
    switchboard: {
      mods: SwitchboardMod[]
      /** Mods whose panels are hidden, in every chat (from ~/.claude/switchboard.json). */
      hidden: string[]
      /** The green line under the list after a switch. */
      notice: string
      /** The mod being switched right now, its row dimmed until it settles. */
      busy: string
    }
  }
}
