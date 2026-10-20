/**
 * dsh-bili-pond —— host 半端
 * ============================================================================
 * 它是什么：每天替你刷一轮 B站 的插件版。
 *   1. **插件内部起那份 Python MCP**（`vendor/bilibili-mcp/mcp_server.py`），把它的能力
 *      注册成 dsh 工具（搜 / 字幕 / 评论 / 发评论 @ 人 / 登录检查）—— 用户不用再手改 profile。
 *   2. **谷时定时器**：中午 12:00–14:00、夜间 00:30–08:30（`lib/state.mjs` 里的 `WINDOWS`），
 *      开了哪个窗口才在哪个窗口自动跑；「定量刷」的数字是**每天总量上限**。
 *   3. **跑一轮** = 起一个 `dsh --profile headless <prompt>`（跟老方案同一条路，已被验证过），
 *      把 `duty.md` 交给它，报告写进 `<家>/out/<日期>.md`。
 *   4. **设置页**（`client.js`）通过 `/api/bili-pond/*` 读写配置、看状态、扫码登录。
 *
 * 家里（`$DSH_HOME/bili-duty/`）都有什么：`config.json` / `mcp_server.py`（从 vendor 铺过来，
 * 这样凭证 `bili_credential.json` 落在家里而不是插件包里）/ `duty.md` / `out/` / `duty.log`。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因（2026-10-16 用户递来的完整报告 + 本机复现）：它们是 optional peer，
//    桌面版 profile 是 `autoInstallPeers: false` ⇒ 永远不装 ⇒ **裸 import 会让整条插件不激活** ✗。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { verifyRecent, appendVerifyToReport } from './lib/verify.mjs'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey } from './lib/state.mjs'
import { loginStart, loginPoll, saveCredential, renderQrPng } from './lib/login.mjs'
import { ensureUv } from './lib/uvfetch.mjs'

export const name = 'bili-pond'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。另外两个条件是：
 *    **loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `bili-pond`）+ **本模块导出 Config**。
 */
// ⚠️ schemastery 彻底拿不到时，这里会是 undefined —— **插件照常加载**，只是设置页降级
//    （宁可少一个设置页，也不能因为一个 import 让整条插件不激活 ✗）
export const Config = !z ? undefined : z.object({
  /* ─────────────────────────────────────────────────────────────
   * ⭐ 2026-10-20 自动运行重构
   *   旧模型：peakValley 是总开关，只有峰谷窗口内才跑（绑死 DeepSeek 官方 API 的峰谷计费）。
   *   新模型：自动运行是主开关；峰谷只是「可选的时间限制」。
   *     autoRun        总开关
   *     autoRunsPerDay 每天最多跑几轮
   *     autoGapMinutes 两轮之间至少隔几分钟（默认 60 ⇒ 每小时最多 1 轮）
   *     peakValleyOnly 只在谷时时段内跑（可选）
   *     noon / night   谷时段开关（仅 peakValleyOnly 时有意义）
   *   ⚠️ 所有范围一律由 clampPatch 在读写两头钳，schema 里不写 .max() ——
   *     schema 校验不过会让整条插件不激活（老坑）。
   * ───────────────────────────────────────────────────────────── */
  /** 自动运行（总开关） */
  autoRun: z.boolean().default(false).extra('volatile', true),
  /** 每天最多跑几轮 */
  autoRunsPerDay: z.natural().default(6).extra('volatile', true),
  /** 两轮之间至少隔几分钟 */
  autoGapMinutes: z.natural().default(60).extra('volatile', true),
  /** 只在谷时时段内自动跑（可选；关掉 = 24 小时均分） */
  peakValleyOnly: z.boolean().default(false).extra('volatile', true),
  /** 谷时子开关：中午 / 夜间（仅 peakValleyOnly 开启时有意义） */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /** 每轮最多挑几条 */
  perRoundMax: z.natural().default(3).extra('volatile', true),
  /** 每天最多挑几条（上限 120，超过会警示）
   *  ⚠️ 默认值必须 ≥ autoRunsPerDay × perRoundMax（6 × 3 = 18），
   *     否则 perDayMax 会先触发，"每天几轮"就成了空头支票。 */
  perDayMax: z.natural().default(18).extra('volatile', true),
  /** 每日转写次数上限（熔断，防止机器一直满负荷） */
  transcribePerDay: z.natural().default(10).extra('volatile', true),
  /** 只看多长的视频（分钟）。minDurationMin=0 表示不限下限；maxDurationMin=0 表示不限上限 */
  minDurationMin: z.natural().default(0).extra('volatile', true),
  maxDurationMin: z.natural().default(60).extra('volatile', true),
  /** 字幕优先：先从候选里挑有字幕的（最多查 N 条），省掉转写时间 */
  preferSubtitle: z.boolean().default(true).extra('volatile', true),
  /** 字幕优先时最多查几条字幕 */
  subtitleProbeMax: z.natural().default(3).extra('volatile', true),
  /** 自动评论 @ 使用者（默认关 —— 会拿用户的号说话，必须他自己开） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 私信投递：off=只发评论（现状）· only=只私信（完全不公开评论）· both=评论 + 私信 */
  dmMode: z.string().default('off').extra('volatile', true),
  /** ⭐ 私信发给谁的 UID（数字）。要在 dmMode 不是 off 时填 */
  dmUid: z.natural().default(0).extra('volatile', true),
  /** 本地转写（没字幕的视频用 Whisper 转；默认关，要下模型） */
  transcribe: z.boolean().default(false).extra('volatile', true),
  /** 本地转写用哪个 Whisper 模型（tiny / base / small / medium） */
  asrModel: z.string().default('small').extra('volatile', true),
  /** ⭐ 每轮最多发几条评论（每条里 @ 一次下面那个人）；**有效范围 0–20，口径见 clampPatch**（0 = 不发评论）
   *  ⚠️ 这里故意**不加 `.max(20)`**：schema 校验不过 ⇒ cordis 拒收这条 entry ⇒ **整条插件不激活** ✗
   *     （跟 schemastery 拿不到时的降级同一个道理）—— 范围一律由 clampPatch 在**写**和**读**两头钳。 */
  commentPerRound: z.natural().default(1).extra('volatile', true),
  /** ⭐ 要 @ 谁（B站 昵称）。由 UID 解析后自动填；手填也行。
   *  **留空 = 不发评论** —— 评论存在的意义就是 @ 那一下 */
  mentionName: z.string().default('').extra('volatile', true),
  /** ⭐ 要 @ 谁的 UID（数字）。填了这个就自动解析出昵称写进 mentionName。
   *  UI 上填 UID，实际发评论用昵称 @（B站 评论只认昵称文本）。 */
  mentionUid: z.natural().default(0).extra('volatile', true),
  /** 关注关键词（空了用章程里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** Python：指向 venv 里的那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就试自动探测，再退化成 shell 里的 dsh） */
  dshBin: z.string().default('').extra('volatile', true),
  /** headless 那一轮用哪个 profile */
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch（把 B站 MCP 挂上）—— 用户 profile 一个字都不用改 */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  /** 跑 headless 时的工作目录 */
  workspace: z.string().default('').extra('volatile', true),
  /** 日报形态：full=完整（现状）· brief=每条一两行 · off=不写报告（只发评论） */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** 回复评论：默认关。开了之后只回「直接回复到它那条评论下面的人」 */
  replyToComments: z.boolean().default(false).extra('volatile', true),
  /** 每轮最多回几条 */
  replyPerRound: z.number().default(1).extra('volatile', true),
  /** 值班那一轮用哪条模型线路（provider）。留空 = 跟随 headless profile 自己的默认模型 */
  dutyProvider: z.string().default('').extra('volatile', true),
  /** 值班那一轮用哪个模型（配合 dutyProvider）。留空 = 该线路的默认模型 */
  dutyModel: z.string().default('').extra('volatile', true),
})

/**
 * ⭐ 给所有 Python 子进程统一 UTF-8。
 * 起因（2026-10-16，用户在评论区反馈）：Windows 上 Python 默认按 GBK 编解码，
 * 我们的脚本 / 内置 MCP 都会往管道里打中文与 emoji（`✅`、`—` 之类），一进管道就可能
 * 报 UnicodeDecodeError / 乱码或直接中断。**编码这种环境差异，插件该自己钉死，不该让用户碰。**
 */
