# 安装 harness-lark 飞书插件

harness-lark 是 deepseek-harness 的飞书/Lark 频道插件。有三种安装方式，任选其一。

## 方式 A：用自带插件的 Docker 镜像（推荐）

直接用 release 发布的 `ghcr.io/huoxue1/deepseek-harness-lark` 镜像，插件已内置：

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=secret

docker run -d --name dsh-web \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  -e FEISHU_APP_ID=$FEISHU_APP_ID \
  -e FEISHU_APP_SECRET=$FEISHU_APP_SECRET \
  ghcr.io/huoxue1/deepseek-harness-lark:latest
```

首次启动时容器自动执行 `dsh plugin --profile web add file:/plugins/harness-lark` 并生成 profile 配置，之后每次重启跳过。

## 方式 B：在已有 dsh 上通过 npm 安装

先发布到 npm（`harness-lark`），然后在 dsh 所在机器上：

```bash
# 进入 dsh 的 profile 目录（或用 dsh 的插件命令）
dsh plugin --profile web add harness-lark
```

## 方式 C：从源码安装

```bash
git clone https://github.com/huoxue1/harness-lark.git
cd harness-lark
pnpm install
pnpm run build
# 把 lib 产物与 cordis.patch.yml 放到 dsh 可发现的位置后：
dsh plugin --profile web add file:/path/to/harness-lark
```

## 飞书开放平台准备

1. 到 [飞书开放平台](https://open.feishu.cn) 创建**企业自建应用**，获得 `App ID` 与 `App Secret`。
2. 在「权限管理」开通插件所需权限：
   - 基础：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:resource`、`im:chat:read`、`im:message.reactions:read`、`im:message.reactions:write_only`（表情回复）等；
   - 云文档/多维表格/云表格/日历/任务等用户数据权限（如 `docx:document`、`base:*`、`sheets:spreadsheet`、`calendar:*`、`task:*`）——**用户授权时会自动按「应用已开通 ∩ 需要的」过滤**，未开通的不会出现在同意页。
3. 「事件与回调」→ 订阅方式选择**使用长连接接收事件**（插件默认 `connectionMode: websocket`，无需公网回调地址）。
4. 发布应用版本并确保审核通过。

## 配置项

profile 的 `cordis.patch.yml`（镜像方式由 entrypoint 生成，可自行修改）：

```yaml
- id: lark
  config:
    appId: !!js process.env.FEISHU_APP_ID
    appSecret: !!js process.env.FEISHU_APP_SECRET
    brand: feishu            # feishu | lark
    connectionMode: websocket
    dmPolicy: open           # open | pairing | allowlist | disabled
    groupPolicy: open        # open | allowlist | disabled
    requireMentionInGroups: true   # 群聊是否必须 @机器人
    respondToMentionAll: false     # 是否响应 @所有人
    replyMode: streaming     # auto | static | streaming
    topicSeparateSession: true     # 话题群按 thread 独立会话
    # allowlist: [ou_xxx]    # open_id 白名单
    # dedupTtlMs: 43200000   # 消息去重窗口
```

## 用户授权（一次性）

要让机器人以**你的身份**读写你的云文档/表格/日历，在飞书私聊里发送：

```
/feishu auth
```

按提示打开链接输入用户码完成授权。授权后：

- token 持久化在 dsh 的 `settings.yaml`（`/root/.dsh/settings.yaml`），**重启容器无需重新授权**；
- access token 2 小时过期会自动用 refresh token 续期；
- 已授权用户调用工具时优先用用户身份，未授权时回退机器人身份。

诊断请用 `/feishu doctor`。

## 下一步

- [使用指南](usage)（命令与工具清单）
- [用 Docker 安装 deepseek-harness](install-dsh-docker)
