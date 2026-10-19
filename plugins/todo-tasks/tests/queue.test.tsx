import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'todo-tasks',
  props: {
    title: '任務佇列',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { top: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('cards are added, edited, run in order, and the next starts after turn.complete', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', async (_, e) => ({ text: e.answer }))

  const ui = await $.ui.mount({ plugin: 'todo-tasks', surface: 'terminal', ...PANE })

  await ui.press({ key: 'add' })
  await ui.press({ key: 'add' })
  // 規範欄常駐，所以只數卡片的標題/內容欄
  const titles = (await ui.findAll({ type: 'Input' })).filter(
    i => i.key?.startsWith('title-') || i.key?.startsWith('content-'),
  )
  expect(titles.length).toBe(4)

  const [t1, , t2] = titles.map(i => i.key)
  await ui.input({ key: t1!, text: '第一個任務', kind: 'change' })
  await ui.input({ key: t2!, text: '第二個任務', kind: 'change' })

  await ui.press({ key: 'start' })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('任務 1/2')
  expect(submitted[0]).toContain('第一個任務')
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  await $.turn.complete({
    reason: 'answer',
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-1',
  })
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('任務 2/2')
  expect(submitted[1]).toContain('第二個任務')

  await $.turn.complete({
    reason: 'answer',
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-2',
  })
  expect(submitted.length).toBe(2)
  expect(await ui.find({ key: 'start' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /2\/2 完成/ }))).toBeDefined()

  // 重置：卡片內容保留、狀態回到待處理，再啟動會從第一張重跑
  await ui.press({ key: 'reset' })
  expect(await ui.find({ key: 'reset' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /0\/2 完成/ }))).toBeDefined()
  await ui.press({ key: 'start' })
  expect(submitted.length).toBe(3)
  expect(submitted[2]).toContain('任務 1/2')
  expect(submitted[2]).toContain('第一個任務')
  await ui.press({ key: 'stop' })
})

test('rules are added to the system prompt and to each task prompt', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))

  const ui = await $.ui.mount({ plugin: 'todo-tasks', surface: 'desktop', ...PANE })
  await ui.input({ key: 'rules', text: '每個任務都先跑測試' })

  const { sections } = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['desktop'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections.some(s => s.id === 'todo-tasks:rules' && s.text.includes('每個任務都先跑測試'))).toBe(true)

  await ui.press({ key: 'add' })
  await ui.press({ key: 'start' })
  expect(submitted[0]).toContain('每個任務都先跑測試')
})

test('skill paths become @buttons that append to the rules and are listed in the prompt', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  const ui = await $.ui.mount({ plugin: 'todo-tasks', surface: 'desktop', ...PANE })
  await ui.press({ key: 'add-skill' })
  // 貼上時常帶引號，登錄時要去掉
  await ui.input({ key: 'skill-path', text: '".claude/skills/my-skill/SKILL.md"' })
  expect(await ui.find({ key: 'skill-0', text: '@my-skill' })).toBeDefined()
  expect(await ui.find({ key: 'skill-path' })).toBeUndefined()

  await ui.input({ key: 'rules', text: '先用', kind: 'change' })
  await ui.press({ key: 'skill-0' })
  expect((await ui.find({ key: 'rules' }))?.text).toBe('先用 @my-skill')

  await ui.press({ key: 'add' })
  await ui.press({ key: 'start' })
  expect(submitted[0]).toContain('先用 @my-skill')
  expect(submitted[0]).toContain('@my-skill → .claude/skills/my-skill/SKILL.md')

  await ui.press({ key: 'rm-skill-0' })
  expect(await ui.find({ key: 'skill-0' })).toBeUndefined()
})

test('a card can attach file paths, which are listed in its task prompt', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  const ui = await $.ui.mount({ plugin: 'todo-tasks', surface: 'desktop', ...PANE })
  await ui.press({ key: 'add' })
  const title = (await ui.findAll({ type: 'Input' })).find(i => i.key?.startsWith('title-'))
  const id = title!.key!.slice('title-'.length)

  await ui.press({ key: `add-file-${id}` })
  await ui.input({ key: `file-path-${id}`, text: '"src/foo.ts"' })
  expect(await ui.find({ type: 'Text', text: 'src/foo.ts' })).toBeDefined()
  expect(await ui.find({ key: `file-path-${id}` })).toBeUndefined()

  // 網址也能附加，原樣列出
  await ui.press({ key: `add-file-${id}` })
  await ui.input({ key: `file-path-${id}`, text: 'https://example.com/spec' })

  await ui.press({ key: 'start' })
  expect(submitted[0]).toContain('## 附加檔案 / 網址')
  expect(submitted[0]).toContain('- src/foo.ts')
  expect(submitted[0]).toContain('- https://example.com/spec')

  await ui.press({ key: `rm-file-${id}-0` })
  expect(await ui.find({ type: 'Text', text: 'src/foo.ts' })).toBeUndefined()
})
