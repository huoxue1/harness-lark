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

## 6. 远程访问（反向代理 / SSH 隧道）

dsh 的 Web UI 有两条**刻意保留的安全设计**，直接 `http://<服务器IP>:3080` 访问会遇到限制：

1. **只绑回环地址**：dsh 拒绝监听 `0.0.0.0`（防止把远程代码执行能力暴露到局域网）。镜像内置了一个 TCP 转发器把 UI 暴露到容器 IP 上（`DSH_WEB_FORWARD=0` 可关闭），Docker 发布端口才能到达。
2. **浏览器信任围栏**：`/api` 网关只接受回环 Host 或 `--trusted-host` 显式声明的地址（DNS rebinding 防御）。局域网 IP 访问时需把 IP 加进信任列表——镜像 entrypoint 已支持 `DSH_TRUSTED_HOSTS` 环境变量：
   ```yaml
   # docker-compose 或 docker run 环境变量（多个用空格分隔）
   DSH_TRUSTED_HOSTS: "192.168.10.251"
   ```
3. **安全上下文**：`crypto.randomUUID` 等 Web Crypto API 只在 HTTPS 或 localhost 可用，局域网 IP 的明文 HTTP 不算安全上下文，页面会报 `crypto.randomUUID is not a function`。
4. **配置平面仅回环**：设置/凭据相关 API（`settings.describe`、`credentials.*` 等）被 dsh **硬性钉在仅回环**，`--trusted-host` 也放行不了——这是认证层出现之前的安全边界，从局域网访问必然 403。

### 推荐方案 A：SSH 隧道（完整功能）

在自己电脑上建一条隧道，然后浏览器开 `http://localhost:3080` —— 回环地址同时满足以上全部条件（安全上下文 + 信任围栏 + 配置平面放行）：

```bash
ssh -L 3080:127.0.0.1:3080 root@<服务器IP>
```

之后浏览器访问 <http://localhost:3080>，**所有功能可用**（含设置页、凭据管理、模型发现）。

### 推荐方案 B：HTTPS 反向代理（日常浏览）

适合想直接在浏览器打开地址的场景。在服务器上用 socat 或 nginx 终结 TLS（自签证书），把 `https://<IP>:3443` 转发到 `127.0.0.1:3080`：

```bash
# 生成自签证书
mkdir -p /etc/dsh-tls && cd /etc/dsh-tls
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -subj '/CN=<服务器IP>'

# socat 单行反代（systemd 常驻更佳）
apt-get install -y socat
socat openssl-listen:3443,reuseaddr,fork,cert=/etc/dsh-tls/cert.pem,key=/etc/dsh-tls/key.pem,verify=0 TCP:127.0.0.1:3080
```

浏览器访问 `https://<服务器IP>:3443`，首次点击"继续前往"信任自签证书即可。用 nginx/caddy 反向代理同理（`proxy_pass http://127.0.0.1:3080;`）。

> ⚠️ 反代方案下**设置页/凭据页仍会 403**（配置平面仅回环是 dsh 的设计，见上文第 4 点）；改模型/凭据配置请走 SSH 隧道。聊天、模型选择等日常功能不受影响。

下一步：[安装 harness-lark 插件](install-harness-lark)（或直接用上面的 lark 镜像，插件已装好）。
