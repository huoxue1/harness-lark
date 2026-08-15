# harness-lark — DeepSeek Harness 飞书频道

[harness-lark](https://github.com/huoxue1/harness-lark) 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的飞书/Lark 频道插件：把飞书群聊/私聊接到 dsh 的 agent，支持流式卡片回复、`/status` `/model` `/cd` `/new` 等命令，以及以**用户身份**调用飞书云文档、多维表格、云表格、日历、任务等 API。

## 两种安装方式

| 方式 | 说明 | 文档 |
|---|---|---|
| 🐳 一键镜像 | 用发布好的 Docker 镜像，**自带 harness-lark 插件**，只需填飞书应用凭据 | [用 Docker 安装](install-dsh-docker) |
| 🧩 已有 dsh | 在已运行的 deepseek-harness 上单独安装 harness-lark 插件 | [安装插件](install-harness-lark) |

## 快速开始（镜像方式）

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

首次启动时容器会自动安装插件并生成配置；打开 <http://localhost:3080> 配置 LLM 模型后即可在飞书里与机器人对话。

> 详细步骤见 [用 Docker 安装 deepseek-harness](install-dsh-docker) 与 [安装 harness-lark 插件](install-harness-lark)。

## 常用命令（在飞书聊天里发）

- `/status` — 当前模型/工作目录/会话状态
- `/model` — 查看或切换模型
- `/cd <路径>` — 切换工作目录
- `/new`（`/reset`）— 清空当前会话上下文
- `/feishu auth` — 用户 OAuth 授权（一次性，重启不丢）
- `/feishu doctor` — 诊断报告
- `/permission` — 查看/切换会话权限预设（如 `/permission danger-full-access`）

完整说明见 [使用指南](usage)。
