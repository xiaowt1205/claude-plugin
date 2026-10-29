import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunMode, Task } from '../types'

const PLUGIN = 'todo-tasks'
const PANE = 'todo-tasks'
const TITLE = '任務佇列'

const rules = atom({ plugin: 'todo-tasks', key: 'rules' } as const, '')
const skills = atom({ plugin: 'todo-tasks', key: 'skills' } as const, [] as string[])
// 正在輸入中的 skill 路徑；null = 沒有顯示輸入欄
const skillDraft = atom({ plugin: 'todo-tasks', key: 'skillDraft' } as const, null as string | null)
// 正在為哪張卡片輸入附加檔案路徑；null = 沒有顯示輸入欄
const fileDraft = atom(
  { plugin: 'todo-tasks', key: 'fileDraft' } as const,
  null as { id: string; text: string } | null,
)
const tasks = atom({ plugin: 'todo-tasks', key: 'tasks' } as const, [] as Task[])
// 執行順序：linear = 一張接一張（預設）；parallel = 每張卡片各派一個 subagent 同時處理
const runMode = atom({ plugin: 'todo-tasks', key: 'runMode' } as const, 'linear' as RunMode)
// 同步模式：subagent id → 任務卡片 id（turn.complete 靠它認出是哪張卡片）
const agentMap = atom({ plugin: 'todo-tasks', key: 'agentMap' } as const, {} as Record<string, string>)
const isRunning = atom({ plugin: 'todo-tasks', key: 'isRunning' } as const, false)
const isPaneOpen = atom({ plugin: 'todo-tasks', key: 'isPaneOpen' } as const, false)
// 這個 session 面板是否已經顯示過或被使用者關過：是的話就不再自動彈出（跨 hot-reload 保留）
const isPaneSeen = atom({ plugin: 'todo-tasks', key: 'isPaneSeen' } as const, false)
const isInitialized = atom({ plugin: 'todo-tasks', key: 'isInitialized' } as const, false)

async function openPane($: $, focus?: true) {
  const r = await $.ui.open(focus ? { id: PANE, title: TITLE, focus } : { id: PANE, title: TITLE })
  // 主動開啟的面板在終端窄於 144 欄時不會被畫出來（isPlaced false）：
  // 這時要讓 prompt 上方的重開列顯示，使用者按下去的開啟是「被要求的」，任何寬度都會放置
  await update($, isPaneOpen, () => r.isPlaced)
  if (r.isPlaced) await update($, isPaneSeen, () => true)
  return r
}

const DEFAULT_RULES = '例如：先讀相關檔案再動手；每個任務完成後跑測試；用 @skill 處理'

type $ = EngineInterface

const STATUS_MARK: Record<Task['status'], string> = {
  pending: '○',
  running: '▶',
  done: '✓',
  failed: '✗',
}

const STATUS_LABEL: Record<Task['status'], string> = {
  pending: '待處理',
  running: '執行中',
  done: '完成',
  failed: '失敗',
}

const STATUS_COLOR: Record<Task['status'], 'subtle' | 'claude' | 'success' | 'error'> = {
  pending: 'subtle',
  running: 'claude',
  done: 'success',
  failed: 'error',
}

// 規範與任務卡片都只屬於當前 session（$.state），新 session 一律從空白開始
// $.state 跨 hot-reload 保留、跨 session 不保留：第一次進來才清空
async function load($: $) {
  // hot-reload 時舊卡片可能沒有 files 欄位（state 跨重載保留）：補上
  await update($, tasks, l => l.map(t => ({ ...t, files: t.files ?? [] })))
  if (await read($, isInitialized)) return
  await update($, isPaneSeen, () => false)
  await update($, rules, () => '')
  await update($, skills, () => [])
  await update($, skillDraft, () => null)
  await update($, fileDraft, () => null)
  await update($, tasks, () => [])
  await update($, runMode, () => 'linear')
  await update($, agentMap, () => ({}))
  await update($, isInitialized, () => true)
}

