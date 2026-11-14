# CF-Workers-WBDaily

一句话：把 WorkBuddy 每日签到搬进 Cloudflare Workers —— 一个 Worker 同时提供**网页面板**、**Cron 定时签到**和 **MCP 接口**，数据只存在你的 KV 里。

- **网页面板**：首次设置密码 → 录入账号 → 一键签到 → 查看每次执行的逐账号明细。
- **积分配额**：账号卡片实时显示用量状态、总剩余积分、套餐基础/奖励积分与切换时间，可手动刷新（只读上游，不写 KV）。
- **账号导入/导出**：直接吃 `cockpit-tools` 导出的 WorkBuddy JSON，也能导出成它可再导入的格式（每个账号卡片内可单独导出该账号，账号区顶部「导出全部」用于批量备份）；重复导入不会产生重复账号。
- **Cron 自动签到**：每天 09:00（Asia/Shanghai）自动跑一次，锁互斥、失败不中断。
- **MCP 接口**：给 Claude / Cursor 等 AI 客户端 5 个工具（列账号、查状态、触发签到、读日志、管账号）。
- **零构建前端**：3 个静态文件，没有打包步骤，`wrangler deploy` 一步上线。
- **写入极省**：一次常规签到只写 4 次 KV（免费额度 1000 写/天）。

## 架构

```
┌──────────────┐        ┌──────────────────────── Cloudflare Worker ────────────────────────┐
│  浏览器面板   │  HTTP  │  index.js                                          src/api.js      │
│ index.html   │───────▶│   ├─ /api/*        ──▶ 鉴权(Cookie) ──▶ 业务 handler ──┐          │
│ app.js       │  JSON  │   ├─ /api/mcp      ──▶ 鉴权(Bearer Key) ──▶ MCP 工具 ──┤          │
│ styles.css   │◀───────│   └─ 其它路径      ──▶ ASSETS（静态文件）            │          │
└──────────────┘        │                                                       ▼          │
                        │  Cron Trigger ──▶ run.js ──▶ checkin.js ──▶ copilot.tencent.com │
                        │                                                       │          │
                        │                            store.js ──▶ KV (WB_KV) ◀──┘          │
                        └──────────────────────────────────────────────────────────────────┘
```

三层结构：`index`（分流）→ `api / mcp / run`（业务）→ `store`（KV 封装），工具函数在 `util / router / auth / checkin / logger`。所有业务函数首参是 `ctx`，KV、`fetch`、时钟全部注入，方便单测。

## 前置要求

- 一个 Cloudflare 账号（免费版即可）
- Node.js **20+**（推荐 22，与 `package.json` 的 `engines` 一致）与 npm
- 一个可用的 WorkBuddy token（面板里填，或从已登录的网页端复制）

## 部署 5 步

```bash
# 1. 装依赖
npm install

# 2. 创建 KV 命名空间，把输出的 id 填进 wrangler.toml 的 REPLACE_WITH_YOUR_KV_ID
npx wrangler kv namespace create WB_KV

# 3. 设置部署令牌（强烈推荐，防止别人抢先初始化你的面板）
npx wrangler secret put SETUP_TOKEN

# 4. 部署
npm run deploy

# 5. 打开终端输出的域名（形如 https://cf-workers-wbdaily.<你的子域>.workers.dev），
#    按页面提示设置管理员密码（至少 8 位）
```

`SETUP_TOKEN` 的作用：设置了它之后，`POST /api/setup` 必须带上正确的 `x-setup-token` 头。面板检测到它存在时，首次设置页会多出一个「部署令牌」输入框。**不设置也能用**，但任何人只要第一个打开你的域名就能设密码。

> `wrangler.toml` 里 `[assets]` 的 `not_found_handling` 必须是 `none`，否则 `POST /api/*` 会拿到 HTML 而不是 JSON。

## 本地开发

```bash
npx wrangler dev            # 默认 http://localhost:8787
```

本地调试建议放一个 `.dev.vars`（已在 `.gitignore` 中）：

```ini
SETUP_TOKEN=dev-token
```

