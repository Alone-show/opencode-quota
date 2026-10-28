/**
 * OpenCode 额度浮窗 —— 宿主半侧。
 *
 * 只做一件事：把 opencode.ai 控制台的额度数据搬到本机同源路由上，供浏览器半侧
 * 轮询。
 *
 *   GET /plugins/opencode-quota          读取（命中缓存则不发上游请求）
 *   GET /plugins/opencode-quota?force=1  跳过缓存，强制刷新（浮窗里的刷新按钮）
 *
 * 为什么不直接让浏览器请求上游：
 *   1. https://opencode.ai/console/api/* 不返回跨域许可，浏览器会被 CORS 挡掉；
 *   2. 凭据（OPENCODE_GO_API_KEY，就是 opencode 的 oc_sk_… key）只应留在宿主侧，
 *      绝不能下发到页面。
 *
 * 数据来源（都是控制台前端自己在用的接口，只读、GET）：
 *   - /console/api/go/status       套餐状态 + 三个计费窗口的用量（microCent)
 *   - /console/api/activity/go     按天的 token / 请求 / 花费汇总
 * 返回体里含 subscriberUserId、paymentMethodId 等账号标识，本路由一律剥离，
 * 只向前端暴露额度本身，所以不需要额外的鉴权层。
 *
 * 凭据解析顺序：ctx.credentials.resolve('OPENCODE_GO_API_KEY')（profile 的
 * ~/.dsh/.credentials.yaml refs 里有这一项），读不到再退回进程环境变量。
 */

/** 套餐状态与计量窗口接口。 */
const STATUS_URL = 'https://opencode.ai/console/api/go/status'
/** 按天用量接口（失败时只让“今日”缺省，不影响额度显示）。 */
const ACTIVITY_URL = 'https://opencode.ai/console/api/activity/go'
/** 与本 profile 中 llm-pi-ai 的 opencode-go 路由共用的凭据引用名。 */
const API_KEY_REF = 'OPENCODE_GO_API_KEY'
/** 同源只读路由，client.js 里的 ENDPOINT 必须和它一致。 */
const ROUTE_PATH = '/plugins/opencode-quota'
/** 成功结果缓存时长：多个标签页 / 轮询共用一次上游请求。 */
const CACHE_TTL_MS = 12_000
/** 失败结果缓存时长：短一些，故障恢复后能尽快自愈。 */
const ERROR_TTL_MS = 5_000
/** 单个上游请求的超时。 */
const REQUEST_TIMEOUT_MS = 8_000
/** 计量窗口的固定顺序，前端按这个顺序渲染。 */
const METER_KEYS = ['fiveHour', 'week', 'month']

/** 依赖的宿主服务：HTTP 载体 + 凭据缝。 */
export const inject = ['webServer', 'credentials']

/**
 * microCent（1e-8 美元）转美元。
 * @param {unknown} value 接口里的字符串数字。
 * @returns {number} 美元金额；无法解析时为 0。
 */
function microCentsToUsd(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n / 1e8 : 0
}

/**
 * 把一个计量窗口压成前端好渲染的形状。
 * @param {string} key fiveHour | week | month。
 * @param {Record<string, unknown>} meter 接口里的单个窗口。
 * @returns {Record<string, unknown>} 归一化后的窗口。
 */
function normalizeMeter(key, meter) {
  const limitUsd = microCentsToUsd(meter?.limitMicroCents)
  const usedUsd = microCentsToUsd(meter?.usedMicroCents)
  const percent = limitUsd > 0 ? Math.min(limitUsd, usedUsd) / limitUsd * 100 : 0
  return {
    key,
    usedUsd,
    limitUsd,
    percent,
    startsAt: typeof meter?.startsAt === 'string' ? meter.startsAt : undefined,
    resetsAt: typeof meter?.resetsAt === 'string' ? meter.resetsAt : undefined,
  }
}

/**
 * 套餐信息：只保留展示需要的字段，账号标识不下发。
 * @param {Record<string, any>} status /go/status 的返回体。
 * @returns {Record<string, unknown>} 套餐视图。
 */
function normalizePlan(status) {
  const product = typeof status?.product === 'string' ? status.product : ''
  const access = status?.access && typeof status.access === 'object' ? status.access : {}
  const meters = access.meters && typeof access.meters === 'object' ? access.meters : undefined
  return {
    product,
    // 非 Go 套餐不把内部 product id 当标题，统一显示产品名。
    label: product === 'go-plus' ? 'Go Plus' : product === 'go' ? 'Go' : 'OpenCode',
    /** 只有 Go / Go Plus 订阅才带 access.meters；其它套餐（按量计费）没有额度。 */
    isGo: (product === 'go' || product === 'go-plus') && meters !== undefined,
    startsAt: typeof access.startsAt === 'string' ? access.startsAt : undefined,
    endsAt: typeof access.endsAt === 'string' ? access.endsAt : undefined,
    cancelAtPeriodEnd: status?.cancelAtPeriodEnd === true,
  }
}

/**
 * 今日用量：取 daily 里日期等于今天的一条。
 * @param {Record<string, any> | undefined} activity /activity/go 的返回体。
 * @param {string} today 本地日期 YYYY-MM-DD。
 * @returns {Record<string, unknown> | null} 今日用量，拿不到就是 null。
 */
