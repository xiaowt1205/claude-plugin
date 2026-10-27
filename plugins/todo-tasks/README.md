# todo-tasks（任務佇列 mod）

Claude Code 的 function-hooks 外掛：在側邊面板維護任務卡片（標題＋內容），
設定一次「處理規範 / skill」，按「▶ 啟動任務」後依序把每張卡片送給模型處理，
一個 turn 結束自動接下一張。

## 安裝 / 使用
```
claude --plugin-dir /path/to/todo-tasks     # 開發期：會 hot-reload
```
- 面板不會自動開啟：要用時輸入 `/todo-tasks` 即可打開。面板關掉後、若還有任務卡片或佇列正在跑，prompt 上方會留一條「📋 任務佇列」列可重新開啟
- 面板純滑鼠操作，沒有熱鍵；規範欄與卡片內容欄是多行欄位，會隨內容自動長高（規範 2～12 行、內容 2～15 行），Enter 送出、換行同 prompt 框的換行方式；規範欄常駐，Enter 儲存；「↻ 重置任務」保留內容、狀態回待處理，可再跑一次
- 每張卡片可附加檔案路徑（＋ 附加檔案），任務訊息會多一段「附加檔案」要模型先讀
- 規範下方可登錄 skill 路徑（按 ＋ 新增欄位）；登錄後變成 `@名稱` 按鈕，編輯規範時按下會補到規範末尾，任務訊息會附上 `@名稱 → 路徑` 對照表
- 規範與卡片都只屬於當前 session，新 session 一律從空白開始；規範同時注入系統提示與每則任務訊息

## 檔案
- `.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.tsx`、`types/index.d.ts`
- `tests/queue.test.tsx` → `claude plugin test .`
- `claude plugin validate .`
