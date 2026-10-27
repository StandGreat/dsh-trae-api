# dsh-trae-api (Trae Local API)

本仓库是 [Wang-JQ77/dsh-trae-api](https://github.com/Wang-JQ77/dsh-trae-api) 的维护分支，保留原项目历史和 MIT 许可证。原作者的 npm 包 `dsh-trae-api` 不会因为此 Fork 的提交而自动更新。

## 本分支的修正

- `/v1/models` 查询 Trae 在线目录，合并 `chat_v3`、`solo_work_remote`、`solo_work_lite`，按账号缓存五分钟；不再返回写死的模型清单。
- 推理请求沿用模型所属的 function、配置名、实际模型名及加密模型参数，避免目录中有模型却无法正确调用。
- 更新客户端版本头，可通过 `TRAE_IDE_VERSION`、`TRAE_IDE_VERSION_CODE` 覆盖。
- 处理上游 SSE 业务错误，修复网络分块导致 event 名丢失的问题，避免将失败转换为空回复。
- 不再打印登录令牌前缀；提供不读取本机登录态、不访问真实上游的回归测试。
- 移除将 Claude、GPT 等名称静默映射到其他厂商模型的别名；`auto` 仍显式使用 `glm-5.2`。
- 原生透传完整工具 JSON Schema、工具调用 ID 和工具结果历史，合并上游分段 `function_call` 参数；不再让模型用 XML 文本模拟工具调用。
- Anthropic 和 OpenAI 接口将真正的工具调用分别标记为 `tool_use`、`tool_calls`，让 Agent 可以执行工具并继续下一轮；普通 XML 文本不会自动变成可执行操作。

2026-10-24 的验收仅覆盖 Windows 的 DSH `0.2.1-rc.2` 中两个模型的短回复和简单工具转换，未充分覆盖实际 Agent 连续操作。原先的文本工具模拟会导致任务提前结束，本分支现已改用原生工具协议，并增加工具调用、执行结果回传、继续生成的回归测试。在线目录不代表全部模型、全部 Trae 版本或所有账号权限均已验证。

原生工具修复另在 DSH `0.2.1-rc.3` 中验证：`glm-5.3-flash`、`deepseek-v4.1-flash` 均通过“读取测试项目 → 回传随机校验码 → 调用写入工具 → 回传成功 → 完成回复”的三轮调用。该测试使用 DSH 的真实流式适配与消息组装，工具仅操作隔离的测试文件，不代表所有真实工作区任务均已覆盖。

### 安装本 Fork

```powershell
dsh plugin --profile web add https://codeload.github.com/StandGreat/dsh-trae-api/tar.gz/refs/heads/master
```

安装后完整重启 DSH。已有同版本 pnpm 本地补丁时，应先备份并移除对应的 `patchedDependencies` 配置，再安装本 Fork，避免重复应用旧补丁。本文原有的 `add dsh-trae-api` 命令安装的是原作者发布的 npm 包。

插件启动的是本地代理，不会自动注册 DSH 模型提供方。DSH 中可添加 Anthropic 兼容提供方，地址 `http://127.0.0.1:9220`，API Key 与代理配置一致；模型 ID 和容量信息以 `/v1/models` 为准。代理在线目录刷新与 DSH 已保存模型列表是两个步骤，新增模型仍需在 DSH 重新获取并保存。

### 开发验证

```powershell
npm ci --ignore-scripts
npm run check
```

测试仅使用虚构凭据和模拟响应，不消耗账号额度。手工实网验收需要本人授权的 Trae 账号；不要提交 `.env`、storage.json、登录令牌、个人日志或 DSH 凭据文件。程序仍会将登录缓存保存到本机 `.env`；本分支未改变这一存储机制。

---

将 Trae Work CN 的**积分/额度**转化为本地 OpenAI/Anthropic 兼容 API 服务，让 Claude Code、Cursor、Cline、Windsurf 等第三方 AI 编程工具直接调用 Trae 底层模型（GLM、DeepSeek、Qwen、Kimi、MiniMax 等）。

本项目是一个 **DeepSeek Harness (DSH) 插件**，安装后随 `dsh` 启动自动运行代理服务；也可以独立运行。

## 原理

1. 本机已安装并登录 Trae Work CN（或 TRAE SOLO CN / Trae SG / TRAE SOLO）
2. 脚本自动从本地 `storage.json` 中解密认证 Token
3. 启动本地 Express 服务器，提供 OpenAI/Anthropic 兼容的 API 端点
4. 第三方 Agent 将请求发送到本地服务器，本地服务器转发到 Trae 上游 API
5. **消耗的是 Trae 的积分，无需额外付费**

## 支持的 Trae 版本

| 版本 | IDE 名称 | 上游端点 |
|------|----------|----------|
| `cn` | Trae CN 国内版 | `trae-api-cn.mchost.guru` |
| `solo` | TRAE SOLO CN 独立部署版 | `trae-api-cn.mchost.guru` |
| `sg` | Trae 国际版 | `a0ai-api-sg.byteintlapi.com` |
| `solo-sg` | TRAE SOLO 国际版 | `a0ai-api-sg.byteintlapi.com` |

## 功能

- 自动解密四版本认证数据，无需手动配置 Token
- 提供 OpenAI (`/v1/chat/completions`) 和 Anthropic (`/v1/messages`) 兼容接口
- 支持 OpenAI Responses API (`/v1/responses`)
- Token 过期自动刷新，自动保存到 `.env`
- 支持流式输出 (SSE)
- 完整支持 Claude Code 工具调用
- 3 级 API 端点回退机制
- 上下文窗口自动截断，避免超出 Token 限制

## 前置条件

- **Node.js >= 18**（内置 `fetch` 支持）
- **已安装并登录**以下任一 Trae IDE：Trae CN、TRAE SOLO CN、Trae（国际版）、TRAE SOLO（国际版）

## 快速开始

### 方式 A：作为 DSH 插件安装（推荐）

```bash
# 安装到 web profile
dsh plugin --profile web add dsh-trae-api
# 重启 dsh 使插件生效
dsh web
```

插件启动后，代理服务自动运行在 `http://localhost:9220`。

卸载：
```bash
dsh plugin --profile web remove dsh-trae-api
```

### 方式 B：独立运行

```bash
npm install
start.bat    # Windows 一键启动
```

首次运行会自动从本机 Trae IDE 的 `storage.json` 解密认证数据并保存到 `.env`，之后直接读取 `.env` 启动。

### 连接第三方 Agent

**Claude Code：**
```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:9220"
$env:ANTHROPIC_API_KEY = "trae-local-api"
claude
```

**Cursor / Cline / Windsurf：** 配置 OpenAI Compatible Provider，Base URL 为 `http://localhost:9220/v1`，API Key 为 `trae-local-api`。

**Python (OpenAI SDK)：**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:9220/v1", api_key="trae-local-api")
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/status` | 服务状态 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI 格式对话 |
| POST | `/v1/messages` | Anthropic 格式对话 |
| POST | `/v1/messages/count_tokens` | 估算 Token 数 |
| POST | `/v1/responses` | OpenAI Responses API |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TRAE_EDITION` | Trae 版本 (cn/solo/sg/solo-sg) | cn |
| `API_KEY` | 本服务的 API Key | trae-local-api |
| `PORT` | 监听端口 | 9220 |
| `HOST` | 监听地址 | 127.0.0.1 |
| `MAX_CONTEXT_TOKENS` | 最大上下文 Token 数 | 200000 |

> 完整环境变量列表见 `.env.example`

## 注意事项

- 本工具仅在你**已经拥有 Trae 积分**的情况下有效，本质上是将 Trae 的 API 额度通过本地代理暴露为标准接口
- 默认仅监听 `127.0.0.1`，局域网与公网无法访问
- 默认启用 API Key 鉴权（默认值 `trae-local-api`，建议修改）
- 请勿将 `.env` 文件提交到版本控制（已在 `.gitignore` 中忽略）

## 免责声明

本工具仅供学习和研究使用。使用本工具调用 Trae API 所产生的费用和合规问题由用户自行承担。请遵守 Trae 平台的使用条款。

## License

MIT
