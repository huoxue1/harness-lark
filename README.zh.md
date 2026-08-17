# harness-lark

Lark/飞书渠道插件，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供飞书通信能力。通信部分参考 [openclaw-lark](https://github.com/larksuite/openclaw-lark)（MIT, ByteDance Ltd.），适配 dsh 的 Cordis 插件体系。

[English](README.md) | 中文 | [📖 安装文档（GitHub Pages）](https://huoxue1.github.io/harness-lark/)

> 用 Docker 一键部署（自带插件的 `deepseek-harness-lark` 镜像）或手动安装插件，见[安装文档](https://huoxue1.github.io/harness-lark/)。

## 功能

| 类别 | 能力 |
|---|---|
| 💬 IM 消息收发 | WebSocket 长连接接收消息、文本/卡片回复、@提及、群聊/私聊策略、重连去重 |
| 🃏 交互卡片 + 流式回复 | 思考过程（reasoning）流式 → 生成（answer）流式 → 最终结果更新到卡片，含可折叠思考面板、耗时/token footer |
| 🖼️ 媒体 | 图片/文件/音频的上传、下载与发送 |
| 📄 文档/Wiki/Drive | 创建/读取/更新云文档（docx）、知识库节点、云盘文件 |
| 📊 Base/表格/日历/任务 | 多维表格（bitable）、电子表格、日历事件、任务 |
| 🔐 用户 OAuth | 设备授权码流程（RFC 8628），用户级 token 管理 |
| 👍 表情反馈 | 收到消息回复 `Get` 表情（处理中），完成后换成 `DONE` |
| 🔐 飞书审批卡片 | dsh 审批请求（如 bash 沙箱升级）以带「批准/拒绝」按钮的卡片发到会话，点击即应答，超时自动拒绝 |
| ⌨️ 斜杠命令 | `/status` `/model` `/cd` `/new` `/permission` `/setting` `/help` 本地命令（不进模型） |

## 架构

- **会话模型**：每个飞书会话（chat_id）映射一个持久的 dsh agent（`ctx.agents.resume` 优先，失败则 `create`），上下文跨消息、跨重启保留。
- **通信层**：`@larksuiteoapi/node-sdk` 的 `WSClient` 长连接 + `EventDispatcher` 路由（参考 openclaw-lark 的 `monitor.ts` / `lark-client.ts`）。
- **回复通路**：飞书消息 → `agent.followup()`；`assistant/chunk`（reasoning-delta / text-delta）→ 流式卡片；`turn/end` → 完成卡片并换表情。
- **话题群**：`topicSeparateSession` 开启时话题消息按 thread 独立建 session，回复挂对应话题线程下。
- **工具注册**：所有飞书能力以 dsh 工具（`ctx.tools.register` + `defineTool`）暴露给模型。

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/status` | 查看当前模型、工作目录、会话状态 |
| `/model` | 列出可用模型；`/model <provider/model>` 切换 |
| `/cd` | 查看工作目录；`/cd <绝对路径>` 修改（下次会话/重启后生效） |
| `/new` | 新建上下文（清空当前对话历史，别名 `/reset`） |
| `/stop` | 停止当前正在进行的回复 |
| `/permission` | 查看/切换会话权限预设（`/permission <预设名>`，如 `danger-full-access`） |
| `/setting` | 查看设置项；`/setting permission [预设名]` 设置新会话默认权限；`/setting model [模型]` 设置新会话默认模型 |
| `/help` | 列出所有命令 |

群聊中命令可带 `@机器人` 前缀（如 `@机器人 /status`），插件会自动剥离提及前缀。

## 安装

### 前置条件

- Node.js ≥ 22
- 已安装 DeepSeek Harness（`dsh` CLI，可通过 `npx @deepseek-ai/dsh web` 或从源码运行）
- 飞书开放平台应用（凭据：`appId`、`appSecret`；推荐开启长连接模式，无需公网回调地址）
- 飞书开放平台后台：事件订阅 → 订阅方式选择「使用长连接接收事件」，并订阅 `im.message.receive_v1` 事件

### 一键安装（推荐）

插件已发布到 npm（`harness-lark`），一条命令完成安装 + 配置 + 启动：

```sh
# 1. 设置凭据
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=your_secret

# 2. 一键：安装插件到 web profile，生成配置，启动 dsh
bash scripts/install-dsh.sh web harness-lark
```

脚本做的事：
1. `dsh plugin --profile web add harness-lark` —— 安装插件（npm 包）
2. 生成 `$DSH_HOME/profiles/web/cordis.patch.yml`（网关配置，已存在则跳过）
3. `dsh --profile web` 启动

> 用本地源码构建后安装：`bash scripts/install-dsh.sh web /path/to/harness-lark`
> （先在仓库目录执行 `pnpm install && pnpm run build`）

### 手动方式

```sh
# npm 发布后（或本地 bundle）
dsh plugin --profile web add harness-lark
# 然后手动编辑 $DSH_HOME/profiles/web/cordis.patch.yml（见下方配置示例）
dsh --profile web
```

### 方式三：手动 patch 安装

在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）中加入：

```yaml
- insert:
    - id: lark
      name: 'harness-lark'
      config:
        appId: !!js process.env.FEISHU_APP_ID
        appSecret: !!js process.env.FEISHU_APP_SECRET
        brand: feishu        # feishu | lark
        connectionMode: websocket
        dmPolicy: open       # open | pairing | allowlist | disabled
        groupPolicy: disabled
        requireMentionInGroups: true
        replyMode: streaming # auto | static | streaming
```

> 群聊允许 + 流式回复：`groupPolicy: open`、`requireMentionInGroups: false`、`replyMode: streaming`。

### 方式四：Docker 部署

参见仓库内 `Dockerfile` / `docker-compose.yml`（dsh 侧镜像），插件通过 `COPY plugins/harness-lark` 打进镜像，entrypoint 首次启动时用 `dsh plugin --profile web add` 装入 profile。

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | string | — | 飞书应用 ID（缺省时仅注册工具、不启动网关） |
| `appSecret` | string | — | 飞书应用密钥（缺省时仅注册工具、不启动网关） |
| `encryptKey` | string | — | 事件加密密钥（长连接模式可留空） |
| `verificationToken` | string | — | 事件验证令牌（长连接模式可留空） |
| `brand` | `feishu` \| `lark` | `feishu` | 平台品牌 |
| `connectionMode` | `websocket` \| `webhook` | `websocket` | 事件接收模式 |
| `provider` | string | — | 创建的 agent 使用的 provider（缺省走默认） |
| `model` | string | — | 创建的 agent 使用的模型 |
| `replyMode` | `auto` \| `static` \| `streaming` | `auto` | 回复模式（`auto` 走静态文本） |
| `dmPolicy` | `open` \| `pairing` \| `allowlist` \| `disabled` | `open` | 私聊策略 |
| `groupPolicy` | `open` \| `allowlist` \| `disabled` | `disabled` | 群聊策略 |
| `allowlist` | string[] | — | open_id 白名单 |
| `requireMentionInGroups` | boolean | `true` | 群聊中是否需要 @机器人 |
| `topicSeparateSession` | boolean | `false` | 话题群消息按 thread 独立建 session（每个话题一个上下文） |
| `dedupTtlMs` | number | 12h | 消息去重窗口 |

## 工具清单

| 工具 | 说明 |
|---|---|
| `feishu_create_doc` | 从 Markdown 创建云文档 |
| `feishu_fetch_doc` | 读取云文档（Markdown） |
| `feishu_update_doc` | 向云文档追加 Markdown |
| `feishu_wiki_space_node` | 列出知识库节点 |
| `feishu_drive_file` | 搜索/列出云盘文件 |
| `feishu_bitable_app` / `_table` / `_record` / `_field` / `_view` | 多维表格操作 |
| `feishu_sheet` | 电子表格创建/读取/写入 |
| `feishu_calendar_event` | 日历事件 CRUD |
| `feishu_task_task` | 任务 CRUD/完成 |
| `feishu_oauth` | 用户 OAuth 授权/状态/撤销 |

> 用户数据类工具（云文档 `feishu_create_doc`/`fetch_doc`/`update_doc`，以及多维表格、电子表格、日历、任务系列工具）在用户执行 `/feishu auth` 授权后，以该用户的身份调用飞书 API；未授权时回退为机器人身份。Wiki/Drive/IM 类工具始终以机器人身份调用。

## 开发

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest
pnpm run build       # tsdown -> lib/
```

### 目录结构

```
src/
  index.ts                 # 插件入口（name/inject/Config/apply）
  core/                    # 配置 schema、LarkClient、类型、去重、OAuth、token store
  channel/                 # WebSocket 网关 + 事件处理
  messaging/inbound/       # 消息解析、@提及、去重
  messaging/outbound/      # 文本/卡片/媒体发送
  agent/bridge.ts          # per-chat 持久 agent 桥接
  card/                    # 交互卡片构建 + 流式控制器
  tools/                   # 文档/Wiki/Drive、Base/表格/日历/任务、OAuth 工具
tests/                     # vitest 单测
```

## 安全说明

与 OpenClaw 插件相同，此插件在授权范围内以机器人身份调用飞书 API，存在模型幻觉、提示注入等固有风险。建议仅作为私聊助手使用，不要加入群聊或允许他人交互；保持默认安全配置（`groupPolicy: disabled`、`requireMentionInGroups: true`）。

## 许可证

[MIT](LICENSE)。通信与卡片设计参考 [openclaw-lark](https://github.com/larksuite/openclaw-lark)（MIT, ByteDance Ltd.）。
