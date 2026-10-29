import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'todo-tasks',
  props: {
    title: '任務佇列',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { top: 0, offset: 0, bodyRows: 30 },
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

test('parallel mode spawns one subagent per card and summarizes once all report back', async ($, on) => {
  const submitted: string[] = []
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))

  const ui = await $.ui.mount({ plugin: 'todo-tasks', surface: 'desktop', ...PANE })
  await ui.press({ key: 'add' })
  await ui.press({ key: 'add' })
  const titles = (await ui.findAll({ type: 'Input' })).filter(i => i.key?.startsWith('title-'))
  await ui.input({ key: titles[0]!.key!, text: '任務 A', kind: 'change' })
  await ui.input({ key: titles[1]!.key!, text: '任務 B', kind: 'change' })

  // 預設線性，切成同步
  expect(await ui.find({ key: 'run-mode' })).toBeDefined()
  await ui.select({ key: 'run-mode', value: 'parallel' })

  // 啟動 → 一則派工訊息給主模型，要求同一則回覆派出兩個 Agent
  await ui.press({ key: 'start' })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('同步執行')
  expect(submitted[0]).toContain('任務 1/2')
  expect(submitted[0]).toContain('任務 A')
  expect(submitted[0]).toContain('任務 2/2')
  expect(submitted[0]).toContain('任務 B')
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  // 主模型派出的 subagent：由其 turn.start（prompt 帶卡片標記）對應到卡片
  const spawned = [...submitted[0]!.matchAll(/<task[^>]*>\n([\s\S]*?)\n<\/task>/g)].map(m => m[1]!)
  expect(spawned.length).toBe(2)
  await $.turn.start({ text: spawned[0]!, turnId: 'turn-a', agentId: 'agent-1' })
  await $.turn.start({ text: spawned[1]!, turnId: 'turn-b', agentId: 'agent-2' })

  // 第二個先回報：只有一張完成，還沒彙整
  await $.turn.complete({
    reason: 'answer',
    answer: 'B 做完了',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-b',
    agentId: 'agent-2',
  })
  expect(await ui.find({ type: 'Text', text: /1\/2 完成/ })).toBeDefined()

  await $.turn.complete({
    reason: 'answer',
    answer: 'A 做完了',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-a',
    agentId: 'agent-1',
  })
  // 全部回報 → 收尾；總結由主模型在同一個 turn 完成，不再另送訊息
  expect(submitted.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: 'A 做完了' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'B 做完了' })).toBeDefined()
  expect(await ui.find({ key: 'start' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/2 完成/ })).toBeDefined()
})

test('a running card shows a progress bar fed by the progress tool and counts tool calls', async ($, on) => {
  on('prompt.submit', async (_, e) => ({ text: e.text }))
  on('tool.call', async () => ({ result: 'x', text: 'x' }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))

  const ui = await $.ui.mount({ plugin: 'todo-tasks', surface: 'desktop', ...PANE })
  await ui.press({ key: 'add' })
  expect(await ui.find({ type: 'Text', text: /0%/ })).toBeUndefined()

  await ui.press({ key: 'start' })
  expect(await ui.find({ type: 'Text', text: /0%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🔧 0/ })).toBeDefined()

  // 一般工具呼叫 → 計數 +1
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  expect(await ui.find({ type: 'Text', text: /🔧 1/ })).toBeDefined()

  // 進度工具 → 百分比與說明
  const r = await $.tool.call({ tool: 'mcp__todo-tasks__progress', percent: 60, note: '修改中' })
  expect(r.isError).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '修改中' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🔧 1/ })).toBeDefined()

  const bad = await $.tool.call({ tool: 'mcp__todo-tasks__progress', percent: 'abc' })
  expect(bad.isError).toBe(true)

  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await ui.find({ type: 'Text', text: /60%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1\/1 完成/ })).toBeDefined()
})
