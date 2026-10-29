/**
 * OpenCode 额度浮窗 —— 浏览器半侧（手写 __ModuleLoader__ 包，不经构建）。
 *
 * 在 shell.overlay（框架级浮动层）里挂一个右下角小胶囊：平时只显示当前最紧张的
 * 那个额度窗口的百分比，点一下展开成小弹窗，显示 5 小时 / 本周 / 本月三个窗口的
 * 用量、百分比、重置倒计时，以及今日 token 用量。
 *
 * 数据来自宿主半侧的同源只读路由 `/plugins/opencode-quota`（浏览器直接请求
 * opencode.ai 会被 CORS 挡掉，且 API Key 不能下发到页面）。
 *
 * 样式只用宿主主题令牌（--dsw-alias-*），深浅色自动跟随；文案走 ctx.locale。
 */

window.__ModuleLoader__.load({
  id: 'dsh-opencode-quota',
  factory: (require) => {
    // 装载器调用 factory 时不注入 module/exports，CJS 包装要自己建（同 dsh-quick-keys）。
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** 本插件的 locale 命名空间。 */
    const NS = 'opencode-quota';
    /** 与宿主 index.js 里的 ROUTE_PATH 保持一致。 */
    const ENDPOINT = '/plugins/opencode-quota';
    /** 轮询间隔；宿主侧另有 12 秒缓存，多标签页不会放大上游请求。 */
    const POLL_MS = 20000;
    /** 计量窗口的渲染顺序。 */
    const METER_KEYS = ['fiveHour', 'week', 'month'];

    const zh = {
      'pill.label': 'OpenCode 额度',
      'panel.subtitle': '额度',
      'plan.endsAt': '{date} 到期',
      'plan.expired': '已过期',
      'plan.cancelAtPeriodEnd': '本期结束后停止',
      'pill.notGo': '非 Go',
      'pill.monthHint': 'OpenCode Go 本月额度已用 {percent}',
      'pill.notGoHint': '当前账号不是 OpenCode Go 订阅，没有额度可看',
      'notice.nonGo': '当前账号不是 OpenCode Go 订阅',
      'notice.nonGoDetail': 'Go 订阅才有 5 小时 / 本周 / 本月额度；下面只是今日按量用量。',
      'notice.unknown': '读不到 Go 套餐信息，额度暂不可用。',
      'meter.fiveHour': '5 小时',
      'meter.week': '本周',
      'meter.month': '本月',
      'meter.resetIn': '{time}后重置',
      'meter.resetUnknown': '重置时间未知',
      'today': '今日 {tokens} tokens · {requests} 次请求',
      'today.none': '今日暂无用量',
      'updated': '{time} 更新',
      'action.refresh': '刷新',
      'action.expand': '展开',
      'action.collapse': '收起',
      'state.loading': '读取中…',
      'state.missing': '本机未配置 OPENCODE_GO_API_KEY',
      'state.rejected': 'API Key 被拒绝，可能已过期',
      'state.failed': '额度读取失败',
      'state.retry': '重试',
      'time.soon': '即将',
      'time.days': '{d} 天 {h} 小时',
      'time.hours': '{h} 小时 {m} 分',
      'time.minutes': '{m} 分钟',
    };

    const en = {
      'pill.label': 'OpenCode quota',
      'panel.subtitle': 'Quota',
      'plan.endsAt': 'ends {date}',
      'plan.expired': 'Expired',
      'plan.cancelAtPeriodEnd': 'ends after this period',
      'pill.notGo': 'Not Go',
      'pill.monthHint': 'OpenCode Go monthly quota used: {percent}',
      'pill.notGoHint': 'This account is not on an OpenCode Go plan, so it has no quota',
      'notice.nonGo': 'This account is not on an OpenCode Go plan',
      'notice.nonGoDetail': 'Only Go subscriptions carry 5-hour / weekly / monthly quota; below is today’s metered usage.',
      'notice.unknown': 'Could not read the Go plan state; quota is unavailable.',
      'meter.fiveHour': '5 hours',
      'meter.week': 'This week',
      'meter.month': 'This month',
      'meter.resetIn': 'resets in {time}',
      'meter.resetUnknown': 'reset time unknown',
      'today': '{tokens} tokens today · {requests} requests',
      'today.none': 'no usage today',
      'updated': 'updated {time}',
      'action.refresh': 'Refresh',
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'state.loading': 'Loading…',
      'state.missing': 'OPENCODE_GO_API_KEY is not configured',
      'state.rejected': 'API key rejected, it may have expired',
      'state.failed': 'Could not read quota',
      'state.retry': 'Retry',
      'time.soon': 'moments',
      'time.days': '{d}d {h}h',
      'time.hours': '{h}h {m}m',
      'time.minutes': '{m}m',
    };

    /** 组件内样式：随组件挂载/卸载，不写 document。 */
    const CSS = `
.ocq-root{position:fixed;right:20px;bottom:20px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:inherit;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary)}
.ocq-root *{box-sizing:border-box}
.ocq-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 6px 18px rgba(0,0,0,.18);cursor:pointer;font:inherit;font-size:12px;font-weight:500;transition:border-color .15s ease,background .15s ease}
.ocq-pill:hover{border-color:var(--dsw-alias-border-l2)}
.ocq-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ocq-dot{width:7px;height:7px;border-radius:50%;background:var(--ocq-tone);flex:0 0 auto}
.ocq-panel{pointer-events:auto;width:300px;padding:14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}
.ocq-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.ocq-head-main{display:flex;align-items:center;gap:7px;min-width:0}
.ocq-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ocq-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ocq-icon{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.ocq-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ocq-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ocq-icon.ocq-spin{animation:ocq-rotate .9s linear infinite}
@keyframes ocq-rotate{to{transform:rotate(360deg)}}
.ocq-meters{display:flex;flex-direction:column;gap:11px;margin-top:13px}
.ocq-meter-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.ocq-meter-name{font-size:12px;font-weight:500}
.ocq-meter-pct{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ocq-bar{position:relative;margin-top:5px;height:6px;border-radius:999px;overflow:hidden;background:linear-gradient(90deg,var(--dsw-alias-state-success-primary) 0%,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-state-warn-primary) 75%,var(--dsw-alias-state-error-primary) 100%)}
.ocq-bar-cover{position:absolute;top:0;bottom:0;right:0;background:var(--dsw-alias-bg-layer-2);transition:left .3s ease}
.ocq-meter-sub{display:flex;align-items:baseline;justify-content:flex-end;gap:8px;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ocq-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:13px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.ocq-state{display:flex;flex-direction:column;gap:8px;margin-top:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ocq-btn{align-self:flex-start;height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.ocq-btn:hover{border-color:var(--dsw-alias-border-l2)}
.ocq-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;

    /**
     * 百分比：小于 10% 保留一位小数，其余取整。
     * @param {number} value 0–100。
     * @returns {string} `17.6%` 形式。
     */
    function formatPercent(value) {
      const n = Number.isFinite(value) ? Math.max(0, value) : 0;
      return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
    }

    /**
     * 紧凑数字（token / 请求数）：走 Intl，中文出“1.7亿”，英文出“169M”。
     * @param {number} value 数值。
     * @param {string} localeId 当前 locale。
     * @returns {string} 紧凑文本。
     */
    function compactNumber(value, localeId) {
      const n = Number.isFinite(value) ? value : 0;
      try {
        return new Intl.NumberFormat(localeId, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      } catch {
        return String(n);
      }
    }

    /**
     * 剩余时长文案。
     * @param {number} ms 剩余毫秒。
     * @param {(key: string, params?: Record<string, unknown>) => string} t 翻译函数。
     * @returns {string} 例如“3 天 4 小时”。
     */
    function durationText(ms, t) {
      if (!Number.isFinite(ms)) return '';
      if (ms <= 0) return t('time.soon');
      const totalMinutes = Math.ceil(ms / 60000);
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return t('time.days', { d: days, h: hours });
      if (hours > 0) return t('time.hours', { h: hours, m: minutes });
      return t('time.minutes', { m: Math.max(1, minutes) });
    }

    /**
     * 按用量挑配色令牌：<70% 品牌色，<90% 警告色，其余错误色。
     * @param {number} percent 0–100。
     * @returns {string} CSS 颜色表达式。
     */
    function toneOf(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary)';
      if (percent >= 70) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-brand-primary)';
    }

    /**
     * 本地 HH:MM:SS。
     * @param {string} iso ISO 时间串。
     * @param {string} localeId 当前 locale。
     * @returns {string} 时间文本。
     */
    function clock(iso, localeId) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleTimeString(localeId, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch {
        return date.toLocaleTimeString();
      }
    }

    /**
     * 本地 M月D日 / M-D。
     * @param {string} iso ISO 时间串。
     * @param {string} localeId 当前 locale。
     * @returns {string} 日期文本。
     */
    function shortDate(iso, localeId) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleDateString(localeId, { month: 'short', day: 'numeric' });
      } catch {
        return `${date.getMonth() + 1}-${date.getDate()}`;
      }
    }

    /** 一个 22px 的刷新图标（自绘 SVG，不依赖宿主图标包）。 */
    function RefreshGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', fill: 'none' },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13 2.6v2.5h-2.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** 收起态的一条横杠图标。 */
    function ChevronGlyph({ up }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': 'true',
          fill: 'none',
          style: { transform: up ? 'rotate(180deg)' : 'none' },
        },
        h('path', {
          d: 'M4 10l4-4 4 4',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * 收起态图标：本月额度的环形进度（外圈是底色，内圈按百分比着色）。
     * @param {{ percent: number, tone: string }} props 百分比与配色。
     * @returns {object} React 元素。
     */
    function RingGlyph({ percent, tone }) {
      const radius = 5;
      const circumference = 2 * Math.PI * radius;
      const filled = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)) / 100;
      return h(
        'svg',
        { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('circle', {
          cx: 7,
          cy: 7,
          r: radius,
          fill: 'none',
          stroke: 'var(--dsw-alias-border-l2)',
          strokeWidth: 2,
        }),
        h('circle', {
          cx: 7,
          cy: 7,
          r: radius,
          fill: 'none',
          stroke: tone,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeDasharray: `${circumference * filled} ${circumference}`,
          transform: 'rotate(-90 7 7)',
        }),
      );
    }

    /**
     * 造一张绑定在当前客户端 context 上的额度浮窗组件。
     *
     * 组件要读 ctx.locale（订阅语言切换）并调用 ctx.slots，所以只能用闭包拿到
     * 客户端根 context——插槽不会把任意注册项当 props 透传给组件。
     * @param {object} ctx 客户端根 context。
     * @returns {object} React 组件。
     */
    function defineWidget(ctx) {
      /** 额度浮窗组件。 */
      function QuotaWidget() {
        const [open, setOpen] = useState(false);
        const [state, setState] = useState({ status: 'idle', payload: null, error: null });
        const [, forceRender] = useState(0);
        const rootRef = useRef(null);

        /** locale 切换时重渲染（文案走 ctx.locale.bind 的实时查找）。 */
        useEffect(() => ctx.locale.subscribe(() => forceRender((n) => n + 1)), []);

        const localeId = ctx.locale.getSnapshot().active;
        const t = ctx.locale.bind(NS);

        /** 读取一次额度；force 时让宿主跳过缓存。 */
        const load = useCallback(async (force) => {
          setState((prev) => ({ ...prev, status: prev.payload === null ? 'loading' : 'refreshing' }));
          try {
            const response = await fetch(force ? `${ENDPOINT}?force=1` : ENDPOINT, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            setState({ status: 'ready', payload, error: null });
          } catch (error) {
            setState((prev) => ({
              status: prev.payload === null ? 'error' : 'stale',
              payload: prev.payload,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }, []);

        // 首次读取 + 定时轮询；页面重新可见时立刻补一次。
        useEffect(() => {
          void load(false);
          const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load(false);
          }, POLL_MS);
          const onVisible = () => {
            if (document.visibilityState === 'visible') void load(false);
          };
          document.addEventListener('visibilitychange', onVisible);
          return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
          };
        }, [load]);

        // 展开时：点外部或按 Escape 收起。
        useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            const root = rootRef.current;
            if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
            setOpen(false);
          };
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
          };
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown);
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
          };
        }, [open]);

        const payload = state.payload;
        const ready = payload !== null && payload.ok === true;
        const plan = ready ? payload.plan : null;
        const isGo = ready && plan !== null && plan.isGo === true;
        const meters = isGo
          ? METER_KEYS.map((key) => metersById(payload.meters, key)).filter((meter) => meter !== undefined)
          : [];
        /** 收起态只报「本月」额度：图标是本月用量环，文字是本月百分比。 */
        const monthMeter = metersById(meters, 'month');
        const monthPercent = monthMeter === undefined ? 0 : monthMeter.percent;
        const tone = isGo ? toneOf(monthPercent) : 'var(--dsw-alias-state-idle-primary)';
        const toneStyle = { '--ocq-tone': tone };
        const pillPercent = monthMeter === undefined ? null : formatPercent(monthPercent);
        const pillText = isGo
          ? pillPercent === null
            ? `${plan.label} –`
            : `${plan.label} ${pillPercent}`
          : ready
            ? t('pill.notGo')
            : t('pill.label');
        const pillHint = isGo
          ? t('pill.monthHint', { percent: pillPercent ?? '–' })
          : ready
            ? t('pill.notGoHint')
            : pillText;

        /** 展开体：成功时是三个计量窗口，失败时是错误说明 + 重试。 */
        function renderBody() {
          if (payload !== null && payload.ok === false) {
            const code = payload.error?.code;
            const message =
              code === 'missing-credential'
                ? t('state.missing')
                : code === 'credential-rejected'
                  ? t('state.rejected')
                  : t('state.failed');
            return h(
              'div',
              { className: 'ocq-state' },
              h('span', null, message),
              payload.error?.message && code !== 'missing-credential' && code !== 'credential-rejected'
                ? h('span', { style: { opacity: 0.7, fontSize: '11px' } }, payload.error.message)
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'ocq-btn',
                  onClick: () => void load(true),
                },
                t('state.retry'),
              ),
            );
          }
          if (payload === null) {
            return h('div', { className: 'ocq-state' }, h('span', null, t('state.loading')));
          }
          if (!isGo) {
            const unknown = payload.notice === 'unknown';
            return h(
              'div',
              { className: 'ocq-state' },
              h('span', null, unknown ? t('notice.unknown') : t('notice.nonGo')),
              unknown ? null : h('span', { style: { fontSize: '11px', opacity: 0.75 } }, t('notice.nonGoDetail')),
            );
          }
          return h(
            'div',
            { className: 'ocq-meters' },
            ...meters.map((meter) =>
              h(
                'div',
                { key: meter.key, className: 'ocq-meter' },
                h(
                  'div',
                  { className: 'ocq-meter-head' },
                  h('span', { className: 'ocq-meter-name' }, t(`meter.${meter.key}`)),
                  h('span', { className: 'ocq-meter-pct' }, formatPercent(meter.percent)),
                ),
                h(
                  'div',
                  { className: 'ocq-bar' },
                  h('div', {
                    className: 'ocq-bar-cover',
                    style: { left: `${Math.min(100, Math.max(0, meter.percent))}%` },
                  }),
                ),
                h(
                  'div',
                  { className: 'ocq-meter-sub' },
                  h(
                    'span',
                    null,
                    meter.resetsAt === undefined
                      ? t('meter.resetUnknown')
                      : t('meter.resetIn', { time: durationText(Date.parse(meter.resetsAt) - Date.now(), t) }),
                  ),
                ),
              ),
            ),
          );
        }

        /**
         * 套餐行：到期时间 / 停止续订 / 需重新授权。
         * @returns {object | null} React 元素。
         */
        function renderPlanLine() {
          if (!ready || plan === null) return null;
          const notes = [];
          if (plan.endsAt !== undefined && Date.parse(plan.endsAt) < Date.now()) notes.push(t('plan.expired'));
          else if (plan.endsAt !== undefined) notes.push(t('plan.endsAt', { date: shortDate(plan.endsAt, localeId) }));
          if (plan.cancelAtPeriodEnd === true) notes.push(t('plan.cancelAtPeriodEnd'));
          if (notes.length === 0) return null;
          return h('div', { className: 'ocq-sub', style: { marginTop: '2px' } }, notes.join(' · '));
        }

        return h(
          'div',
          { className: 'ocq-root', ref: rootRef },
          h('style', null, CSS),
          open
            ? h(
                'div',
                { className: 'ocq-panel', style: toneStyle, role: 'dialog', 'aria-label': pillText },
                h(
                  'div',
                  { className: 'ocq-head' },
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h(
                      'div',
                      { className: 'ocq-head-main' },
                      h('span', { className: 'ocq-dot' }),
                      h('span', { className: 'ocq-title' }, ready ? plan.label : t('pill.label')),
                      ready ? h('span', { className: 'ocq-sub' }, t('panel.subtitle')) : null,
                    ),
                    renderPlanLine(),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ocq-icon',
                      title: t('action.collapse'),
                      'aria-label': t('action.collapse'),
                      onClick: () => setOpen(false),
                    },
                    h(ChevronGlyph, { up: false }),
                  ),
                ),
                renderBody(),
                h(
                  'div',
                  { className: 'ocq-foot' },
                  h(
                    'span',
                    null,
                    ready && payload.today !== null && payload.today !== undefined
                      ? t('today', {
                          tokens: compactNumber(payload.today.tokens, localeId),
                          requests: compactNumber(payload.today.requests, localeId),
                        })
                      : ready
                        ? t('today.none')
                        : '',
                  ),
                  h(
                    'span',
                    { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                    ready ? h('span', { style: { fontSize: '10px' } }, clock(payload.fetchedAt, localeId)) : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `ocq-icon${state.status === 'refreshing' || state.status === 'loading' ? ' ocq-spin' : ''}`,
                        title: t('action.refresh'),
                        'aria-label': t('action.refresh'),
                        onClick: () => void load(true),
                      },
                      h(RefreshGlyph),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'ocq-pill',
              style: toneStyle,
              title: pillHint,
              'aria-expanded': open ? 'true' : 'false',
              'aria-label': t('action.expand'),
              onClick: () => setOpen((value) => !value),
            },
            h(RingGlyph, { percent: isGo ? monthPercent : 0, tone }),
            h('span', null, pillText),
          ),
        );
      }

      return QuotaWidget;
    }
    /**
     * 按 key 取一个计量窗口。
     * @param {Array<Record<string, any>>} meters 响应里的窗口数组。
     * @param {string} key fiveHour | week | month。
     * @returns {Record<string, any> | undefined} 命中的窗口。
     */
    function metersById(meters, key) {
      if (!Array.isArray(meters)) return undefined;
      return meters.find((meter) => meter !== null && typeof meter === 'object' && meter.key === key);
    }

    /** 需要的客户端服务；缺一个就不挂载，避免半套注册。 */
    const inject = ['slots', 'locale'];

    /**
     * 往 shell.overlay 注册浮窗。
     * @param {object} ctx 客户端根 context。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-quota: 字典');
      const QuotaWidget = defineWidget(ctx);
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'opencode-quota',
            order: 40,
          },
          QuotaWidget,
        ),
      );
      console.info('[opencode-quota] floating quota widget ready');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