// 同步模式任務訊息裡的卡片標記：turn.start 看到它就能把 subagent 對應回卡片
const TASK_MARK = '[todo-tasks:'

// 模型回報進度用的工具：完整名稱 mcp__todo-tasks__progress
const PROGRESS_TOOL = 'progress'
const PROGRESS_TOOL_FULL = `mcp__${PLUGIN}__${PROGRESS_TOOL}`
const PROGRESS_HINT =
  `處理過程中請用 ${PROGRESS_TOOL_FULL} 工具回報進度（percent 0～100 與一句 note），` +
  `至少在：開始分析後、主要修改完成、驗證/測試完成、回報結果前各呼叫一次。`

function markedTaskId(text: string) {
  const at = text.indexOf(TASK_MARK)
  if (at < 0) return undefined
  const end = text.indexOf(']', at)
  return end < 0 ? undefined : text.slice(at + TASK_MARK.length, end)
}

const RUN_MODE_OPTIONS: readonly { value: RunMode; label: string }[] = [
  { value: 'linear', label: '線性' },
  { value: 'parallel', label: '同步' },
]

const RUN_MODE_LABEL: Record<RunMode, string> = { linear: '線性', parallel: '同步' }

function isRunMode(v: string): v is RunMode {
  return v === 'linear' || v === 'parallel'
}

// `.claude/skills/foo/SKILL.md`、`foo/` 或 `foo.md` → `foo`
// 去掉前後空白與引號（從檔案總管「複製路徑」貼上會帶引號）
function cleanPath(raw: string) {
  return raw.trim().replace(/^["']+|["']+$/g, '').trim()
}

function skillName(path: string) {
  const parts = cleanPath(path).replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  if (parts.length > 1 && /^skill\.md$/i.test(parts[parts.length - 1]!)) parts.pop()
  return parts[parts.length - 1]!.replace(/\.md$/i, '')
}

// 規範文字 + 已登錄的 skill 對照表（@名稱 → 路徑）；兩者皆空則回空字串
function rulesText(ruleText: string, skillList: string[]) {
  const parts: string[] = []
  if (ruleText.trim()) parts.push(ruleText.trim())
  if (skillList.length) {
    parts.push(
      '可用的 skill（規範中以 @名稱 引用，處理任務前先讀取對應檔案）：\n' +
        skillList.map(p => `- @${skillName(p)} → ${p}`).join('\n'),
    )
  }
  return parts.join('\n\n')
}

function buildPrompt(ruleText: string, task: Task, index: number, total: number, mode: RunMode = 'linear') {
  const rulesPart = ruleText ? `## 任務處理規範\n${ruleText}\n\n` : ''
  const tail =
    mode === 'parallel'
      ? `請嚴格依照上述規範處理這個任務。這個任務與佇列中其他任務正由不同的 subagent 同時處理，` +
        `只負責自己這一項、不要動其他任務的範圍。完成後請簡短回報結果（做了什麼、改了哪些檔案、有無問題）。`
      : `請嚴格依照上述規範處理這個任務。完成後請簡短回報結果；` +
        `這是佇列中的第 ${index + 1} 個任務，回報後會自動開始下一個。`
  return (
    `【TodoTasks 任務 ${index + 1}/${total}】` +
    (mode === 'parallel' ? `${TASK_MARK}${task.id}]` : '') +
    `\n\n` +
    rulesPart +
    `## 任務標題\n${task.title.trim() || '（未命名）'}\n\n` +
    `## 任務內容\n${task.content.trim() || '（無內容）'}\n\n` +
    (task.files.length
      ? `## 附加檔案 / 網址\n處理前請先讀取（本機路徑用 Read，網址用 WebFetch）：\n${task.files.map(f => `- ${f}`).join('\n')}\n\n`
      : '') +
    `## 進度回報\n${PROGRESS_HINT}\n\n` +
    tail
  )
}

// 卡片進入執行中：清掉上一輪的進度與計數
function startFields(): Partial<Task> {
  return { status: 'running', result: undefined, progress: { percent: 0 }, toolCalls: 0 }
}

// 哪張卡片在呼叫工具：同步模式看 agentId 對應；線性模式就是唯一執行中的那張
async function taskOfCall($: $, agentId: string | undefined) {
  const map = await read($, agentMap)
  const list = await read($, tasks)
  if (Object.keys(map).length) return agentId ? list.find(t => t.id === map[agentId]) : undefined
  return list.find(t => t.status === 'running')
}

function clampPercent(v: unknown) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(100, Math.round(n)))
}