`wrangler dev` 会用本地模拟的 KV；想连真实 KV 加 `--remote`。本地没有 `SETUP_TOKEN` 时，设置页不会显示部署令牌输入框。

跑单元测试（**零依赖、不需要 wrangler 登录、不需要网络**）：

```bash
npm test
```

等价于 `node --test test/*.test.mjs`。它会跑 `test/` 下的全部用例（7 个测试文件）：用内存 KV + mock 上游覆盖签到 / 鉴权 / 接口 / MCP / 额度 / 导入导出全链路，**不会真的去签到**，也不会碰你线上的 KV。

> 请用 `npm test`（或上面的完整命令），不要用 `node --test test`。后者在 Node 22 上会按目录解析成模块路径并报 `MODULE_NOT_FOUND`。

## 使用说明

1. **录入账号**：面板「新增账号」→ 填名称 + 粘贴 WorkBuddy token（可选 UID / 备注）。最多 10 个账号。
2. **看额度**：账号卡片会自动查询积分配额，显示用量状态、总剩余积分、套餐基础积分、平台奖励积分与切换时间；点「刷新额度」可单独重查。额度接口需要 UID，**建议填写 UID**，否则可能查不到数据。
3. **测试签到**：某行右侧「测试签到」立刻跑一次，结果会以徽标形式出现在该账号行上（最近一次结果）。
4. **立即全部签到**：只跑「启用」的账号；执行期间按钮禁用，完成后弹「成功 x / 共 y」。
5. **看日志**：「执行记录」列出每次执行的时间、触发方式（定时/手动/单账号）、成功数与耗时；点一行展开逐账号明细（HTTP 状态、业务 code、上游 message、连续天数、额度）。
6. **MCP Key**：「设置」→「MCP 接口」→ 生成 Key，**明文只显示一次**。
7. **导入/导出账号**：账号区「导入」选 `cockpit-tools` 导出的 `workbuddy_accounts_*.json`；每张账号卡片底部的「导出」按钮只导出**该账号**的 JSON（文件名形如 `workbuddy_account_<账号名>_<日期>.json`），账号区顶部的「导出全部」用于批量备份（生成 `workbuddy_accounts_<日期>.json`）。两者都**含明文 token**，都会二次确认，请妥善保管。重复导入按 uid 优先、token 兜底匹配，不会重复添加；导入后超过 10 个账号会整批拒绝。

## MCP 接入

在 AI 客户端里加一个 HTTP MCP Server（各家字段命名略有差异，核心是 **URL** + **Authorization 头**）：

```json
{
  "mcpServers": {
    "wb-daily": {
      "url": "https://cf-workers-wbdaily.<你的子域>.workers.dev/api/mcp",
      "headers": {
        "Authorization": "Bearer sk-mcp_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

只支持 stdio 的客户端可以用 `mcp-remote` 桥接：

```json
{
  "mcpServers": {
    "wb-daily": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://cf-workers-wbdaily.<你的子域>.workers.dev/api/mcp",
               "--header", "Authorization: Bearer sk-mcp_xxxxxxxxxxxxxxxx"]
    }
  }
}
```

先用 curl 验证 Key 是否可用：

```bash
curl -sS https://cf-workers-wbdaily.<你的子域>.workers.dev/api/mcp \
  -H "Authorization: Bearer sk-mcp_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

返回 5 个工具即表示打通：

| 工具 | 作用 |
| --- | --- |
| `wb_list_accounts` | 列出账号（token 已脱敏为 `tokenMasked`） |
| `wb_checkin_status` | 只查今日签到状态，不产生签到、不写 KV |
| `wb_trigger_checkin` | 触发签到，`dryRun:true` 时只预演 |
| `wb_get_logs` | 读执行记录；给 `runId` 返回该次明细 |
| `wb_manage_account` | 增 / 改 / 删账号（出参一律脱敏） |

工具级错误不会中断会话，而是以 `isError:true` 的文本返回（例如 `CONFLICT: 已有任务在执行（run_xxx）`）；只有 Key 错误才返回 HTTP 401。

## 修改 Cron 时间