function normalizeToday(activity, today) {
  const daily = Array.isArray(activity?.daily) ? activity.daily : []
  const row = daily.find((entry) => entry?.date === today)
  if (row === undefined) return null
  const tokens = Number(row.totalTokens)
  const requests = Number(row.totalRequests)
  return {
    date: row.date,
    tokens: Number.isFinite(tokens) ? tokens : 0,
    requests: Number.isFinite(requests) ? requests : 0,
    costUsd: microCentsToUsd(row.totalCostMicroCents),
  }
}

/**
 * 本地日期（用于匹配按天汇总里的 date 字段）。
 * @returns {string} YYYY-MM-DD。
 */
function localDateKey() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 一次 GET 上游接口。
 * @param {string} url 目标地址。
 * @param {string} key OpenCode API Key。
 * @returns {Promise<Record<string, any>>} 解析后的 JSON。
 */
async function fetchJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`opencode api responded HTTP ${response.status}`)
    error.httpStatus = response.status
    throw error
  }
  return await response.json()
}

/**
 * 挂载路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 */
export function apply(ctx) {
  /** @type {{ at: number, ttl: number, payload: unknown } | undefined} */
  let cache
  /** @type {Promise<unknown> | undefined} */
  let inflight

  /**
   * 取 API Key：先走凭据缝，再退回环境变量。
   * @returns {Promise<string | undefined>} 密钥明文（只在宿主进程内使用）。
   */
  async function apiKey() {
    try {
      const resolved = await ctx.credentials.resolve(API_KEY_REF)
      if (resolved && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
    } catch {
      /* 凭据服务不可用时退回环境变量，不阻断插件 */
    }
    const ambient = process.env[API_KEY_REF]
    return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  }

  /**
   * 把结果写进缓存并返回。
   * @param {unknown} payload 响应体。
   * @param {number} ttl 缓存时长。
   * @returns {unknown} 同一个响应体。
   */
  function remember(payload, ttl) {
    cache = { at: Date.now(), ttl, payload }
    return payload
  }

  /** 真正打上游、组装响应体。 */
  async function refresh() {
    const key = await apiKey()
    if (key === undefined) {
      return remember(
        {
          ok: false,
          fetchedAt: new Date().toISOString(),
          error: { code: 'missing-credential', message: `${API_KEY_REF} 未配置` },
        },
        ERROR_TTL_MS,
      )
    }
    try {
      const [statusOutcome, activityOutcome] = await Promise.allSettled([
        fetchJson(STATUS_URL, key),
        fetchJson(ACTIVITY_URL, key),
      ])
      const statusError = statusOutcome.status === 'rejected' ? statusOutcome.reason : undefined
      const httpStatus = statusError?.httpStatus
      // Key 被拒是硬错误：无论今日用量能不能读到，都直接报出来。
      if (httpStatus === 401 || httpStatus === 403) {
        return remember(
          {
            ok: false,
            fetchedAt: new Date().toISOString(),
            error: { code: 'credential-rejected', message: statusError.message },
          },
          ERROR_TTL_MS,
        )
      }
      const status = statusOutcome.status === 'fulfilled' ? statusOutcome.value : undefined
      const activity = activityOutcome.status === 'fulfilled' ? activityOutcome.value : undefined
      const fetchedAt = new Date().toISOString()
      // 两条都拿不到才整体失败；只缺套餐信息时仍返回今日用量，并带 notice 让前端提示。
      if (status === undefined && activity === undefined) {
        return remember(
          {
            ok: false,
            fetchedAt,
            error: { code: 'upstream', message: statusError?.message ?? 'opencode api unavailable' },
          },
          ERROR_TTL_MS,
        )
      }
      const plan = normalizePlan(status)
      return remember(
        {
          ok: true,
          fetchedAt,
          plan,
          meters: plan.isGo ? METER_KEYS.map((meterKey) => normalizeMeter(meterKey, status?.access?.meters?.[meterKey])) : [],
          today: normalizeToday(activity, localDateKey()),
          // non-go：接口通但账号不是 Go 订阅；unknown：/go/status 读不到（非鉴权失败）
          notice: plan.isGo ? null : status === undefined ? 'unknown' : 'non-go',
        },
        CACHE_TTL_MS,
      )
    } catch (error) {
      return remember(
        {
          ok: false,
          fetchedAt: new Date().toISOString(),
          error: {
            code: 'upstream',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        ERROR_TTL_MS,
      )
    }
  }

  /**
   * 读快照：命中缓存直接返回；并发请求合并成一次上游调用。
   * @param {boolean} force 是否跳过缓存。
   * @returns {Promise<unknown>} 响应体。
   */
  async function read(force) {
    if (!force && cache !== undefined && Date.now() - cache.at < cache.ttl) return cache.payload
    if (inflight !== undefined) return inflight
    const running = refresh().finally(() => {
      inflight = undefined
    })
    inflight = running
    return running
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.end()
            return
          }
          let force = false
          try {
            force = new URL(String(req.url), 'http://localhost').searchParams.get('force') === '1'
          } catch {
            /* URL 异常时按普通读取处理 */
          }
          const payload = await read(force)
          const body = JSON.stringify(payload)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      }),
    `opencode-quota: GET ${ROUTE_PATH}`,
  )
}
