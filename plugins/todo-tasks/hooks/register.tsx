import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task } from '../types'

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
  await update($, isInitialized, () => true)
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

function buildPrompt(ruleText: string, task: Task, index: number, total: number) {
  const rulesPart = ruleText ? `## 任務處理規範\n${ruleText}\n\n` : ''
  return (
    `【TodoTasks 任務 ${index + 1}/${total}】\n\n` +
    rulesPart +
    `## 任務標題\n${task.title.trim() || '（未命名）'}\n\n` +
    `## 任務內容\n${task.content.trim() || '（無內容）'}\n\n` +
    (task.files.length
      ? `## 附加檔案 / 網址\n處理前請先讀取（本機路徑用 Read，網址用 WebFetch）：\n${task.files.map(f => `- ${f}`).join('\n')}\n\n`
      : '') +
    `請嚴格依照上述規範處理這個任務。完成後請簡短回報結果；` +
    `這是佇列中的第 ${index + 1} 個任務，回報後會自動開始下一個。`
  )
}

async function runNext($: $): Promise<boolean> {
  const list = await read($, tasks)
  const index = list.findIndex(t => t.status === 'pending')
  if (index < 0) return false
  const task = list[index]!
  await update($, tasks, l => l.map(t => (t.id === task.id ? { ...t, status: 'running' } : t)))
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
  await runNext($)
}

async function stop($: $) {
  await update($, isRunning, () => false)
  await update($, tasks, l => l.map(t => (t.status === 'running' ? { ...t, status: 'pending' } : t)))
  $.ui.status(undefined)
  $.ui.toast('已停止任務佇列')
}

function newId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // hot-reload 也會再跑一次 session.start：面板已顯示過就不要再彈
    const first = !(await read($, isInitialized))
    await load($)
    await update($, isRunning, () => false)
    if (first) {
      void openPane($).then(r => {
        if (!r.isPlaced) $.ui.log(`todo-tasks: 面板尚未顯示（${r.reason}）`)
      })
    }
    return next(e)
  })

  // session.start 主動開的面板在窄視窗不會被畫出來（要 ≥144 欄）；
  // 使用者送出的第一則 prompt 算「被要求」的開啟，任何寬度都會放置，所以在那時再開一次。
  // 只做在面板還沒顯示過、也沒被關過的時候（isPaneSeen）
  on('prompt.submit', async ($, e, next) => {
    // 先讓 prompt 通過，再開面板：在 next 之前改 state 會讓佇列的下一則 submit 丟失
    const result = await next(e)
    if (!e.isMeta && !e.command && !(await read($, isPaneSeen))) {
      await update($, isPaneSeen, () => true)
      if (!(await read($, isPaneOpen))) await openPane($)
    }
    return result
  })

  // 面板被關掉後，prompt 上方留一條可重新開啟的列；關過就不再自動彈出
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)
    await update($, isPaneSeen, () => true)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tasks)
    const running = await read($, isRunning)
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
            `處理這些任務時必須遵守以下規範：\n\n${text}`,
        },
      ],
    }
  })

  // 一個任務的 turn 結束 → 標記完成，接著送出下一個
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || !(await read($, isRunning))) return result
    const list = await read($, tasks)
    const current = list.find(t => t.status === 'running')
    if (!current) return result

    const ok = e.reason === 'answer'
    await update($, tasks, l =>
      l.map(t => (t.id === current.id ? { ...t, status: ok ? 'done' : 'failed' } : t)),
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
            </Box>
          ))}
          {running ? (
            <Button key="stop" label="■ 停止" onPress={() => stop($)} />
          ) : (
            <Button key="start" variant="primary" label="▶ 啟動任務" onPress={() => start($)} />
          )}
          <Text dimColor>{done}/{list.length} 完成</Text>
        </Box>
      )
    }

    const { Box, Text, Button, Input } = $.ui.resolve(e)

    const setTask = (id: string, patch: Partial<Task>) =>
      update($, tasks, l => l.map(t => (t.id === id ? { ...t, ...patch } : t)))

    return (
      <Box flexDirection="column" width={width} gap={1}>
        {/* 處理規範：常駐輸入欄，Enter 儲存 */}
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={0}>
          <Box justifyContent="space-between">
            <Text weight="bold">處理規範</Text>
            <Text dimColor size="caption">每則任務都會附上，只在本 session 有效</Text>
          </Box>
          <Input
            key="rules"
            placeholder={DEFAULT_RULES}
            value={ruleText}
            submitLabel="儲存"
            onInput={v => update($, rules, () => v)}
            onSubmit={async v => {
              await update($, rules, () => v)
              $.ui.toast('規範已儲存')
            }}
          />
          {/* Input 是單行元件拉不高：下方用可換行文字把全文顯示出來 */}
          {ruleText.trim() !== '' && (
            <Box paddingX={1} marginTop={1} borderStyle="single" borderColor="subtle" borderDimColor>
              <Text wrap="wrap">{ruleText}</Text>
            </Box>
          )}
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
            {running && <Text color="claude">　● 執行中</Text>}
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
          {running ? (
            <Button key="stop" variant="secondary" label="■ 停止" onPress={() => stop($)} />
          ) : (
            <Button key="start" variant="primary" label="▶ 啟動任務" onPress={() => start($)} />
          )}
          {list.some(t => t.status !== 'pending') && !running ? (
            // 保留卡片內容，只把狀態全部回到待處理，之後再按啟動就會重跑
            <Button
              key="reset"
              variant="secondary"
              label="↻ 重置任務"
              onPress={async () => {
                await update($, tasks, l => l.map(t => ({ ...t, status: 'pending' })))
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