// 文字進度條：[██████░░░░] 60%
function progressBar(percent: number, cells: number) {
  const n = Math.max(4, cells)
  const filled = Math.round((percent / 100) * n)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(n - filled) }
}

// 同步模式：由主模型在同一則回覆裡用 Agent 工具派出所有 subagent
// （plugin 直接 $.agent.spawn 會被 auto mode 的分類器擋下：「沒有模型請求對應這個動作」）
async function startParallel($: $) {
  const list = await read($, tasks)
  const pending = list.filter(t => t.status === 'pending')
  const ruleText = rulesText(await read($, rules), await read($, skills))
  await update($, agentMap, () => ({}))
  await update($, tasks, l =>
    l.map(t => (t.status === 'pending' ? { ...t, ...startFields() } : t)),
  )
  $.ui.status(`同步處理 ${pending.length} 個任務…`)

  const blocks = pending.map(task => {
    const index = list.findIndex(t => t.id === task.id)
    return (
      `<task n="${index + 1}" description="TodoTasks ${index + 1}/${list.length}：${task.title.trim() || '（未命名）'}">\n` +
      buildPrompt(ruleText, task, index, list.length, 'parallel') +
      `\n</task>`
    )
  })
  void $.prompt.submit({
    text:
      `【TodoTasks 同步執行】\n\n` +
      `請用 Agent 工具（subagent_type: general-purpose）**在同一則回覆中一次發出 ${pending.length} 個呼叫**，` +
      `讓 ${pending.length} 個 subagent 同時處理下列任務：每個 <task> 對應一個 Agent 呼叫，` +
      `prompt 請原封不動使用 <task> 內的全文（包含開頭的【TodoTasks 任務 i/N】標記行），description 用 <task> 的 description 屬性。` +
      `不要自己動手做任務、不要分批、不要先讀檔案再派。` +
      `全部 subagent 回報後，請彙整成一份簡短總結（每個任務一兩句：做了什麼、有無問題）。\n\n` +
      blocks.join('\n\n'),
    asUser: true,
  })
  $.ui.toast(`已要求主模型同時派出 ${pending.length} 個 subagent`)
}

// 同步模式：還在「執行中」卻沒有任何 subagent 對應的卡片 → 主模型沒派出，標失敗
async function failUndispatched($: $) {
  const dispatched = new Set(Object.values(await read($, agentMap)))
  const stuck = (await read($, tasks)).filter(t => t.status === 'running' && !dispatched.has(t.id))
  if (!stuck.length) return 0
  await update($, tasks, l =>
    l.map(t =>
      t.status === 'running' && !dispatched.has(t.id)
        ? { ...t, status: 'failed', result: '主模型沒有派出 subagent 處理這張卡片' }
        : t,
    ),
  )
  return stuck.length
}

// 同步模式全部回報後收尾（總結由主模型在同一個 turn 內完成）
async function finishParallel($: $) {
  const stuck = await failUndispatched($)
  await update($, isRunning, () => false)
  await update($, agentMap, () => ({}))
  $.ui.status(undefined)
  $.ui.toast(stuck ? `同步任務完成，${stuck} 張卡片沒有被派出` : '同步任務全部完成')
}

async function runNext($: $): Promise<boolean> {
  const list = await read($, tasks)
  const index = list.findIndex(t => t.status === 'pending')
  if (index < 0) return false
  const task = list[index]!
  await update($, tasks, l => l.map(t => (t.id === task.id ? { ...t, ...startFields() } : t)))
  $.ui.status(`任務 ${index + 1}/${list.length}：${task.title || '（未命名）'}`)
  void $.prompt.submit({
    text: buildPrompt(rulesText(await read($, rules), await read($, skills)), task, index, list.length),
    asUser: true,
  })
  return true
}