默认 `[triggers] crons = ["0 1 * * *"]`，即 **01:00 UTC = 09:00 Asia/Shanghai**。想改成北京时间 08:30：

```toml
[triggers] crons = ["30 0 * * *"]
```

改完必须重新 `npm run deploy` 才会生效。Cron 表达式是 UTC，换算时减 8 小时。

## 免费额度与成本

| 项目 | 免费额度 | 本项目的用量 |
| --- | --- | --- |
| KV 写入 | 1000 次/天 | 常规一次签到 **4 次**（抢锁 / 明细 / 索引 / 解锁）；命中淘汰的 run 为 **5 次**（多一次删最旧明细） |
| KV 读取 | 100,000 次/天 | 面板首屏约 4 次，轮询每次 3 次，签到每账号 1~2 次 |
| Worker 请求 | 100,000 次/天 | 每天 1 次 Cron + 你自己开面板的次数 |

所以每天自动跑一次大约只用掉 **4~5 次写入**，10 个账号也一样（批量写集中在一次收尾，循环里零写入）。导入 N 个账号只写 **1 次**（整批一次 `putAccounts`），导出与额度查询各 **0 次**。

**调低「日志保留条数」时的一次性开销**：保存设置的那一刻会立即清理超额的旧记录（先删明细、再写回裁剪后的索引），所以那一次 `PUT /api/settings` 会产生 `N+1` 次写入（N = 被清理的条数）。这就是面板可能提示「设置已保存，同时清理了 N 条旧记录」的原因。这样做是为了让后续每次 run 最多只淘汰 1 条、稳定在 4~5 写，而不是攒到下一次 run 一次删几十条。

**PBKDF2 为什么是 30000 迭代而不是 10 万**：免费版单个请求 CPU 上限 10ms，`deriveBits` 跑 10 万迭代大概率触发 `1102`（CPU 超限）导致登录必失败。迭代数写在哈希记录里（`config:auth.iterations`），以后升级到付费版可以逐条提高，不影响老记录。

## 安全权衡（请务必阅读）

1. **token 明文存放在 KV**。能读你 KV 的人就能看到 token。这是为了「一次读取全部账号、省读次数」而做的取舍；如需要可自行加密后再存。
2. **单管理员、单 MCP Key**。没有多用户、没有细粒度权限，面板密码只有一套。
3. **登出是无状态的**：只清 Cookie，被复制的 Cookie 在 `exp` 之前仍然有效。唯一能全量失效的手段是**修改密码**（会 bump `sessionVersion`，旧会话立即失效）。
4. **限流只在 isolate 内存里**：多边缘节点各自计数，理论上可被绕过；做全局限流需要 KV 写，会破坏写入预算，因此没有做。
5. **CORS 未开启**：面板与 API 同源部署，写操作还会校验 `Origin`/`Referer`；MCP 走独立的 Bearer Key，不受同源限制。
6. **`SETUP_TOKEN` 建议一定要配**，否则存在「被抢先初始化」的风险。
7. **导出的 JSON 含明文 token**：与 KV 里的存储方式一致，拿到文件等于拿到账号；卡片内单账号导出与顶部「导出全部」都会二次确认，请勿放进 Git、网盘公开链接或聊天记录。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 账号显示「失败 / Token 已失效（HTTP 401）」 | 上游 token 过期。重新从 WorkBuddy 网页端复制 token，编辑账号粘贴保存（留空不会改动 token） |
| 登录或设置密码时报 `1102` / 页面 500 | 单请求 CPU 超限。确认 `wrangler.toml` 里 `PBKDF2_ITERATIONS = "30000"`，不要调到 10 万 |
| 页面 404 / 打开是空白 | 检查 `wrangler.toml` 的 `[assets] directory = "./public"`、`binding = "ASSETS"`、`not_found_handling = "none"`；`public/` 下必须有 `index.html`、`app.js`、`styles.css` |
| 部署报 `KV namespace ... not found` | `[[kv_namespaces]]` 的 `id` 还是占位值，替换成 `wrangler kv namespace create WB_KV` 的输出 |
| 设置页提示「系统已初始化」（409） | KV 里已有 `config:auth`。要重新初始化请按下方「彻底重置」处理（注意：只删 `config:auth` 会保留账号与 token） |
| 登录提示「尝试过于频繁」 | 5 次密码错误后进入退避（30s 起，逐次翻倍，封顶 15min），等倒计时结束或换网络环境 |
| 签到提示「已有任务在执行」 | 有别的 run 持有锁（`lock:run`，TTL 300s）。等 5 分钟或等上一次跑完 |
| 想看运行日志 | `npx wrangler tail`（结构化单行 JSON，可用 `--search run_finished` 过滤） |

