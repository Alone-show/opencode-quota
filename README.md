# dsh-opencode-quota

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web 界面挂一个
可展开的额度浮窗：右下角一个小胶囊实时显示 **OpenCode Go** 的本月额度，点开看 5 小时 /
本周 / 本月三个窗口和今日 token 用量。

在 DSH `0.2.1-rc.2` 的 Web 客户端上开发和验证。

## 功能

- **收起态**：右下角胶囊 `Go 19%` —— 左侧小圆环是本月额度进度，文字是本月百分比；
  颜色随水位变化（<70% 品牌色 / <90% 警告色 / 其余错误色）。
- **展开态**：三个计量窗口各一条进度条 + 百分比 + 重置倒计时；进度条整条是
  绿→黄→红的渐变，用量越高条越往红端伸，一眼能看出哪档告急。顶部是套餐到期日，
  底部是今日 tokens / 请求数和刷新按钮。
- **不显示金额**：只看百分比和颜色判断水位（接口里的美元字段只用来算百分比，界面不展示）。
- **非 Go 订阅**：胶囊显示灰色 `非 Go`，展开后给提示「当前账号不是 OpenCode Go 订阅」，
  不再渲染空进度条；能读到今日用量时照常显示。
- 每 20 秒轮询一次（宿主侧另有 12 秒缓存，多标签页不会放大上游请求），
  页面重新可见时立刻补一次；点胶囊外面或按 `Escape` 收起。
- 样式只用宿主主题令牌（`--dsw-alias-*`），深浅色自动跟随；文案走 DSH 的
  locale 服务（内置中文 / English）。
- 只读：不写任何上游数据，不下发 API Key 到页面，返回体里剥离 `subscriberUserId`、
  `paymentMethodId` 等账号标识。

## 环境要求

- DSH（DeepSeek Harness）Web 版；本插件在 `0.2.1-rc.2` 上验证。
- 一个 OpenCode API Key（`oc_sk_…`）。如果你的 DSH 已经在用 `opencode-go` 模型路由，
  那这份 key 已经在凭据里了，装完插件即可用。

## 安装

### 图形界面（推荐）

1. 打开 DSH Web GUI；
2. 左侧边栏点「插件」；
3. 点「添加插件」；
4. 在「包名或地址」输入框里粘贴仓库地址（任选一种，效果一样）：

   ```
   github:Alone-show/opencode-quota
   ```

   ```
   git+https://github.com/Alone-show/opencode-quota.git
   ```

   本机配了 GitHub SSH key 也可以用：

   ```
   git+ssh://git@github.com/Alone-show/opencode-quota.git
   ```

5. 点「安装」，等出现「已安装」后点「完成」；
6. 插件会热加载到当前页面；右下角没出现胶囊就刷新一次页面。

> 仓库根目录就是插件包，所以地址后面**不需要** `#分支` 或子目录后缀；
> 想锁版本再加标签，例如 `github:Alone-show/opencode-quota#v1.0.0`。
>
> 已经装过的话，升级需要先在插件页「卸载」再重新添加（界面上的提示也是这个意思）。

### 让 agent 装

对 agent 说「安装 github:Alone-show/opencode-quota」，它对应的工具调用是
`plugin_manager` 的 `install_bundle`，`target` 就是上面那个地址。

### CLI / 本地目录

- **CLI**：`dsh plugin --profile web add github:Alone-show/opencode-quota`
  只写 `dependencies`，还要把 `dsh-opencode-quota` 加进 profile 的
  `dsh.profile.bundles` 并执行 `pnpm install` 才会启用——所以推荐用界面装。
- **本地目录**：先 `git clone` 仓库，然后在「添加插件」里填这个目录的绝对路径即可。

## 配置 API Key

插件按顺序解析 `OPENCODE_GO_API_KEY`：

1. 宿主凭据服务：`~/.dsh/.credentials.yaml` 的 `refs` 段；
2. 进程环境变量。

已经用 DSH 的 `opencode-go` 模型路由的话，这个引用通常已经存在，装完直接可用。
否则任选一种方式补上：

- 在 DSH 设置 → 模型 里给 OpenCode Go 填 API Key（会写进 `refs`）；
- 手动往 `~/.dsh/.credentials.yaml` 的 `refs` 加一行：

  ```yaml
  refs:
    OPENCODE_GO_API_KEY: oc_sk_xxxxxxxx
  ```