const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  // ⭐ 自己的版本号（从 package.json 读，设置页要显示它）
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }
  const stateDir = stateDirOf(ctx)

  // ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在
  //    （2026-10-15：只看目录，害一位真实用户"显示就绪但其实装失败"白折腾 ✗）
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  // ⚠️ 2026-10-18 用户实测：徽章显示「环境已就绪」、B站也登录了，可一跑就 `ModuleNotFoundError: No module named 'mcp'`
  //    ⇒ 原判据**只查了 bilibili_api**（0.1.2 修"假就绪"时留下的口子）⇒ 缺 `mcp` / `qrcode` 也照样说就绪 ✗
  //    ⇒ 三个都得有：bilibili_api（查数据）· mcp（跑那一轮的 MCP 服务器）· qrcode（画登录二维码）
  const VENV_DEPS = ['bilibili_api', 'mcp', 'qrcode']
  const missingVenvDeps = () => VENV_DEPS.filter((n) => !hasPkg(join(stateDir, '.venv'), n))
  const venvReadyNow = () => existsSync(venvPython()) && missingVenvDeps().length === 0
  const asrReadyNow = () => existsSync(asrPython()) && hasPkg(asrDir, 'faster_whisper')
  const cfgFile = join(stateDir, 'config.json')
  /**
   * 本地优先（2026-10-18，两个用户实证）：DSH 0.2.1 某些启动方式下 ctx.settings.update 会抛
   *   profile reload requires the root Include entry（dsh-app-boot 的 reconcileProfilePatches）
   *   ⇒ 写不进宿主 ⇒ 而 loadCfg 的规则是"宿主有值就以宿主为准" ⇒ 用户刚点的开关几秒后被压回原状，
   *   表现成"开一个，另一个像被关掉"（其实是每个开关都在自己亮一下就被复位）。
   * ⇒ 记一份"本地刚存、宿主没同步成功"的键，loadCfg 时这些键以本地为准；宿主同步成功就把它们删掉。
   */
  const overrideFile = join(stateDir, 'local-override.json')
  const readOverride = () => {
    try { const j = readJson(overrideFile, {}); return j && typeof j === 'object' ? j : {} } catch { return {} }
  }
  const markOverride = (keys, on) => {
    try {
      const cur = readOverride()
      for (const k of keys) { if (on) cur[k] = Date.now(); else delete cur[k] }
      writeFileSync(overrideFile, JSON.stringify(cur, null, 2), 'utf8')
    } catch (e) { log('记 local-override 失败：' + (e && e.message ? e.message : e)) }
  }
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  mkdirSync(outDir, { recursive: true })

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[bili-pond] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  // 宿主依赖是从哪儿取的（桌面版那次事故的排查看这里：duty.log 里会写明白）
  for (const n of hostDeps.notes) log(n)

  /**
   * ⚠️ 2026-10-14 事故（第一次挂上就炸了整个 DSH，见当天的 lesson）：
   *   `apply(ctx, config)` 传进来的那个 `config`，字段值**不保证是标量** —— 我们的 `config.pythonPath`
   *   是个**对象**、`config.keywords` 也不是数组（日志里打成 `[object Object]`）。对象是"真值"，
   *   于是 `if (!cfg.peakValley) return` 这类守卫全部失效，一路走到 `cfg.keywords.filter(...)`
   *   抛 TypeError —— 而那是在**定时器回调**里，没人接 ⇒ **整个 dsh 进程被带走** ✗✗。
   *   ⇒ 两条规矩：
   *     ① 逐字段按默认值的类型挑一遍（拿不准就用默认值），再叠自己的 `config.json`；
   *     ② **定时器回调里绝不让异常外冒**（见 tick）—— 未捕获异常会杀掉整个宿主进程。
   */
  const DEFAULTS = {
    /* perDay / peakValley 是**老字段**，保留只为迁移：
     *   老配置里 perDay>0 ⇒ 视为「每天最多挑 perDay 条」
     *   老配置里 peakValley=true ⇒ 视为「自动开 + 只在谷时跑」
     * 新代码只写 perRoundMax / perDayMax / autoRun / peakValleyOnly。 */
    perDay: 5, peakValley: false,
    autoRun: false, autoRunsPerDay: 6, autoGapMinutes: 60, peakValleyOnly: false,
    perRoundMax: 3, perDayMax: 18, transcribePerDay: 10,
    minDurationMin: 0, maxDurationMin: 60, preferSubtitle: true, subtitleProbeMax: 3,
    noon: true, night: true, autoComment: false, transcribe: false, asrModel: 'small',
    dmMode: 'off', dmUid: 0,
    keywords: [], commentPerRound: 1, mentionName: '', mentionUid: 0, pythonPath: 'python', dshBin: '', headlessProfile: 'headless', dutyProvider: '', dutyModel: '', overlayMcp: true, workspace: '', reportLevel: 'full', replyToComments: false, replyPerRound: 1,
  }
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }
  /* ── 配置从哪来：DSH 自带的「插件设置」页 > 插件自己的 config.json > 默认值 ──
   * 老代码是 `normalize(readJson(cfgFile, {}), normalize(config, DEFAULTS))` —— config.json 一刀切盖住宿主，
   * 后果：用户在 DSH 自带的插件设置页里改了值，插件照旧读 config.json 的旧值 ⇒ **静默不生效** ✗。
   * 判据用 describe() 给的 `user` 层（= 用户在原生设置页**显式设过**的键）：
   *   设过的键 ⇒ 听宿主的；没设过 ⇒ 还是 config.json 说了算（老用户零回归 ✓）。
   * 拿不到设置服务就完全退回老行为。
   */
  /* ⭐ 「设置里能写什么范围」收在一处 —— HTTP 接口、bili_config 工具、**读配置**三处都走它，
   *    所以 perDay 0–50 / commentPerRound 0–20 这些数字**只有这一份**（schema 里不再写一遍）。
   *    （2026-10-16 审查修：原来只有 HTTP 路径钳制，工具路径连 perDay 都能写任意值；
   *      commentPerRound 两条路径都没钳，直接 POST 能写 9999）
   *    （2026-10-17 复查补：DSH 原生设置页那条路我们钳不到**写** —— 用户能在那儿直接填 9999 ⇒
   *      loadCfg 读回来也过一遍，写进去和读出来一个口径） */
  /* ⭐ 所有数值范围都收在这里：HTTP 写、工具写、读回来三道口子共用一份口径 */
  const clampPatch = (patch) => {
    const p = { ...patch }
    const num = (k, lo, hi, dflt) => { if (k in p) p[k] = Math.max(lo, Math.min(Number(p[k]) || dflt, hi)) }
    // 老的 perDay：保留钳制（迁移用），但新 UI 不再写它
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 120))
    if ('reportLevel' in p) p.reportLevel = ['full', 'brief', 'off'].includes(String(p.reportLevel)) ? String(p.reportLevel) : 'full'
    if ('replyToComments' in p) p.replyToComments = Boolean(p.replyToComments)
    num('replyPerRound', 1, 10, 1)
    num('commentPerRound', 0, 20, 0)

    /* ── 2026-10-20 自动运行 / 配额 / 熔断 ── */
    num('autoRunsPerDay', 0, 24, 6)          // 一天最多 24 轮（每小时 1 轮）
    num('autoGapMinutes', 15, 240, 60)       // 两轮最少隔 15 分钟
    num('perRoundMax', 0, 20, 3)             // 每轮最多挑几条
    num('perDayMax', 0, 120, 18)             // 每天最多挑几条（上限 120 = 理论极限）
    num('transcribePerDay', 0, 50, 10)       // 每日转写熔断

    /* ── 时长过滤：分钟。两个都 0 = 不限；min > max 时自动对调 ── */
    num('minDurationMin', 0, 600, 0)
    num('maxDurationMin', 0, 600, 60)
    if (('minDurationMin' in p || 'maxDurationMin' in p)) {
      // 只有在「两个都有意义」时才纠正顺序（任一为 0 表示该端不限）
      const lo = Number(p.minDurationMin ?? 0) || 0
      const hi = Number(p.maxDurationMin ?? 0) || 0
      if (lo > 0 && hi > 0 && lo > hi) { p.minDurationMin = hi; p.maxDurationMin = lo }
    }
    num('subtitleProbeMax', 1, 10, 3)
    if ('preferSubtitle' in p) p.preferSubtitle = Boolean(p.preferSubtitle)
    if ('autoRun' in p) p.autoRun = Boolean(p.autoRun)
    if ('peakValleyOnly' in p) p.peakValleyOnly = Boolean(p.peakValleyOnly)
    return p
  }

  const hostCfg = () => normalize(config, { ...DEFAULTS })       // 宿主那份（schema 校验过、默认值已填）
  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })
  const CFG_SIG = ['perDay', 'mentionName', 'replyToComments', 'overlayMcp']   // 靠这几个键认出"哪一行是我们"
  let settingsRow = { at: 0, row: null }
  /**
   * 我们那一行设置表单（拿不到就返回 null ⇒ 一切按 config.json 来）。
   * ⚠️ DSH 自带的「插件设置」页**不需要注册** —— 老代码那句 `ctx.settings.register(...)` 是个不存在的方法，
   *    每次都抛 TypeError、被 catch 吞掉（2026-10-17 读宿主源码 @deepseek-ai/dsh-settings 才明白）：
   *    describe() 自己扫 profile 里**带 volatile 字段**的条目列出来（lib/index.js:413-452），
   *    命名空间 ns **等于 loader 条目的 id**（我们 cordis.patch.yml 里是 `bili-pond`，不是老注释写的 bili-duty）。
   * 另外两条同样要紧（都是读宿主源码得来的，别再想当然）：
   *    ① `apply(ctx, config)` 收到的 config 就是 fiber.config 本体，volatile 字段一改宿主**就地**改它
   *       （cordis-plugin-loader/src/config/entry.ts：`this.fiber._config = …` + `_commitVolatile()`）⇒
   *       启动时快照的 cfg 永远看不到设置页的改动，用之前得 refreshCfg()。
   *    ② describe() 每行给三层：value（生效值）/ base（继承层）/ user（用户在设置页显式设过的那层）。
   */
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row   // 挡 UI 轮询：describe() 要扫所有条目
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }
  /**
   * ⭐ 老配置迁移（2026-10-20）：把 perDay / peakValley 那套老语义映射到新字段。
   *    **只在读的时候迁移，不写回文件**（避免每次读都改盘，也避免和 DSH 层的旧值打架）。
   *    判据：新字段仍是默认值 ⇒ 认为用户没动过 ⇒ 才吃老值。
   *      · 老 perDay > 0 且新 perDayMax 还是默认 10 ⇒ 用 perDay 当 perDayMax
   *      · 老 peakValley = true 且新 autoRun = false ⇒ 自动开 + 只在谷时跑
   */
  const migrateCfg = (c, savedRaw) => {
    const out = { ...c }
    /* ⚠️ 关键：判据要看**磁盘上那份 config.json 里有没有这个键**，
     *    不能看合并后的值 —— DEFAULTS 里 perDay:5 / peakValley:false 会让
     *    每个新用户都被当成"老配置"，把 perDayMax 从 18 压成 5。
     *    行为：只有「文件里明确写了 perDay」才迁移。 */
    const raw = savedRaw || {}
    const hasLegacyPerDay = Object.prototype.hasOwnProperty.call(raw, 'perDay')
    const hasLegacyPv = Object.prototype.hasOwnProperty.call(raw, 'peakValley')
    if (hasLegacyPerDay) {
      const legacyPerDay = Number(raw.perDay) || 0
      if (legacyPerDay > 0 && !Object.prototype.hasOwnProperty.call(raw, 'perDayMax')) {
        out.perDayMax = Math.min(legacyPerDay, 120)
      }
    }
    // peakValley：只有文件里显式 true、且文件里没有 autoRun 才迁移
    if (hasLegacyPv && raw.peakValley === true && !Object.prototype.hasOwnProperty.call(raw, 'autoRun')) {
      out.autoRun = true
      out.peakValleyOnly = true
    }
    return out
  }

  const loadCfg = () => {
    const saved = savedCfg()
    // ⭐ 迁移判据要用**原始文件**（savedCfg 已经 normalize 过，每个键都有值，
    //    hasOwnProperty 永远 true ⇒ 迁移永远不会触发）
    const savedRaw = readJson(cfgFile, {})
    const row = settingsDesc()
    // ⭐ 读回来统一过一遍范围：原生设置页那边我们是钳不到写的（见 clampPatch 的注释）
    if (!row) return clampPatch(migrateCfg(saved, savedRaw))
    const user = row.user || {}
    const out = { ...hostCfg() }
    // ⚠️ 2026-10-18（用户实证 + 他的 dsh 定位）：`pythonPath` 是**装依赖时自动写的**，
    //    但它一旦在 DSH 原生设置里有过值（默认 "python"），就会被宿主覆盖回来 ⇒
    //    「重装依赖」日志写着"已把 pythonPath 设为 venv"，实际生效的还是系统那个空壳 python
    //    ⇒ 画二维码 import 不到 qrcode ⇒ **永远不出码** ✗
    //    ⇒ 这个键不让宿主对账（它由插件自己算出来，不该被界面上的旧值压住）
    const HOST_WINS_EXCLUDED = new Set(['pythonPath'])
    const ov = readOverride()   // 本地刚存、宿主没同步成功的键 ⇒ 以本地为准
    for (const k of Object.keys(DEFAULTS)) {
      if (HOST_WINS_EXCLUDED.has(k)) { out[k] = saved[k]; continue }
      if (ov[k] !== undefined) { out[k] = saved[k]; continue }
      if (user[k] === undefined) out[k] = saved[k]
    }
    return clampPatch(migrateCfg(out, savedRaw))
  }
  const cfg = loadCfg()
  // ⭐ 配置是"随时可能被设置页就地改掉"的东西 ⇒ 每个入口用之前重算一遍（cfg 这个对象要一直指向同一份）
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }
  const saveCfg = (patch) => { Object.assign(cfg, normalize(patch, cfg)); writeJson(cfgFile, cfg) }
  /**
   * ⭐ 同时写一份到宿主：不写的话会出现死结 —— 某个键一旦在原生设置页设过就由宿主说了算，
   *    插件页再改那个键就成了"改了没反应" ✗。写失败不算致命（config.json 那份还在），把话带回给用户。
   */
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await ctx.settings.update(row.ns, patch, row.revision)
      return row.ns
    }
    try { return { ok: true, ns: await attempt(false) } }
    catch (e) {
      // revision 过期（刚有别人改过）⇒ 重取一次再写。**只有真的抛错才算失败。**
      if (!e?.noForm) {
        try { return { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 }
      }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /**
   * ⭐ 关于「写 DSH 设置后回读校验」（2026-10-20 分家时去掉）
   *
   *   原实现在 update() 成功后调 settingsDesc(true) 回读 user 层，比对不上就判失败、
   *   记进 local-override.json，界面上显示「有 N 项未能同步到 DSH 原生设置」。
   *
   *   实测这是**误报**：
   *     · ctx.settings.update() 写的是 profile patch 文件（值确实落盘了，文件里查得到）；
   *     · 但 describe() 读的是 loader **内存里**的 entry.options.config，
   *       内存要等下一次 config reload 才刷新；
   *     · 于是紧接着回读拿到的是旧值 ⇒ 判定「没写进去」⇒ 10 个键全被记成 override。
   *
   *   危害：那条提示常驻不下，还会把**真正的**同步失败淹掉（override 里全是假阳性）。
   *   现在：写成功就信成功；只在 update() 真抛错时才算失败。
   *   真被压回去也有另一道保险 —— loadCfg 是「本地优先」，即使宿主层没生效，
   *   插件仍按自己的 config.json 跑，行为是对的。
   */
  /**
   * ⭐ 落配置的**唯一入口**：插件自己那份 config.json + DSH 原生设置页那份，钳完范围一起写。
   *    （2026-10-17 复查修：`saveCfg` + `await saveCfgHost` 这对义务原来在三个调用点各抄一遍 ——
   *      漏掉任何一处，正好就是「设置页改了没反应」那个 bug 本身 ⇒ 收成一个函数。）
   */
  /**
   * ⭐ 关于「写 DSH 设置后回读校验」（2026-10-20 分家时去掉）
   *
   *   原实现在 update() 成功后调 settingsDesc(true) 回读 user 层，比对不上就判失败、
   *   记进 local-override.json，界面上显示"有 N 项未能同步到 DSH 原生设置"。
   *
   *   实测这是**误报**：
   *     · ctx.settings.update() 写的是 profile patch 文件（值确实落盘了 —— 文件里查得到）；
   *     · 但 describe() 读的是 loader **内存里**的 entry.options.config，
   *       内存要等下一次 config reload 才刷新；
   *     · 于是紧接着回读拿到的是旧值 ⇒ 判定"没写进去" ⇒ 10 个键全被记成 override。
   *
   *   危害：那条提示常驻不下，而且会把**真正的**同步失败淹掉（override 里全是假阳性）。
   *
   *   现在：写成功就信成功；只在 update() 真的抛错时才算失败。
   *   真被压回去的情况有另一道保险 —— loadCfg 本身是「本地优先」（persistCfg 里 markOverride），
   *   所以即使宿主层没生效，插件也按自己的 config.json 跑，行为是对的。
   */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    const host = await saveCfgHost(clean)
    // 宿主写成功 ⇒ 恢复对账；失败 ⇒ 记成"本地优先"，别让界面把它们压回去
    // ⭐ 无条件本地优先（2026-10-18 第二次修）：
    //   三四位用户装了 0.1.9、界面没有"没同步"提示、开关照样弹回
    //   ⇒ 往 DSH 写这一步既没报错、回读也看不出差别，但**生效值仍是旧的**
    //   （多半是 profile 层压过了 user 层）✗
    //   ⇒ 不再指望 DSH 那边：只要是从**插件面板**保存的键，读配置时一律以插件自己那份为准 ✓
    //   ⚠️ 代价：同名的项若在 DSH 原生设置页改，以插件面板为准（我们的设置页才是"正式的家"）。
    markOverride(Object.keys(clean), true)
    if (!host.ok) log('⚠️ 这几项没能同步到 DSH 原生设置，改为以插件自己的值为准：' + Object.keys(clean).join(', ') + '（' + host.error + '）')
    return { clean, host }
  }

  ensureHomeFiles(pluginDir, stateDir, log)

  // ⭐ 值班章程单独记账（跟 mcp_server.py 不一样：用户改过就得留着 —— 见 state.mjs 的 ensureCharter）
  ensureCharter(pluginDir, stateDir, log)

  /* ─────────────── MCP（内部起那个 Python MCP） ─────────────── */

  let mcp = null
  let mcpKey = ''
  const mcpKeyNow = () => `${cfg.pythonPath}|${join(stateDir, 'mcp_server.py')}`

  const ensureMcp = async () => {
    if (mcp?.running && mcpKey === mcpKeyNow()) return mcp
    if (mcp) { mcp.stop(); mcp = null }
    const script = join(stateDir, 'mcp_server.py')
    if (!existsSync(script)) throw new Error(`家里没有 mcp_server.py（应有 ${script}）—— 装上插件后重启一次 dsh 会自动铺好`)
    mcpKey = mcpKeyNow()
    mcp = new McpClient({
      command: cfg.pythonPath || 'python',
      args: [script],
      cwd: stateDir,                     // 凭证落在家里 ✓
      // ⭐ 这个内置的 Python MCP 会往 stdout 打中文（ensure_ascii=False）；
      //    Windows 默认 GBK 的话，中文/emoji 一进管道就可能炸 ⇒ 钉死 UTF-8
      env: pyEnv(),
      log,
    })
    return mcp
  }

  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }

  const hasCredential = () => existsSync(join(stateDir, 'bili_credential.json'))

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /**
   * 工具返回值一律过一遍这里：**宿主只吃"无损 JSON"**，塞进去任何函数/循环引用/类实例都会报
   * `value is not lossless JSON`（2026-10-14 第一次挂上就撞了一次）。
   */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「刷B站」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!hasCredential()) {
        return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「刷B站」里点「扫码登录」（凭证会存在插件自己的家目录里）' }
      }
      const r = await call('bili_check_credential', {})
      return { ok: true, ...(typeof r === 'object' ? r : { raw: r }) }
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。\n'
      + '⚠️ 刷一轮的用法：搜近 7 天的、按播放或最新都行，然后**读字幕原文**再判断（别看摘要下结论）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      return call('bili_search', {
        keyword: String(args.keyword ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        order: String(args.order || 'totalrank'),
      })
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。**判断内容就靠它** —— 没有字幕时，'
      + '若设置里开了「本地转写」再想别的办法，否则直接跳过这条。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) { return call('bili_subtitle', { bvid: String(args.bvid ?? '') }) },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。刷一轮时顺手翻一眼，看值不值得占用使用者一次注意力。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      return call('bili_comments', { bvid: String(args.bvid ?? ''), num: Math.max(1, Number(args.num) || 30) })
    },
  })

  tool({
    name: 'bili_reply',
    description: '在视频下发评论（或回复某条评论）。这就是"@ 本人"那一下：短、干净、纯文本 @ 写在正文里。\n'
      + '🔴 安全闸：设置页的「自动评论并 @ 你」**默认是关的**；关着的时候这个工具会拒绝 —— '
      + '除非本人当场让你发（那时传 force: true）。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本 @；别写敏感词）' },
      rpid: { type: 'number', description: '要回复的评论 id（0/不填 = 发新评论）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过"自动评论关着"的闸' },
    },
    async execute(args) {
      // dmMode==='only' 时本轮根本不该发公开评论 —— 在工具层也一并挡掉（除非当场 force）
      const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only')
      if (!commentOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: cfg.dmMode === 'only'
            ? '现在是「只私信」模式（dmMode=only）—— 规定不发公开评论，改成用 bili_send_message 私信。确实要发时传 force: true。'
            : '要发评论得同时满足两条：设置里开着「自动评论并 @ 你」、并且填了「要 @ 谁」。或者本人当场让你发时传 force: true。',
        }
      }
      return call('bili_reply', {
        bvid: String(args.bvid ?? ''),
        text: String(args.text ?? ''),
        rpid: Number(args.rpid) || 0,
      })
    },
  })

  tool({
    name: 'bili_send_message',
    description: '给**设置里指定的那个人**发私信（只在「投递方式」含私信时才有意义）。'
      + '🔴🔴 硬闸：收件人只能是设置页里的「私信收件人 UID」——'
      + '**绝不发给视频 UP 主、也不发给任何其他人**（传别的 UID 会被拒绝）。'
      + '🔴 dmMode=off 时也会拒绝（除非本人当场让你发，传 force: true）。',
    parameters: {
      receiver_uid: { type: 'number', description: '收件人 UID（数字）' },
      text: { type: 'string', description: '私信正文；B站 私信有 500 字符上限' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过 dmMode=off 的闸' },
    },
    async execute(args) {
      const allowed = Number(cfg.dmUid) || 0
      if (!allowed) {
        return { ok: false, error: '没有收件人 UID（设置页「私信收件人 UID」留空了）' }
      }
      // 🔴🔴 2026-10-20 硬闸：私信**只能**发给设置里指定的那个人。
      //    起因：使用者明确要求「不许给视频 UP 主发私信」。
      //    这里不信任模型传什么 —— 传了别的 UID 一律拒绝，且返回实际允许的那个，
      //    避免模型以为"发错了再试一次"。
      const asked = Number(args.receiver_uid) || allowed
      if (asked !== allowed) {
        return {
          ok: false,
          blocked: true,
          error: '私信只允许发给设置里指定的收件人（UID ' + allowed + '），不能发给其他人。',
          allowedUid: allowed,
        }
      }
      if (cfg.dmMode === 'off' && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: '现在是「仅发布评论」模式（dmMode=off）—— 设置页把「投递方式」改成「仅发送私信」或「评论 + 私信」才能发私信。确实要发时传 force: true。',
        }
      }
      return call('bili_send_message', { receiver_uid: allowed, text: String(args.text ?? '') })
    },
  })

  tool({
    name: 'bili_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、登录过没有、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      refreshCfg()
      const st = readJson(join(stateDir, 'state.json'), {})
      const now = new Date()
      return {
        ok: true,
        today: dayKey(now),
        ranToday: st.day === dayKey(now) ? Number(st.count || 0) : 0,
        pickedToday: countPickedToday(now),
        perDay: cfg.perDay,
        windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, {
          label: w.label, start: w.start, end: w.end,
          switchOn: Boolean(cfg[k]),
          opening: inWindow(now, w),
        }])),
        peakValley: cfg.peakValley,
        autoComment: cfg.autoComment,
        dmMode: cfg.dmMode,
        dmUid: Number(cfg.dmUid) || 0,
        transcribe: cfg.transcribe,
        loggedIn: hasCredential(),
        home: stateDir,
        report: join(outDir, `${dayKey(now)}.md`),
      }
    },
  })

  tool({
    name: 'bili_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。'
      + '适合"我现在就想看一份"的场合。',
    parameters: {},
    async execute() { const r = await runDutySafe('manual'); return { ok: true, ...r } },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（画成 PNG 存在插件家目录里，返回路径）和一个 key。\n'
      + '用法：拿到 PNG 后用 `present` 把它推给本人（手机 B站 → 我的 → 扫一扫），再用 `bili_login_poll` 轮询。\n'
      + '⚠️ 二维码大约 180 秒有效，出码要马上递过去；手机上确认时选「记住我」那种长期登录。',
    parameters: {},
    async execute() {
      const { key, url } = await loginStart()
      const png = await renderQrPng(cfg.pythonPath, stateDir, url)
      return {
        ok: true, key, url, png,
        hint: png ? '用 present 把这张 PNG 推给本人扫；扫完调 bili_login_poll' : '没画出 PNG：先去设置里点「建 venv 装依赖」（venv 里要有 qrcode）',
      }
    },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 还没扫 / scanned 扫了待确认 / ok 成功 / expired 过期。'
      + '成功时会自动把凭证写进插件家目录的 `bili_credential.json`（MCP 认的那四个字段）。',
    parameters: { key: { type: 'string', description: 'bili_login_start 给的那个 key' } },
    async execute(args) {
      const r = await loginPoll(String(args.key ?? ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return { ok: true, state: 'ok', file }
      }
      return { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message }
    },
  })

  tool({
    name: 'bili_setup',
    description: '给刷B站装运行环境：在插件家目录建一个**独立 venv**、装上那个 Python MCP 的依赖，装完自动把 `pythonPath` 指过去。\n'
      + '**第一次用之前跑一次**。⭐ 它**起完就返回、不等装完**（几分钟的活），进度看家目录里的 `install.log`。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'bili_config',
    description: '读 / 改「刷B站」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n'
      + '例：`{"perDay":5,"peakValley":true,"noon":true,"night":true,"autoComment":false,"transcribe":false,"keywords":["DeepSeek Harness"]}`；'
      + '私信投递：`{"dmMode":"only","dmUid":12345678}`（dmMode = off / only / both）。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        // ⭐ 设置页显式设过的键以宿主为准 ⇒ 必须跟着写一份，否则"改了没反应"（钳范围也在这里）
        host = (await persistCfg(args.patch)).host
      }
      return { ok: true, config: cfg, windows: WINDOWS, home: stateDir, venvReady: venvReadyNow(), host }
    },
  })

  /* ─────────────── 跑一轮（跟老方案同一条路：dsh --profile headless <prompt>） ─────────────── */

  const dutyStateFile = join(stateDir, 'state.json')
  const bumpState = (patch) => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day !== today) { st.day = today; st.count = 0; st.picked = 0; st.windows = {} }
    writeJson(dutyStateFile, { ...st, ...patch })
    return st
  }

  /* ⭐ 「定量刷」承诺的是**每天挑几条**（2026-10-16 审查修 H1：原来 st.count 从没自增过，
   *   tick 那道 `count >= perDay` 的闸形同虚设 ⇒ noon + night 两个窗口各跑满一轮，
   *   后一轮还会把前一轮的报告覆盖掉）。
   *   数哪儿？数**今天的报告**里那些 `### BV号` 标题行（章程写死了这个格式）。
   *   ⚠️ 为什么不数「报告里出现的所有 BV」（2026-10-17 复查修的）：报告里还会出现**没挑中**的 BV ——
   *     「因无字幕跳过 N 条」那行、评论区里别人问起的视频、"判重表读不到"的说明 —— 全算进去的话，
   *     perDay 默认 5 ⇒ 一轮里出现 5 个 BV 就把当天额度吃光 ⇒ **傍晚那轮直接不跑** ✗。
   *   ⚠️ 围栏 ``` 里的内容一律不看：那一轮没写报告时 stubReportIfMissing 会把 duty.log 尾部贴进报告，
   *     那里面的 BV 是"看过的"，不是"挑出来的"。
   *   ⚠️ 数不出来（章程那条格式没照做）就当 0 条 —— 宁可少算（顶多多跑一轮、额度也写在提示词里），
   *     也别把"提到过"算成"挑中"（那会让使用者当天再也拿不到内容）✓。 */
  const PICK_RE = /^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm
  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  // 报告是事实来源；state 兜住"报告被删 / 手改"那一下（取两者里大的）
  const countPickedToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0
    return Math.max(fromState, countPicks(reportFileOf(now)))
  }
  const roundsToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  // ⭐ 一键升级：由宿主自己跑 `dsh plugin --profile web add dsh-bili-pond`
  //    ⚠️ 装完必须重启 dsh 才生效；⚠️ Windows 上"替换正在运行的插件"可能被文件占用挡住（我们踩过）
  let upgrading = false
  const runUpgrade = () => {
    if (upgrading) return { ok: true, busy: true, log: installLogFile, hint: '正在升级，别重复点' }
    upgrading = true
    appendInstall('\n=== ' + new Date().toISOString() + ' 开始升级（add dsh-bili-pond）===\n')
    ;(async () => {
      try {
        const dsh = resolveDsh()
        // ⭐ 照抄那一轮的形状：resolveDsh 返回 { command, args, shell }
        //    （写错就退化成裸 'dsh'，而宿主 PATH 里常常没有它 ⇒ 静默失败）
        let cmd = dsh.command || 'dsh'
        let args = [...(dsh.args || []), 'plugin', '--profile', 'web', 'add', 'dsh-bili-pond']
        if (dsh.shell) { args = ['/c', cmd, ...args]; cmd = 'cmd.exe' }
        appendInstall('$ ' + cmd + ' ' + args.join(' ') + '\n')
        const code = await spawnTo(cmd, args, { sink: appendInstall })
        if (code === 0) appendInstall('=== 升级完成 —— 重启一次 dsh 才生效 ===\n')
        else appendInstall('=== 升级没成功（exit ' + code + '）。可以自己手动跑一次：dsh plugin --profile web add dsh-bili-pond ===\n')
      } catch (e) { appendInstall('升级崩了：' + (e?.stack ?? e) + '\n') } finally { upgrading = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在升级 —— 完成后重启一次 dsh 才生效' }
  }

  const resolveDsh = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit], shell: false }
    // 常见的全局安装位置（Windows 的 npm 前缀 / POSIX 的 lib）
    const guesses = [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    // ⭐ 2026-10-16（issue #5 / #6 / #7）：**桌面版是 Electron 安装包，不是 npm -g 装的** ⇒ 上面几条全找不到
    //    ⇒ 老逻辑退到 `dsh`（PATH 里没有这个命令）⇒ 那一轮必败、而且只留下一句 exit 1 ✗
    //    桌面版把 dsh 打在应用里 ⇒ 按 `process.resourcesPath` 猜几个位置（找到就用；找不到就**明说**）
    if (process.resourcesPath) {
      for (const rel of [
        ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) {
        const p = join(process.resourcesPath, ...rel)
        if (existsSync(p)) return { command: process.execPath, args: [p], shell: false }
      }
    }
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    // ⚠️ 走到这儿就是真找不到 —— 一定要出声（静默失败比报错更坏）
    log('⚠️ 找不到 dsh：桌面版多半不是 npm 全局安装的 ⇒ 请在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js，或改用 npm 装的 dsh')
    return { command: 'dsh', args: [], shell: true }
  }

  const promptFor = () => {
    // ⭐ 章程取哪一份：家里那份优先（ensureCharter 保证铺好；他改过的话就是他那份，升级的事由 ensureCharter 记账处理）
    let duty = charterPath(pluginDir, stateDir)
    // ⭐ 2026-10-17（issue #8④）：章程里的 `<家目录>` 这种占位符会被模型读成 `~`，实测**整轮转写白跑** ✗
    //    ⇒ 在拼提示词这一步把**绝对路径**填进去，别让它猜（我们的老规矩：提示词一律给绝对路径）
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 替换失败就按原文用 */ }
    const kws = Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean) : []
    // ⭐ 开场先让它读**工作区**的 AGENTS.md —— 这一轮的工作目录就是使用者的工作区，
    //    AGENTS.md 本来就会自动注入；这里再点一句，保证它真按使用者的设定来（别人的设定同理）。
    // ⭐ 那一轮的工作目录是**插件家**（沙箱只让它写自己工作目录里的东西 ✗），
    //    所以"使用者的设定"由**我们自己读进来**喂给它 —— 它在宿主进程里跑，没有沙箱限制 ✓
    let ownerDoc = ''
    try {
      // ⚠️ 2026-10-16 用户反馈（"只要给人设就会走偏"）：留空时我们以前退到 `process.cwd()`，
      //    也就是 **dsh 进程自己的工作目录** —— 那对多数人根本不是他的工作区 ✗
      //    ⇒ 读错人设、甚至把别的目录的设定读进来 ✓
      //    ⭐ 现在的规矩：**留空 = 不读设定**（宁可按中性说话，也别猜错 ✓）；要按人设就自己填工作区 ✓。
      const wsDir = String(cfg.workspace || '').trim()
      const agents = wsDir ? join(wsDir, 'AGENTS.md') : ''
      if (agents && existsSync(agents)) {
        const text = readFileSync(agents, 'utf8')
        ownerDoc = '\n\n===== 使用者的 AGENTS.md（他写给自己 AI 的人设与准则，**按这个来**）=====\n'
          + text.slice(0, 6000)
          + '\n===== 设定结束 =====\n'
      }
    } catch { /* 读不到就算了，别因此跑不成 */ }
    // ⭐ 配额改成两级：每轮上限 + 每天上限
    //    · 这一轮能挑几条 = min(perRoundMax, 今天剩余额度)
    //    · 「每天」是全天账：上一轮已经挑过的要扣掉
    const already = countPickedToday()
    const dayMax = Math.max(0, Number(cfg.perDayMax) || 0)
    const roundMax = Math.max(0, Number(cfg.perRoundMax) || 0)
    const dayLeft = dayMax > 0 ? Math.max(0, dayMax - already) : roundMax
    const left = Math.min(roundMax, dayLeft)
    const quota = dayMax

    /* ⭐ 时长过滤（分钟）：0 = 该端不限 */
    const minDur = Math.max(0, Number(cfg.minDurationMin) || 0)
    const maxDur = Math.max(0, Number(cfg.maxDurationMin) || 0)
    const durRange = (minDur || maxDur)
      ? (minDur && maxDur ? `${minDur}–${maxDur} 分钟`
        : minDur ? `至少 ${minDur} 分钟`
        : `最多 ${maxDur} 分钟`)
      : ''

    /* ⭐ 字幕优先 + 熔断 */
    const preferSub = cfg.preferSubtitle !== false
    const probeMax = Math.max(1, Number(cfg.subtitleProbeMax) || 3)
    const transCap = Math.max(0, Number(cfg.transcribePerDay) || 0)
    const transUsed = asrUsedToday()
    // ⭐ 投递方式（2026-10-17 加）：dmMode = off（只评论）· only（只私信）· both（都发）
    //    commentOn 是"这一轮到底能不能发公开评论"的唯一判据（工具层的闸用的是同一套逻辑）
    const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only')
    const dmOn = Boolean(cfg.dmMode !== 'off' && Number(cfg.dmUid) > 0)
    return `你是这个账号的 B站 助手。`
      + `下面是使用者的设定（如果有）—— **按它来**，别用你默认那套人格。`
      + ownerDoc
      + (ownerDoc
        ? ''
        : '⭐ 这一轮**没有**拿到使用者的设定（他没填「工作区」，或那个目录里没有 `AGENTS.md`）⇒ **按中性说话**：别扮演任何人、也别自己编一套设定 ✓。')
      + `然后读章程 ${duty}，按里面的要求刷一轮 B站，`
      + (cfg.reportLevel === 'brief'
        ? `日报写成薄版：每条一两行（值不值得 + 链接）就够，别写长摘要。`
        : cfg.reportLevel === 'off'
          ? `这一轮不要写日报文件，也别生成任何报告；只有真发了评论就一句话记下。`
          : `把报告写到 ${join(outDir, `${dayKey()}.md`)}。`)
      + (cfg.reportLevel === 'off' ? '' : `⚠️ 今天那份报告里可能已经有上一轮写的东西 —— 有就**追加到末尾**，别覆盖（配额按全天算）。`)
      + (cfg.reportLevel === 'off' ? '' : '⭐ 报告里**每挑中一条**，第一行写成 `### BV号`（例：`### BV1xxxxxxx`）—— 宿主**就数这些标题行**算今天挑了几条：漏写当成没挑中，给只是提到 / 跳过的视频加上标题则当成挑中。')
      /* ── 配额：每轮 + 每天，两级 ── */
      + (already > 0
        ? `今天已经挑过 ${already} 条（全天上限 ${quota || '不限'}）⇒ **这一轮最多挑 ${left} 条**；`
        : `**这一轮最多挑 ${left} 条**（全天上限 ${quota || '不限'}）；`)
      /* ── 时长过滤 ── */
      + (durRange
        ? `⏱ **时长限制：只看 ${durRange} 的视频。** `
          + `搜索结果每条都带 \`duration\` 字段（\`"16:33"\` = 16 分 33 秒；\`"142:43"\` = 142 分 43 秒）—— `
          + `**超出范围的直接跳过**，不要取字幕、不要转写、不要写进报告正文（只在报告里记一行统计）；`
        : '')
      /* ── 字幕优先 ── */
      + (preferSub
        ? `⭐ **字幕优先**：候选里先挑**有字幕**的（省掉转写时间）。`
          + `最多只查 **${probeMax} 条**字幕：`
          + `这 ${probeMax} 条里只要有带字幕的，就优先从有字幕的那几条里挑；`
          + `如果 ${probeMax} 条全都没有字幕，**不要再继续往下找了** —— `
          + `直接从这 ${probeMax} 条里挑优先级最高的那条（播放量/相关度）转写它。`
          + `⚠️ 不许为了"找有字幕的"无限翻页，那会把一整轮都耗在取字幕上。`
        : '')
      /* ── 转写熔断 ── */
      + (cfg.transcribe
        ? (transCap > 0
          ? `🔴 **转写熔断**：今天已转写 ${transUsed} 次、上限 ${transCap} 次。`
            + (transUsed >= transCap
              ? `**已经到上限了 ⇒ 这一轮只挑有字幕的视频**，没有字幕的一律跳过（别转写）。`
              : `这一轮最多再转 ${transCap - transUsed} 条。`)
          : '')
        : '')
      + `关键词${kws.length ? `用这些：${kws.join('、')}` : '用章程里的默认那几组'}。`
      + `本地转写：${cfg.transcribe
        ? (asrReadyNow()
          ? '开着，而且装好了（没字幕的视频用家里那份 asr.py 转，命令见章程）'
          : '**开着、但依赖没装好** ⇒ 这一轮没字幕的视频只能跳过')
        : '关着（没字幕的视频就跳过）'}；`
      + `⭐ 不管哪种情况，**报告里都要写一行「因无字幕跳过 N 条」**（N=0 也写）—— 别让它悄悄少几条。`
      + `判重表 = ${join(stateDir, 'seen.md')}（**就是这个绝对路径**，别写到家目录 ~、也别写到别处）；`
      + `⚠️ 它读不出来或写不进去，**必须在报告里明说** —— 那一轮宁可不发评论，也别当成"没有记录"重发一遍。`
      + `⭐ 另外把这一轮**看过的每一条视频（挑中的和跳过的都算）**追加进归档：${join(digestDir, `${dayKey().slice(0, 7)}.md`)}`
      + ` —— 一行一条：日期 · BV 号 · 标题 · UP · 一句话结论 · 链接（跳过的那条在后面注明理由）；`
      + `这是**给以后检索用**的（报告是给人看的，归档是给"回头翻"用的），别省略、也别只写挑中的。`
      + `自动评论并 @ ${cfg.mentionName || '（还没填要 @ 谁）'}${cfg.mentionUid ? '（UID ' + Number(cfg.mentionUid) + '）' : ''} 是${commentOn
        ? `开着的（每轮最多 ${cfg.commentPerRound} 条评论，每条在正文里纯文本 @ ${cfg.mentionName}，150 字内）`
        : (cfg.dmMode === 'only'
          ? '关着的 —— 当前是「**只私信**」模式：**这一轮一条公开评论都不许发**，改走私信'
          : '关着的（只写报告，别发评论）')}。`
      + (dmOn
        ? `⭐⭐ **私信投递**：用 bili_send_message 把这一轮的结果发到 UID **${Number(cfg.dmUid)}**。`
          + `内容**别照抄评论那套**：把本轮每条值得的写成 **标题 + 链接 + 一句话理由**`
          + `（私信是私人渠道、不占别人的地方，可以比评论长一点，但**别啰嗦**）。`
          + `🔴🔴 **但私信有长度上限 —— 实测 500 字符就顶了**：`
          + `490 字那条能发出去、再长就被接口拒（报 **code 21007**）✗。`
          + `所以**一条私信务必控制在 500 字以内、最多塞 4~5 条** —— 宁可少放一条，也别整条被拒；`
          + `⚠️ **被拒了就精简一次重发**（删理由、砍条目），**别原样无脑重试** ✗。`
          + `🔴🔴 **私信是写给「人」看的，必须是干净的人话** —— **不许出现任何设置名 / 内部术语 / 台账口径** ✗：`
          + `dmMode、only、aiReply、判据、白名单、prompt、token、复核 这类词，**一个都不许出现在私信正文里**；`
          + `**更不许写「公开评论一条没发 / 楼中楼跳过」这种内部机制说明** ✗`
          + `（那是在跟使用者念操作手册，可读性极差）。他关心的只有：**这次挑了哪几条、为什么值得**。`
          + `（想交代"没别的了"就用一句人话，比如「今天没什么新的了」；`
          + `⚠️ **不要**把「无字幕跳过 N 条」这种统计口径搬进私信 —— 那是**报告**里写的，不是私信里写的。）`
          + `⚠️ 私信里**不用 @ 任何人**；⚠️ **一轮只发一条私信**（多条合并成一条）；`
          + `⚠️ 私信里**不要**写"本鱼 / 本鲸 / 主人 / 人家"那套；⚠️ 发完把"已私信"记进报告（**报告里**可以写口径）。`
          + (cfg.dmMode === 'both' ? `⚠️ 现在是 **both**：公开评论照发（走下面那一整套规矩），私信**另外**再发一条。` : '')
        : '')
      + (cfg.replyToComments
        ? `回复评论：开着（每轮最多回 ${Number(cfg.replyPerRound) || 1} 条）—— 只回「直接回复到你那条评论下面的人」，回完记进报告；找不到你那条评论就跳过，别硬找。`
        : `回复评论：关着（一个字都不要回任何人 —— 有人回复你那条评论也不要理）。`)
      + `最后用一句话汇报你挑到了什么。现在几点了自己看一眼系统时间。`
  }

  /**
   * 给 headless 那一轮写一份 overlay —— 把 B站 MCP 挂上去。
   * 🔴 为什么需要它：**某个 profile 能拿到什么工具，取决于它自己那层的 patch**
   *    （headless 里那两条 B站 MCP 就是当初手写进去的）。分发给别人时不能要求人家改 profile，
   *    所以插件自己生成一份、跑的时候 `--patch` 带上（dsh 支持可重复的 `--patch`）。
   */
  /**
   * ⭐ 值班轮能看到哪些 MCP 工具（2026-10-17 审查里的 H3）
   *    起因：overlay 把整台 mcp_server.py 挂成 stdio server ⇒ 那一轮的模型手里握着**原生全套**工具
   *    （bili_reply / bili_crawl / bili_send_opus / bili_upload_video / bili_login…）——
   *    宿主这边 autoComment / mentionName 两道闸只拦得住我们自己的 bili_reply 工具，拦不住它 ✗。
   *    做法：白名单写进 overlay 的 env（mcp-client 会把它并进子进程环境），
   *    mcp_server.py 那头**不在白名单里的工具根本不注册** —— 连名字都不给它看见 ✓。
   *    要读全就手工改这个列表（或者直接跑 mcp_server.py，不设这个变量 = 全放）。
   */
  const mcpWhitelist = () => {
    const list = ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_user_info']
    if (cfg.autoComment || cfg.replyToComments) list.push('bili_reply')   // 只有真要发评论才给这只
    // ⭐ 私信：dmMode 不是 off 才给这只（2026-10-20 修：以前一直没放行 ⇒ 私信功能是死的）
    if (cfg.dmMode && cfg.dmMode !== 'off') list.push('bili_send_message')
    return list
  }

  /**
   * ⭐ 值班那一轮用哪条模型线路 —— 设置页选的，这里只负责写进 overlay 的 agent-default-model。
   *    ⚠️ 两个都空 ⇒ 一个字都不写，完全跟随 headless 自己的默认模型
   *       （别人没装 buddy 也不会因为写了个不存在的线路而 NO_ADAPTER）。
   *    ⚠️ provider 写了但 model 空 ⇒ 只覆盖 provider，model 用该线路自己的默认。
   */
  const modelOverrideYml = () => {
    const prov = String(cfg.dutyProvider || '').trim()
    if (!prov) return []
    const model = String(cfg.dutyModel || '').trim()
    const out = ['- id: agent-default-model', '  config:', '    provider: ' + prov]
    if (model) out.push('    model: ' + model)
    return out
  }

  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const script = join(stateDir, 'mcp_server.py')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = []
    // ⭐⭐ 2026-10-18（用户 `Elec-Tron-lc` 递来完整报告，逐条核过）：
    //    DSH **0.2.1-rc.2** 的 `@deepseek-ai/dsh-headless` 自带 patch 把三个服务 `disabled: true` 了 ——
    //    `credentials` / `authorization` / `deepseek-account` ⇒ 那一轮既用不了账号模型、也读不到凭证库里的 key
    //    （`resolveApiKey` 退到 env 也没有）⇒ `ACCOUNT_SIGN_IN_REQUIRED` / `NO_ADAPTER: buddy`。
    //    ⭐ 我们的 overlay 是**最后**叠加的一层（bundle → profile → `--patch`）⇒ 在这里把它们打开，
    //    用户什么都不用配（0.2.0 时代没这三条禁用，所以以前不炸）。
    //    ⚠️ 老版本没有这些 id 时 DSH 会把未知条目当无事发生，不会因此起不来。
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      yml.push('- id: ' + id, '  disabled: false', '')
    }
    // ⭐ 模型线路（设置页选的）。空 = 不覆盖，跟随 headless 自己的默认模型。
    const modelYml = modelOverrideYml()
    if (modelYml.length) yml.push(...modelYml, '')
    if (cfg.overlayMcp) {
      yml.push(
        '- insert:',
        '    - id: mcp-bili-pond',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: bili-pond',
        '        transport: stdio',
        `        command: '${posix(cfg.pythonPath || 'python')}'`,
        '        args:',
        `          - '${posix(script)}'`,
        '        env:',
        `          BILI_MCP_TOOLS: '${mcpWhitelist().join(',')}'`,
        '',
      )
    }
    try { writeFileSync(file, yml.join('\n'), 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  /**
   * ⭐ 评论发出后复核（2026-10-16 加的行 —— 起因是用户在评论区反馈
   *    「**回执成功不等于公开可见，新号会被压审**」）：
   * 那一轮的 `bili_reply` 回"发送成功"只代表**接口收了**；新号 / 风控会让它进审核，
   * 那时候连 @ 通知都不会推 ⇒ 插件以为发了、下一轮又不再发 ⇒ **一条都没到人**。
   * 所以由**宿主**（有网络、有凭证、不受沙箱限制）去拉一次评论列表 / 楼中楼来核。
   * ⚠️ 措辞守则：看不到写「**没查到**」，**绝不写"没发出去"**（翻页/热度排序都会漏）。
   */
  let verifying = false
  const runVerify = async (why = 'manual') => {
    if (verifying) return { ok: false, error: '上一次复核还没跑完，等它完事' }
    verifying = true
    try {
      log(`评论复核开始（${why}）`)
      const r = await verifyRecent(stateDir, { log })
      const f = appendVerifyToReport(stateDir, r.text)
      log(`评论复核结束（${why}）：查了 ${r.checked.length} 条${f ? `，已写进 ${f}` : ''}`)
      return { ok: true, why, checked: r.checked, skipped: r.skipped, text: r.text, report: f || '' }
    } catch (e) {
      log(`评论复核失败（${why}）：${e?.message ?? e}`)
      return { ok: false, why, error: String(e?.message ?? e) }
    } finally { verifying = false }
  }

  /**
   * ⭐ 保底：那一轮**没写出报告**时，宿主自己补一份"占位报告"。
   * 起因（2026-10-16 用户实测反馈）：有一轮卡在"转写返回空 ⇒ 以为 ASR 坏了"上反复重试，
   *   最后 `out/` 是空的、判重表也没建 ⇒ **使用者完全看不到发生了什么**，也不知道白烧了钱 ✗。
   * ⚠️ 只在"报告本来该有却没有"时补（`reportLevel: off` 不补 ✓），不覆盖已有的报告 ✓。
   */
  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      writeFileSync(f, [
        `# 刷B站 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        '> 常见原因是它卡在某个工具上反复重试、或者把预算烧完了。下一轮它会重来。',
        '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  const runDuty = (why = 'window') => {
   try {
    refreshCfg()          // ⭐ 设置页刚改过的值要立刻生效（config 是就地改的，快照会过期）
    const dsh = resolveDsh()
    const overlay = ensureOverlay()
    const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
    if (overlay) args.push('--patch', overlay)
    args.push(promptFor())
    // ⭐ 这一轮的工作目录 = 使用者（或别的用户）的**工作区** —— 只有这样它的 `AGENTS.md` 才会自动加载。
    // ⭐ 工作目录 = **插件家**：那一轮**被沙箱关着**，只写得了自己工作目录里的东西 ✗
    //    （2026-10-14 教训：为了让它读工作区里的 AGENTS.md 把 cwd 改成工作区 ⇒
    //      它写不了家目录里的 out/ 报告、整轮卡在"我是被沙箱关着的"上面打转 ✗；
    //      现在改成"设定由插件读进来、内联进提示词" ✓，cwd 回到插件家 ✓）
    const cwd = stateDir
    log(`刷B站开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
    const child = spawn(dsh.command, args, {
      cwd,
      shell: dsh.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ⭐ PYTHONUTF8 / PYTHONIOENCODING：Windows 上 Python 默认按 GBK 编解码，
      //    中文 / emoji 打进管道会炸（用户反馈过 UnicodeDecodeError），一律按 UTF-8 来
      // ⭐ ELECTRON_RUN_AS_NODE：**桌面版（Electron）里 spawn 出去的 node 必须带这个**，
      //    否则它当成"再开一个 Electron 应用"、什么都不干就以 0 退出（issue #5：0.17 秒、code 0、什么都没做）
      env: pyEnv({ BILI_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
    })
    // ⚠️ 2026-10-16 issue #1（用户 `miaoxingyunduo` 贴了崩溃日志）：`duty.log` 被别的进程占着时
    //    (`EBUSY`) `appendFileSync` 会抛异常 —— 而这里是 **stream 的 data 回调**，没人接
    //    ⇒ **未捕获异常 ⇒ 整个 DSH 宿主被杀**（所有会话一起没）。跟 10-14 定时器那次是同一类 ✗
    //    ⇒ ⭐ 规矩：**插件里任何写日志/写文件的地方都包好 try/catch**，再错也只该"这一轮没跑成" ✓
    const pick = (buf) => {
      try { appendFileSync(logFile, String(buf), 'utf8') } catch { /* 写不进去就丢，绝不能抛 */ }
    }
    child.stdout?.on('data', pick)
    child.stderr?.on('data', pick)
    child.on('exit', (code) => {
      log(`刷B站结束（${why}，code=${code}）`)
      stubReportIfMissing(code)   // ⭐ 没写报告就补一份占位 —— 别让使用者什么都看不到
      rotateLogIfBig()            // ⭐ 日志别无声地长（三天 797KB ⇒ 一年约 100MB）
      // ⭐ 这一轮挑了几条：从今天的报告里数（上一轮挑的还在同一份文件里 ⇒ 数出来就是全天的账）
      try {
        const st = readJson(dutyStateFile, {})
        const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
        const picked = countPickedToday()   // 报告是事实来源、state 只是兜底（跟闸门同一个算法）
        if (picked > prev) { bumpState({ picked }); log(`今天挑到 ${picked} 条（上限 ${Number(cfg.perDay) || 0} 条）`) }
      } catch (e) { log(`数挑了几条时出错（不影响这一轮）：${e?.message ?? e}`) }
      // ⭐ 发完评论之后**过一会儿再核一次**（2026-10-16 加的「评论发出后复核」）：
      //    接口回"发送成功"≠ 公开可见（新号/风控会进审核）；而"不公开"时连 @ 通知都不会推 ⇒
      //    插件会以为发了、下一轮不再发 ⇒ 一条都没到人。等 90 秒再查，避免把"还在审核"误判成"没发出去"。
      const verifyTimer = setTimeout(() => { Promise.resolve(runVerify('round')).catch((e) => log('复核异常：' + (e?.message ?? e))) }, 90_000)
      verifyTimer.unref?.()   // 别为了一次复核把宿主进程的退出拖住 90 秒
    })
    child.on('error', (e) => log(`刷B站起不来：${e?.message ?? e}`))
    return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile }
   } catch (e) {
    log(`刷B站开跑失败（${why}）：${e?.stack ?? e}`)
    return { started: false, why, error: String(e?.message ?? e) }
   }
  }

  /**
   * ⭐ 开跑前的守卫：设置页选了模型线路时，先确认值班那个 profile 真能解析到它，
   *    解析不到就直接拒绝（别空跑半小时才报 NO_ADAPTER）。
   *    ⚠️ 校验器自己失败时不拦（宁可照老行为跑）。
   */
  const runDutySafe = async (why) => {
    try {
      const chk = await checkDutyModel()
      if (!chk.ok) {
        log(`这一轮没跑：${chk.error}`)
        return { started: false, why, error: chk.error, known: chk.known || [] }
      }
      if (chk.unchecked) log(`模型线路没能预检（${chk.why}）—— 照常开跑`)
    } catch (e) {
      log(`模型预检出错（不拦，照常跑）：${e?.message ?? e}`)
    }
    return runDuty(why)
  }

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 2026-10-14 事故（使用者那边表现为"DSH 突然崩了、网页 Failed to fetch (gateway/internal)"）：
   *    第一版是 `setInterval(tick, 60_000)`，回调里抛的 TypeError **没人接**，直接把整个宿主进程带走
   *    （`dsh: fatal uncaught exception`）。⇒ **定时器回调必须自己兜住所有异常**：
   *    插件再错也只该"这一轮没跑成"，绝不该杀宿主。
   */
  /* ═══════════════════════════════════════════════════════════════════
   * ⭐ 2026-10-20 自动运行重构
   *
   * 旧逻辑：peakValley 是总开关 ⇒ 关着就永不自动；开着又必须落在峰谷窗口内。
   *   那是「只能走 DeepSeek 官方 API、峰谷差价 4 倍」时代的产物。
   *
   * 新逻辑（四级闸门，逐条 return）：
   *   ① autoRun 关            ⇒ 不跑
   *   ② 今天挑满 perDayMax    ⇒ 不跑（配额是全天账）
   *   ③ 今天跑满 autoRunsPerDay ⇒ 不跑
   *   ④ 距上一轮不足 autoGapMinutes ⇒ 不跑（默认 60 分钟 ⇒ 每小时最多 1 轮）
   *   ⑤ peakValleyOnly 开着时，再看是不是在谷时窗口内
   *        · 中午 12:00–14:00 **一轮只排一次**（2 小时默认跑不完两轮）
   *        · 夜间 18:00–09:00 照常按间隔排
   *
   * ⚠️ 手动跑一轮不经过这里，也不写 windows 标记 ⇒
   *    手动那一轮不占自动配额（用户想随时看一眼就看不该扣自动额度）。
   * ⚠️ 定时器回调里绝不让异常外冒 —— 未捕获异常会杀掉整个宿主（2026-10-14 事故）。
   * ═══════════════════════════════════════════════════════════════════ */
  const tick = () => {
    try {
      refreshCfg()
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)

      // ① 自动总开关
      if (!cfg.autoRun) return

      // ② 配额：今天挑满了吗（perDayMax，0 = 不限）
      const dayMax = Number(cfg.perDayMax) || 0
      if (dayMax > 0 && countPickedToday(now) >= dayMax) return

      // 「不写日报」那档没有报告可数 ⇒ 数不出条数就保守：一天只跑一轮
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) return

      // ③ 轮数上限
      const runsMax = Number(cfg.autoRunsPerDay) || 0
      if (runsMax > 0 && roundsToday(now) >= runsMax) return

      // ④ 间隔：距上一轮不足 N 分钟就等
      const gapMs = Math.max(15, Number(cfg.autoGapMinutes) || 60) * 60_000
      const lastAt = st.lastRunAt ? Date.parse(st.lastRunAt) : 0
      if (lastAt && (now.getTime() - lastAt) < gapMs) return

      // ⑤ 峰谷优先（可选）
      let why = 'auto'
      if (cfg.peakValleyOnly) {
        const inNoon = cfg.noon && inWindow(now, WINDOWS.noon)
        const inNight = cfg.night && inWindow(now, WINDOWS.night)
        if (!inNoon && !inNight) return
        why = inNoon ? 'noon' : 'night'
        /* ⭐ 2026-10-20：给中午留配额。
         *   夜间窗口 18:00–09:00 有 15 小时、间隔 60 分钟 ⇒ 单夜间就能跑 15 轮，
         *   autoRunsPerDay=6 的话 18–23 点就跑满了，中午那轮永远轮不到 ✗。
         *   所以：夜间最后一轮要扣着 —— 只要「中午还没跑」且「今天还能跑」，就留 1 次给它。
         *   （中午已经跑过、或中午窗口关了，就不留。） */
        if (inNight && cfg.noon) {
          const noonKey = `${today}:noon`
          const noonPending = !st.windows?.[noonKey]
          const runsMaxNow = Number(cfg.autoRunsPerDay) || 0
          const usedNow = roundsToday(now)
          if (noonPending && runsMaxNow > 0 && usedNow >= runsMaxNow - 1) {
            // 只剩最后一轮额度，且现在还在夜间 ⇒ 留给中午
            // 但如果现在已经过了中午窗口（14:00 之后）就不用留了，否则会白等一整天
            const curMin = now.getHours() * 60 + now.getMinutes()
            const noonEnd = 14 * 60
            if (curMin >= noonEnd) {
              // 已经过了中午窗口 ⇒ 这个"保底"作废，照常跑
            } else {
              return
            }
          }
        }
        // 中午那个窗口：**整个 12–14 点只排一轮**（2 小时默认跑不完两轮）
        if (inNoon) {
          const noonKey = `${today}:noon`
          if (st.windows?.[noonKey]) return
          const next = { ...(st.windows || {}), [noonKey]: true }
          bumpState({ windows: next, count: roundsToday(now) + 1, lastRunAt: now.toISOString(), lastWhy: 'noon' })
          Promise.resolve(runDutySafe('window:noon')).then((r) => {
            if (r && r.started === false) {
              try {
                const st2 = readJson(dutyStateFile, {})
                const w = { ...(st2.windows || {}) }
                delete w[noonKey]
                writeJson(dutyStateFile, { ...st2, windows: w, count: Math.max(0, roundsToday(now)) })
                log(`中午那一轮没跑成，已退回窗口标记（下一跳重试）`)
              } catch (e2) { log(`退窗口标记失败（不影响）：${e2?.message ?? e2}`) }
            }
          }).catch((e) => log(`定时器那一轮出错（已兜住）：${e?.message ?? e}`))
          return
        }
      }

      // 开跑
      bumpState({ count: roundsToday(now) + 1, lastRunAt: now.toISOString(), lastWhy: why })
      Promise.resolve(runDutySafe(`auto:${why}`)).then((r) => {
        if (r && r.started === false) {
          try {
            const st2 = readJson(dutyStateFile, {})
            writeJson(dutyStateFile, { ...st2, count: Math.max(0, roundsToday(now)) })
            log(`这一轮没跑成，已把轮次计数退回（下一跳会重试）`)
          } catch (e2) { log(`退轮次计数失败（不影响）：${e2?.message ?? e2}`) }
        }
      }).catch((e) => log(`定时器那一轮出错（已兜住）：${e?.message ?? e}`))
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()                                    // 别因为这个定时器让进程不肯退出
    ctx.effect(() => () => clearInterval(timer), 'bili-pond: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  /**
   * ⭐ 「值班用哪个模型」下拉的数据源 —— **不写死任何线路**，直接问 DSH 当前注册了什么。
   *    跟 Web 界面右下角那个模型选择器读的是同一个服务（ctx.llm.listProviders / listModels）。
   *    ⚠️ llm 是**可选**依赖：拿不到（老版本 / 没挂 llm）就回空列表，设置页照样能用，
   *       只是没有下拉 —— 绝不能让整条插件因为这个不激活。
   *    ⚠️ 这里读出的是**当前进程（桌面 profile）**的线路；值班那一轮跑在另一个 profile 里，
   *       所以 runDuty 前还要用 checkDutyModel() 去那个 profile 里再核一遍。
   */
  const modelsHere = async () => {
    const llm = ctx.get?.('llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      return { ok: false, providers: [], error: '这个 DSH 没有提供 llm 服务，无法列模型' }
    }
    try {
      const providers = llm.listProviders() || []
      const out = []
      for (const p of providers) {
        const id = String(p?.id || '')
        if (!id) continue
        let models = []
        try {
          const list = await llm.listModels(id)
          models = (list || []).map((m) => ({ id: String(m?.id || ''), name: String(m?.name || m?.id || '') }))
            .filter((m) => m.id)
        } catch { /* 这条线路列不出来就留空，不影响别的 */ }
        out.push({ id, name: String(p?.name || id), models })
      }
      return { ok: true, providers: out }
    } catch (e) {
      return { ok: false, providers: [], error: String(e?.message ?? e) }
    }
  }

  /**
   * ⭐ 去**值班那个 profile** 里查它到底能解析到哪些线路 —— 这才是真正要用的那份。
   *    做法：跑一次 `dsh --profile <headlessProfile> --dump-config`，从输出里收集 provider 名。
   *    这样就能在"开跑前"拦住 NO_ADAPTER，而不是跑半小时才失败。
   */
  const modelsInProfile = async (profileName) => {
    const dsh = resolveDsh()
    const name = String(profileName || '').trim() || 'headless'
    const out = await new Promise((resolve) => {
      let child
      try {
        child = spawn(dsh.command, [...dsh.args, '--profile', name, '--dump-config'], {
          cwd: stateDir, shell: dsh.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: pyEnv(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        })
      } catch (e) { return resolve({ ok: false, error: String(e?.message ?? e) }) }
      let text = ''
      const cap = (b) => { if (text.length < 2_000_000) text += String(b) }
      child.stdout?.on('data', cap)
      child.stderr?.on('data', cap)
      let done = false
      const finish = (r) => { if (!done) { done = true; resolve(r) } }
      child.on('error', (e) => finish({ ok: false, error: String(e?.message ?? e) }))
      child.on('exit', (code) => {
        if (code !== 0) return finish({ ok: false, error: 'dsh --dump-config 退出码 ' + code })
        finish({ ok: true, text })
      })
      const t = setTimeout(() => { try { child.kill() } catch { /* 无妨 */ } finish({ ok: false, error: '查 profile 超时' }) }, 45_000)
      t.unref?.()
    })
    if (!out.ok) return out
    const prov = new Set()
    for (const m of out.text.matchAll(/provider:\s*['"]?([A-Za-z0-9_.-]+)/g)) prov.add(m[1])
    const plugins = new Set()
    for (const m of out.text.matchAll(/name:\s*['"]?((?:@[^/]+\/)?[A-Za-z0-9_.-]+)['"]?/g)) {
      const n = String(m[1]).trim()
      if (/workbuddy|deepseek|llm|assistant|connect/i.test(n)) {
        plugins.add(n)
        plugins.add(n.replace(/^@[^/]+\//, ''))
      }
    }
    return { ok: true, providers: [...prov], plugins: [...plugins], text: out.text }
  }

  /**
   * ⭐ 开跑前校验：设置页选了线路，就去 headless profile 里确认它真能解析到。
   *    解析不到 ⇒ 直接拒绝开跑并说清楚（别让它空跑半小时才发现 NO_ADAPTER）。
   *    ⚠️ 查不到（dump-config 失败）时不拦 —— 宁可按老行为跑，也不要因为校验器自己坏了而跑不了。
   */
  const checkDutyModel = async () => {
    const prov = String(cfg.dutyProvider || '').trim()
    if (!prov) return { ok: true }
    const r = await modelsInProfile(cfg.headlessProfile)
    if (!r.ok) return { ok: true, unchecked: true, why: r.error }
    const hit = (r.providers || []).includes(prov)
      || (r.plugins || []).some((n) => n === prov || n.includes(prov))
    if (!hit) {
      const known = [...new Set([...(r.providers || []), ...(r.plugins || [])])].slice(0, 20)
      return {
        ok: false,
        error: `「${cfg.headlessProfile}」这个 profile 里没有可用线路「${prov}」—— `
          + `要么给那个 profile 装上提供它的插件，要么在设置里换一个（或留空用默认）`,
        known,
      }
    }
    return { ok: true, checked: true }
  }

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    // ⚠️ 超过 1MB 得**先把 Promise 收掉**再掐断：只 destroy 的话它永远不 settle，
    //    这个请求就挂在那儿（不回响应、也不释放）
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')

  /**
   * 建 venv + 装依赖 —— ⭐ **起完就返回，不等它装完**。
   *
   * 🔴 为什么必须这样（2026-10-14 事故）：第一版是 `async` 全程 await，
   *    而"建 venv + pip install"在使用者这条网络上要**几分钟** ⇒ 那个工具调用一直挂着，
   *    **整个会话僵住、连"暂停"都卡，最后只能重启 dsh** ✗。
   *    现在的做法：spawn 出去、输出追加进 `install.log`，函数立刻返回；
   *    想知道装完没 —— 读日志，或看 `bili_duty_status` 里的 `installing`。
   * 依赖走**国内镜像**（使用者那条网络 pip 直连只有 ~24KB/s ✗；uv + 清华源是几十秒 ✓）。
   */
  let installing = false
  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 写不进去就算了 */ } }

  let uvOk = null
  const haveUv = async () => {
    if (uvOk) return true
    const ok = await new Promise((resolve) => {
      try {
        const c = spawn('uv', ['--version'], { windowsHide: true, stdio: 'ignore' })
        c.on('exit', (code) => resolve(code === 0))
        c.on('error', () => resolve(false))
      } catch { resolve(false) }
    })
    // ⭐ 只缓存"有"：把"没有"也缓存住的话，这一轮里刚下好的 uv（或用户刚装上的）会被一直当成没有，
    //    非重启 dsh 不可 ✗（调用点只有装依赖那两处，多探一次几毫秒）
    if (ok) uvOk = true
    return ok
  }

  /** 探一下某个命令在不在（用于"这台机器有没有 python"）—— 陌生人第一条坎就卡在这儿 */
  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })

  const spawnLogged = (cmd, args) => new Promise((resolve) => {
    appendInstall(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try { c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv() }) }
    catch (e) { appendInstall(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => appendInstall(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { appendInstall(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { appendInstall(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  // ───────── 本地转写（ASR）：**独立环境**，别把主 venv 撑成 1GB ─────────
  const asrDir = join(stateDir, '.venv-asr')
  const asrLogFile = join(stateDir, 'asr-install.log')
  const asrPython = () => join(asrDir, process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python')
  const appendAsr = (s) => { try { appendFileSync(asrLogFile, String(s)) } catch { /* 日志写不了也不能炸 */ } }
  // ⭐ 转写的临时目录必须由**宿主**预先建好：值班那一轮跑在沙箱里，
  //    而沙箱只允许写"该子进程启动前就已存在"的目录（2026-10-14 那一轮自己挖出来的规则）
  const asrTmp = join(stateDir, 'tmp', 'asr')
  try { mkdirSync(asrTmp, { recursive: true }) } catch { /* 建不了也别拦着插件加载 */ }

  // ⭐ 判重表也由**宿主**预先建好（两个原因）：
  //   ① 那一轮被沙箱关着，"新建文件"会被拒（2026-10-14 那条规矩）；
  //   ② 它读不出判重表 ⇒ 以为"没记录过" ⇒ 同一批视频反复推送（用户实测反馈 2026-10-16）。
  const seenFile = join(stateDir, 'seen.md')
  try {
    if (!existsSync(seenFile)) {
      writeFileSync(seenFile, [
        '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
        '',
        '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
        '',
        '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
        '| --- | --- | --- | --- | --- |',
        '',
        '## 看过的视频',
        '',
      ].join('\n'), 'utf8')
    }
  } catch { /* 建不了也别拦着插件加载 */ }

  // ⭐ 归档目录：那一轮**被沙箱关着**，只写得了"启动前就已存在"的目录 ⇒ 宿主预建 ✓
  //    （2026-10-16 主人要的"它看过什么"清单：报告是给人看的，归档是给检索用的 ✓）
  const digestDir = join(stateDir, 'digest')
  try { mkdirSync(digestDir, { recursive: true }) } catch { /* 建不了也别拦着插件加载 */ }

  /**
   * ⭐ 日志轮转（2026-10-16 量出来的：`duty.log` 三天就 797 KB、没有轮转 ⇒ 一年约 100 MB ✗）
   * 超过 2MB 就滚成 `duty.log.1`（只留一份），别让它在 C 盘上无声地长。
   */
  const rotateLogIfBig = (limit = 2 * 1024 * 1024) => {
    try {
      if (!existsSync(logFile) || statSync(logFile).size < limit) return
      const bak = logFile + '.1'
      try { rmSync(bak, { force: true }) } catch { /* 删不掉就算了 */ }
      renameSync(logFile, bak)
      appendFileSync(logFile, `${new Date().toISOString()}  日志超过 2MB，旧的滚到 duty.log.1\n`, 'utf8')
    } catch { /* 轮转失败不该影响跑一轮 */ }
  }
  let installingAsr = false

  /** 找 uv：系统里的 → 插件家里下好的 → 自己下一份（给"两样都没有"的人）；主/转写两套安装共用 */
  const resolveUv = async () => {
    const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (await haveUv()) return 'uv'
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
    if (got) appendInstall('uv 已就位：' + got + '\n')
    return got
  }

  /** 跟 spawnLogged 一样，但可以写进别的日志、可以带环境变量 */
  const spawnTo = (cmd, args, { sink = appendInstall, env = null } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  /** 装"本地转写"那一套：独立环境 + faster-whisper + yt-dlp + 先把 Whisper 模型下好 */
  const runAsrInstall = () => {
    if (installingAsr) return { ok: true, busy: true, log: asrLogFile, hint: '正在装转写依赖，别重复起' }
    installingAsr = true
    appendAsr(`\n=== ${new Date().toISOString()} 开始装"本地转写"依赖 ===\n`)
    ;(async () => {
      try {
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const hf = process.env.BILI_DUTY_HF_ENDPOINT || 'https://hf-mirror.com'
        const py = asrPython()
        const uvCmd = await resolveUv()
        if (!existsSync(py)) {
          // --seed：把 pip 也装进去（uv 默认不给）—— 不然出现问题时连 pip 都没有，没法补救 ✗
          if (uvCmd) await spawnTo(uvCmd, ['venv', '--seed', asrDir], { sink: appendAsr })
          else await spawnTo(String(cfg.pythonPath || 'python'), ['-m', 'venv', asrDir], { sink: appendAsr })
        }
        if (!existsSync(py)) {
          appendAsr('建环境失败 —— 先点上面的「装依赖」，把 uv 或 Python 准备好\n')
          log('转写：建环境失败'); return
        }
        appendAsr('装 faster-whisper + yt-dlp（走国内镜像）…\n')
        let code = 1
        // ⚠️ av 必须钉在 17 以下：faster-whisper 1.2.1 会调 av.open(metadata_errors=…)，
        //    而 av 17+ 不再接受这个参数 ⇒ 装了最新的 av 反而转不了（2026-10-14 在主人机器上实证）
        const AV_PIN = process.env.BILI_DUTY_AV_PIN || 'av>=12,<17'
        if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', py, '-i', mirror, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr })
        if (code !== 0) code = await spawnTo(py, ['-m', 'pip', 'install', '-i', mirror, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr })
        if (code !== 0) { appendAsr('装包失败 —— 看上面的报错\n'); log('转写：装包失败'); return }
        // ⭐ 顺手把模型也下好（不然第一次跑那一轮会卡在下载上 ✗）；模型走 HuggingFace 国内镜像
        const model = String(cfg.asrModel || 'small')
        // 模型缓存必须放进插件家：默认的 ~/.cache 在本机拒绝写入（2026-10-14 实测 WinError 5）
        const hfHome = join(stateDir, '.hf-cache')
        try { mkdirSync(hfHome, { recursive: true }) } catch { /* 建不了后面会给报错 */ }
        appendAsr(`下 Whisper 模型「${model}」（缓存在 ${hfHome}，源 ${hf}，几百 MB，只需要一次）…\n`)
        const code2 = await spawnTo(py, ['-c',
          'import os,sys;os.environ["HF_HUB_DISABLE_XET"]="1";from faster_whisper import WhisperModel;WhisperModel(sys.argv[1], device="cpu", compute_type="int8");print("模型就绪")',
          model], { sink: appendAsr, env: { HF_ENDPOINT: hf, HF_HOME: hfHome, HF_HUB_DISABLE_XET: '1' } })
        appendAsr(`=== 结束（装包 exit ${code}，模型 exit ${code2}，asrReady=${asrReadyNow()}）===\n`)
        log(`装转写依赖结束：exit=${code}/${code2}`)
      } catch (e) {
        appendAsr(`装转写依赖崩了：${e?.stack ?? e}\n`)
        log(`装转写依赖崩了：${e?.message ?? e}`)
      } finally { installingAsr = false }
    })()
    return { ok: true, started: true, log: asrLogFile, hint: '正在后台装转写依赖 —— 进度显示在下面（要下几百 MB 模型，慢一点正常）' }
  }

  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装依赖 ===\n`)
    ;(async () => {
      try {
        const reqFile = join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt')
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const venvPy = venvPython()
        const py = String(cfg.pythonPath || 'python')
          const uvCmd = await resolveUv()   // ⭐ 系统里的 → 家里下好的 → 自己下一份
        if (!existsSync(venvPy) && !uvCmd && !(await probeCmd(py))) {
          const msg = '这台机器上没有 uv，也没有可用的 python（试过 "' + py + '"），而且我自动下 uv 也没成功'
            + '（大概是网络到不了 GitHub / PyPI 镜像）。⇒ 请手动装 uv（单个 exe：https://docs.astral.sh/uv/）'
            + '或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次「装依赖」。'
          appendInstall(msg + '\n'); log(msg); installing = false; return
        }
        if (!existsSync(venvPy)) {
          // ⭐ 2026-10-17（issue #8③）：ASR 那个环境带了 --seed，主环境却漏了 ⇒ uv 建的 venv 默认不含 pip，
          //    一旦镜像失败、回退 `python -m pip` 就是 `No module named pip` ⇒ 连补救的路都没有 ✗
          if (uvCmd) await spawnLogged(uvCmd, ['venv', '--seed', join(stateDir, '.venv')])
          if (!existsSync(venvPy) && !uvCmd) await spawnLogged(py, ['-m', 'venv', join(stateDir, '.venv')])
        }
        let code = 1
        // ⭐ 2026-10-17（issue #8②）：镜像也会整站拒绝（清华对部分 IP 回 403，而 pip 的报错写成"这个包不存在"，很误导）
        //    ⇒ 一个镜像失败就换下一个，别让用户在一个死镜像上反复撞
        const mirrors = [mirror, 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']
        for (let i = 0; i < mirrors.length && code !== 0; i++) {
          const m = mirrors[i]
          if (i > 0) appendInstall(`\n--- 换个镜像再试：${m} ---\n`)
          if (uvCmd) code = await spawnLogged(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', reqFile])
          if (code !== 0) code = await spawnLogged(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', reqFile])
        }
        if (code === 0 && existsSync(venvPy)) {
          // ⚠️ 光写 config.json 不够：DSH 原生设置里那份旧值（"python"）会在 loadCfg 时压回来
          //    （已由 loadCfg 的 HOST_WINS_EXCLUDED 解决 ✓）；这里再把宿主的同步结果说清楚，
          //    免得以后再出现"日志说设好了、实际没生效" ✗
          const r = await persistCfg({ pythonPath: venvPy })
          appendInstall(`已把 pythonPath 设为 ${venvPy}（DSH 那边${r?.host?.ok ? '已同步' : '没写成：' + (r?.host?.error || '未知原因')}）\n`)
        }
        {
          const miss = missingVenvDeps()
          appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}${miss.length ? '，缺：' + miss.join(' / ') : ''}）===\n`)
          log(`装依赖结束：exit=${code} venvReady=${venvReadyNow()}${miss.length ? ' 缺：' + miss.join(',') : ''}`)
        }
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖 —— 进度就显示在下面（走国内镜像，通常几十秒到一两分钟）' }
  }

  /** 「测一下」：真跑一次查询再下结论（判据落在载荷上，不看自报） */
  const checkUp = async () => {
    const out = { ok: false, steps: [] }
    if (!venvReadyNow()) { out.error = '环境还没装好（可能上次装失败了）—— 点「重装主依赖」再试一次'; return out }
    if (!hasCredential()) { out.error = '还没登录：点「扫码登录」，手机 B站 扫一下'; return out }
    try {
      const who = await call('bili_check_credential', {})
      out.who = (typeof who === 'object' ? JSON.stringify(who) : String(who)).slice(0, 140)
      out.steps.push('登录有效')
    } catch (e) { out.error = '登录检查失败：' + (e?.message ?? e); return out }
    try {
      const s = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
      const t = typeof s === 'string' ? s : JSON.stringify(s)
      out.sample = t.slice(0, 160)
      out.steps.push('能搜到东西')
      out.ok = t.length > 2
      if (!out.ok) out.error = '搜到了空结果'
    } catch (e) { out.error = '搜索失败：' + (e?.message ?? e) }
    return out
  }

  /* ⭐ 转写计数（2026-10-20 熔断用）：按天记今天已经转写了几条。
   *    模型在那一轮里自己调 asr.py，宿主拦不到每一次 —— 所以这里是**软熔断**：
   *    提示词里告诉它今天还剩几次，跑完一轮再按报告里的实际转写记录校准。
   *    真要硬拦就得包 MCP 层，成本高收益低（模型基本会照做）。
   */
  const asrCountFile = join(stateDir, 'asr-count.json')
  const asrUsedToday = () => {
    try {
      const j = readJson(asrCountFile, {})
      return Number(j[dayKey()] || 0) || 0
    } catch { return 0 }
  }
  const addAsrUsed = (n) => {
    try {
      const j = readJson(asrCountFile, {})
      const today = dayKey()
      j[today] = Math.max(0, (Number(j[today]) || 0) + (Number(n) || 0))
      // 只留最近 7 天，别让文件无限长
      const keys = Object.keys(j).sort().slice(-7)
      const trimmed = {}
      for (const k of keys) trimmed[k] = j[k]
      writeJson(asrCountFile, trimmed)
      return trimmed[today]
    } catch { return 0 }
  }

  let updateCache = null            // { at, latest } —— 检查更新的结果缓存

  const status = () => {
    refreshCfg()
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      windows: WINDOWS,
      today,
      ranToday: st.day === today ? Number(st.count || 0) : 0,   // 今天跑了几轮
      pickedToday: countPickedToday(),                          // 今天挑到几条（从报告里数）
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: hasCredential(),
      venvReady: venvReadyNow(),
      version: myVersion(),
      // 2026-10-18：这几项"本地存了、但没能同步到 DSH 原生设置" ⇒ 设置页要告诉用户
      // （DSH 0.2.1 某些启动方式会拒写：profile reload requires the root Include entry）
      notSynced: Object.keys(readOverride()),
      installFailed: !installing && !venvReadyNow() && (() => { try { return readFileSync(installLogFile, 'utf8').length > 0 } catch { return false } })(),
      installing,
      // ── 2026-10-20 自动运行 / 配额 / 熔断 的可观测值 ──
      asrUsedToday: asrUsedToday(),
      roundsToday: roundsToday(),
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      // ── 本地转写那一套的状态（设置页要显示进度）──
      asrReady: asrReadyNow(),
      // 模型下没下（免得界面写"就绪"、其实还得现下）
      asrModelReady: (() => { try { return existsSync(join(stateDir, '.hf-cache', 'hub')) } catch { return false } })(),
      asrInstalling: installingAsr,
      asrLog: asrLogFile,
      asrTail: (() => { try { return readFileSync(asrLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      installLog: installLogFile,
      // ⭐ 让设置页能显示"装到哪了"（陌生人原来只看到一句"后台在装" ✗）
      installTail: (() => { try { return readFileSync(installLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      report: join(outDir, `${today}.md`),
      log: logFile,
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-pond/status') return sendJson(res, 200, status())

    // ⭐ 「@ 谁」：前端填 UID，后端解析出昵称写进 mentionName
    //    （B站 评论只认昵称文本，所以最终还得有昵称；但让用户记 UID 比记昵称可靠）
    if (req.method === 'POST' && path === '/api/bili-pond/resolve-user') {
      const body = await readBody(req)
      const uid = Math.max(0, Number(body?.uid) || 0)
      if (!uid) return sendJson(res, 200, { ok: false, error: 'UID 为空' })
      try {
        const raw = await call('bili_user_info', { uid })
        let info = raw
        if (typeof raw === 'string') { try { info = JSON.parse(raw) } catch { /* 保持原样 */ } }
        const name = String(info?.name || '').trim()
        if (!name) return sendJson(res, 200, { ok: false, error: '解析不到昵称（UID 可能不存在）', raw: String(raw).slice(0, 200) })
        // 解析成功 ⇒ 顺手把两个字段都落盘（外加深链到 DSH 设置层）
        await persistCfg({ mentionUid: uid, mentionName: name })
        return sendJson(res, 200, { ok: true, uid, name, face: info?.face || '', level: info?.level ?? null })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ⭐ 「值班用哪个模型」下拉的数据源：当前进程真实注册的线路 + 模型（不写死）
    if (req.method === 'GET' && path === '/api/bili-pond/models') {
      const here = await modelsHere()
      const inProfile = await modelsInProfile(cfg.headlessProfile)
      const usable = new Set([
        ...((inProfile.providers) || []),
        ...((inProfile.plugins) || []),
      ])
      const providers = (here.providers || []).map((p) => ({
        ...p,
        // 这条线路在值班那个 profile 里能不能用（不能就置灰/提示）
        usable: !inProfile.ok ? null : (usable.has(p.id) || [...usable].some((n) => n.includes(p.id))),
      }))
      return sendJson(res, 200, {
        ok: true,
        current: { provider: cfg.dutyProvider || '', model: cfg.dutyModel || '' },
        profile: cfg.headlessProfile,
        profileKnown: Boolean(inProfile.ok),
        profileError: inProfile.ok ? '' : (inProfile.error || ''),
        providers,
      })
    }

    if (req.method === 'GET' && path === '/api/bili-pond/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home: stateDir })
    }

    if (req.method === 'POST' && path === '/api/bili-pond/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of ['perDay', 'peakValley', 'noon', 'night', 'autoComment', 'transcribe', 'asrModel',
        'commentPerRound', 'mentionName', 'mentionUid', 'dmMode', 'dmUid',
        // 2026-10-20 自动运行 / 配额 / 时长 / 字幕优先 / 熔断
        'autoRun', 'autoRunsPerDay', 'autoGapMinutes', 'peakValleyOnly',
        'perRoundMax', 'perDayMax', 'transcribePerDay',
        'minDurationMin', 'maxDurationMin', 'preferSubtitle', 'subtitleProbeMax',
        'keywords', 'pythonPath', 'dshBin', 'headlessProfile', 'dutyProvider', 'dutyModel', 'workspace', 'reportLevel', 'replyToComments', 'replyPerRound']) {
        if (k in body) patch[k] = body[k]
      }
      // ⭐ 范围钳制 + 两份都写（config.json / DSH 原生设置页），统一走 persistCfg —— 见文件上方
      // ⭐ 私信那两个字段的合法值（2026-10-17 摘 PR #9；其余范围钳制统一在 persistCfg 里）
      if ('dmMode' in patch) patch.dmMode = ['off', 'only', 'both'].includes(String(patch.dmMode)) ? String(patch.dmMode) : 'off'
      if ('dmUid' in patch) patch.dmUid = Math.max(0, Math.min(Number(patch.dmUid) || 0, Number.MAX_SAFE_INTEGER))
      const { clean, host } = await persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: cfg, host })
    }

    if (req.method === 'POST' && path === '/api/bili-pond/run') {
      return sendJson(res, 200, { ok: true, ...(await runDutySafe('manual')) })
    }

    // 建 venv + 装依赖（**不等它**：几分钟的活，进度写 install.log）
    if (req.method === 'POST' && path === '/api/bili-pond/install') {
      return sendJson(res, 200, runInstall())
    }

    // 装"本地转写"那套（独立环境：faster-whisper + yt-dlp + Whisper 模型）
    if (req.method === 'POST' && path === '/api/bili-pond/install-asr') {
      return sendJson(res, 200, runAsrInstall())
    }

    // ⭐ 「复核评论」：拿判重表里最近的记录，去 B站 核一遍到底公开可见没有
    //    （设置页那个按钮、以及每轮结束 90 秒后自动跑一次，都走这里）
    if (req.method === 'POST' && path === '/api/bili-pond/verify') return sendJson(res, 200, await runVerify('manual'))

    // 「看今天的报告」：把报告的文本读出来给设置页显示（浏览器不能直接开本地文件 ✗）
    if (req.method === 'GET' && path === '/api/bili-pond/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 200000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }

    // 「打开文件夹」：浏览器开不了本地目录 ⇒ 让宿主去开（只认 out / home 两个，别的不受理）
    if (req.method === 'POST' && path === '/api/bili-pond/open') {
      const body = await readBody(req)
      const dir = String(body?.what || 'out') === 'home' ? stateDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      // ⭐ 三种方式依次试（PATH 不全时 explorer.exe 会找不到 ✗；spawn 的失败是**异步**的，
      //    try/catch 抓不到 ⇒ 必须挂 'error' 监听，否则会升级成未捕获异常）
      // ⭐ 顺序很重要：把**最可能真的弹出窗口**的放第一（cmd start 走 shell 的 ShellExecute ✓）
      //    并且**不要再传 windowsHide**（2026-10-15 实测：传了以后"成功"但窗口不出现 ✗）
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
        ['powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '" + dir.replace(/'/g, "''") + "'"]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) { log('打开文件夹：用了 ' + cmd + '（没报错；窗口不一定真弹出来了）'); return sendJson(res, 200, { ok: true, opened: dir, via: cmd }) }
        lastErr = err
        log('打开文件夹失败（' + cmd + '）：' + err)
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }

    // 「一键升级」：点了它自己跑 add（⚠️ 之后要重启才生效）
    if (req.method === 'POST' && path === '/api/bili-pond/upgrade') return sendJson(res, 200, runUpgrade())

    // 「检查更新」：⚠️ 只在用户点按钮时才联网（不偷偷发请求 ✓），结果缓存一天 ✓
    if (req.method === 'GET' && path === '/api/bili-pond/update') {
      const out = { ok: true, current: myVersion(), latest: '', hasNew: false, page: 'https://www.npmjs.com/package/dsh-bili-pond' }
      try {
        if (updateCache && Date.now() - updateCache.at < 24 * 3600 * 1000) out.latest = updateCache.latest
        else {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 8000)
          const r = await fetch('https://registry.npmjs.org/dsh-bili-pond/latest', { signal: ctrl.signal })
          clearTimeout(timer)
          const j = await r.json()
          out.latest = String(j.version || '')
          updateCache = { at: Date.now(), latest: out.latest }
        }
      } catch (e) { out.ok = false; out.error = String(e?.message ?? e); return sendJson(res, 200, out) }
      // ⭐ 要比谁更新，不能只比不相等 —— 否则本地版本高于 npm 时会误报有新版
      const vnum = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0)
      const cmp = (a, b) => {
        const x = vnum(a), y = vnum(b)
        for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0) }
        return 0
      }
      out.hasNew = Boolean(out.latest) && cmp(out.latest, out.current) > 0
      return sendJson(res, 200, out)
    }

    // 「测一下」：真跑一次，回答"能不能用"
    if (req.method === 'POST' && path === '/api/bili-pond/check') {
      return sendJson(res, 200, await checkUp())
    }

    // ── 扫码登录（设置页用）──
    if (req.method === 'POST' && path === '/api/bili-pond/login/start') {
      const { key, url } = await loginStart()
      const png = await renderQrPng(cfg.pythonPath, stateDir, url)
      let qr = null
      if (png) { try { qr = 'data:image/png;base64,' + readFileSync(png).toString('base64') } catch { qr = null } }
      log(`出码：${url}${qr ? '（已画成 PNG）' : '（没画出 PNG —— venv 里大概还没有 qrcode）'}`)
      return sendJson(res, 200, { ok: true, key, url, qr })
    }

    if (req.method === 'POST' && path === '/api/bili-pond/login/poll') {
      const body = await readBody(req)
      const r = await loginPoll(String(body.key || ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return sendJson(res, 200, { ok: true, state: 'ok', file })
      }
      return sendJson(res, 200, { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-pond',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-pond: /api/bili-pond 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'bili-pond: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
