import { expect, test } from 'claude-code/testing'

const MODS = [
  { name: 'ember', id: 'ember@claude-code-ember', title: 'Ember', description: 'Cache timer', hint: '', icon: 'flame', isOn: true, hasUi: true },
  {
    name: 'screen-share',
    title: 'Screen-Share Mode',
    description: 'Hides emails, phones and amounts',
    hint: '/screen-share to hide private data',
    icon: 'shield',
    isOn: false,
    hasUi: false,
  },
]

function seed(on: any, values: Record<string, unknown>) {
  on('state.get', (_: unknown, e: any) => (e.key in values ? { value: { value: values[e.key], version: 1 } } : { value: undefined }))
}

const PANE = {
  plugin: 'switchboard',
  component: 'Pane',
  requestId: 'mods',
  props: { title: 'Mods', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the Mods pane lists each mod with its line and hint', async ($, on) => {
  seed(on, { mods: MODS, hidden: [], notice: 'Context Gauge is off in every chat.', busy: '' })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect((await ui.find({ type: 'Text', text: /^Screen-Share Mode$/ }))?.text).toBe('Screen-Share Mode')
    expect((await ui.find({ type: 'Text', text: /screen-share to hide/ }))?.text).toBe('/screen-share to hide private data')
    expect((await ui.find({ type: 'Text', text: /off in every chat\.$/ }))?.text).toBe('Context Gauge is off in every chat.')
    expect((await ui.find({ type: 'Text', text: /^Off means off/ }))?.text).toContain('Hidden keeps it on but out of sight')
    await ui.unmount()
  }
})

test('a hidden mod is left out of the band above the prompt', async ($, on) => {
  seed(on, { hidden: ['ember'] })
  on('ui.render', ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      key: 'band-stack',
      flexDirection: 'column',
      children: [Box({ key: 'handoff', children: [Text({ children: 'handoff card' })] }), Box({ key: 'ember', children: [Text({ children: 'ember card' })] })],
    })
  })

  const ui = await $.ui.mount({ plugin: 'switchboard', component: 'AbovePrompt', requestId: 'band', surface: 'desktop', props: { hasSurvey: false } } as never)
  expect((await ui.find({ type: 'Text', text: /handoff/ }))?.text).toBe('handoff card')
  expect(await ui.find({ type: 'Text', text: /ember/ })).toBeUndefined()
  await ui.unmount()
})
