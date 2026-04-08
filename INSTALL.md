# 金融市场日报（market-digest）— 安装手册（Agent 操作指南）

**本文件仅在安装时使用。安装完成后无需再次读取。**

用户说"帮我安装金融市场日报"或类似话语时，Agent 按以下步骤逐一执行。所有操作均由 Agent 完成，不需要用户有任何技术背景。

---

## 第 1 步：确定安装目录并克隆仓库

根据当前使用的 AI 框架，选择合适的技能/工作区目录（例如：`~/<框架名>/workspace/skills/market-digest`）。如框架有约定的技能目录，请使用该目录；若不确定，可询问用户或使用 `~/market-digest`。

```bash
git clone <用户提供的仓库地址> <技能目录>
```

如果目录已存在，跳过此步（说明已经克隆过）。

---

## 第 2 步：安装 Node.js 依赖

```bash
cd <技能目录> && npm install
```

---

## 第 3 步：收集数据库配置

**逐项询问**，一次只问一个问题，等用户回答后再问下一个：

1. "数据库主机地址是什么？（例如：192.168.1.100 或 localhost）"
2. "数据库端口是多少？（默认 5432，不确定直接说默认就好）"
3. "数据库名称是什么？"
4. "数据库用户名是什么？"
5. "数据库密码是什么？"

---

## 第 4 步：运行 setup.js（自动检测模型 & Chrome）

> **说明**：`setup.js` 会自动做两件事：
> 1. 读取已知 AI 框架的本机配置文件（如 `~/.openclaw/openclaw.json`），提取模型信息；
> 2. 检测系统中已安装的 Chrome/Chromium 路径（检查常见安装目录 + `which` 命令）。
>
> 两者都是**读本地磁盘/命令**实现的，与 LLM 自身无关。
> 检测结果分别以 `[DETECTED_MODEL]` 和 `[DETECTED_CHROME]` 行输出，Agent 据此与用户交互。

先运行以下命令（仅传数据库参数）：

```bash
node <技能目录>/setup.js \
  --db-host <host> \
  --db-port <port> \
  --db-name <dbname> \
  --db-user <user> \
  --db-pass <password>
```

### 4A：处理模型配置（`[DETECTED_MODEL]` 行）

**若输出包含 `[DETECTED_MODEL] source=xxx model=xxx base_url=xxx`**：

询问用户：

> "检测到你当前配置的模型是 **[model]**（来自 [source]），是否用这个模型生成日报？"

- **用户确认** → `config.js` 已自动写入，继续 4B。
- **用户想换其他模型** → 见下方「需要重新指定」。

**若输出包含 `[DETECTED_MODEL] none`，或用户要指定其他模型**：

逐一询问：

1. "请提供模型名称（如 `deepseek-v3`、`gpt-4o` 等）"
2. "请提供 API Key"
3. "请提供 API Base URL（如 `https://api.openai.com/v1`）"

收集后，见第 4 步末尾「重新运行 setup.js」。

---

### 4B：处理 Chrome/Chromium（`[DETECTED_CHROME]` 行）

**若输出包含 `[DETECTED_CHROME] path=<路径>`**：

告知用户：

> "检测到系统已安装浏览器：**[路径]**，将直接使用，无需额外操作。"

继续第 5 步。

**若输出包含 `[DETECTED_CHROME] none`（未找到浏览器）**：

询问用户：

> "未检测到 Chrome/Chromium，抓取功能需要浏览器才能运行。是否现在自动安装？"

- **用户选择跳过** → 跳过，继续第 5 步，并提醒：
  > "⚠️ 后续使用抓取功能前，请手动安装 Chrome/Chromium：
  > - macOS：`brew install --cask google-chrome`
  > - Ubuntu/Debian：`sudo apt install -y chromium-browser`"

- **用户同意自动安装** → 根据系统尝试安装：

  ```bash
  # macOS（需要 Homebrew）
  brew install --cask google-chrome

  # Ubuntu/Debian
  sudo apt install -y chromium-browser

  # 其他系统，参照系统包管理器
  ```

  - **安装成功** → 重新运行 setup.js（见下方「重新运行」），写入检测到的路径，继续第 5 步。
  - **安装失败** → 跳过，继续第 5 步，并提醒用户手动安装（同上）。