彻底重置（清空所有数据，**不可恢复**）：

```bash
# 推荐：直接删掉整个命名空间，然后按「部署 5 步」重新 create + 把新 id 填回 wrangler.toml
npx wrangler kv namespace delete WB_KV
```

这会把**登录密码、账号与 token、MCP Key、全部日志**一起删除（控制台里删 KV 命名空间等价）。

> ⚠️ **只删 `config:auth` 不等于重置**：账号、token、MCP Key、日志都还在，下一个设置密码的人会直接接管你所有的 token。只有当「想保留账号与日志、只想重设密码」时才这么做：
>
> ```bash
> # 先列出全部键，确认清楚要动哪些（log:run:{runId} 每个 run 一个，要按实际 runId 删）
> npx wrangler kv key list --namespace-id <你的 KV id>
> npx wrangler kv key delete --namespace-id <你的 KV id> config:auth
> ```

## 目录结构

```
.
├── src
│   ├── index.js      Worker 入口：/api 与静态资源分流、Cron 触发
│   ├── router.js     路由匹配、同源校验、JSON body 解析、requireAuth
│   ├── util.js       响应信封 / 错误码 / 脱敏 / 编码 / 常量时间比较 / ID
│   ├── auth.js       PBKDF2 密码、HMAC 会话 Cookie、内存限流器
│   ├── store.js      createContext 装配点 + KV 读写封装 + 写计数
│   ├── checkin.js    上游签到客户端（10s 超时、两段式签到、9 类错误归一）
│   ├── credits.js    上游额度客户端（积分配额四分组、只读、零 KV 写）
│   ├── account-io.js 账号 JSON 导入/导出（cockpit-tools 兼容）
│   ├── logger.js     run 内存日志缓冲 + 64KB 截断汇总
│   ├── run.js        签到编排：抢锁 → 串行执行 → 收尾落盘 → 解锁
│   ├── api.js        22 条 REST 路由 + 可复用的服务函数
│   └── mcp.js        MCP JSON-RPC 分发 + 5 个工具
├── public
│   ├── index.html    三态视图骨架（setup / login / panel）
│   ├── app.js        单 state + 全量 render、API 客户端、轮询
│   └── styles.css    深色主题、卡片、徽标、移动端单列
├── docs              需求 / 架构 / 任务分解
├── wrangler.toml     Worker、assets、KV 绑定、Cron、环境变量
└── package.json
```

## 数据存储

全部数据在 **1 个 KV 命名空间**（`WB_KV`）里，共 7 类键（其中 `log:run:{runId}` 每个 run 一个，条数受「日志保留条数」限制）：

| 键 | 内容 |
| --- | --- |
| `config:auth` | 管理员密码哈希、会话密钥、`sessionVersion` |
| `config:settings` | 日志保留条数、Cron 展示信息 |
| `config:mcp` | MCP Key 的 sha256（不存明文） |
| `accounts` | 账号数组（token 明文，最多 10 个） |
| `log:index` | 执行记录索引（倒序，≤ 保留条数） |
| `log:run:{runId}` | 单次执行明细（≤ 64KB，超出自动截断） |
| `lock:run` | 互斥锁（TTL 300s） |

## License

[MIT](./LICENSE)

## 致谢

积分配额接口的路径、字段与分组规则参考了 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)（CC BY-NC-SA 4.0），仅参考接口事实、未复制其源码；商用前请自行评估上游接口与参考项目的许可约束。
