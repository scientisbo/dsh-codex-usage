# dsh-codex-usage ·「Codex 用量」

> **Codex 订阅配额 + DeepSeek 余额聚合，一键并入 DeepSeek Harness 的用量面板。**
>
> 一个 DeepSeek Harness (DSH) **host 插件**：只读、回环、带缓存的聚合接口
> `GET /api/dsh-usage/overview`，把 **Codex (ChatGPT 订阅)** 的滚动配额窗口
> 和 **DeepSeek 账户余额** 收进同一个 JSON 里，供 UI 插件渲染。
>
> `Codex Usage` — a DeepSeek Harness host plugin that aggregates your Codex
> (ChatGPT) subscription quota windows and DeepSeek account balance into one
> loopback-only API endpoint.

---

## 这个插件是干什么的？

如果你在用 **DeepSeek Harness + Codex 子代理**（把日常工作委派给 Codex），
**最怕的就是订阅额度不知不觉刷爆**——Plus 账号是按 5 小时 / 7 天 / 每月
滚动窗口限流的。这个插件：

- 📊 **查 Codex 订阅配额**：通过锁定版 `@openai/codex@0.147.0` 的
  app-server 协议读取 `account/read` + `account/rateLimits/read`，
  得到 5h / 7d / month 三个滚动窗口的 **已用百分比 + 重置倒计时**；
- 💰 **查 DeepSeek 余额**：官方 `api.deepseek.com/user/balance`
  （总余额 / 赠金 / 充值分列，自动按有余额的 USD 优先选币种）；
- 🔗 **给 UI 一个聚合端点**：一个 JSON、5 分钟缓存、`?refresh=1` 强制穿透，
  前端只管渲染，不用碰任何密钥。

> 💡 **有 ChatGPT Plus 账号？把它物尽其用。**
> 配合 DSH 的 Codex 子代理（`dsh-subagent-codex`），日常写码、查资料、
> 跑测试都能交给 Codex 分担 DeepSeek 的 token 压力；本插件 + 配套的
> [DeepSeek 用量面板](#搭配-deepseek-用量面板) 就是你的"仪表盘"——
> 一边干活，一边盯着配额不超限。

## 安装（需要 DSH ≥ 0.1.1-rc.x、Node ≥ 22）

```bash
# 从本地目录安装（开发中）
dsh plugin --profile web add "file:/绝对路径/dsh-codex-usage"
# 或发布到 npm 后：
dsh plugin --profile web add dsh-codex-usage
```

安装后 `dsh web` 会自动通过 `cordis.patch.yml` 注册插件；浏览器里不必刷新服务端
以外的任何东西（UI 面板请看配套插件）。插件依赖的 `@openai/codex@0.147.0`
由 npm 自动安装，**Codex 侧需已登录**（`codex login status` 显示
`Logged in using ChatGPT`）。

## 接口

```http
GET /api/dsh-usage/overview
```

| 查询参数 | 说明 |
| --- | --- |
| 无 | 命中 5 分钟内存缓存 |
| `?refresh=1` | 强制穿透缓存，刷新数据 |

响应示例：

```json
{
  "ok": true,
  "updatedAt": 1787492831169,
  "codex": {
    "configured": true,
    "windows": [
      { "label": "5h",    "usedPercent": 42.5, "resetIn": "3h20m", "resetsAt": 1787492831169 },
      { "label": "7d",    "usedPercent": 18.2, "resetIn": "5d",    "resetsAt": null },
      { "label": "month", "usedPercent": 61.0, "resetIn": "12d",   "resetsAt": null }
    ],
    "error": null
  },
  "deepseek": { "balance": { "currency": "USD", "total": 12.66, "granted": 0, "toppedUp": 12.66 } },
  "links": {
    "codexUsage":    "https://codex.app/account/usage",
    "deepseekUsage": "https://platform.deepseek.com/usage"
  }
}
```

- `window.label`：`5h` / `7d` / `month` 英文短标签，多语言由 UI 层翻译；
  `usedPercent` 0–100；`resetIn` 给人读的倒计时，`resetsAt` 时间戳（无则 `null`）。
- Codex 未登录 / 网络异常时返回 `codex.configured: false` + 友好错误文本，**不抛 500**；
  余额失败不影响 Codex 数据。

## 安全设计

- **回环-only**：仅接受本机回环地址 + `Host` 头校验（`127.x` / `::1` / `localhost`），
  外部请求一律 403；
- **只读 GET**：不接收请求体、不写任何状态，仅两个只读上游调用；
- **密钥不出 DSH**：DeepSeek 的 API Key 通过 DSH 的 `credentials` 服务解析
  （`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` ref 或同名环境变量），
  不落盘、不写日志；Codex 配额走本机已登录的 `~/.codex`，也不需要密钥。

## 可选配置

`cordis.patch.yml` 的 insert 条目加 `config`：

```yaml
- insert:
    - id: codex-usage
      name: dsh-codex-usage
      config:
        apiKeyRef: DEEPSEEK_API_KEY        # 余额接口 API Key ref（默认）
        codexUsageUrl: https://codex.app/account/usage     # 官方用量页链接（默认）
        deepseekUsageUrl: https://platform.deepseek.com/usage
        refreshMs: 300000                  # 缓存 TTL（默认 5 分钟）
        timeoutMs: 30000                   # Codex app-server / 上游超时（默认 30s）
```

## 与 Codex 子代理的关系（别搞混）

- **"用 Codex 干活"**（把任务委派出去 / 发布 subagent）：这是**官方插件**
  `@deepseek-ai/dsh-subagent-codex` 的事——一条命令装上：
  `dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex`，
  之后 DSH 里出现 `subagent_codex` 工具，由它把任务交给 Codex 执行
  （需 ChatGPT 账号先 `codex login`）。该插件由 deepseek-ai 官方维护，
  **不随本仓库分发**；
- **"看 Codex 用了多少"**（本插件）：只通过 app-server 的 `account/read` +
  `account/rateLimits/read` 读配额，**不发布任何任务、不参与调用**；
- 组合玩法：如果你想用 ChatGPT Plus 账号分担日常工作，先装官方子代理去
  **干活**，再用本插件**盯着配额**——5h / 7d 滚动窗口用了多少、多久重置，
  一目了然，不会刷爆限流。

## 搭配 DeepSeek 用量面板

数据是拿来**看得舒服**的。配套客户端插件
[`dsh-deepseek-usage`](https://github.com/scientisbo/dsh-deepseek-usage)：
一个**简洁美观**的浮动面板——侧边栏底部入口、余额徽标、今日/本月 token
与花费、Top 模型、每日热力图，并自带「Codex 订阅」区块消费本插件这个
`/api/dsh-usage/overview` 接口（缺端时静默隐藏）。

- 本插件提供**数据**（Codex 配额 + DeepSeek 余额）；
- 面板负责**展示**（界面、刷新按钮、5 分钟自动轮询）。

两者独立安装、独立更新，用同一个数据契约串联。

## 接口契约 / 致谢

`account/rateLimits/read` 等 app-server 方法为 Codex 插件协议；聚合口径参考
[CodexBar](https://github.com/steipete/CodexBar)、
DeepSeek 余额结构参考官方 `/user/balance` 文档。
DSH 插件骨架与回环护栏借鉴
[@ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)（MIT）。

## License

MIT
