# 使用指南

## 聊天命令

| 命令 | 说明 |
|---|---|
| `/status` | 当前模型、工作目录、会话状态 |
| `/model` | 查看可用模型；`/model <名称>` 切换 |
| `/cd <路径>` | 切换 agent 工作目录（重建会话） |
| `/new` / `/reset` | 清空当前会话上下文，开启新会话 |
| `/permission` | 查看/切换会话权限预设（`/permission <预设名>`，如 `danger-full-access`） |
| `/setting permission` | 查看/设置新会话默认权限预设（`/setting permission <预设名>`） |
| `/help` | 命令帮助 |
| `/feishu auth` | 用户 OAuth 设备授权（一次性） |
| `/feishu doctor` | 插件诊断报告（凭据、机器人、连接、授权状态） |

群聊中命令同样需要 @机器人（`requireMentionInGroups: true` 时）。

## 工具清单

| 工具 | 能力 |
|---|---|
| `feishu_create_doc` / `fetch_doc` / `update_doc` | 云文档创建/读取/追加（Markdown） |
| `feishu_wiki_space_node` | 知识库节点列表 |
| `feishu_drive_file` | 云盘文件搜索/列表 |
| `feishu_bitable_app` / `_table` / `_record` / `_field` / `_view` | 多维表格操作 |
| `feishu_sheet` | 电子表格创建/读写（sheets v2 values API） |
| `feishu_calendar_event` | 日历事件 CRUD |
| `feishu_task_task` | 任务 CRUD/完成 |
| `feishu_oauth` | 用户 OAuth 授权/状态/撤销 |

> 用户数据类工具（文档、多维表格、云表格、日历、任务）在授权后以**用户身份**调用，未授权回退机器人身份。Wiki/Drive/IM 类工具始终以机器人身份调用。

## 常见问题

**重启容器后要重新授权吗？**
不用。用户 token 持久化在 `/root/.dsh/settings.yaml`（dsh 内置 settings 存储），重启自动加载；access token 过期自动用 refresh token 续期。

**群聊里机器人不回复？**
确认是否 @了机器人（`requireMentionInGroups: true`）。话题群中每条 thread 有独立会话（`topicSeparateSession: true`）。

**授权时提示权限很多？**
同意页只展示「应用已开通 ∩ 插件需要」的权限；应用未开通的权限会被自动过滤并提示，可在开放平台补开通后重新 `/feishu auth`。

**如何部署到 Lark（国际版）？**
把配置 `brand` 改为 `lark`，并在开放平台使用 lark 域名注册的应用。