- 或在启动 DSH 前 `export OPENCODE_GO_API_KEY=oc_sk_xxxxxxxx`。

换 key 不用重装插件，下一次请求就会用新 key。

## 它从哪拿数据

宿主半侧（`index.js`）注册一个同源只读路由，替浏览器去取 opencode.ai 控制台
自己用的两个接口：

| 上游接口 | 用途 |
| --- | --- |
| `GET https://opencode.ai/console/api/go/status` | 套餐状态 + `access.meters` 里的 5 小时 / 本周 / 本月用量（`limitMicroCents`、`usedMicroCents`，1e-8 美元为单位） |
| `GET https://opencode.ai/console/api/activity/go` | 按天汇总的 token / 请求 / 花费，用于「今日」一行 |

两个请求都带 `Authorization: Bearer <OPENCODE_GO_API_KEY>`，与 DSH 里
`llm-pi-ai` 的 `opencode-go` 路由共用同一份凭据。

**为什么不在浏览器里直接请求**：`opencode.ai` 的 console API 不返回跨域许可，
浏览器会被 CORS 挡掉；而且 API Key 只能留在宿主进程里，不能下发到页面。

路由会剥离 `subscriberUserId`、`paymentMethodId` 等账号标识，只回额度本身：

```jsonc
// GET /plugins/opencode-quota
{
  "ok": true,
  "fetchedAt": "2026-10-28T06:31:12.000Z",
  "plan": {
    "product": "go",
    "label": "Go",
    "isGo": true,
    "startsAt": "2026-10-20T04:00:05.000Z",
    "endsAt": "2026-11-20T04:00:05.000Z",
    "cancelAtPeriodEnd": false
  },
  "meters": [
    { "key": "fiveHour", "usedUsd": 2.32, "limitUsd": 12, "percent": 19.4, "resetsAt": "…" },
    { "key": "week",     "usedUsd": 8.27, "limitUsd": 30, "percent": 27.6, "resetsAt": "…" },
    { "key": "month",    "usedUsd": 11.5, "limitUsd": 60, "percent": 19.2, "resetsAt": "…" }
  ],
  "today": { "date": "2026-10-28", "tokens": 168885802, "requests": 1100, "costUsd": 2.93 },
  "notice": null
}
```

> `usedUsd` / `limitUsd` / `today.costUsd` 仍保留在返回体里（算百分比、给别的消费者用），
> 界面已经不展示金额了。

`notice` 表示「没有额度可看」的原因：

| 值 | 含义 |
| --- | --- |
| `null` | 正常，Go / Go Plus 订阅，`meters` 有三项 |
| `non-go` | 账号不是 Go 订阅（按量计费），`meters` 为空，`today` 仍可用 |
| `unknown` | `/go/status` 读不到（非鉴权失败），额度不可用 |

失败时返回 `{ ok: false, error: { code, message } }`，`code` 取
`missing-credential` / `credential-rejected` / `upstream`。

`?force=1` 跳过宿主侧缓存，浮窗里的刷新按钮用它。

## 排错

| 现象 | 处理 |
| --- | --- |
| 右下角没有胶囊 | 刷新一次页面；仍没有就看插件页里本插件是否处于「运行中」 |
| 胶囊显示灰色 `非 Go` | 当前账号不是 OpenCode Go 订阅，没有额度可看 |
| 展开后提示「未配置 OPENCODE_GO_API_KEY」 | 按上面「配置 API Key」补上凭据 |
| 提示「API Key 被拒绝」 | key 过期或被撤销，换一个 |
| 提示「读不到 Go 套餐信息」 | `/go/status` 请求失败（网络 / 上游临时故障），点刷新重试 |
| 数字比控制台晚一点 | 宿主缓存 12 秒 + 前端 20 秒轮询，属正常；点刷新按钮可立即取 |
| 改了插件代码没生效 | 客户端会热替换；**宿主侧** `index.js` 改动需要在插件页把本插件「停用 → 启用」一次 |

调试接口：`curl http://127.0.0.1:3080/plugins/opencode-quota` 直接看宿主返回。

## 卸载

插件页里点「卸载」即可；要连凭据一起清掉，再删掉 `refs` 里的
`OPENCODE_GO_API_KEY`（前提是你不再需要它做模型路由）。

## 许可

[MIT](LICENSE)
