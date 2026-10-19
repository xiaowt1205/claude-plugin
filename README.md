# xiaowt-plugins

Justin 的 Claude Code plugin marketplace。

Repo：https://github.com/xiaowt1205/claude-plugin

## 現有 plugin

| Plugin | 版本 | 說明 |
| --- | --- | --- |
| [todo-tasks](plugins/todo-tasks) | 0.1.0 | 任務卡片佇列 mod：設定處理規範，新增任務卡片（標題＋內容），啟動後依序逐一交給模型處理 |

## 結構

```
.claude-plugin/marketplace.json     # marketplace 目錄（name / owner / plugins）
plugins/<plugin-name>/
  .claude-plugin/plugin.json        # plugin manifest（name 需與 marketplace entry 相同）
  skills/<skill>/SKILL.md           # 另可加 commands/、agents/、hooks/hooks.json、.mcp.json
```

## 安裝

### Claude 桌面版

1. 左側欄打開 **Customize** → **Plugins**（Cowork 要先切到 **Cowork** 分頁）
2. **Add** → **Add marketplace** → **Add from a repository**
3. 輸入 `xiaowt1205/claude-plugin`（或完整 URL）
4. 到 **Discover** 分頁選擇 plugin → **Add**

> 部分桌面版版本的 Plugins 頁沒有「Add from a repository」選項。遇到時，在 Claude Code session 裡輸入
> `/plugin marketplace add xiaowt1205/claude-plugin`，再 `/plugin install todo-tasks@xiaowt-plugins`。

移除 marketplace：**Customize** → **Plugins**，在 marketplace 右側選單選 **Remove**（會一併移除它的 plugin）。

### CLI

```bash
claude plugin marketplace add xiaowt1205/claude-plugin
claude plugin install todo-tasks@xiaowt-plugins
```

## 新增 plugin

### 1. 在 repo 裡加入 plugin

1. 建立 `plugins/<name>/.claude-plugin/plugin.json`（`name` 用 kebab-case）
2. 在 `.claude-plugin/marketplace.json` 的 `plugins` 加一筆：
   ```json
   { "name": "<name>", "source": "./plugins/<name>", "description": "..." }
   ```
   - entry 的 `name` 必須和 `plugin.json` 的 `name` 相同
   - `source` 從 repo 根目錄算起、以 `./` 開頭，不可用 `..`
   - `version` 只寫在 `plugin.json`（兩邊都寫時 plugin.json 優先，validate 會警告）
3. 更新上方「現有 plugin」表格
4. commit 並 push 到 `main`（所有 plugin 放同一個 branch 的子資料夾，不需要分 branch）

### 2. 用桌面版驗證與安裝

- **最省事**：在桌面版連結本機的 repo 資料夾，請 Claude「驗證這個 marketplace」，由 Claude 檢查 JSON 與欄位
- **安裝新 plugin**：push 後到 **Customize** → **Plugins** → **Discover** 找到新 plugin → **Add**
- 若 Discover 沒出現新 plugin：在 Plugins 頁把 `xiaowt-plugins` **Remove** 後重新 **Add from a repository**，或在 Claude Code session 輸入 `/plugin marketplace update xiaowt-plugins`

### CLI 驗證（選用）

```bash
claude plugin validate .
```
