export type TaskStatus = 'pending' | 'running' | 'done' | 'failed'

export type Task = {
  id: string
  title: string
  content: string
  // 附加檔案路徑，會列在任務訊息裡
  files: string[]
  status: TaskStatus
}

declare module 'claude-code' {
  interface PluginState {
    'todo-tasks': {
      rules: string
      skills: string[]
      skillDraft: string | null
      // 正在為哪張卡片輸入附加檔案路徑
      fileDraft: { id: string; text: string } | null
      tasks: Task[]
      isRunning: boolean
      isPaneOpen: boolean
      isPaneSeen: boolean
      isInitialized: boolean
    }
  }
}
