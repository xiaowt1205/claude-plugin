export type TaskStatus = 'pending' | 'running' | 'done' | 'failed'

// 執行順序：線性 = 一張接一張交給主模型；同步 = 啟動時每張卡片各派一個 subagent 同時處理
export type RunMode = 'linear' | 'parallel'

// Skill 收藏：跨 session 保留（$.store）。target 是 skill 路徑，或 `/名稱` 形式的既有 skill 指令
export type Favorite = { name: string; target: string }

export type Task = {
  id: string
  title: string
  content: string
  // 附加檔案路徑，會列在任務訊息裡
  files: string[]
  status: TaskStatus
  // 同步模式：負責這張卡片的 subagent 回報內容
  result?: string
  // 執行中的進度：模型透過 mcp__todo-tasks__progress 回報的百分比與說明
  progress?: { percent: number; note?: string }
  // 執行中累計的工具呼叫次數（活動指標）
  toolCalls?: number
}

declare module 'claude-code' {
  interface PluginState {
    'todo-tasks': {
      rules: string
      skills: string[]
      skillDraft: string | null
      // Skill 收藏（$.store 的鏡像）、是否展開、登錄中的欄位
      favorites: Favorite[]
      favOpen: boolean
      favDraft: Favorite | null
      // 正在為哪張卡片輸入附加檔案路徑
      fileDraft: { id: string; text: string } | null
      tasks: Task[]
      runMode: RunMode
      // 同步模式：subagent id → 任務卡片 id
      agentMap: Record<string, string>
      isRunning: boolean
      isPaneOpen: boolean
      isPaneSeen: boolean
      isInitialized: boolean
    }
  }
}