async function start($: $) {
  const list = await read($, tasks)
  if (!list.some(t => t.status === 'pending')) {
    $.ui.toast('沒有待處理的任務')
    return
  }
  await update($, isRunning, () => true)
  if ((await read($, runMode)) === 'parallel') {
    await startParallel($)
    return
  }
  await runNext($)
}

async function stop($: $) {
  const parallel = Object.keys(await read($, agentMap)).length > 0
  await update($, isRunning, () => false)
  await update($, agentMap, () => ({}))
  await update($, tasks, l => l.map(t => (t.status === 'running' ? { ...t, status: 'pending' } : t)))
  $.ui.status(undefined)
  // subagent 沒有中止 API：已派出的會跑完，但回報不再寫回卡片
  $.ui.toast(parallel ? '已停止：已派出的 subagent 會自行跑完，結果不再記錄' : '已停止任務佇列')
}

// 多行欄位依內容長高：每個實際換行各算一行，過長的行再依欄寬折行；夾在 min～max 之間
function autoRows(text: string, columns: number, min: number, max: number) {
  const cols = Math.max(10, columns)
  let lines = 0
  for (const line of (text || '').split('\n')) {
    // 以顯示寬度估算：CJK 等全形字算 2 格
    let w = 0
    for (const ch of line) w += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
    lines += Math.max(1, Math.ceil(w / cols))
  }
  return Math.min(max, Math.max(min, lines))
}

