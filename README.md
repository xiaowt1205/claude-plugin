# xiaowt-plugins

Claude Code plugin marketplace。

## 結構

```
.claude-plugin/marketplace.json     # marketplace 目錄（name / owner / plugins）
plugins/<plugin-name>/
  .claude-plugin/plugin.json        # plugin manifest（name 需與 marketplace entry 相同）
  skills/<skill>/SKILL.md           # 另可加 commands/、agents/、hooks/hooks.json、.mcp.json
```

## 使用

```bash
# 驗證
claude plugin validate .

# 本機測試
claude plugin marketplace add ./ClaudePlugin
claude plugin install hello-world@xiaowt-plugins

# 推上 GitHub 後，其他人
claude plugin marketplace add xiaowt1205/ClaudePlugin
claude plugin install hello-world@xiaowt-plugins
```

## 新增 plugin

1. 建立 `plugins/<name>/.claude-plugin/plugin.json`
2. 在 `marketplace.json` 的 `plugins` 加一筆 `{ "name": "<name>", "source": "./plugins/<name>", "description": "..." }`
3. `version` 只寫在 `plugin.json`（兩邊都寫時 plugin.json 優先，validate 會警告）
4. 執行 `claude plugin validate .`