---

### 重新运行 setup.js（有额外参数时）

如需同时传入模型和/或 Chrome 路径，组合以下参数重新运行：

```bash
node <技能目录>/setup.js \
  --db-host <host> \
  --db-port <port> \
  --db-name <dbname> \
  --db-user <user> \
  --db-pass <password> \
  [--model <model> --api-key <api_key> --base-url <base_url>] \
  [--chrome-path <chrome可执行文件路径>]
```

- 退出码 **0**：配置成功，继续第 5 步
- 退出码 **1**：失败，将错误信息告知用户

---

## 第 5 步：配置定时任务

需要创建两个定时任务（时区统一用 `Asia/Shanghai`）：

| 触发时机 | Cron 表达式 | 说明 |
|---------|------------|------|
| 每天 8:00 | `0 8 * * *` | 完整日报：抓取 + 聚类 + 生成报告（`daily-full.js`） |
| 每小时（非 8 点）| `0 0-7,9-23 * * *` | 仅抓取文章写入数据库（`fetch.js`） |

---

### 方式 A：OpenClaw 框架

OpenClaw 的定时任务写在 `~/.openclaw/cron/jobs.json`。
在该文件的 JSON 数组中追加以下两个条目（文件不存在则新建）：

```json
[
  {
    "jobId": "market-digest-daily",
    "name": "金融市场日报 - 每日8点",
    "enabled": true,
    "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "生成财经日报",
      "timeoutSeconds": 1800,
      "toolsAllow": ["exec", "read", "write"]
    }
  },
  {
    "jobId": "market-digest-fetch",
    "name": "金融市场日报 - 每小时抓取",
    "enabled": true,
    "schedule": { "kind": "cron", "expr": "0 0-7,9-23 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "抓一下财经新闻",
      "timeoutSeconds": 3600,
      "toolsAllow": ["exec", "read", "write"]
    }
  }
]
```

> **说明**：OpenClaw cron 通过向 Agent 发消息触发，Agent 收到后根据 SKILL.md 的触发词路由到对应脚本，不需要直接填命令行。

写入后确认 `~/.openclaw/openclaw.json` 中 cron 已启用：

```json5
{
  cron: {
    enabled: true,
    store: "~/.openclaw/cron/jobs.json"
  }
}
```

---

### 方式 B：其他框架

参照当前框架的定时任务文档，用上述两个 cron 表达式创建任务，触发内容分别为"生成财经日报"和"抓一下财经新闻"。

---

### 方式 C：系统 cron（兜底）

若框架不支持定时任务：

```bash
crontab -e
# 添加以下两行（替换 <技能目录> 为实际路径，如 ~/.openclaw/workspace/skills/market-digest）：
0 8 * * *        node <技能目录>/daily-full.js >> <技能目录>/logs/daily.log 2>&1
0 0-7,9-23 * * * node <技能目录>/fetch.js      >> <技能目录>/logs/fetch.log  2>&1
```

---

## 第 6 步：安装完成提示

向用户报告安装结果：

```
✅ 金融市场日报已安装完成！

📅 已配置定时任务：
  • 每天 8:00 自动生成并推送日报
  • 每小时自动抓取最新财经资讯

💬 您也可以随时对我说：
  • "生成财经日报" / "出个日报"   → 立即生成
  • "抓一下财经新闻"              → 只抓取，不生成日报
  • "昨天的财经日报"              → 生成昨日日报
```

---

## 故障排查

| 问题 | 排查方向 |
|------|----------|
| DB 连接失败 | 确认数据库服务已启动、host/port 可访问、用户名密码正确 |
| `chromium` 启动失败 | 安装系统 Chrome：macOS `brew install --cask google-chrome`；Ubuntu `sudo apt install chromium-browser` |
| `node` 找不到 | 确认已安装 Node.js ≥ 18：`node --version` |
| 日报为空 | 先跑 `node fetch.js` 确认抓取正常，再跑 `node daily.js`；若希望一步完成抓取+日报，可跑 `node daily-full.js` |
| 定时任务未触发 | 确认框架的调度服务正在运行；或检查系统 cron：`crontab -l` |