function newId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // hot-reload 也會再跑一次 session.start
    await load($)
    await update($, isRunning, () => false)
    // 不自動彈出面板：只在使用者下 /todo-tasks（或按 prompt 上方的重開列）時開啟
    await $.tool.register({
      name: PROGRESS_TOOL,
      description:
        '回報目前 TodoTasks 任務的進度：percent（0～100）與一句 note。處理任務卡片時在每個階段呼叫，面板會顯示進度條。',
      inputSchema: {
        type: 'object',
        properties: {
          percent: { type: 'number', minimum: 0, maximum: 100, description: '完成百分比 0～100' },
          note: { type: 'string', description: '一句話說明目前在做什麼' },
        },
        required: ['percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'todo-tasks',
      description: '開啟任務佇列面板（任務卡片依序交給模型處理）',
    })
    return next(e)
  })

  on('command.run', { command: 'todo-tasks' }, async $ => {
    const r = await openPane($, true)
    return { text: r.isPlaced ? '任務佇列面板已開啟。' : `任務佇列面板尚未顯示（${r.reason}）` }
  })

  // 面板被關掉後，prompt 上方留一條可重新開啟的列；關過就不再自動彈出
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)
    await update($, isPaneSeen, () => true)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen))) return next(e)
    const list = await read($, tasks)
    const running = await read($, isRunning)
    // 沒有任務也沒在跑：不佔 prompt 上方的空間（要開面板用 /todo-tasks）
    if (list.length === 0 && !running) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const done = list.filter(t => t.status === 'done').length
    return (
      <Box gap={1}>
        <Button key="reopen" variant="primary" label="📋 任務佇列" onPress={() => openPane($, true)} />
        <Text dimColor>
          {list.length === 0 ? '尚無任務' : `${done}/${list.length} 完成`}
          {running ? '　執行中…' : ''}
        </Text>
      </Box>
    )
  })

  // 規範進系統提示：每個新 session 都會先知道處理規範
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const text = rulesText(await read($, rules), await read($, skills))
    if (!text) return { sections }
    return {
      sections: [
        ...sections,
        {
          id: `${PLUGIN}:rules`,
          scope: 'session',
          text:
            `# TodoTasks 任務處理規範\n` +
            `使用者透過「任務佇列」面板逐一送出任務（訊息以【TodoTasks 任務 i/N】開頭）。` +
            `處理這些任務時必須遵守以下規範，並用 ${PROGRESS_TOOL_FULL} 工具回報進度：\n\n${text}`,
        },
      ],
    }
  })

  // 模型回報進度 → 寫到對應卡片
  on('tool.call', { tool: PROGRESS_TOOL_FULL }, async ($, e) => {
    const percent = clampPercent(e.percent)
    if (percent === undefined) {
      const msg = 'percent 必須是 0～100 的數字'
      return { isError: true, result: msg, text: msg }
    }
    const note = typeof e.note === 'string' ? e.note.trim() : ''
    const task = (await read($, isRunning)) ? await taskOfCall($, e.agentId) : undefined
    if (!task) return { result: '目前沒有執行中的任務卡片，已忽略', text: '目前沒有執行中的任務卡片，已忽略' }
    await update($, tasks, l =>
      l.map(t => (t.id === task.id ? { ...t, progress: { percent, ...(note ? { note } : {}) } } : t)),
    )
    return { result: 'ok', text: `已記錄進度 ${percent}%` }
  })

  // 任何工具呼叫 → 對應卡片的活動計數 +1
  on('tool.call', async ($, e, next) => {
    if (e.tool !== PROGRESS_TOOL_FULL && (await read($, isRunning))) {
      const task = await taskOfCall($, e.agentId)
      if (task) {
        await update($, tasks, l => l.map(t => (t.id === task.id ? { ...t, toolCalls: (t.toolCalls ?? 0) + 1 } : t)))
      }
    }
    return next(e)
  })

  // 同步模式：主模型派出的 subagent，prompt 帶卡片標記 → 記下 agentId ↔ 卡片
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (!r.agentId || !(await read($, isRunning))) return r
    const taskId = markedTaskId(e.prompt)
    if (!taskId) return r
    const list = await read($, tasks)
    const map = await read($, agentMap)
    if (list.find(t => t.id === taskId)?.status === 'running' && !Object.values(map).includes(taskId)) {
      const agentId = r.agentId
      await update($, agentMap, m => ({ ...m, [agentId]: taskId }))
    }
    return r
  })

  // 同步模式：subagent 的第一個 turn 以我們的任務訊息開頭 → 記下 agentId ↔ 卡片
  on('turn.start', async ($, e, next) => {
    if (!e.agentId || !(await read($, isRunning))) return next(e)
    const taskId = markedTaskId(e.text)
    if (!taskId) return next(e)
    const list = await read($, tasks)
    const map = await read($, agentMap)
    const task = list.find(t => t.id === taskId)
    if (task?.status === 'running' && !Object.values(map).includes(taskId)) {
      await update($, agentMap, m => ({ ...m, [e.agentId!]: taskId }))
    }
    return next(e)
  })

  // 一個任務的 turn 結束 → 標記完成，接著送出下一個
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!(await read($, isRunning))) return result

    // 同步模式：某個 subagent 回報了 → 寫回對應卡片；全部回報後彙整
    if (e.agentId) {
      const map = await read($, agentMap)
      const taskId = map[e.agentId]
      if (!taskId) return result
      const ok = e.reason === 'answer'
      await update($, tasks, l =>
        l.map(t =>
          t.id === taskId
            ? {
                ...t,
                status: ok ? 'done' : 'failed',
                progress: ok ? { percent: 100 } : t.progress,
                result: ok ? e.answer : `中斷（${e.reason}）${e.answer ? `\n${e.answer}` : ''}`,
              }
            : t,
        ),
      )
      await update($, agentMap, m => {
        const { [e.agentId!]: _, ...rest } = m
        return rest
      })
      const remaining = Object.keys(await read($, agentMap)).length
      const list = await read($, tasks)
      const finished = list.filter(t => t.status !== 'pending' && t.status !== 'running').length
      $.ui.status(remaining ? `同步處理中：${finished}/${list.length} 已回報` : undefined)
      if (!remaining) await finishParallel($)
      return result
    }
    if ((await read($, runMode)) === 'parallel') {
      // 主迴圈的 turn 結束（派工 turn，或使用者另外打字）：派工已經發生過，
      // 還在跑卻沒有 subagent 的卡片就是主模型沒派出的 → 標失敗；一個都沒派就直接停
      const stuck = await failUndispatched($)
      if (Object.keys(await read($, agentMap)).length) {
        if (stuck) $.ui.toast(`同步模式：${stuck} 張卡片沒有被派出`)
        return result
      }
      if (!stuck) return result
      await update($, isRunning, () => false)
      $.ui.status(undefined)
      $.ui.toast(`同步模式：${stuck} 張卡片沒有被派出，佇列已停止`)
      return result
    }
    const list = await read($, tasks)
    const current = list.find(t => t.status === 'running')
    if (!current) return result

    const ok = e.reason === 'answer'
    await update($, tasks, l =>
      l.map(t =>
        t.id === current.id ? { ...t, status: ok ? 'done' : 'failed', progress: ok ? { percent: 100 } : t.progress } : t,
      ),
    )

    if (!ok) {
      await update($, isRunning, () => false)
      $.ui.status(undefined)
      $.ui.toast(`任務「${current.title || '（未命名）'}」中斷（${e.reason}），佇列已停止`)
      return result
    }

    const started = await runNext($)
    if (!started) {
      await update($, isRunning, () => false)
      $.ui.status(undefined)
      $.ui.toast('任務佇列全部完成')
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, tasks)
    const ruleText = await read($, rules)
    const running = await read($, isRunning)
    const parallelRunning = running && Object.keys(await read($, agentMap)).length > 0
    const skillList = await read($, skills)
    const draft = await read($, skillDraft)
    const fDraft = await read($, fileDraft)
    const width = Math.max(20, e.props.bodyColumns - 2)
    const done = list.filter(t => t.status === 'done').length

    if (e.surface === 'mobile') {
      // 手機沒有文字輸入元件：唯讀檢視＋啟動/停止
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap={1}>
          {list.map((task, i) => (
            <Box key={`m-${task.id}`} flexDirection="column" borderStyle="single" paddingX={1}>
              <Text weight="bold">
                {STATUS_MARK[task.status]} {i + 1}. {task.title || '（未命名）'}
              </Text>
              <Text dimColor>{task.content}</Text>
              {task.status === 'running' && (
                <Text color="claude" size="caption">
                  {progressBar(task.progress?.percent ?? 0, 16).filled}
                  <Text dimColor>{progressBar(task.progress?.percent ?? 0, 16).empty}</Text>
                  {' '}{task.progress?.percent ?? 0}%{task.progress?.note ? `　${task.progress.note}` : ''}
                </Text>
              )}
              {task.result && <Text size="caption">↳ {task.result}</Text>}
            </Box>
          ))}
          {running ? (
            <Button key="stop" label="■ 停止" onPress={() => stop($)} />
          ) : (
            <Button key="start" variant="primary" label="▶ 啟動任務" onPress={() => start($)} />
          )}
          <Text dimColor>
            {done}/{list.length} 完成　執行順序：{RUN_MODE_LABEL[await read($, runMode)]}
          </Text>
        </Box>
      )
    }

    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const mode = await read($, runMode)

    const setTask = (id: string, patch: Partial<Task>) =>
      update($, tasks, l => l.map(t => (t.id === id ? { ...t, ...patch } : t)))

    return (
      <Box flexDirection="column" width={width} gap={1}>
        {/* 處理規範：常駐輸入欄，邊打邊存 */}
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={0}>
          <Text weight="bold">處理規範</Text>
          <Input
            key="rules"
            placeholder={DEFAULT_RULES}
            value={ruleText}
            rows={autoRows(ruleText, width - 4, 2, 12)}
            onInput={v => update($, rules, () => v)}
            onSubmit={v => update($, rules, () => v)}
          />
          <Box justifyContent="space-between" alignItems="center" marginTop={1}>
            <Text weight="bold">Skill</Text>
            {draft === null && (
              <Button
                key="add-skill"
                variant="secondary"
                label="＋ 新增 skill"
                onPress={() => update($, skillDraft, () => '')}
              />
            )}
          </Box>
          {skillList.length === 0 && draft === null && (
            <Text dimColor size="caption">尚未登錄；登錄後按名稱會補到規範末尾</Text>
          )}
          {skillList.map((path, i) => (
            <Box key={`skill-row-${i}`} alignItems="center" gap={1}>
              <Button
                key={`skill-${i}`}
                variant="secondary"
                label={`@${skillName(path)}`}
                onPress={() => {
                  // 按下 → 在規範末尾補上 @名稱
                  const name = `@${skillName(path)}`
                  return update($, rules, v => (v.trimEnd() ? `${v.trimEnd()} ${name}` : name))
                }}
              />
              <Text dimColor size="caption" wrap="truncate-start">
                {path}
              </Text>
              <Button
                key={`rm-skill-${i}`}
                plain
                dimColor
                label="×"
                onPress={() => update($, skills, l => l.filter((_, j) => j !== i))}
              />
            </Box>
          ))}
          {draft !== null && (
            <Input
              key="skill-path"
              label="路徑"
              placeholder=".claude/skills/my-skill/SKILL.md"
              value={draft}
              submitLabel="新增"
              autoFocus
              onInput={v => update($, skillDraft, () => v)}
              onSubmit={async v => {
                const path = cleanPath(v)
                if (path) await update($, skills, l => [...l, path])
                await update($, skillDraft, () => null)
              }}
            />
          )}
        </Box>

        {/* 任務列表標題列：計數 + 新增 */}
        <Box justifyContent="space-between" alignItems="center">
          <Text weight="bold">
            任務{' '}
            <Text dimColor>
              {list.length === 0 ? '（空）' : `${done}/${list.length} 完成`}
            </Text>
            {running && <Text color="claude">　● {parallelRunning ? '同步執行中' : '執行中'}</Text>}
          </Text>
          <Button
            key="add"
            label="＋ 新增任務"
            onPress={async () => {
              const task: Task = { id: newId(), title: '', content: '', files: [], status: 'pending' }
              await update($, tasks, l => [...l, task])
            }}
          />
        </Box>

        {list.length === 0 && (
          <Box borderStyle="round" borderColor="subtle" borderDimColor paddingX={1} justifyContent="center">
            <Text dimColor>還沒有任務卡片，按上方「＋ 新增任務」</Text>
          </Box>
        )}

        {list.map((task, i) => (
          <Box
            key={`card-${task.id}`}
            flexDirection="column"
            borderStyle="round"
            borderColor={STATUS_COLOR[task.status]}
            borderDimColor={task.status === 'pending' || task.status === 'done'}
            paddingX={1}
          >
            <Box justifyContent="space-between" alignItems="center">
              <Text color={STATUS_COLOR[task.status]} weight="semibold">
                {STATUS_MARK[task.status]} {i + 1}. {task.title.trim() || '（未命名）'}
                <Text dimColor size="caption">　{STATUS_LABEL[task.status]}</Text>
              </Text>
              <Button
                key={`del-${task.id}`}
                plain
                dimColor
                label="刪除"
                onPress={() => update($, tasks, l => l.filter(t => t.id !== task.id))}
              />
            </Box>
            <Input
              key={`title-${task.id}`}
              label="標題"
              placeholder="一句話說這個任務"
              value={task.title}
              onInput={v => setTask(task.id, { title: v })}
              onSubmit={v => setTask(task.id, { title: v })}
            />
            <Input
              key={`content-${task.id}`}
              label="內容"
              placeholder="要做什麼、涉及哪些檔案、完成條件"
              value={task.content}
              rows={autoRows(task.content, width - 4 - 5, 2, 15)}
              onInput={v => setTask(task.id, { content: v })}
              onSubmit={v => setTask(task.id, { content: v })}
            />
            {/* 附加檔案：做法同 skill 區 */}
            <Box justifyContent="space-between" alignItems="center">
              <Text dimColor>附加檔案 / 網址</Text>
              {fDraft?.id !== task.id && (
                <Button
                  key={`add-file-${task.id}`}
                  plain
                  label="＋ 附加檔案"
                  onPress={() => update($, fileDraft, () => ({ id: task.id, text: '' }))}
                />
              )}
            </Box>
            {task.files.map((path, j) => (
              <Box key={`file-row-${task.id}-${j}`} alignItems="center" gap={1}>
                <Text size="caption" wrap="truncate-start">
                  {path}
                </Text>
                <Button
                  key={`rm-file-${task.id}-${j}`}
                  plain
                  dimColor
                  label="×"
                  onPress={() => setTask(task.id, { files: task.files.filter((_, k) => k !== j) })}
                />
              </Box>
            ))}
            {/* 執行中的進度條：模型用 progress 工具回報百分比；右側是工具呼叫次數 */}
            {task.status === 'running' && (
              <Box flexDirection="column" marginTop={1}>
                <Box gap={1}>
                  <Text color="claude">
                    {progressBar(task.progress?.percent ?? 0, Math.min(40, width - 16)).filled}
                    <Text dimColor>{progressBar(task.progress?.percent ?? 0, Math.min(40, width - 16)).empty}</Text>
                  </Text>
                  <Text weight="semibold">{task.progress?.percent ?? 0}%</Text>
                  <Text dimColor size="caption">🔧 {task.toolCalls ?? 0}</Text>
                </Box>
                <Text dimColor size="caption">{task.progress?.note || '處理中…'}</Text>
              </Box>
            )}
            {/* 同步模式：subagent 的回報 */}
            {task.result && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>回報</Text>
                <Text size="caption" wrap="wrap">{task.result}</Text>
              </Box>
            )}
            {fDraft?.id === task.id && (
              <Input
                key={`file-path-${task.id}`}
                label="路徑"
                placeholder="src/foo.ts、完整路徑或 https://…"
                value={fDraft.text}
                submitLabel="新增"
                autoFocus
                onInput={v => update($, fileDraft, () => ({ id: task.id, text: v }))}
                onSubmit={async v => {
                  const path = cleanPath(v)
                  if (path) await setTask(task.id, { files: [...task.files, path] })
                  await update($, fileDraft, () => null)
                }}
              />
            )}
          </Box>
        ))}

        {/* 底部動作列 */}
        <Box justifyContent="space-between" alignItems="center">
          <Box gap={1} alignItems="center">
            {running ? (
              <Button key="stop" variant="secondary" label="■ 停止" onPress={() => stop($)} />
            ) : (
              <Button key="start" variant="primary" label="▶ 啟動任務" onPress={() => start($)} />
            )}
            {/* 執行順序：線性 = 一張接一張交給主模型；同步 = 每張各派一個 subagent 同時跑 */}
            {running ? (
              <Text dimColor size="caption">{RUN_MODE_LABEL[mode]}</Text>
            ) : (
              <Select
                key="run-mode"
                label="執行順序"
                options={RUN_MODE_OPTIONS}
                value={mode}
                onSelect={v => {
                  if (isRunMode(v)) void update($, runMode, () => v)
                }}
              />
            )}
          </Box>
          {list.some(t => t.status !== 'pending') && !running ? (
            // 保留卡片內容，只把狀態全部回到待處理，之後再按啟動就會重跑
            <Button
              key="reset"
              variant="secondary"
              label="↻ 重置任務"
              onPress={async () => {
                await update($, tasks, l => l.map(t => ({ ...t, status: 'pending', result: undefined, progress: undefined, toolCalls: undefined })))
                $.ui.toast('已重置，按 ▶ 啟動任務 可再跑一次')
              }}
            />
          ) : (
            <Text dimColor size="caption">
              {list.length === 0 ? '先新增任務卡片' : `${list.length} 張待處理`}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
