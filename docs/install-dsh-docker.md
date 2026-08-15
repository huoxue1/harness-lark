# 用 Docker 安装 deepseek-harness

deepseek-harness 官方提供 `deploy/Dockerfile`，本仓库在 release 时构建并发布两个镜像到 GitHub Container Registry（ghcr.io）：

| 镜像 | 说明 |
|---|---|
| `ghcr.io/huoxue1/deepseek-harness` | 原版 deepseek-harness（不含飞书插件） |
| `ghcr.io/huoxue1/deepseek-harness-lark` | 自带 harness-lark 飞书频道插件 |

## 1. 前置条件

- Docker Engine 20.10+（或 Docker Desktop）
- 可访问 ghcr.io 的网络

## 2. 拉取并运行

### 原版镜像

```bash
docker run -d --name dsh \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  ghcr.io/huoxue1/deepseek-harness:latest
```

### 自带飞书插件的镜像

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

## 3. docker compose（推荐）

仓库里带了一份开箱即用的 [`deploy/docker-compose.yml`](https://github.com/huoxue1/harness-lark/blob/master/deploy/docker-compose.yml)：

```bash
# 导出飞书应用凭据
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=secret
# 启动
docker compose -f deploy/docker-compose.yml up -d
# 查看日志
docker logs -f dsh-web
```

## 4. 关键说明

- **端口**：dsh 出于安全拒绝监听 `0.0.0.0`，容器内部绑定回环地址，由 Docker 把 `3080` 发布到主机（`-p 主机端口:3080`）。
- **数据持久化**：所有用户数据（会话、设置、授权 token、profile）都在 `/root/.dsh`，务必挂载命名卷 `dsh-data`，容器重建/升级不丢数据。
- **健康检查**：镜像内置 healthcheck（每 20s 探测 `http://127.0.0.1:3080`）。
- **LLM 配置**：首次启动后打开 <http://localhost:3080>，在界面配置模型/API Key；也可通过环境变量（如 `DEEPSEEK_API_KEY`）传入。

## 5. 首次启动后

1. 打开 <http://localhost:3080>，配置一个可用的 LLM 模型。
2. 在飞书里给你的应用机器人发一条私聊消息（如 `/status`），确认能收到回复。
3. 群聊需要 @机器人 才会回复（`requireMentionInGroups: true`，可在 profile 的 `cordis.patch.yml` 里改）。

下一步：[安装 harness-lark 插件](install-harness-lark)（或直接用上面的 lark 镜像，插件已装好）。
