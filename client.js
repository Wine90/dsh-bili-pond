/**
 * dsh-bili-pond —— 浏览器半端（设置在「设置」里的一页）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **怎么进「设置」**（抄第三方插件 `dsh-meme/client.js`）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'bili-pond', order: 30, label: 'B站鱼塘' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页要满足使用者 2026-10-14 说的形状：
 *   · **总开关 → 打开之后下面才展开子开关**（谷时运行 → 中午 / 夜间）
 *   · **数字项要能自己填**（每日选取上限）
 *   · **账号绑定必须在设置页里**（扫码登录 + 二维码直接显示在页里）
 *   · 会发东西出去的（发布评论）、要下大模型的（本地转写）**默认关**
 *
 * ⭐⭐ 2026-10-19 排版重做 v2（只动结构与样式，**没动任何 handler / 字段 / 请求**）：
 *   上一版的问题（使用者直接指出）：文案口语化、控件宽度靠内联硬压、select 假箭头。
 *   本版按「紧凑型设置页」规范重做：
 *   · **指标栏**：今日选取 / 运行环境 / 账号 / 版本，四格等宽，带分隔线
 *   · **分组卡片**：标题栏 + 底部分隔线，正文行「标签左、控件右」，行间细分隔线
 *   · **控件统一**：32px 高、6px 圆角、13px 字号；宽度由语义类决定（数值/短/中/满宽），
 *     **不用内联 style 压宽度**；select 用内联 SVG 箭头（不再是两个 gradient 拼的假三角）
 *   · **术语产品化**：运行计划 / 任务参数 / 发布与互动 / 检索与上下文 / 高级设置
 *   · 颜色全部走 DSH 主题 token（`--dsw-alias-*`），亮/暗自动跟随
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-pond',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-pond'
    /* ⚠️ 原来 jget/jpost 直接 .json()、从不看 res.ok ⇒ HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 无权限）' : res.status === 403 ? '（被宿主拦截）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* 只有一处箭头图标：内联 SVG（data URI），不依赖字体，也不再拿 gradient 拼三角 */
    const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888e96' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

    const CSS = `
/* ══ 局部变量：全部映射到 DSH 主题 token，亮/暗自动跟随 ══════════════════ */
[data-bd-page]{
  --bd-surface:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#1b1c1e));
  --bd-surface-2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));
  --bd-input:var(--dsw-alias-bg-base,rgba(0,0,0,.18));
  --bd-line:var(--dsw-alias-border-l1,rgba(128,128,128,.20));
  --bd-line-2:var(--dsw-alias-border-l2,rgba(128,128,128,.34));
  --bd-fg:var(--dsw-alias-label-primary,inherit);
  --bd-fg-2:var(--dsw-alias-label-secondary,#c5c8cd);
  --bd-fg-3:var(--dsw-alias-label-tertiary,#8b8f96);
  --bd-accent:var(--dsw-alias-brand-primary,#3b82f6);
  --bd-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --bd-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --bd-err:var(--dsw-alias-state-error-primary,#ef4444);
  --bd-hover:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  display:flex;flex-direction:column;gap:16px;
  max-width:720px;padding:2px 0 28px;
  color:var(--bd-fg);font-size:13px;line-height:20px;
  -webkit-font-smoothing:antialiased;
}
[data-bd-page] *{box-sizing:border-box;}

/* ══ 指标栏 ═════════════════════════════════════════════════════════════ */
[data-bd-metrics]{
  display:grid;grid-template-columns:1fr 1fr 1fr 1fr;
  border:1px solid var(--bd-line);border-radius:10px;overflow:hidden;
  background:var(--bd-surface);
}
[data-bd-metric]{padding:11px 16px 12px;min-width:0;}
[data-bd-metric] + [data-bd-metric]{border-left:1px solid var(--bd-line);}
[data-bd-metric-label]{
  font-size:11px;font-weight:400;letter-spacing:.02em;color:var(--bd-fg-3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
[data-bd-metric-value]{
  display:flex;align-items:center;gap:6px;margin-top:3px;
  font-size:15px;font-weight:600;line-height:22px;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
[data-bd-metric-value] i{width:6px;height:6px;border-radius:50%;background:var(--bd-fg-3);flex:none;display:block;}
[data-bd-metric][data-tone="ok"] [data-bd-metric-value] i{background:var(--bd-ok);}
[data-bd-metric][data-tone="warn"] [data-bd-metric-value] i{background:var(--bd-warn);}
[data-bd-metric][data-tone="err"] [data-bd-metric-value] i{background:var(--bd-err);}
[data-bd-metric-value] span{overflow:hidden;text-overflow:ellipsis;}

/* ══ 工具栏（主操作） ═══════════════════════════════════════════════════ */
[data-bd-toolbar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-bd-toolbar-spacer]{flex:1;min-width:0;}
[data-bd-toolbar] [data-bd-hint]{font-size:12px;color:var(--bd-fg-3);}

/* ══ 分组卡片 ═══════════════════════════════════════════════════════════ */
[data-bd-card]{
  border:1px solid var(--bd-line);border-radius:10px;
  background:var(--bd-surface);overflow:hidden;
}
[data-bd-card-head]{
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  padding:11px 16px;border-bottom:1px solid var(--bd-line);
  background:var(--bd-surface-2);
}
[data-bd-card-title]{font-size:13px;font-weight:600;line-height:20px;}
[data-bd-card-desc]{font-size:12px;line-height:18px;color:var(--bd-fg-3);}
[data-bd-card-body]{padding:2px 16px 8px;}

/* ══ 行：标签左 / 控件右 ═════════════════════════════════════════════════ */
[data-bd-row]{
  display:flex;align-items:center;gap:20px;
  padding:10px 0;min-height:44px;
}
[data-bd-row] + [data-bd-row]{border-top:1px solid var(--bd-line);}
[data-bd-row-main]{flex:1;min-width:0;}
[data-bd-row-label]{font-size:13px;font-weight:500;line-height:19px;color:var(--bd-fg);}
[data-bd-row-desc]{font-size:12px;line-height:18px;color:var(--bd-fg-3);margin-top:2px;}
[data-bd-row-ctl]{flex:none;display:flex;align-items:center;gap:8px;}
[data-bd-row][data-bd-stack]{flex-direction:column;align-items:stretch;gap:8px;}
[data-bd-row][data-bd-stack] [data-bd-row-ctl]{width:100%;}

/* 级联子项：左侧竖线内缩 */
[data-bd-sub]{padding-left:14px;border-left:2px solid var(--bd-line-2);margin:2px 0 6px;}
[data-bd-sub] [data-bd-row]:first-child{border-top:0;}

/* 分组分隔线（高级设置内部用） */
[data-bd-divider]{height:1px;background:var(--bd-line);margin:6px 0;}

/* ══ 控件：统一 32px 高 / 6px 圆角 / 13px 字号 ═══════════════════════════ */
[data-bd-input],[data-bd-select],[data-bd-textarea]{
  font-family:inherit;font-size:13px;color:var(--bd-fg);
  background:var(--bd-input);
  border:1px solid var(--bd-line-2);
  border-radius:6px;
  transition:border-color .12s ease;
}
[data-bd-input],[data-bd-select]{height:32px;padding:0 10px;}
[data-bd-textarea]{
  padding:7px 10px;line-height:19px;resize:vertical;min-height:80px;
  width:100%;display:block;
}
[data-bd-input]:hover,[data-bd-select]:hover,[data-bd-textarea]:hover{border-color:var(--bd-fg-3);}
[data-bd-input]:focus,[data-bd-select]:focus,[data-bd-textarea]:focus{
  outline:none;border-color:var(--bd-accent);
  box-shadow:0 0 0 1px var(--bd-accent);
}
[data-bd-input]::placeholder,[data-bd-textarea]::placeholder{color:var(--bd-fg-3);opacity:1;}

/* select：原生外观关掉，换成内联 SVG 箭头 */
[data-bd-select]{
  appearance:none;-webkit-appearance:none;-moz-appearance:none;
  padding-right:28px;cursor:pointer;
  background-image:${CHEVRON};
  background-repeat:no-repeat;
  background-position:right 10px center;
}
[data-bd-select] option{background:var(--bd-surface);color:var(--bd-fg);}

/* 宽度由语义决定 —— 不再用内联 style 压 */
[data-bd-w-num]{width:76px;text-align:right;font-variant-numeric:tabular-nums;padding-right:10px;}
[data-bd-w-num]::-webkit-outer-spin-button,
[data-bd-w-num]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
[data-bd-w-num]{-moz-appearance:textfield;}
[data-bd-w-sm]{width:150px;}
[data-bd-w-md]{width:230px;}
[data-bd-w-full]{width:100%;}

/* ══ 开关 ═══════════════════════════════════════════════════════════════ */
[data-bd-sw]{
  position:relative;flex:none;width:36px;height:20px;border-radius:10px;
  border:1px solid transparent;padding:0;cursor:pointer;
  background:var(--bd-line-2);transition:background .15s ease;
}
[data-bd-sw] i{
  position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:#fff;display:block;transition:left .15s ease;
  box-shadow:0 1px 2px rgba(0,0,0,.28);
}
[data-bd-sw][data-on]{background:var(--bd-accent);}
[data-bd-sw][data-on] i{left:18px;}
[data-bd-sw]:focus-visible{outline:2px solid var(--bd-accent);outline-offset:2px;}
[data-bd-sw][disabled]{opacity:.45;cursor:not-allowed;}

/* ══ 按钮 ═══════════════════════════════════════════════════════════════ */
[data-bd-btn]{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 12px;flex:none;
  font-family:inherit;font-size:13px;font-weight:500;line-height:1;
  color:var(--bd-fg);white-space:nowrap;cursor:pointer;
  background:transparent;border:1px solid var(--bd-line-2);border-radius:6px;
  transition:background .12s ease,border-color .12s ease;
}
[data-bd-btn]:hover{background:var(--bd-hover);border-color:var(--bd-fg-3);}
[data-bd-btn]:focus-visible{outline:2px solid var(--bd-accent);outline-offset:1px;}
[data-bd-btn][data-primary]{
  background:var(--bd-accent);border-color:var(--bd-accent);color:#fff;
}
[data-bd-btn][data-primary]:hover{background:var(--bd-accent);opacity:.9;}
[data-bd-btn][disabled]{opacity:.45;cursor:not-allowed;}
[data-bd-btn][disabled]:hover{background:transparent;border-color:var(--bd-line-2);}
[data-bd-btn][data-primary][disabled]:hover{background:var(--bd-accent);}
[data-bd-btns]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 0 10px;}

/* ══ 提示条 ═════════════════════════════════════════════════════════════ */
[data-bd-msg]{
  font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px;
  background:var(--bd-surface-2);color:var(--bd-fg-2);
  border-left:3px solid var(--bd-line-2);
  word-break:break-word;
}
[data-bd-msg][data-good]{border-left-color:var(--bd-ok);}
[data-bd-msg][data-warn]{border-left-color:var(--bd-warn);}
[data-bd-msg][data-err]{border-left-color:var(--bd-err);}
[data-bd-msg][data-bd-msg-flex]{flex:1 1 220px;}
[data-bd-msg][data-bd-msg-gap]{margin-bottom:10px;}

/* ══ 初始配置引导 ═══════════════════════════════════════════════════════ */
[data-bd-guide]{
  display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:12px 16px;border-radius:10px;
  border:1px solid var(--bd-accent);
  background:var(--bd-surface-2);
}
[data-bd-guide-txt]{flex:1;min-width:220px;font-size:12.5px;line-height:19px;color:var(--bd-fg-2);}
[data-bd-guide-txt] [data-bd-guide-title]{
  display:block;font-size:13px;font-weight:600;color:var(--bd-fg);margin-bottom:2px;
}

/* ══ 二维码 ═════════════════════════════════════════════════════════════ */
[data-bd-qr]{display:flex;gap:16px;align-items:flex-start;padding:10px 0;flex-wrap:wrap;}
[data-bd-qr] img{
  width:148px;height:148px;flex:none;padding:6px;
  background:#fff;border:1px solid var(--bd-line);border-radius:8px;
}
[data-bd-qr-note]{flex:1;min-width:180px;font-size:12px;line-height:19px;color:var(--bd-fg-3);}

/* ══ Markdown 报告排版（2026-10-20） ═══════════════════════════════════════
 * 报告是给人读的成品，按 markdown 渲染；行高和间距照阅读体验调。 */
[data-bd-md]{font-size:13px;line-height:1.75;color:var(--bd-fg-2);max-height:420px;overflow:auto;}
[data-bd-md] [data-bd-md-h]{margin:16px 0 8px;font-weight:600;color:var(--bd-fg);line-height:1.4;}
[data-bd-md] [data-bd-md-h="1"]{font-size:16px;}
[data-bd-md] [data-bd-md-h="2"]{font-size:15px;}
[data-bd-md] [data-bd-md-h="3"]{font-size:14px;padding-bottom:6px;border-bottom:1px solid var(--bd-line);}
[data-bd-md] [data-bd-md-h="4"]{font-size:13px;}
[data-bd-md] [data-bd-md-h="5"],[data-bd-md] [data-bd-md-h="6"]{font-size:13px;color:var(--bd-fg-3);}
[data-bd-md] [data-bd-md-p]{margin:8px 0;}
[data-bd-md] [data-bd-md-ul],[data-bd-md] [data-bd-md-ol]{margin:8px 0;padding-left:20px;}
[data-bd-md] li{margin:3px 0;}
[data-bd-md] a[data-bd-md-link]{color:var(--dsw-alias-link,#3b82f6);text-decoration:none;}
[data-bd-md] a[data-bd-md-link]:hover{text-decoration:underline;}
[data-bd-md] code[data-bd-md-code]{
  padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:12px;background:var(--bd-input);border:1px solid var(--bd-line);}
[data-bd-md] [data-bd-md-pre]{
  margin:10px 0;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.6;
  font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;
  background:var(--bd-input);border:1px solid var(--bd-line);overflow:auto;}
[data-bd-md] [data-bd-md-quote]{
  margin:10px 0;padding:6px 12px;border-left:3px solid var(--bd-line);
  color:var(--bd-fg-3);background:var(--bd-input);border-radius:0 6px 6px 0;}
[data-bd-md] [data-bd-md-table]{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px;}
[data-bd-md] [data-bd-md-table] th,[data-bd-md] [data-bd-md-table] td{
  padding:6px 10px;border:1px solid var(--bd-line);text-align:left;}
[data-bd-md] [data-bd-md-table] th{background:var(--bd-input);font-weight:600;}
[data-bd-md] [data-bd-md-hr]{margin:16px 0;border:0;border-top:1px solid var(--bd-line);}
[data-bd-md] strong{font-weight:600;color:var(--bd-fg);}

/* ══ 可折叠日志 ═══════════════════════════════════════════════════════════ */
[data-bd-logfold]{margin:8px 0;}
[data-bd-logfold-head]{
  display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;
  border:1px solid var(--bd-line);border-radius:6px;background:var(--bd-input);
  font-size:12px;color:var(--bd-fg-2);cursor:pointer;text-align:left;
  font-family:inherit;transition:background .12s;}
[data-bd-logfold-head]:hover{background:var(--bd-surface-2);}
[data-bd-logfold-caret]{flex:none;font-size:10px;color:var(--bd-fg-3);width:10px;}
[data-bd-logfold-label]{flex:none;font-weight:500;}
[data-bd-logfold-desc]{flex:1;min-width:0;color:var(--bd-fg-3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-logfold-hint]{flex:none;margin-left:auto;color:var(--bd-fg-3);font-size:11px;}

/* ══ 预格式块（日志 / 报告） ══════════════════════════════════════════════ */
[data-bd-pre]{
  margin:4px 0 10px;padding:10px 12px;border-radius:8px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:17px;
  white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow:auto;
  background:var(--bd-input);color:var(--bd-fg-2);
  border:1px solid var(--bd-line);
}
[data-bd-kv]{
  font-size:12px;line-height:20px;color:var(--bd-fg-3);
  word-break:break-all;
  padding:8px 0;
}
[data-bd-kv] b{font-weight:500;color:var(--bd-fg-2);}

/* ══ 折叠区 ═════════════════════════════════════════════════════════════ */
[data-bd-fold]{
  display:flex;align-items:center;gap:8px;width:100%;
  padding:11px 16px;margin:0;
  font-family:inherit;font-size:13px;font-weight:600;line-height:20px;
  color:var(--bd-fg);text-align:left;cursor:pointer;
  background:var(--bd-surface-2);border:0;border-bottom:1px solid transparent;
  transition:background .12s ease;
}
[data-bd-fold]:hover{background:var(--bd-hover);}
[data-bd-fold][data-open]{border-bottom-color:var(--bd-line);}
[data-bd-fold] [data-bd-chev]{
  flex:none;width:10px;height:10px;color:var(--bd-fg-3);
  transition:transform .15s ease;
}
[data-bd-fold][data-open] [data-bd-chev]{transform:rotate(90deg);}
[data-bd-fold] [data-bd-fold-extra]{
  font-size:12px;font-weight:400;color:var(--bd-fg-3);
}

/* ══ 加载骨架 ═══════════════════════════════════════════════════════════ */
[data-bd-skeleton]{display:flex;flex-direction:column;gap:10px;}
[data-bd-skeleton] div{height:56px;border-radius:10px;background:var(--bd-surface-2);}
[data-bd-skeleton] div[data-bd-sk-narrow]{height:20px;width:40%;}

/* ══ 页脚：作者 ═════════════════════════════════════════════════════════ */
[data-bd-foot]{
  display:flex;align-items:center;flex-wrap:wrap;gap:2px;
  padding-top:2px;
  font-size:12px;line-height:18px;color:var(--bd-fg-3);
}
[data-bd-foot] a{
  display:inline-flex;align-items:center;
  color:var(--bd-fg-2);text-decoration:none;border-radius:4px;
  transition:color .12s ease;
}
[data-bd-foot] a:hover{color:var(--bd-accent);text-decoration:underline;}
[data-bd-foot] [data-bd-foot-sep]{color:var(--bd-line-2);padding:0 6px;}

/* ══ 窄屏 ═══════════════════════════════════════════════════════════════ */
@media (max-width:560px){
  [data-bd-metrics]{grid-template-columns:1fr 1fr;}
  [data-bd-metric]:nth-child(3){border-left:0;}
  [data-bd-metric]:nth-child(n+3){border-top:1px solid var(--bd-line);}
  [data-bd-row]{gap:12px;}
  [data-bd-card-body]{padding-left:14px;padding-right:14px;}
  [data-bd-card-head]{padding-left:14px;padding-right:14px;}
  [data-bd-w-sm]{width:120px;}
  [data-bd-w-md]{width:170px;}
  [data-bd-btns] [data-bd-btn]{flex:1 1 auto;}
}
`

    // ⚠️ 与 lib/state.mjs 的 WINDOWS 保持一致（官方口径：工作日 9–12、14–18 是高峰，其余都是谷时）
    const DEFAULT_WINDOWS = {
      noon: { label: '中午时段', start: '12:00', end: '14:00' },
      night: { label: '夜间时段', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小组件 ────────────── */

    /** 折叠箭头：一个 10×10 的内联 SVG，比字符 ▶ 对齐更稳 */
    function Chevron() {
      return h('svg', {
        'data-bd-chev': '', viewBox: '0 0 10 10', width: 10, height: 10,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, h('path', { d: 'M3.5 1.5L7 5l-3.5 3.5' }))
    }

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        title: on ? '已开启' : '已关闭',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    /** 一行：左标签/说明，右控件 */
    function Row({ label, desc, children }) {
      return h('div', { 'data-bd-row': '' },
        h('div', { 'data-bd-row-main': '' },
          h('div', { 'data-bd-row-label': '' }, label),
          desc ? h('div', { 'data-bd-row-desc': '' }, desc) : null),
        children ? h('div', { 'data-bd-row-ctl': '' }, children) : null)
    }

    /** 一行：开关型 */
    function SwitchRow({ label, desc, on, onChange, disabled }) {
      return h(Row, { label, desc },
        h(Switch, { on, onChange, disabled }))
    }

    /** 一行：长控件占满（textarea / 日志等） */
    function StackRow({ label, desc, children }) {
      return h('div', { 'data-bd-row': '', 'data-bd-stack': '' },
        (label || desc) ? h('div', { 'data-bd-row-main': '' },
          label ? h('div', { 'data-bd-row-label': '' }, label) : null,
          desc ? h('div', { 'data-bd-row-desc': '' }, desc) : null) : null,
        h('div', { 'data-bd-row-ctl': '' }, children))
    }

    /** 分组分隔线（高级设置里把几组分开用，不是空 div 拼的） */
    function Divider() {
      return h('div', { 'data-bd-divider': '', role: 'separator' })
    }

    /** 分组卡片：标题栏 + 正文 */
    function Card({ title, desc, children }) {
      return h('div', { 'data-bd-card': '' },
        (title || desc) ? h('div', { 'data-bd-card-head': '' },
          title ? h('div', { 'data-bd-card-title': '' }, title) : null,
          desc ? h('div', { 'data-bd-card-desc': '' }, desc) : null) : null,
        h('div', { 'data-bd-card-body': '' }, children))
    }

    /**
     * ⭐ 可折叠日志块（2026-10-20）
     *    安装日志 / 转写日志都是原始终端输出，默认收起来 —— 平时不看，出问题才展开。
     *    保持 <pre> 原样显示（不做 markdown 渲染：日志里的 * | # 会被误解析）。
     */
    function LogFold({ label, desc, text, open, onToggle }) {
      if (!text) return null
      return h('div', { 'data-bd-logfold': '' },
        h('button', {
          'data-bd-logfold-head': '', 'data-open': open ? '' : undefined,
          onClick: onToggle,
        },
          h('span', { 'data-bd-logfold-caret': '' }, open ? '▾' : '▸'),
          h('span', { 'data-bd-logfold-label': '' }, label),
          desc ? h('span', { 'data-bd-logfold-desc': '' }, desc) : null,
          h('span', { 'data-bd-logfold-hint': '' }, open ? '收起' : '展开')),
        open ? h('pre', { 'data-bd-pre': '' }, text) : null)
    }

    /** 指标格 */
    function Metric({ label, value, tone }) {
      return h('div', { 'data-bd-metric': '', 'data-tone': tone || undefined },
        h('div', { 'data-bd-metric-label': '' }, label),
        h('div', { 'data-bd-metric-value': '' }, h('i'), h('span', null, value)))
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d?.ok) setSt(d)
          } catch { /* 网络抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    /* ══ 极简 markdown 渲染（2026-10-20） ═════════════════════════════════════
     * 为什么自己写而不引依赖：插件是单个 client.js，不能装 npm 包。
     * 覆盖报告实际用到的语法就够了：标题 / 粗体 / 行内代码 / 链接 / 列表 / 引用 / 代码块 / 表格。
     * ⚠️ 不做 HTML 注入 —— 全部走 React 元素，用户/模型写的内容不会被当 HTML 执行。
     * ═══════════════════════════════════════════════════════════════════════ */

    const MD_FENCE = String.fromCharCode(96, 96, 96)   // ```
    const MD_TICK = String.fromCharCode(96)            // `

    /**
     * 行内：**粗体** `代码` [文本](url)
     *
     * ⚠️ 2026-10-20 修：原来三条规则各写一个「贪婪前缀」(.*?) 的正则，谁先匹配上谁让步，
     *    结果一行里有 **粗体** 又有 [链接] 时，粗体的 (.*?) 会把整段吞掉，
     *    后面的 [链接] 就被当成普通文字了（真实报告里每行都是这种结构）。
     *    改成**一次扫描找最靠前的那个标记**，就近解析 —— 不会互相吞。
     */
    const renderInline = (text, keyPrefix) => {
      const nodes = []
      const src = String(text)
      let pos = 0
      let k = 0
      const pushText = (t) => { if (t) nodes.push(t) }

      while (pos < src.length) {
        // 从当前位置往后找：粗体 / 行内代码 / 链接，取**最靠前**的那个
        const rest = src.slice(pos)
        const cand = []
        let m

        m = rest.match(/\*\*([^*]+)\*\*/)
        if (m) cand.push({ at: m.index, len: m[0].length, kind: 'strong', m })
        m = rest.match(/`([^`]+)`/)
        if (m) cand.push({ at: m.index, len: m[0].length, kind: 'code', m })
        m = rest.match(/\[([^\]]+)\]\(([^)]+)\)/)
        if (m) cand.push({ at: m.index, len: m[0].length, kind: 'link', m })

        if (!cand.length) { pushText(rest); break }
        cand.sort((a, b) => a.at - b.at)
        const best = cand[0]

        pushText(rest.slice(0, best.at))
        if (best.kind === 'strong') {
          nodes.push(h('strong', { key: keyPrefix + 'b' + (k++) }, best.m[1]))
        } else if (best.kind === 'code') {
          nodes.push(h('code', { key: keyPrefix + 'c' + (k++), 'data-bd-md-code': '' }, best.m[1]))
        } else {
          nodes.push(h('a', {
            key: keyPrefix + 'a' + (k++), href: best.m[2], target: '_blank', rel: 'noreferrer',
            'data-bd-md-link': '',
          }, best.m[1]))
        }
        pos += best.at + best.len
      }
      return nodes
    }

    /**
     * 把 markdown 文本转成 React 元素数组。
     * 支持：### 标题 / 段落 / - 列表 / > 引用 / 代码块 / | 表格 |
     */
    const renderMarkdown = (text) => {
      const lines = String(text || '').split(/\r?\n/)
      const out = []
      let i = 0
      let key = 0
      const k = () => 'md' + (key++)

      while (i < lines.length) {
        const line = lines[i]

        // 代码块
        if (line.startsWith(MD_FENCE)) {
          const buf = []
          i++
          while (i < lines.length && !lines[i].startsWith(MD_FENCE)) { buf.push(lines[i]); i++ }
          i++
          out.push(h('pre', { key: k(), 'data-bd-md-pre': '' }, buf.join('\n')))
          continue
        }

        // 标题
        const hm = line.match(/^(#{1,6})\s+(.*)$/)
        if (hm) {
          const level = hm[1].length
          const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5'
          out.push(h(tag, { key: k(), 'data-bd-md-h': String(level) }, ...renderInline(hm[2], k())))
          i++
          continue
        }

        // 表格
        if (/^\s*\|/.test(line)) {
          const rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++ }
          const parseRow = (r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim())
          const header = parseRow(rows[0])
          const bodyRows = rows.slice(1).filter((r) => !/^[\s|:-]+$/.test(r)).map(parseRow)
          out.push(h('table', { key: k(), 'data-bd-md-table': '' },
            h('thead', null, h('tr', null, ...header.map((c, ci) => h('th', { key: ci }, ...renderInline(c, 'th' + ci))))),
            h('tbody', null, ...bodyRows.map((cells, ri) => h('tr', { key: ri },
              ...cells.map((c, ci) => h('td', { key: ci }, ...renderInline(c, 'td' + ri + ci))))))))
          continue
        }

        // 引用
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
          out.push(h('blockquote', { key: k(), 'data-bd-md-quote': '' }, ...renderInline(buf.join(' '), k())))
          continue
        }

        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
            i++
          }
          out.push(h('ul', { key: k(), 'data-bd-md-ul': '' },
            ...items.map((it, ii) => h('li', { key: ii }, ...renderInline(it, 'li' + ii)))))
          continue
        }

        // 有序列表
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
            i++
          }
          out.push(h('ol', { key: k(), 'data-bd-md-ol': '' },
            ...items.map((it, ii) => h('li', { key: ii }, ...renderInline(it, 'li' + ii)))))
          continue
        }

        // 水平线
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
          out.push(h('hr', { key: k(), 'data-bd-md-hr': '' }))
          i++
          continue
        }

        // 空行
        if (!line.trim()) { i++; continue }

        // 普通段落
        const buf = []
        while (i < lines.length && lines[i].trim()
          && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>|\s*\||" + MD_FENCE + ")/.test(lines[i])) {
          buf.push(lines[i])
          i++
        }
        if (buf.length) out.push(h('p', { key: k(), 'data-bd-md-p': '' }, ...renderInline(buf.join(' '), k())))
        else i++
      }
      return out
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      const [st, setSt] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      const [rl, setRl] = React.useState(null)
      const [newVer, setNewVer] = React.useState('')       // 发现的新版本号（空 = 没发现）
      const [selfUpgrade, setSelfUpgrade] = React.useState(true)  // 桌面版不能自升级，只提示去「设置 → 插件」
      const [runLog, setRunLog] = React.useState(null)     // 本轮进度（日志尾部 + 阶段）
      const [dmInfo, setDmInfo] = React.useState(null)     // 私信收件人的识别结果 { name, level } / { error }
      const [dmBusy, setDmBusy] = React.useState(false)
      const [runLogFold, setRunLogFold] = React.useState(null)  // 运行日志折叠：null = 跟随"是否在跑"
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [replyPer, setReplyPer] = React.useState(null)
      const [dmUid, setDmUid] = React.useState(null)        // 私信收件人 UID（本地草稿）
      const [dmOn, setDmOn] = React.useState(null)          // 私信开关（独立于评论）
      const [autoRun, setAutoRun] = React.useState(null)
      const [runsPerDay, setRunsPerDay] = React.useState(null)
      const [gapMin, setGapMin] = React.useState(null)
      const [pvOnly, setPvOnly] = React.useState(null)
      const [pickPerRound, setPickPerRound] = React.useState(null)   // 每轮最多挑几条
      const [pickPerDay, setPickPerDay] = React.useState(null)       // 每天最多挑几条
      const [transCap, setTransCap] = React.useState(null)      // 每日转写上限
      const [minDur, setMinDur] = React.useState(null)          // 最短分钟
      const [maxDur, setMaxDur] = React.useState(null)          // 最长分钟
      const [preferSub, setPreferSub] = React.useState(null)    // 字幕优先
      const [probeMax, setProbeMax] = React.useState(null)      // 最多查几条字幕
      const [mention, setMention] = React.useState(null)
      const [mentionUid, setMentionUid] = React.useState(null)
      const [mentionInfo, setMentionInfo] = React.useState(null)   // { name, face, level } 或 { error }
      const [mentionBusy, setMentionBusy] = React.useState(false)
      const [login, setLogin] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)    // 顶部状态提示（原来在最底下，看不见）
      const [report, setReport] = React.useState(null)      // 非 null = 报告已展开
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      const [adv, setAdv] = React.useState(null)            // 高级设置：null = 按状态自动判定
      const [logOpen, setLogOpen] = React.useState(false)      // 主依赖日志
      const [asrLogOpen, setAsrLogOpen] = React.useState(false) // 转写日志
      /* ⚠️ 扫码轮询的 timer 必须能停：切走设置页后还在跑的话会在已卸载的组件上 setState，
       *    重复点「扫码登录」还会叠出第二个 timer。（2026-10-16 审查修） */
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st?.config
      /* ⭐ 运行模型：数据来自服务端 /models，
       *    它读的是 DSH 真实注册的 provider —— 这里不写死任何线路。 */
      const [models, setModels] = React.useState(null)
      const [dutyProv, setDutyProv] = React.useState('')
      const [dutyModel, setDutyModel] = React.useState('')
      React.useEffect(() => {
        let alive2 = true
        const load = async () => {
          try { const d = await jget('/models'); if (alive2 && d?.ok) setModels(d) } catch { /* 拿不到就降级 */ }
        }
        load()
        return () => { alive2 = false }
      }, [])
      /* ⚠️ 只在「第一次拿到配置」时回填：status 每 5 秒轮询一次，无条件回填会把
       *    用户正在选的值冲回旧值（跟上面 perDay 那些输入框同一类坑）。 */
      const dutyFilled = React.useRef(false)
      React.useEffect(() => {
        if (!cfg || dutyFilled.current) return
        dutyFilled.current = true
        setDutyProv(cfg.dutyProvider || '')
        setDutyModel(cfg.dutyModel || '')
      }, [cfg])
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && ws === null) setWs(cfg.workspace || '')
        if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) setMention(cfg.mentionName || '')
        if (cfg && mentionUid === null) setMentionUid(cfg.mentionUid ? String(cfg.mentionUid) : '')
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmOn === null) setDmOn(Boolean(cfg.dmOn))
        if (cfg && autoRun === null) setAutoRun(Boolean(cfg.autoRun))
        if (cfg && runsPerDay === null) setRunsPerDay(String(cfg.autoRunsPerDay ?? 6))
        if (cfg && gapMin === null) setGapMin(String(cfg.autoGapMinutes ?? 60))
        if (cfg && pvOnly === null) setPvOnly(Boolean(cfg.peakValleyOnly))
        if (cfg && pickPerRound === null) setPickPerRound(String(cfg.perRoundMax ?? 3))
        if (cfg && pickPerDay === null) setPickPerDay(String(cfg.perDayMax ?? 18))
        if (cfg && transCap === null) setTransCap(String(cfg.transcribePerDay ?? 10))
        if (cfg && minDur === null) setMinDur(String(cfg.minDurationMin ?? 0))
        if (cfg && maxDur === null) setMaxDur(String(cfg.maxDurationMin ?? 60))
        if (cfg && preferSub === null) setPreferSub(cfg.preferSubtitle !== false)
        if (cfg && probeMax === null) setProbeMax(String(cfg.subtitleProbeMax ?? 3))
      }, [cfg])

      /* ⭐ 本轮进度轮询（2026-10-20）：跑着的时候每 2 秒拉一次日志尾部，跑完再拉一次收尾。
       *    只读日志尾部，不攒内存；st.running 一变就重建定时器。 */
      const runningNow = Boolean(st?.running)
      React.useEffect(() => {
        let alive = true
        let timer = null
        const pull = async () => {
          try { const r = await jget('/runlog?n=40'); if (alive && r && r.ok) setRunLog(r) } catch { /* 网络抖一下就跳过 */ }
        }
        if (runningNow) {
          pull()
          timer = setInterval(pull, 2000)
        } else pull()
        return () => { alive = false; if (timer) clearInterval(timer) }
      }, [runningNow])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部
      }

      /* ⚠️ 并发保存的最后一笔才算数：响应乱序时，晚到的旧 config 会把新的盖回去。 */
      const patchSeq = React.useRef(0)
      const patch = async (p, what) => {
        const seq = ++patchSeq.current
        setSaving(true)
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config && seq === patchSeq.current) setSt((old) => ({ ...old, config: r.config }))
          // ⭐ DSH 原生设置页里显式设过的键由宿主说了算 ⇒ 我们这份也得写进去；写失败要说出来，别假装"已保存"
          // ⚠️ noForm 不算失败：那个部署本来就没有可写的设置表单，配置就只存在插件这边
          if (r?.host && r.host.ok === false && !r.host.noForm) say(`${what || '设置'}：已保存到插件配置，但同步到 DSH 设置失败（${r.host.error}）`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setSaving(false); setBusy('') }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }       // 再点一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.exists ? (r.text || '（报告内容为空）') : '今日暂无报告 —— 运行一轮后生成')
        } catch (e) { setReport('读取报告失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      // ⭐ 复核评论：接口回"发送成功"≠ 公开可见（新号/风控会进审核，那时候连 @ 都不会推）
      //    所以让宿主真去拉一次评论列表 / 楼中楼，确认那条到底在不在。
      const onVerify = async () => {
        setBusy('verify')
        try {
          const r = await jpost('/verify', {})
          if (!r || !r.ok) { say('复核未执行：' + ((r && r.error) || '未知原因'), 'warn'); return }
          const n = (r.checked || []).length
          const vis = (r.checked || []).filter((c) => c.visible === true).length
          if (!n) say(r.text || '没有需要复核的记录', 'good')
          else say(`复核完成 ${n} 条：公开可见 ${vis} 条，其余状态为「未查到」（可能仍在审核，未查到不等于未发布）。结果已追加到今日报告末尾。`, vis ? 'good' : 'warn')
          if (r.report) setReport(null)
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const copyText = async (text) => {
        const v = String(text || '')
        try {
          await navigator.clipboard.writeText(v)
          say('已复制：' + v, 'good')
        } catch {
          say('复制失败 —— 路径为：' + v)       // 兜底：至少把路径显示出来，手动选中也能复制
        }
      }

      const onOpenFolder = async (what) => {
        try {
          const r = await jpost('/open', { what })
          if (r && r.ok) say('已请求系统打开：' + (r.opened || '') + '（若未弹出窗口，请使用「复制报告路径」）', 'good')
          else say('无法打开（' + ((r && r.error) || '未知原因') + '）—— 可手动打开该路径：' + ((r && r.dir) || ''))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onUpgrade = async () => {
        setBusy('upgrade')
        try {
          const r = await jpost('/upgrade', {})
          say(((r && r.hint) || '正在升级') + ' —— 升级过程写入「主依赖日志」；完成后需重启 dsh 才会生效', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheckUpdate = async () => {
        setBusy('update')
        try {
          const r = await jget('/update')
          if (r && r.ok && r.latest) {
            if (r.hasNew) {
              setNewVer(r.latest)
              setSelfUpgrade(r.selfUpgrade !== false)
              say(r.selfUpgrade === false
                ? '发现新版本 v' + r.latest + '（当前 v' + r.current + '）—— 桌面版请到「设置 → 插件」里更新'
                : '发现新版本 v' + r.latest + '（当前 v' + r.current + '）—— 点击「升级」，完成后重启 dsh', 'warn')
            } else say('已是最新版本 v' + r.current, 'good')
          } else {
            say('无法获取最新版本（可能网络不可用）—— 当前版本 v' + ((r && r.current) || '?'))
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('运行正常：' + (r.steps || []).join('、'))
          else say('尚不可用：' + (r && r.error ? r.error : '未获取到结果'))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstallAsr = async () => {
        setBusy('asr')
        say('')
        try {
          const r = await jpost('/install-asr', {})
          say(r?.started ? '开始安装转写依赖 —— 进度显示在下方（需下载模型，耗时较长）' : (r?.hint || '未启动'),
            r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        say('')
        try {
          const r = await jpost('/install', {})
          say(r?.hint || '已在后台开始安装', '')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          if (r?.started) say('已在后台运行一轮，报告将写入 out/ 目录', 'good')
          else if (r?.busy) say(String(r.error || '上一轮还在跑，等它结束再开'), 'warn')
          else say('未启动，详见 duty.log', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onLoginStart = async () => {
        setBusy('login')
        setLoginTone('')
        setLoginState('正在生成二维码…')
        try {
          const r = await jpost('/login/start', {})
          if (!r?.ok) { setLoginTone('warn'); setLoginState(r?.error || '生成二维码失败'); return }
          setLogin({ key: r.key, qr: r.qr })
          if (!r.qr) { setLoginTone('warn'); setLoginState('未能绘制二维码 —— 请先点「重装主依赖」（venv 需含 qrcode）') }
          else setLoginState('请使用手机 B站 扫描二维码')
          if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }   // 重复点：先把上一轮停掉
          let n = 0
          const stop = () => { clearInterval(timer); if (loginTimer.current === timer) loginTimer.current = null }
          const timer = setInterval(async () => {
            if (!alive.current) { stop(); return }        // 已经切走设置页了：别再问、别再 setState
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                stop(); setLogin(null)
                setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('已扫描，请在手机上确认') }
              else if (p?.state === 'expired') { stop(); setLogin(null); setLoginTone('warn'); setLoginState('二维码已过期，请重新点击「扫码登录」') }
              // ⚠️ 扫码成功但响应里没有 SESSDATA 时服务端回 state='unknown'：原来没这个分支
              //    ⇒ 界面一直显示「等扫码…」，用户白等 3 分钟才超时。（2026-10-16 审查修）
              else if (p?.state === 'unknown') {
                stop(); setLogin(null); setLoginTone('warn')
                setLoginState('登录未完成：' + (p?.message || '响应中无 SESSDATA，请重新点击「扫码登录」'))
              }
              else { setLoginTone(''); setLoginState('等待扫描…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { stop(); setLogin(null); setLoginTone('warn'); setLoginState('已超时，请重新点击「扫码登录」') }
          }, 2000)
          loginTimer.current = timer
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      /* ⭐ UID → 昵称：B站 评论只认昵称文本，所以让用户填 UID（可记、可查），
       *    后端解析出昵称后自动写进 mentionName。解析失败要说清楚，别静默。 */
      const onResolveUid = async () => {
        const uid = Math.max(0, Number(mentionUid) || 0)
        if (!uid) { setMentionInfo({ error: '先填 UID' }); return }
        setMentionBusy(true)
        setMentionInfo(null)
        try {
          const r = await jpost('/resolve-user', { uid, target: 'mention' })
          if (r?.ok) {
            setMention(r.name)
            setMentionInfo({ name: r.name, level: r.level })
            say('已识别：' + r.name, 'good')
          } else {
            setMentionInfo({ error: r?.error || '解析失败' })
            say(r?.error || '解析失败', 'warn')
          }
        } catch (e) {
          setMentionInfo({ error: String(e?.message ?? e) })
          say(String(e?.message ?? e), 'warn')
        } finally { setMentionBusy(false) }
      }

      /* ⭐ 私信收件人的识别（2026-10-20）：只回昵称给界面确认，**不写 mentionName**
       *    —— 那是评论里 @ 的人，写错会串到公开评论上。 */
      const onResolveDmUid = async () => {
        const uid = Math.max(0, Number(dmUid) || 0)
        if (!uid) { setDmInfo({ error: '先填 UID' }); return }
        setDmBusy(true); setDmInfo(null)
        try {
          const r = await jpost('/resolve-user', { uid, target: 'dm' })
          if (r?.ok) { setDmInfo({ name: r.name, level: r.level }); say('私信收件人：' + r.name, 'good') }
          else { setDmInfo({ error: r?.error || '解析失败' }); say(r?.error || '解析失败', 'warn') }
        } catch (e) { setDmInfo({ error: String(e?.message ?? e) }) }
        finally { setDmBusy(false) }
      }

      const onSaveText = async () => {
        const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        await patch({ keywords: list, workspace: String(ws || '').trim() }, '检索关键词与工作区')
      }

      /* ⭐ 「建模板」：不知道 AGENTS.md 该写什么格式 ⇒ 让插件在工作区里铺一份能直接改的骨架 */
      const onAgentsTemplate = async () => {
        const dir = String(ws ?? '').trim()
        if (!dir) { say('先在上面填「工作区路径」，再点「建模板」', 'warn'); return }
        setBusy('agents')
        try {
          const r = await jpost('/agents-template', { dir })
          if (r && r.ok) say('已生成 ' + r.path + ' —— 照着里面每一节改就行', 'good')
          else if (r && r.exists) say('这个目录里已经有 AGENTS.md 了，没覆盖：' + r.path, 'warn')
          else say('生成失败：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      /* ── 加载态：给骨架，别只丢一句"读设置中…" ── */
      if (!cfg) {
        return h('div', { 'data-bd-page': '' },
          h('div', { 'data-bd-skeleton': '' },
            h('div', { 'data-bd-sk-narrow': '' }), h('div'), h('div'), h('div')),
          h('div', { 'data-bd-row-desc': '' }, '正在加载设置…（若长时间停留在此，请查看 duty.log）'))
      }

      const sw = (k) => Boolean(cfg[k])
      const picked = st.pickedToday ?? st.ranToday ?? 0
      // 高级设置默认：环境未就绪 / 未登录 ⇒ 展开（那正是最需要操作的时候）
      const advOpen = adv === null ? (!st.venvReady || !st.loggedIn) : adv
      const needSetup = !st.venvReady
      const needLogin = st.venvReady && !st.loggedIn

      /* 状态文案：短、可判定
       * ⭐ 2026-10-20：改成读新字段 autoRun / perDayMax（原来读 peakValley / perDay，
       *    导致自动开着也显示「仅手动」）。 */
      const dayCap = Number(cfg.perDayMax) || 0
      const pickedTone = dayCap > 0 && picked >= dayCap ? 'ok' : undefined
      const envTxt = st.venvReady ? '就绪' : (st.installing ? '安装中' : '未安装')
      const envTone = st.venvReady ? 'ok' : (st.installing ? 'warn' : 'err')
      const loginTxt = st.loggedIn ? '已登录' : '未登录'
      const loginToneV = st.loggedIn ? 'ok' : 'warn'
      const inPvWindow = Boolean(st.windows?.noon?.opening || st.windows?.night?.opening)
      const planTxt = st.installing ? '安装中'
        : (!sw('autoRun')
          ? '仅手动'
          : (sw('peakValleyOnly')
            ? (inPvWindow ? '运行中' : '待触发')
            : '自动运行'))
      const planTone = st.installing ? 'warn'
        : (sw('autoRun') ? (inPvWindow || !sw('peakValleyOnly') ? 'ok' : undefined) : undefined)

      /* ⭐ 本轮实际会投递什么 —— 评论与私信是两个**独立开关**，判据与宿主端一致
       *   （index.js 的 commentOn = autoComment && mentionName、dmOn = dmOn && dmUid） */
      const dmActive = Boolean(dmOn && Number(dmUid) > 0)
      const commentActive = Boolean(sw('autoComment') && cfg.mentionName)
      const deliverNow = !commentActive && !dmActive
        ? '只生成报告，不发布任何内容'
        : (commentActive && dmActive
          ? '评论 + 私信'
          : (commentActive ? '只发公开评论' : '只发私信'))

      return h('div', { 'data-bd-page': '' },

        /* ══ ① 指标栏 ══════════════════════════════════════════════════ */
        /* 指标栏：三个就够了 —— 「环境」和「状态」原来分成两格，
         * 但环境没装好时状态必然是「待配置」，信息重复；这里并成一格。 */
        h('div', { 'data-bd-metrics': '' },
          h(Metric, {
            label: '今日选取',
            value: `${picked} / ${cfg.perDayMax || '不限'}`,
            tone: pickedTone,
          }),
          h(Metric, {
            label: '运行环境',
            value: st.venvReady ? (st.loggedIn ? '就绪' : '待登录') : (st.installing ? '安装中' : '待安装'),
            tone: st.venvReady ? (st.loggedIn ? 'ok' : 'warn') : (st.installing ? 'warn' : 'err'),
          }),
          h(Metric, { label: '运行状态', value: planTxt, tone: planTone })),

        /* ══ ①.5 本轮进度（跑的时候实时刷，跑完留最后一份）══════════════ */
        (st.running || runLog) ? (() => {
          const L = runLog || {}
          const lines = Array.isArray(L.lines) ? L.lines : []
          const sec = st.running ? (L.elapsedSec || st.runElapsedSec || 0) : 0
          const mm = Math.floor(sec / 60); const ss = String(sec % 60).padStart(2, '0')
          /* ⭐ 日志默认折叠（2026-10-20）：跑着的时候展开（这时候才关心），跑完了默认收起。
           *    用户手动点过就记住他的选择（runLogFold !== null 之后一律听他的）。 */
          const foldOpen = runLogFold !== null ? runLogFold : Boolean(st.running)
          return h(Card, {
            title: '本轮进度',
            desc: st.running
              ? `跑着（${st.runWhy === 'manual' ? '手动' : st.runWhy || '自动'}）· 已用时 ${mm}:${ss}${L.stage ? ' · 当前：' + L.stage : ''}`
              : (lines.length ? '上一轮已结束' : ''),
          },
            h('div', { 'data-bd-row-desc': '' },
              `今日已挑 ${st.pickedToday ?? 0} / ${cfg.perDayMax || '不限'} 条`
              + (st.running ? ' · 日志每 2 秒刷新，跑完自动停' : '')),
            (st.lastError && !st.running)
              ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, '⚠️ 上一轮没成功：' + st.lastError.hint)
              : null,
            lines.length
              ? h(LogFold, {
                label: '本轮运行输出',
                desc: `（末尾 ${Math.min(lines.length, 20)} 行 · 这份是这一轮的模型输出，插件自己的事件在 duty.log）`,
                text: lines.slice(-20).join('\n'),
                open: foldOpen,
                onToggle: () => setRunLogFold(!foldOpen),
              })
              : h('div', { 'data-bd-row-desc': '' }, '（还没有日志：这一轮刚开始，或者日志被清了）'))
        })() : null,

        /* ══ ② 工具栏 ═════════════════════════════════════════════════ */
        /* ⭐ 跑着的时候按钮变灰（2026-10-20）：以前只灰"点了请求"那一两秒，
         *    之后又能点第二次 ⇒ 会重复开 headless 进程、重复烧模型额度。
         *    现在改成看 status.running（服务端那一轮的进程还活着就一直是 true）。 */
        h('div', { 'data-bd-toolbar': '' },
          h('button', {
            'data-bd-btn': '', 'data-primary': '',
            disabled: busy === 'run' || Boolean(st.running),
            onClick: onRun,
          }, busy === 'run'
            ? '启动中…'
            : (st.running
              ? `运行中…${st.runElapsedSec ? ' ' + Math.floor(st.runElapsedSec / 60) + ':' + String(st.runElapsedSec % 60).padStart(2, '0') : ''}`
              : '立即运行一轮')),
          h('button', {
            'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport,
          }, report !== null ? '收起报告' : '查看今日报告'),
          h('div', { 'data-bd-toolbar-spacer': '' }),
          /* 投递方式在「发布与互动」卡片里已经有了，工具栏只留版本号 */
          h('span', { 'data-bd-hint': '' }, `v${st.version || '?'}`)),

        /* 操作反馈：紧贴工具栏 */
        runNote ? h('div', {
          'data-bd-msg': '',
          'data-good': runNote.tone === 'good' ? '' : undefined,
          'data-warn': runNote.tone === 'warn' ? '' : undefined,
          'data-err': runNote.tone === 'err' ? '' : undefined,
        }, runNote.t) : null,

        /* ══ ③ 初始配置引导（只在缺失时出现） ══════════════════════════ */
        (needSetup || needLogin) ? h('div', { 'data-bd-guide': '' },
          h('div', { 'data-bd-guide-txt': '' },
            h('span', { 'data-bd-guide-title': '' }, needSetup ? '第 1 步 · 安装运行环境' : '第 2 步 · 扫码登录'),
            needSetup
              ? '在本机创建独立 Python 环境，并安装 B站 接口依赖。通常需要几十秒。'
              : '使用手机 B站 扫码，确认时请选择「记住我 / 长期」。'),
          h('button', {
            'data-bd-btn': '', 'data-primary': '',
            disabled: needSetup ? busy === 'install' : busy === 'login',
            onClick: needSetup ? onInstall : onLoginStart,
          }, needSetup
            ? (st.installing ? '正在安装…' : '安装运行环境')
            : '扫码登录')) : null,

        /* ══ ④ 配置未同步提示 ══════════════════════════════════════════
           2026-10-18：DSH 0.2.1 某些启动方式会拒写（profile reload requires the root Include entry），
           以前的表现是"开关亮一下又被压回原状"，用户以为是自己手滑。 */
        (Array.isArray(st.notSynced) && st.notSynced.length)
          ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
              `有 ${st.notSynced.length} 项未能同步到 DSH 原生设置（${st.notSynced.join('、')}）。`
              + '插件将以本页配置为准，功能不受影响；DSH 自带设置页不显示这些值。')
          : null,

        /* 报告展开：放在工具栏下方，读报告时不用滚到底
         * ⭐ 2026-10-20：报告改成渲染 markdown（原来是 <pre> 原样显示，满屏星号）。
         *    报告是给人读的成品；日志才是原始终端输出，仍旧用 <pre>。 */
        report !== null ? h(Card, { title: '今日报告' },
          h('div', { 'data-bd-md': '' }, ...renderMarkdown(report))) : null,

        /* ══ ⑤ 自动运行（2026-10-20 重构） ═════════════════════════════
         * 旧模型：peakValley 是总开关（只有谷时才跑）。
         * 新模型：autoRun 是主开关；「只在谷时跑」降级成一个可选项。
         * 排班规则：每小时最多 1 轮（间隔可调）、每天最多 N 轮、每天最多挑 M 条。 */

        /* 上限提醒：配置有风险时顶部提示 */
        (() => {
          const warns = []
          const dm = Number(pickPerDay) || 0
          const pr = Number(pickPerRound) || 0
          const rd = Number(runsPerDay) || 0
          if (dm > 24) warns.push(`每天 ${dm} 条 ⇒ 平均每 ${Math.max(1, Math.round(1440 / dm))} 分钟发一条评论。B站 对高频评论 + 固定 @ 同一人有明确的反垃圾识别，小号很可能当天被封。`)
          if (pr > 5) warns.push(`每轮 ${pr} 条偏多 —— 单轮越久，转写和判断成本越高。`)
          if (rd > 12) warns.push(`每天 ${rd} 轮 ⇒ 平均每 ${Math.max(1, Math.round(1440 / rd))} 分钟跑一轮，机器基本没有空闲。`)
          if (!warns.length) return null
          return h('div', { 'data-bd-guide': '', 'data-warn-guide': '' },
            h('div', { 'data-bd-guide-txt': '' },
              h('span', { 'data-bd-guide-title': '' }, '⚠️ 当前配置偏激进'),
              ...warns.map((w, wi) => h('div', { key: wi, style: { marginTop: '4px' } }, w))))
        })(),

        h(Card, {
          title: '自动运行',
          desc: '每天自动跑若干轮；也可以只手动跑。手动那一轮不占自动额度。',
        },
          h(SwitchRow, {
            label: '自动运行',
            desc: '关闭后仅可通过「立即运行一轮」手动触发',
            on: Boolean(autoRun),
            onChange: (v) => { setAutoRun(v); patch({ autoRun: v }, '自动运行') },
          }),
          Boolean(autoRun) ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '每天最多几轮',
              desc: '0 = 不限。建议 6（配合 60 分钟间隔 ≈ 每小时 1 轮）',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 24,
              value: runsPerDay ?? '',
              onChange: (e) => setRunsPerDay(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(runsPerDay) || 0, 24)); setRunsPerDay(String(n)); patch({ autoRunsPerDay: n }, '每天最多几轮') },
            })),
            h(Row, {
              label: '两轮间隔',
              desc: '分钟。默认 60 ⇒ 每小时最多 1 轮',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 15, max: 240,
              value: gapMin ?? '',
              onChange: (e) => setGapMin(e.target.value),
              onBlur: () => { const n = Math.max(15, Math.min(Number(gapMin) || 60, 240)); setGapMin(String(n)); patch({ autoGapMinutes: n }, '两轮间隔') },
            }))) : null),

        h(Divider),

        h(Card, { title: '每轮与每天上限' },
          h(Row, {
            label: '每轮最多挑几条',
            desc: '一轮里最多挑中几个视频（0 = 只跑不挑）',
          }, h('input', {
            'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 20,
            value: pickPerRound ?? '',
            onChange: (e) => setPickPerRound(e.target.value),
            onBlur: () => { const n = Math.max(0, Math.min(Number(pickPerRound) || 0, 20)); setPickPerRound(String(n)); patch({ perRoundMax: n }, '每轮最多挑几条') },
          })),
          h(Row, {
            label: '每天最多挑几条',
            desc: '全天上限。默认 18 = 6 轮 × 3 条，调到上限 120 会提示风险',
          }, h('input', {
            'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 120,
            value: pickPerDay ?? '',
            onChange: (e) => setPickPerDay(e.target.value),
            onBlur: () => { const n = Math.max(0, Math.min(Number(pickPerDay) || 0, 120)); setPickPerDay(String(n)); patch({ perDayMax: n }, '每天最多挑几条') },
          })),
          h(Row, {
            label: '每天最多转写几次',
            desc: '熔断：超过就只挑有字幕的视频，不再走本地转写',
          }, h('input', {
            'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 50,
            value: transCap ?? '',
            onChange: (e) => setTransCap(e.target.value),
            onBlur: () => { const n = Math.max(0, Math.min(Number(transCap) || 0, 50)); setTransCap(String(n)); patch({ transcribePerDay: n }, '每天最多转写几次') },
          })),
          h('div', { 'data-bd-row-desc': '' },
            `今天已转写 ${st.asrUsedToday ?? 0} 次${Number(transCap) > 0 ? ' / 上限 ' + transCap : ''} · 今天跑了 ${st.roundsToday ?? 0} 轮`)),

        h(Divider),

        h(Card, { title: '内容筛选' },
          h(Row, {
            label: '只看多长的视频',
            desc: '分钟。0 = 该端不限。长视频转写很慢，建议设上限',
          }, h('div', { 'data-bd-inline': '' },
            h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 600,
              value: minDur ?? '', placeholder: '最短',
              onChange: (e) => setMinDur(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(minDur) || 0, 600)); setMinDur(String(n)); patch({ minDurationMin: n }, '最短时长') },
            }),
            h('span', { 'data-bd-inline-sep': '' }, '~'),
            h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 600,
              value: maxDur ?? '', placeholder: '最长',
              onChange: (e) => setMaxDur(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(maxDur) || 0, 600)); setMaxDur(String(n)); patch({ maxDurationMin: n }, '最长时长') },
            }))),
          h(SwitchRow, {
            label: '字幕优先',
            desc: '先从候选里挑有字幕的（省掉转写时间）；查完还没有就转写优先级最高的那条',
            on: Boolean(preferSub),
            onChange: (v) => { setPreferSub(v); patch({ preferSubtitle: v }, '字幕优先') },
          }),
          Boolean(preferSub) ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '最多查几条字幕',
              desc: '查完这么多还没有字幕，就直接转写优先级最高的那条',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 10,
              value: probeMax ?? '',
              onChange: (e) => setProbeMax(e.target.value),
              onBlur: () => { const n = Math.max(1, Math.min(Number(probeMax) || 3, 10)); setProbeMax(String(n)); patch({ subtitleProbeMax: n }, '最多查几条字幕') },
            }))) : null),

        h(Divider),

        h(Card, { title: '峰谷时段（可选）' },
          h(SwitchRow, {
            label: '只在谷时跑',
            desc: '开启后自动轮只排在谷时窗口内。用免费模型时通常不需要',
            on: Boolean(pvOnly),
            onChange: (v) => { setPvOnly(v); patch({ peakValleyOnly: v }, '只在谷时跑') },
          }),
          Boolean(pvOnly) ? h('div', { 'data-bd-sub': '' },
            ...['noon', 'night'].map((k) => h(SwitchRow, {
              key: k,
              label: win[k].label + (st.windows?.[k]?.opening ? '（当前在窗口内）' : ''),
              desc: `${win[k].start} – ${win[k].end}` + (k === 'noon' ? '（这个窗口只排 1 轮）' : ''),
              on: sw(k),
              onChange: (v) => patch({ [k]: v }, win[k].label),
            }))) : null),

        h(Divider),

        h(Card, { title: '日报' },
          h(Row, {
            label: '日报详细程度',
            desc: '完整版报告更长、更费 token；简要版每条一两行',
          }, h('select', {
            'data-bd-select': '', 'data-bd-w-md': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报详细程度') },
          },
            h('option', { value: 'full' }, '完整'),
            h('option', { value: 'brief' }, '简要'),
            h('option', { value: 'off' }, '不生成')))),

        /* ══ ⑦ 发布与互动 ══════════════════════════════════════════════
       * ⭐ 2026-10-20 合并：原来「自动发布评论」和「回复楼中楼」是两个独立开关，
       *   各带子项 = 4 个控件，但实际只有 3 种有意义的状态。改成三段式。
       *   （后端字段不变：replyToComments 仍然独立存在，只是 UI 把它归进一档） */
        h(Card, {
          title: '发布与互动',
          desc: '发布内容以你的账号身份发出。默认关闭，仅生成报告',
        },
          /* 三段式：关闭 / 只发评论 / 发评论+回楼中楼 */
          h(Row, {
            label: '评论行为',
            desc: `本轮会做：${deliverNow}`,
          }, h('select', {
            'data-bd-select': '', 'data-bd-w-md': '',
            value: !sw('autoComment') ? 'off' : (sw('replyToComments') ? 'reply' : 'comment'),
            onChange: (e) => {
              const v = e.target.value
              if (v === 'off') patch({ autoComment: false, replyToComments: false }, '评论行为')
              else if (v === 'comment') patch({ autoComment: true, replyToComments: false }, '评论行为')
              else patch({ autoComment: true, replyToComments: true }, '评论行为')
            },
          },
            h('option', { value: 'off' }, '关闭 —— 只在报告里给出结论'),
            h('option', { value: 'comment' }, '发评论 —— 在选中的视频下发布一条'),
            h('option', { value: 'reply' }, '发评论 + 回复楼中楼')
          )),

          sw('autoComment') ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '每轮评论上限',
              desc: '设为 0 则本轮不发布评论',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 5,
              value: perRound ?? '',
              onChange: (e) => setPerRound(e.target.value),
              // ⭐ 0 是合法值（= 这一轮不发评论）；UI 上限收紧到 5（个人号不宜批量刷）
              //    后端 clampPatch 仍允许到 20，避免老配置被强改
              onBlur: () => { const n = Math.max(0, Math.min(Number(perRound) || 0, 5)); setPerRound(String(n)); patch({ commentPerRound: n }, '每轮评论上限') },
            })),
            h(Row, {
              label: '在评论里 @ 谁',
              desc: mention
                ? `当前：@${mention}${mentionUid ? '（UID ' + mentionUid + '）' : ''}`
                : '填 B站 UID，点「识别」自动带出昵称。留空则不发布评论',
            }, h('div', { 'data-bd-inline': '' },
              h('input', {
                'data-bd-input': '', 'data-bd-w-sm': '', type: 'number', min: 0,
                value: mentionUid ?? '', placeholder: 'B站 UID',
                onChange: (e) => setMentionUid(e.target.value),
                onBlur: () => {
                  const n = Math.max(0, Number(mentionUid) || 0)
                  setMentionUid(n ? String(n) : '')
                  patch({ mentionUid: n }, '被 @ 的 UID')
                },
              }),
              h('button', {
                'data-bd-btn': '', disabled: Boolean(mentionBusy),
                onClick: onResolveUid,
              }, mentionBusy ? '识别中…' : '识别')),
            )) : null,

          sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '每轮回复上限',
              desc: '仅统计直接回复在本插件评论下的人',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 10,
              value: replyPer ?? '',
              onChange: (e) => setReplyPer(e.target.value),
              onBlur: () => { const n = Math.max(1, Math.min(Number(replyPer) || 1, 10)); setReplyPer(String(n)); patch({ replyPerRound: n }, '每轮回复上限') },
            }))) : null,

          h(Divider),

          /* 私信：跟评论并列的独立开关 */
          h(Row, {
            label: '私信',
            desc: '另外私信给一个人（公开评论由上面的「评论行为」决定）',
          }, h(Switch, {
            on: Boolean(dmOn),
            onChange: (v) => { setDmOn(v); patch({ dmOn: v }, '私信') },
          })),
          dmOn ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '私信收件人 UID',
              desc: dmInfo?.name
                ? `已识别：${dmInfo.name}${dmInfo.level ? '（Lv' + dmInfo.level + '）' : ''}`
                : (dmInfo?.error ? '识别失败：' + dmInfo.error : '填 B站 UID，点「识别」确认发给谁'),
            }, h('div', { 'data-bd-inline': '' },
              h('input', {
                'data-bd-input': '', 'data-bd-w-sm': '', type: 'number', min: 0, value: dmUid ?? '',
                placeholder: 'UID',
                onChange: (e) => { setDmUid(e.target.value); setDmInfo(null) },
                onBlur: () => { const n = Math.max(0, Number(dmUid) || 0); setDmUid(n ? String(n) : ''); patch({ dmUid: n }, '私信收件人 UID') },
              }),
              h('button', {
                'data-bd-btn': '', disabled: dmBusy || !dmUid, onClick: onResolveDmUid,
              }, dmBusy ? '识别中…' : '识别'))),
            h('div', { 'data-bd-row-desc': '' },
              '私信内容为本轮各条的「标题 + 链接 + 一句话理由」，每轮合并为一条（不受 150 字限制）。'),
            h('div', { 'data-bd-row-desc': '' },
              '⚠️ 建议与收件人互相关注：B站 对陌生人私信设有频率限制，且可能不推送提醒。')) : null),
        /* ══ ⑧ 检索与上下文 ════════════════════════════════════════════ */
        h(Card, { title: '检索与上下文', desc: '决定检索范围与采用的设定来源' },
          h(StackRow, {
            label: '检索关键词',
            desc: '每行一个。留空时用内置的这几组：DeepSeek Harness、DSH 插件、dsh 教程、meow-memory、DeepSeek Harness 桌面端',
          }, h('textarea', {
            'data-bd-textarea': '', rows: 4,
            placeholder: '每行一个关键词（留空 = 用内置那 5 组）',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
          })),
          h(StackRow, {
            label: '工作区路径',
            desc: st.workspace
              ? (st.agentsFound
                ? `已读到 ${st.workspace}\\AGENTS.md（这一轮会用它的设定）`
                : `${st.workspace} 里没有 AGENTS.md —— 会按中性口吻输出，点下面「建模板」就能生成一份`)
              : '填一个含 AGENTS.md 的目录，运行时读它的设定；留空 = 不读设定、中性口吻。不知道怎么写？填好路径后点「建模板」',
          }, h('div', { 'data-bd-inline': '' },
            h('input', {
              'data-bd-input': '', 'data-bd-w-full': '', value: ws ?? '',
              placeholder: '例如 C:\\Users\\你\\my-workspace',
              onChange: (e) => setWs(e.target.value),
              onBlur: () => { patch({ workspace: String(ws ?? '').trim() }, '工作区路径') },
            }),
            h('button', {
              'data-bd-btn': '', disabled: busy === 'agents', onClick: onAgentsTemplate,
            }, busy === 'agents' ? '生成中…' : '建模板'))),
          h('div', { 'data-bd-btns': '' },
            h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: Boolean(busy) || saving, onClick: onSaveText },
              saving ? '保存中…' : '保存'),
            msg ? h('div', {
              'data-bd-msg': '', 'data-bd-msg-flex': '',
              'data-good': msgTone === 'good' ? '' : undefined,
              'data-warn': msgTone === 'warn' ? '' : undefined,
            }, msg) : null)),

        /* ══ ⑨ 高级设置（可折叠） ═══════════════════════════════════════ */
        h('div', { 'data-bd-card': '' },
          h('button', {
            'data-bd-fold': '', 'data-open': advOpen ? '' : undefined,
            onClick: () => setAdv(!advOpen),
          },
            h(Chevron),
            '高级设置',
            advOpen ? null : h('span', { 'data-bd-fold-extra': '' }, '运行模型 · 语音转写 · 运行环境 · 数据目录')),

          /* ── 运行模型 ── */
          advOpen ? h('div', { 'data-bd-card-body': '' },
            (() => {
              const list = (models && models.providers) || []
              const cur = list.find((x) => x.id === (dutyProv || '')) || null
              const curModels = cur ? (cur.models || []) : []
              const provOpts = [h('option', { value: '', key: '__default' }, '跟随 headless 默认（推荐）')]
              for (const x of list) {
                provOpts.push(h('option', {
                  key: x.id,
                  value: x.id,
                  disabled: x.usable === false,
                }, x.name + (x.usable === false ? '（该 profile 未安装）' : '')))
              }
              const modelOpts = [h('option', { value: '', key: '__lineDefault' }, '（使用线路默认）')]
              for (const m of curModels) {
                modelOpts.push(h('option', { key: m.id, value: m.id }, m.name !== m.id ? (m.name + ' · ' + m.id) : m.name))
              }
              return h('div', null,
                h(Row, {
                  label: '运行模型线路',
                  desc: (models && !models.profileKnown)
                    ? '未能读取运行 profile 的线路，可用性未知'
                    : '列表来自 DSH 当前注册的线路；运行 profile 中未安装的会标注',
                }, h('select', {
                  'data-bd-select': '', 'data-bd-w-md': '', value: dutyProv ?? '',
                  onChange: (e) => {
                    const v = e.target.value
                    setDutyProv(v)
                    setDutyModel('')
                    patch({ dutyProvider: v, dutyModel: '' }, '运行模型线路')
                  },
                }, provOpts)),
                (dutyProv && curModels.length > 0)
                  ? h(Row, {
                      label: '具体模型',
                      desc: '留空则使用该线路的默认模型',
                    }, h('select', {
                      'data-bd-select': '', 'data-bd-w-md': '', value: dutyModel ?? '',
                      onChange: (e) => {
                        setDutyModel(e.target.value)
                        patch({ dutyModel: e.target.value }, '具体模型')
                      },
                    }, modelOpts))
                  : null,
                (models && models.ok === false)
                  ? h('div', { 'data-bd-row-desc': '' }, '无法读取模型列表：' + (models.error || ''))
                  : null,
                (models && models.profileError)
                  ? h('div', { 'data-bd-row-desc': '' }, '预检提示：' + models.profileError)
                  : null)
            })(),

            /* ── 语音转写 ── */
            h(Divider),
            h(SwitchRow, {
              label: '本地语音转写',
              desc: '对无字幕视频在本机执行 Whisper 转写，不产生 API 费用；需下载数百 MB 模型',
              on: sw('transcribe'),
              onChange: (v) => patch({ transcribe: v }, '本地语音转写'),
            }),
            sw('transcribe') ? h('div', { 'data-bd-sub': '' },
              h('div', { 'data-bd-btns': '' },
                h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                  st.asrReady ? '重装转写依赖' : '安装转写依赖')),
              h('div', { 'data-bd-row-desc': '' },
                !st.asrReady
                  ? '尚未安装 —— 当前开启无效：无字幕视频将被跳过（报告会记录「因无字幕跳过 N 条」）'
                  : (st.asrModelReady ? '环境与模型均已就绪' : '环境已就绪；模型将在首次转写时下载（数百 MB）')),
              h('div', { 'data-bd-row-desc': '' },
                '安装内容：独立环境 + faster-whisper + yt-dlp + Whisper 模型（默认 small，走国内镜像）'),
              h(LogFold, {
                label: st.asrInstalling ? '转写依赖安装进度' : '转写依赖日志',
                desc: st.asrInstalling ? '' : '（末尾 1400 字）',
                text: st.asrTail,
                open: asrLogOpen,
                onToggle: () => setAsrLogOpen((v) => !v),
              })) : null,

            /* ── 运行环境 ── */
            h(Divider),
            h(StackRow, {
              label: '运行环境与账号',
              desc: !st.venvReady
                ? (st.installFailed ? '上次安装失败，请查看下方日志' : '尚未安装，请先安装运行环境')
                : (st.loggedIn ? '环境与账号均已就绪' : '环境已就绪，请继续扫码登录'),
            }, h('div', { 'data-bd-btns': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
                st.venvReady ? '重装主依赖' : '安装主依赖'),
              h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '连通性检测'),
              h('button', { 'data-bd-btn': '', disabled: busy === 'update', onClick: onCheckUpdate }, '检查更新'),
              h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录'),
              (newVer && selfUpgrade) ? h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'upgrade', onClick: onUpgrade }, '升级到 v' + newVer) : null)),
            loginState ? h('div', {
              'data-bd-msg': '', 'data-bd-msg-gap': '',
              'data-good': loginTone === 'good' ? '' : undefined,
              'data-warn': loginTone === 'warn' ? '' : undefined,
            }, loginState) : null,
            login?.qr ? h('div', { 'data-bd-qr': '' },
              h('img', { src: login.qr, alt: 'B站登录二维码' }),
              h('div', { 'data-bd-qr-note': '' },
                '手机 B站 → 我的 → 扫一扫。',
                h('br'),
                '确认时请选择「记住我 / 长期」；选择 24 小时则次日需重新扫码。')) : null,
            h(LogFold, {
              label: st.installing ? '主依赖安装进度' : '主依赖日志',
              desc: st.installing ? '' : '（末尾 1400 字）',
              text: st.installTail,
              open: logOpen,
              onToggle: () => setLogOpen((v) => !v),
            }),

            /* ── 数据目录 ── */
            h(Divider),
            h(StackRow, { label: '数据目录' },
              h('div', { 'data-bd-kv': '' },
                h('b', null, '插件数据目录：'), st.home, h('br'),
                h('b', null, '今日报告：'), st.report),
              h('div', { 'data-bd-btns': '' },
                h('button', { 'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport },
                  report !== null ? '收起报告' : '查看今日报告'),
                h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告目录'),
                h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开数据目录'),
                h('button', { 'data-bd-btn': '', disabled: busy === 'verify', onClick: onVerify }, '复核评论'),
                h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')))) : null),

        /* ══ 页脚：作者 ═════════════════════════════════════════════════ */
        /* 只放事实：谁做的、去哪找他。不放推广、不放诱导、不放联系方式以外的任何东西。 */
        h('div', { 'data-bd-foot': '' },
          'B站鱼塘',
          h('span', { 'data-bd-foot-sep': '' }, '·'),
          '作者 ',
          h('a', {
            href: 'https://space.bilibili.com/14430149',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '在 B站 打开「变量探索SEQVEC」的主页',
          }, '@变量探索SEQVEC'),
          h('span', { 'data-bd-foot-sep': '' }, '·'),
          h('a', {
            href: 'https://github.com/YOYOLnFu/dsh-bili-pond',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '项目仓库（MIT）',
          }, 'GitHub')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-pond')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-pond: 设置页样式')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-meme 的写法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-pond', order: 30, label: 'B站鱼塘' },
          () => h(Panel),
        ))
      },
    }
  },
})
