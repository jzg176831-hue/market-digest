# 金融市场日报（market-digest）— 安装手册（Agent 操作指南）

**本文件仅在安装时使用。安装完成后无需再次读取。**

用户说"帮我安装金融市场日报"或类似话语时，Agent 按以下步骤逐一执行。所有操作均由 Agent 完成，不需要用户有任何技术背景。

---

## 第 1 步：克隆仓库

```bash
git clone <用户提供的仓库地址> ~/.openclaw/workspace/skills/market-digest
```

如果目录已存在，跳过此步（说明已经克隆过）。

---

## 第 2 步：安装 Node.js 依赖

```bash
cd ~/.openclaw/workspace/skills/market-digest && npm install
```

---

## 第 3 步：收集数据库配置

**逐项询问**，一次只问一个问题，等用户回答后再问下一个：

1. "数据库主机地址是什么？（例如：192.168.1.100 或 localhost）"
2. "数据库端口是多少？（默认 5432，不确定直接说默认就好）"
3. "数据库名称是什么？"
4. "数据库用户名是什么？"
5. "数据库密码是什么？"

收集完毕后，运行以下命令测试连接并初始化：

```bash
node ~/.openclaw/workspace/skills/market-digest/setup.js \
  --db-host <host> \
  --db-port <port> \
  --db-name <dbname> \
  --db-user <user> \
  --db-pass <password>
```

- 退出码 **0**：连接成功，继续下一步
- 退出码 **1**：连接失败，将错误信息告知用户，请用户确认数据库是否可访问、密码是否正确

---

## 第 4 步：询问 Embedding 配置（可跳过）

问用户：

> "是否有 OpenAI 兼容的 Embedding API Key？它能让文章去重效果更好。如果没有或不确定，跳过也完全没问题，系统会自动用标题相似度替代。"

**有 Embedding Key**：询问 API Key、接口地址（OpenAI 兼容的 base URL）以及 **Embedding 模型名**（须与服务商文档一致，如 `text-embedding-3-small`、云厂商给出的模型 ID），然后重新运行 setup.js 补充参数：

```bash
node ~/.openclaw/workspace/skills/market-digest/setup.js \
  --db-host <host> --db-port <port> --db-name <dbname> --db-user <user> --db-pass <password> \
  --embedding-key <api_key> \
  --embedding-url <base_url> \
  --embedding-model <model_name>
```

**没有**：直接跳过，继续第 5 步。

---

## 第 5 步：创建定时任务

使用 `mcp__scheduled-tasks__create_scheduled_task` 工具创建两个定时任务：

**任务 1：每小时整点后台抓取文章（8 点除外，避免与日报冲突）**

```
name:             market-digest-fetch-hourly
schedule:         0 0-7,9-23 * * *
command:          node fetch.js
workingDirectory: ~/.openclaw/workspace/skills/market-digest
```

**任务 2：每天早上 8 点自动生成日报**

```
name:             market-digest-daily-report
schedule:         0 8 * * *
command:          node daily.js
workingDirectory: ~/.openclaw/workspace/skills/market-digest
```

---

## 第 6 步：安装完成提示

向用户报告安装结果：

```
✅ 金融市场日报已安装完成！

📅 已创建两个定时任务：
  • 每天 08:00  自动抓取 + 生成日报，推送到您的配置渠道
  • 每小时整点  后台静默抓取最新财经资讯（非 8 点）

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
| 日报为空 | 先跑 `node fetch.js` 确认抓取正常，再跑 `node daily.js` |
