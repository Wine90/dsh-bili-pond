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
  /** ⭐ 私信开关（独立于评论：两个都开就是「评论 + 私信」） */
  dmOn: z.boolean().default(false).extra('volatile', true),
  /**
   * ⚠️ 已废弃：旧版把私信当成「投递方式」三档（off / only / both），
   *    结果出现「选了 both 但评论开关关着 ⇒ 实际只发私信」这种自相矛盾。
   *    现在只留字段做**老配置迁移**（见 migrateCfg），逻辑一律看 dmOn。
   */
  dmMode: z.string().default('off').extra('volatile', true),
  /** ⭐ 私信发给谁的 UID（数字）。私信开关打开时要填 */
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
  /**
   * 把「界面里正在用的模型线路」自动带进值班那一轮（2026-10-21）。
   * 关掉的话，值班只能用值班 profile 自己装的那几条。
   */
  reuseRoutes: z.boolean().default(true).extra('volatile', true),
  /* ── 守护评论区（骑士团，2026-10-22） ──────────────────────────────
   *  用**小号（骑士号）的登录态**去回被 @ 的评论：不是替大号管评论，
   *  而是让这个号自己会说话 —— 所以不需要骑士团的删评/删弹幕权限 ✓
   *  ⚠️ 默认全关：它会拿账号的嘴说话，必须使用者自己开。
   *  ⚠️ 范围一律在 clampPatch 里钳，schema 不写 .max()（老坑：schema 校验不过 = 整条插件不激活）。
   * ─────────────────────────────────────────────────────────────── */
  /** 守护总开关 */
  guardOn: z.boolean().default(false).extra('volatile', true),
  /** 白名单 UID（逗号/空格分隔）。留空 = 只认「要 @ 谁」那个 UID。
   *  ⭐ 2026-10-22 用户澄清：这条**只管别人视频下的 @**；大号自己视频的评论区不看白名单。 */
  guardWhitelist: z.string().default('').extra('volatile', true),
  /** 大号自己视频下：不用 @ 也回（真·守护）。关掉 = 退化成「只回白名单」 */
  guardOwnAll: z.boolean().default(true).extra('volatile', true),
  /** 每天最多回几条（跨所有视频合计，防一觉醒来刷 200 条 + 撞风控） */
  guardDailyCap: z.natural().default(30).extra('volatile', true),
  /** 守最近几条视频的评论区（1 = 只守最新一条；调大 = 请求量跟着涨） */
  guardScope: z.natural().default(1).extra('volatile', true),
  /** 每轮最多回几条 */
  guardPerRound: z.natural().default(3).extra('volatile', true),
  /** 多少分钟扫一次（@ 通知 + 评论区） */
  guardPollMinutes: z.natural().default(3).extra('volatile', true),
  /** 回复末尾带一个表情 */
  guardEmoji: z.boolean().default(true).extra('volatile', true),
  /** 守护口径：想让小号怎么说话 / 什么不能答（拼进每一轮提示词） */
  guardTone: z.string().default('').extra('volatile', true),
  /** 私信遥控：大号（mentionUid）给小号发「# 状态」这类私信，这边扫到就执行并回一条（默认关） */
  dmCtlOn: z.boolean().default(false).extra('volatile', true),
  /** 私信遥控的命令前缀（默认 #，别的私信一律不当命令） */
  dmCtlPrefix: z.string().default('#').extra('volatile', true),
  /** 多久扫一次私信（分钟） */
  dmCtlPollMinutes: z.natural().default(5).extra('volatile', true),
  /** 私信遥控每天最多回几条（0 = 不限） */
  dmCtlDailyCap: z.natural().default(30).extra('volatile', true),
  /** 私信里「# 问 …」每天最多起几轮（每一轮 = 一次 headless，要烧模型额度） */
  dmCtlAskCap: z.natural().default(20).extra('volatile', true),
  /** 跑 headless 时的工作目录 */
  workspace: z.string().default('').extra('volatile', true),
  /** 值班/私信轮**跑在哪个目录**（会话按 cwd 分桶，想让会话出现在你日常那个工作区的列表里就填它；留空 = 用工作区） */
  dutyCwd: z.string().default('').extra('volatile', true),
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

/**
 * ⭐ 已知的「provider id → 提供它的插件包名」。
 *    用途：设置页发现这条线路只在桌面配置里装了、值班 profile 里没有时，
 *    可以一键把它装进值班 profile —— 不用让用户自己去查包名。
 *    新插件可以往这里加；查不到包名时前端只提示，不给按钮。
 */
const PROVIDER_PACKAGES = {
  workbuddy: 'dsh-connect-workbuddy',
  'workbuddy-global': 'dsh-connect-workbuddy',
}

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
  /**
   * ⭐ 2026-10-20：两本账必须分开记，否则「设置页保存过什么」会被当成「什么没写进去」
   *
   *   · local-override.json = 从**插件面板**保存过的键（local-first 的依据）。
   *     无条件记 ⇒ 有 10 个键是常态，不是故障。它只喂 loadCfg 的优先级。
   *   · sync-failed.json    = `ctx.settings.update()` **真的抛错**的键。
   *     只有这本账才能拿去提示用户「没能同步」。
   *
   *   上一版把 local-override 的键直接当失败列表交给界面 ⇒ 只要你动过一次设置，
   *   那 10 个键就会常驻报「有 10 项未能同步」（而其实全都存下来了）。
   */
  const syncFailedFile = join(stateDir, 'sync-failed.json')
  const readSyncFailed = () => {
    try { const j = readJson(syncFailedFile, {}); return j && typeof j === 'object' ? j : {} } catch { return {} }
  }
  const markSyncFailed = (keys, on) => {
    try {
      const cur = readSyncFailed()
      for (const k of keys) { if (on) cur[k] = Date.now(); else delete cur[k] }
      writeFileSync(syncFailedFile, JSON.stringify(cur, null, 2), 'utf8')
    } catch (e) { log('记 sync-failed 失败：' + (e && e.message ? e.message : e)) }
  }
  const logFile = join(stateDir, 'duty.log')
  /* ⭐ 两本日志（2026-10-20）：
   *    duty.log —— **结构化事件**（谁触发的、开始了、几次工具调用、发没发评论、结束码）
   *    run.log  —— 那一轮子进程的**原始输出**（模型会边想边打印，又长又吵），每轮开头清空
   *  以前两者混在一个文件里 ⇒ 265 KB 全是模型独白，真要排查时得在垃圾里捞针。 */
  const runLogFile = join(stateDir, 'run.log')
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
    dmOn: false, dmMode: 'off', dmUid: 0,
    keywords: [], commentPerRound: 1, mentionName: '', mentionUid: 0, pythonPath: 'python', dshBin: '', headlessProfile: 'headless', dutyProvider: '', dutyModel: '', overlayMcp: true, reuseRoutes: true, workspace: '', dutyCwd: '', reportLevel: 'full', replyToComments: false, replyPerRound: 1,
    guardOn: false, guardWhitelist: '', guardOwnAll: true, guardDailyCap: 30, guardScope: 1, guardPerRound: 3, guardPollMinutes: 3, guardEmoji: true, guardTone: '',
    dmCtlOn: false, dmCtlPrefix: '#', dmCtlPollMinutes: 5, dmCtlDailyCap: 30, dmCtlAskCap: 20,
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
    /* ⚠️ 这里以前是 `Number(p[k]) || dflt` —— **0 是 falsy，会被 dflt 顶掉** ✗
     *    ⇒ 「每轮最多挑几条 = 0（只跑不挑）」「每天最多挑几条 = 0」「转写熔断 = 0」
     *      「时长下限 = 0」这些界面明说合法的值，全部存不进去、被悄悄改回默认。
     *    ⇒ 现在只有**真的不是数字**（NaN）才退到默认值，0 原样保留。
     *    （2026-10-20 写 commentPerRound 的钳制测试时抓到的） */
    const nums = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }
    const num = (k, lo, hi, dflt) => { if (k in p) p[k] = Math.max(lo, Math.min(nums(p[k], dflt), hi)) }
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

    /* ⭐ 评论上限不能超过每轮挑中数（2026-10-20）
     *    评论的对象只能是"这一轮挑中的视频" ⇒ 挑 3 条却想发 5 条评论是不可能发生的，
     *    那个 5 只是个永远不生效的摆设，用户会以为设置没生效。
     *    这里在**写入时**就钳下来（不只在界面上限制），直接 POST 也绕不过去。
     *    注：只钳 commentPerRound，不反过来动 perRoundMax —— 用户的意图是"挑几条"，
     *    不该因为一个次要上限被悄悄调小。
     *
     *    ⚠️ 顺序很重要：**先**确定 perRoundMax，**再**钳 commentPerRound。
     *       同一份 patch 里两个都带时（比如一次保存里挑中数 3→0、评论上限 3），
     *       如果先钳评论就会拿"还没更新的旧 perRoundMax"去比 ⇒ 钳不干净。
     *       （2026-10-20 实测踩到：挑 0 条时评论上限还留着 3） */
    {
      // ⚠️ 这里是函数定义（在 cfg 之前），运行时才执行 ⇒ 用 savedCfg() 现读，别直接引用 cfg
      const savedNow = (() => { try { return savedCfg() } catch { return {} } })()
      const pk = Math.max(0, Number(('perRoundMax' in p) ? p.perRoundMax : (savedNow.perRoundMax ?? DEFAULTS.perRoundMax)) || 0)
      if ('commentPerRound' in p) {
        p.commentPerRound = Math.min(Number(p.commentPerRound) || 0, pk)
      } else if ('perRoundMax' in p) {
        // 调小挑中数时，把已存的评论上限一起顺下来（否则又变成摆设）
        const old = Number(savedNow.commentPerRound) || 0
        if (old > pk) p.commentPerRound = pk
      }
    }

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
    /* dmOn（2026-10-20）：私信从「投递方式三档」改成独立开关。
     *   老文件没有 dmOn ⇒ 由 dmMode 反推：off→关，only/both→开。
     *   而且 dmMode=only 的旧语义是「一条公开评论都不发」⇒ 顺手把 autoComment 关掉，
     *   保证老用户升级后行为不变（否则会突然开始发评论）。 */
    if (!Object.prototype.hasOwnProperty.call(raw, 'dmOn')) {
      const legacyDm = String(raw.dmMode || 'off')
      out.dmOn = legacyDm !== 'off'
      if (legacyDm === 'only') out.autoComment = false
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
      /* ⭐ 2026-10-20（干净安装实测）：`noForm` **不是失败**。
       *   profile 的 cordis.patch.yml 里没有本插件条目时（bundle 自带的 patch 只声明 enabled），
       *   DSH 这边就没有可写的设置表单 —— 这是**正常的部署形态**，不是"没写进去"。
       *   把它算成失败会让「有 N 项未能同步」整条横幅又亮起来（本机实测 11 项）。 */
      if (e?.noForm) {
        log('跳过写 DSH 原生设置：这个部署没有可写的设置表单（配置只落在插件自己的 config.json）')
        return { ok: false, noForm: true, error: '这个部署没有可写的 DSH 设置表单（配置只落在插件自己的 config.json）' }
      }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /**
   * ⭐ 落配置的**唯一入口**：插件自己那份 config.json + DSH 原生设置页那份，钳完范围一起写。
   *    （2026-10-17 复查修：`saveCfg` + `await saveCfgHost` 这对义务原来在三个调用点各抄一遍 ——
   *      漏掉任何一处，正好就是「设置页改了没反应」那个 bug 本身 ⇒ 收成一个函数。）
   *
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
   *   现在：写成功就信成功；只在 update() 真抛错时才算失败 —— 而且只有这种失败
   *   才记进 sync-failed.json、才会出现在界面上（见上面两本账的注释）。
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
    // ⭐ 只有「真有表单、但写失败」才算失败；noForm（这个部署没有设置表单）是正常的
    if (host.ok || host.noForm) markSyncFailed(Object.keys(clean), false)
    else {
      markSyncFailed(Object.keys(clean), true)
      log('⚠️ 这几项没能同步到 DSH 原生设置，改为以插件自己的值为准：' + Object.keys(clean).join(', ') + '（' + host.error + '）')
    }
    return { clean, host }
  }

  ensureHomeFiles(pluginDir, stateDir, log)

  // ⭐ 值班章程单独记账（跟 mcp_server.py 不一样：用户改过就得留着 —— 见 state.mjs 的 ensureCharter）
  ensureCharter(pluginDir, stateDir, log)

  /* ⭐ 人设模板（2026-10-20）：用户不知道工作区里的 AGENTS.md 该写什么格式，
   *    这份骨架就是"照着填就行"的答案。只在用户点按钮且文件不存在时才写。 */
  const AGENTS_TEMPLATE = `# 我是谁（人设）

> 这份文件会被**整份读进**「刷 B站」那一轮的提示词。写得越具体，挑出来的内容越像你会看的。
> 格式无所谓（普通 markdown），下面每一节都可以改、删、加、调换顺序。

## 我是谁

（例：我在做 B站/工具类内容，平时主要看工程实现、踩坑复盘这一类。）

## 我关心什么

- 主题 A（例：AI 工具、插件开发、本地部署）
- 主题 B（例：后端架构、性能优化）

## 我不关心什么

- 纯娱乐、标题党、蹭热度
- 只念 PPT / 复读文档、没有自己内容的
- 保姆级入门教程

## 判断值得看的标准

- 有实操、有源码仓库、有可复现数据的，优先
- 讲清「踩了什么坑、为什么这么设计」的复盘，优先
- 观点类要能自圆其说，不要只喊口号

## 说话口吻

（例：别用感叹号，别用「家人们」这类词，直接给结论。）
`

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
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「B站鱼塘」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!hasCredential()) {
        return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「B站鱼塘」里点「扫码登录」（凭证会存在插件自己的数据目录里）' }
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
      // 评论开关关着 / 没填「要 @ 谁」⇒ 工具层也挡掉（除非当场 force）
      const commentOn = Boolean(cfg.autoComment && cfg.mentionName)
      if (!commentOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: '要发评论得同时满足两条：设置里开着「评论」、并且填了「要 @ 谁」。或者本人当场让你发时传 force: true。',
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
    description: '给**设置里指定的那个人**发私信（只在设置页「私信」打开时才有意义）。'
      + '🔴🔴 硬闸：收件人只能是设置页里的「私信收件人 UID」——'
      + '**绝不发给视频 UP 主、也不发给任何其他人**（传别的 UID 会被拒绝）。'
      + '🔴 私信开关关着时也会拒绝（除非本人当场让你发，传 force: true）。',
    parameters: {
      receiver_uid: { type: 'number', description: '收件人 UID（数字）' },
      text: { type: 'string', description: '私信正文；B站 私信有 500 字符上限' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过私信开关的闸' },
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
      if (!cfg.dmOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: '私信开关是关的 —— 设置页「私信」打开、并填好收件人 UID 才能发。确实要发时传 force: true。',
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
        dmOn: Boolean(cfg.dmOn),
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
      + '适合"我现在就想看一份"的场合。⚠️ 上一轮还没跑完时不会重复开（返回 busy）。',
    parameters: {},
    async execute() {
      const r = await runDutySafe('manual')
      return r.started ? { ok: true, ...r } : { ok: false, ...r }
    },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（画成 PNG 存在插件数据目录里，返回路径）和一个 key。\n'
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
      + '成功时会自动把凭证写进插件数据目录的 `bili_credential.json`（MCP 认的那四个字段）。',
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
    description: '给B站鱼塘装运行环境：在插件数据目录建一个**独立 venv**、装上那个 Python MCP 的依赖，装完自动把 `pythonPath` 指过去。\n'
      + '**第一次用之前跑一次**。⭐ 它**起完就返回、不等装完**（几分钟的活），进度看数据目录里的 `install.log`。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'bili_config',
    description: '读 / 改「B站鱼塘」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n'
      + '例：`{"autoRun":true,"perRoundMax":3,"perDayMax":18,"keywords":["DeepSeek Harness"]}`；'
      + '评论与私信是两个独立开关：`{"autoComment":true,"mentionUid":14430149,"dmOn":true,"dmUid":12345678}`。',
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
  //    ⚠️⚠️ 桌面版（Electron 安装包）不行：它的 profile 归应用自己管，命令行 add 会被拒，
  //         而且 profile 名也不一定是 web ⇒ 那边只提示"去「设置 → 插件」里更新"，不假装能自升级。
  const isDesktopApp = Boolean(process.versions?.electron && process.resourcesPath)
  let upgrading = false
  const runUpgrade = () => {
    if (isDesktopApp) {
      return {
        ok: false,
        desktop: true,
        hint: '桌面版请到「设置 → 插件」里更新（这个 profile 归应用管理，插件不能自己改自己）',
      }
    }
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

  /**
   * ⭐ 跑一次 dsh CLI 并收集输出（给「把线路插件装到值班 profile」用）。
   *    跟 modelsInProfile 同一套桌面版兼容：process.execPath + ELECTRON_RUN_AS_NODE。
   */
  const runDshCapture = (extraArgs, timeoutMs = 240_000) => new Promise((resolve) => {
    const dsh = resolveDsh()
    let child
    try {
      child = spawn(dsh.command, [...dsh.args, ...extraArgs], {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      })
    } catch (e) {
      return resolve({ ok: false, code: -1, text: String(e?.message ?? e) })
    }
    let text = ''
    const cap = (b) => { if (text.length < 2_000_000) text += String(b) }
    child.stdout?.on('data', cap)
    child.stderr?.on('data', cap)
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    child.on('error', (e) => finish({ ok: false, code: -1, text: String(e?.message ?? e) }))
    child.on('exit', (code) => finish({ ok: code === 0, code, text }))
    const t = setTimeout(() => {
      try { child.kill() } catch { /* 无妨 */ }
      finish({ ok: false, code: -2, text: text + '\n[超时]' })
    }, timeoutMs)
    t.unref?.()
  })

  const promptFor = (why = 'window') => {
    /* ⭐ 守护轮是**另一种任务**，不是「顺便把日常那套也做一遍」（2026-10-22 用户抓到）：
     *    以前守护轮把整份章程都喂进去，模型（hy3）很听话地把日常那套也跑了 ——
     *    搜视频、写推荐、发私信，用户一脸问号：「这个搜索一遍是从哪来的？我没手动也没开自动」。
     *    ⇒ 守护轮只给守护任务：没有搜索、没有私信、没有公开评论、没有挑片。 */
    if (why === 'guard') {
      /* ⭐ 第一行会变成会话列表里的标题（2026-10-22 用户：值班轮也要进同一条对话） */
      return `守护评论区：替我回几条评论。\n\n`
        + `这是**守护评论区**的一轮：你只替主人回评论，别的事一件都不要做。\n`
        + `🚫 不许按关键词搜视频、不许写推荐/挑片、不许发私信、不许发公开评论、不许发动态。\n`
        + `✅ 只做一件事：把下面列出的这几条评论，各回一条（用 \`bili_reply\`）。\n`
        + guardPromptPart()
        + `\n最后用一句话汇报：回了哪几条（谁、回了什么），没回成的说清原因。`
    }
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
    // ⭐ 评论与私信是**两个独立开关**（2026-10-20 改）：
    //    评论 = autoComment（还要填了 mentionName 才有 @ 对象）
    //    私信 = dmOn（还要填了 dmUid）
    //    两个都开 = 评论 + 私信；工具层的闸用的是同一套判据。
    const commentOn = Boolean(cfg.autoComment && cfg.mentionName)
    const dmOn = Boolean(cfg.dmOn && Number(cfg.dmUid) > 0)
    /* ⭐ 第一行会变成会话列表里的标题（2026-10-22 用户：「值班轮也进对话，不是新建」） */
    return `值班：刷一轮 B站，挑值得我看的。\n\n`
      + `你是这个账号的 B站 助手。`
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
      /* ⭐ 2026-10-22：这一轮跑在**工作区**里（会话才会出现在你的会话列表），
       *    而工作区的沙箱只让写 cwd ⇒ 报告 / 判重表 / 归档都写不进去。
       *    所以这三样改用 MCP 工具交（子进程代写，落在插件家目录里）。 */
      + `\n\n===== 这一轮怎么交作业（重要）=====\n`
      + `这一轮的工作目录是**工作区**，你**写不了**插件数据目录（` + stateDir + `）—— 别用写文件工具去试，会报 sandbox 拒绝。\n`
      + `改用这三只工具（宿主提供，落在插件家目录里）：\n`
      + `① 报告：\`bili_report_save(markdown)\` —— 整份报告正文一次交给它（覆盖写 out/<今天>.md）。\n`
      + `② 判重表：\`bili_seen_read()\` 读、\`bili_seen_append(lines)\` 追加（一行一条）。\n`
      + `③ 归档：\`bili_archive_append(lines)\` 追加（一行一条：日期 · BV · 标题 · UP · 一句话结论 · 链接）。\n`
      + `===== 交作业说明结束 =====\n`
      + `判重表 = ${join(stateDir, 'seen.md')}（路径给你看，**读写都走上面那两只工具**）；`
      + `⚠️ 它读不出来或写不进去，**必须在报告里明说** —— 那一轮宁可不发评论，也别当成"没有记录"重发一遍。`
      + `⭐ 另外把这一轮**看过的每一条视频（挑中的和跳过的都算）**追加进归档：${join(digestDir, `${dayKey().slice(0, 7)}.md`)}`
      + `（用 \`bili_archive_append\`）`
      + ` —— 一行一条：日期 · BV 号 · 标题 · UP · 一句话结论 · 链接（跳过的那条在后面注明理由）；`
      + `这是**给以后检索用**的（报告是给人看的，归档是给"回头翻"用的），别省略、也别只写挑中的。`
      + `自动评论并 @ ${cfg.mentionName || '（还没填要 @ 谁）'}${cfg.mentionUid ? '（UID ' + Number(cfg.mentionUid) + '）' : ''} 是${commentOn
        ? `开着的（每轮最多 ${cfg.commentPerRound} 条评论，每条在正文里纯文本 @ ${cfg.mentionName}，150 字内）`
        : '关着的（只写报告，别发评论）'}。`
      + (dmOn
        ? `⭐⭐ **私信**：用 bili_send_message 把这一轮的结果发到 UID **${Number(cfg.dmUid)}**。`
          + `内容**别照抄评论那套**：把本轮每条值得的写成 **标题 + 链接 + 一句话理由**`
          + `（私信是私人渠道、不占别人的地方，可以比评论长一点，但**别啰嗦**）。`
          + `🔴🔴 **但私信有长度上限 —— 实测 500 字符就顶了**：`
          + `490 字那条能发出去、再长就被接口拒（报 **code 21007**）✗。`
          + `所以**一条私信务必控制在 500 字以内、最多塞 4~5 条** —— 宁可少放一条，也别整条被拒；`
          + `⚠️ **被拒了就精简一次重发**（删理由、砍条目），**别原样无脑重试** ✗。`
          + `🔴🔴 **私信是写给「人」看的，必须是干净的人话** —— **不许出现任何设置名 / 内部术语 / 台账口径** ✗：`
          + `内部字段名、判据、白名单、prompt、token、复核 这类词，**一个都不许出现在私信正文里**；`
          + `**更不许写「公开评论一条没发 / 楼中楼跳过」这种内部机制说明** ✗`
          + `（那是在跟使用者念操作手册，可读性极差）。他关心的只有：**这次挑了哪几条、为什么值得**。`
          + `（想交代"没别的了"就用一句人话，比如「今天没什么新的了」；`
          + `⚠️ **不要**把「无字幕跳过 N 条」这种统计口径搬进私信 —— 那是**报告**里写的，不是私信里写的。）`
          + `⚠️ 私信里**不用 @ 任何人**；⚠️ **一轮只发一条私信**（多条合并成一条）；`
          + `⚠️ 私信里**不要**写"本鱼 / 本鲸 / 主人 / 人家"那套；⚠️ 发完把"已私信"记进报告（**报告里**可以写口径）。`
          + (commentOn ? `⚠️ 评论和私信都开着：公开评论照发（走下面那一整套规矩），私信**另外**再发一条。` : '')
        : '')
      + (cfg.replyToComments
        ? `回复评论：开着（每轮最多回 ${Number(cfg.replyPerRound) || 1} 条）—— 只回「直接回复到你那条评论下面的人」，回完记进报告；找不到你那条评论就跳过，别硬找。`
        : `回复评论：关着（一个字都不要回任何人 —— 有人回复你那条评论也不要理）。`)
      /* ── 守护评论区：这一轮的待回复清单（宿主扫好、内联进来） ── */
      + guardPromptPart()
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
  const mcpWhitelist = (why = 'window') => {
    /* ⭐ 守护轮**只给守护要用的那几只**（2026-10-22 用户抓到「我没手动也没开自动，怎么搜了一遍视频」）：
     *    那一轮本来只需要「看内容 → 回一条」，可整份章程喂进去之后模型顺手把日常流程也跑了
     *    （搜视频、写推荐、发私信）⇒ 从工具这一层就把路掐掉：连 bili_search / bili_send_message
     *    都不注册，它想跑日常也没有手 ✓ */
    if (why === 'guard') {
      return ['bili_guard_scan', 'bili_user_videos', 'bili_subtitle', 'bili_video_info', 'bili_reply']
    }
    /* ⭐ 私信遥控轮（2026-10-22）：**不给 bili_send_message** ——
     *    实测让模型自己发，它会先回一句「已发给主人」然后什么都没发（它以为发了）；
     *    回什么、发给谁、发几条，全部由宿主决定（宿主发完才写记录），模型只负责把话写出来。 */
    if (why === 'dm') {
      /* ⭐ 私信 = 跟 AI 聊天（用户 2026-10-22 澄清：不是「查询命令」，是对话入口）。
       *    所以把 B站 的**读**能力全开给它：他发个视频链接过来，它得自己取字幕/简介再看。
       *    🚫 依然不给写工具：bili_reply / bili_send_message / 上传 / 登录 —— 回信由宿主发，
       *       免得它自己又发一遍，也免得一句「帮我回一下」就公开说话。 */
      return ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_user_info', 'bili_user_videos', 'bili_guard_scan',
        /* ⭐ 私信里也能改设置（用户 2026-10-22：A 档那几项）——只给「读设置 / 改一个设置」两只，
         *    收件人、路径、白名单、凭证都不在那张表里，所以改不了 ✓ */
        'bili_setting_get', 'bili_setting_set']
    }
    /* ⭐ 值班轮跑在**工作区**里（2026-10-22 用户：「都搬进工作区哇，不然都要打开插件才能看到」），
     *    而那一轮的沙箱只让写 cwd（workspace-write）⇒ 它写不了插件家目录里的
     *    `out/` 报告、`seen.md` 判重表、归档 ✗（实测 `[sandbox: file access denied]`）。
     *    ⇒ 这三件事改由 MCP 子进程代劳（子进程是宿主起的，不受那一轮的沙箱限制），
     *      工具名刻意收窄：报告 / 判重表 / 归档各自一个，**不给通用文件工具** ✓ */
    const list = ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_user_info',
      'bili_report_save', 'bili_seen_read', 'bili_seen_append', 'bili_archive_append']
    if (cfg.autoComment || cfg.replyToComments) list.push('bili_reply')   // 只有真要发评论才给这只
    // ⭐ 私信：开关打开才给这只
    if (cfg.dmOn) list.push('bili_send_message')
    /* ⭐ 守护评论区（2026-10-22）：这一轮要「读内容 → 回一条」，所以三只都得给：
     *    bili_guard_scan（宿主已经扫过、把待回复清单内联进提示词了，但允许它自己补扫一次）
     *    bili_subtitle / bili_video_info（先看视频再说话，不许凭空编）
     *    bili_reply（精确回到那条评论上）
     *    取大号投稿用 bili_user_videos。 */
    if (cfg.guardOn) list.push('bili_guard_scan', 'bili_user_videos', 'bili_reply')
    return list
  }

  /**
   * ⭐ 值班那一轮用哪条模型线路 —— 设置页选的，这里只负责写进 overlay 的 agent-default-model。
   *    ⚠️ 两个都空 ⇒ 一个字都不写，完全跟随 headless 自己的默认模型
   *       （别人没装 buddy 也不会因为写了个不存在的线路而 NO_ADAPTER）。
   *    🔴 2026-10-22 实测踩到：`agent-default-model` 的 schema 里 **model 是必填**。
   *       只写 provider 会让这个插件激活失败（`$.model missing required value`），
   *       整个值班进程 exit 1 —— 所以「只选了线路、没选模型」时**宁可不写**，
   *       这一轮跟随 profile 默认模型，也不能写出半条无效配置把值班打死。
   */
  const modelOverrideYml = () => {
    const prov = String(cfg.dutyProvider || '').trim()
    if (!prov) return []
    const model = String(cfg.dutyModel || '').trim()
    if (!model) {
      log(`线路选了 ${prov}，但没选具体模型 —— 这一轮跟随 profile 默认模型（不写 agent-default-model，避免配置无效）`)
      return []
    }
    return ['- id: agent-default-model', '  config:', '    provider: ' + prov, '    model: ' + model]
  }

  /* ⭐⭐ 2026-10-21（用户反馈：「别的插件用户也在为这条发愁 —— 需要一个对所有人都好用的办法，
   *    别靠名字匹配、也别让人一步步手配」）：
   *    值班跑的是**另一个 profile**，那条 profile 里没有你在界面上配的模型线路 ⇒
   *    下拉里你常用的线路是灰的，非要去装包 / 改配置才能用 ✗
   *    ⭐ 做法：DSH 的 profile 是**一层层补丁叠出来的**，`dsh --patch <file>` 是官方给的口子
   *    （`dsh --help`：`--patch <path>  extra patch-list overlay applied after the profile layer`）。
   *    所以值班开跑前，把**宿主（你现在用的这个 profile）那份 cordis.patch.yml 里跟模型有关的 entry
   *    原样抄进 overlay** —— 线路叫什么、有几条、来自哪个插件，全都不用管 ✓
   *    ⚠️ 只抄「模型相关」的 entry（contains providers:/models:/baseURL:/apiKeyEnv: 之类），
   *       权限、UI、沙箱策略那些一概不碰（用户 2026-10-21 明确选的这个范围）。
   *    ⚠️ 抄不到就静默跳过（用户选的是「失败也照旧跑」，不许因为这个小功能把值班卡死）。
   */
  /* ⚠️ 认「这条 entry 是不是模型线路配置」只看**线路声明才有的字段**：
   *    `providers:`（一个插件带多条线路）/ models / baseURL / apiKeyEnv / api …
   *    ⚠️ 别认单独一个 `provider:` —— `ui-chat`、`agent-default-model` 里也有 `provider: xxx`，
   *       那是"选哪条"，不是"定义哪条"，抄过去只会把 UI 配置也带进值班（实测踩过）。 */
  const ROUTE_BLOCK_HINT = /(^|\n)\s*(providers|models|baseURL|base_url|apiBase|apiKeyEnv|apiKey|api|displayName):/m
  /** 值班那一轮的默认模型由本插件自己写（设置页），宿主的这条不能抄 —— 否则会悄悄改掉用户选的模型 */
  const ROUTE_SKIP_IDS = new Set(['agent-default-model'])

  /** 宿主 profile 的补丁层在哪。
   *    ⚠️⚠️ 2026-10-21 实测教训：**Electron 宿主进程里 `DSH_PROFILE_DIR` / `DSH_PROFILE` 是空的**
   *    （那些 `DSH_*` 变量只注入给工具子进程，插件自己所在的宿主进程没有）⇒
   *    只认 env 的话这里永远返回空串、整个功能静默失效（用户看到的就是「还是不可以」）。
   *    ⇒ 多路兜底，最靠得住的是**从插件自己的路径倒推**：
   *       插件装在 `<profile>/node_modules/dsh-bili-pond` ⇒ 往上两级就是那个 profile 的根。
   */
  /** 上一次 hostPatchFile() 试过哪几个位置（设置页排错用） */
  let patchCandsSeen = []
  const hostPatchFile = () => {
    /** 候选：[文件, 是否可信]。可信 = 明确指定（env），否则要求路径像 `<…>/profiles/<name>/cordis.patch.yml`
     *  —— 免得往上走时撞上**包自己带的** patch（`…/node_modules/@deepseek-ai/dsh/cordis.patch.yml` 之类） */
    const cands = []
    const add = (p, trusted = false) => {
      const s = String(p || '').trim()
      if (!s) return
      if (cands.some(([q]) => q === s)) return
      cands.push([s, trusted])
    }
    const dir = String(process.env.DSH_PROFILE_DIR || '').trim()
    /* ⭐⭐ 第一顺位：插件自己的位置倒推 profile 根 —— 这份补丁就是"加载我的那个 profile"的，
     *    比 env 更可信（env 可能指向别的 profile，或者干脆是空的）。
     *    同时往上多走几级：pnpm 的软链布局会落在 `node_modules/.pnpm/<pkg>@x/node_modules/<pkg>`，
     *    真正的 profile 根在上好几层（Node 默认解析成 realpath，所以插件看到的自己是那个深路径）。 */
    let up = pluginDir
    for (let i = 0; i < 6; i++) {
      up = join(up, '..')
      add(join(up, 'cordis.patch.yml'))
    }
    /* 兜底：环境变量（CLI 版会设；Electron 宿主进程里是空的） */
    if (dir) add(join(dir, 'cordis.patch.yml'), true)
    const home = String(process.env.DSH_HOME || '').trim()
    const prof = String(process.env.DSH_PROFILE || '').trim()
    if (home && prof) add(join(home, 'profiles', prof, 'cordis.patch.yml'), true)
    patchCandsSeen = cands.map(([file, trusted]) => {
      let exists = false
      try { exists = existsSync(file) } catch { exists = false }
      const okPath = trusted || /[\\/]profiles[\\/][^\\/]+[\\/]cordis\.patch\.yml$/.test(file)
      return { file, exists, okPath }
    })
    for (const [file, trusted] of cands) {
      let exists = false
      try { exists = existsSync(file) } catch { exists = false }
      if (!exists) continue
      if (trusted || /[\\/]profiles[\\/][^\\/]+[\\/]cordis\.patch\.yml$/.test(file)) return file
    }
    return ''
  }

  /** 把 patch 文件按顶层 `- id:` 切成一块块（纯文本切，不引 YAML 依赖：我们只需要整块搬运） */
  const splitPatchBlocks = (text) => {
    const blocks = []
    let cur = null
    for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = /^- id:\s*['"]?([A-Za-z0-9_@/.-]+)/.exec(line)
      if (m) { cur = { id: m[1], lines: [line] }; blocks.push(cur); continue }
      if (!cur) continue
      if (/^\S/.test(line) && line.trim()) { cur = null; continue }   // 顶格又不是 - id: ⇒ 这块结束了
      cur.lines.push(line)
    }
    return blocks
  }

  /** 上一次 routeOverlayYml() 实际带了哪几个 entry（给设置页排错用：空 = 没带成，界面能直接看出来） */
  let routeIdsSeen = []
  /** 生成「把宿主线路带过去」的那几行 overlay（sync：跑在开跑路径上，不能等 I/O 之外的任何东西） */
  const routeOverlayYml = () => {
    routeIdsSeen = []
    if (cfg.reuseRoutes === false) return []
    const f = hostPatchFile()
    if (!f) return []
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { return [] }
    if (!text.trim()) return []
    const out = []
    const taken = []
    const seen = new Set()
    for (const b of splitPatchBlocks(text)) {
      if (seen.has(b.id)) continue
      if (ROUTE_SKIP_IDS.has(b.id)) continue
      const body = b.lines.join('\n')
      if (/^\s*disabled:\s*true/m.test(body)) continue    // 宿主那边本来就关着，别硬打开
      if (!ROUTE_BLOCK_HINT.test(body)) continue          // 不是模型相关的那类 entry
      seen.add(b.id)
      taken.push(b.id)
      out.push(body.replace(/\s+$/, ''), '')
    }
    if (taken.length) {
      routeIdsSeen = taken.slice()
      log(`值班会带上宿主的线路配置：${taken.join('、')}`)
    }
    return out
  }

  /**
   * 把「宿主线路」那几行单独写成一个 overlay 文件，给"探测"用（探完就删）。
   * 返回路径；没有内容就返回空串（调用方照旧跑不带 patch 的探测）。
   */
  const writeRouteOverlay = () => {
    const yml = routeOverlayYml()
    if (!yml.length) return ''
    const f = join(stateDir, 'probe-route-overlay.yml')
    try { writeFileSync(f, yml.join('\n'), 'utf8'); return f } catch (e) {
      log(`写探测用的 overlay 失败（不影响开跑）：${e?.message ?? e}`)
      return ''
    }
  }

  const ensureOverlay = (why = 'window') => {
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
    // ⭐ 把界面里在用的模型线路一起带过去（见上面 routeOverlayYml 的注释）
    const routeYml = routeOverlayYml()
    if (routeYml.length) yml.push(...routeYml)   // 自带结尾空行，不再补
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
        `          BILI_MCP_TOOLS: '${mcpWhitelist(why).join(',')}'`,
        `          BILI_GUARD_LOG: '${posix(guardLogFile)}'`,
        /* ⭐ 值班轮的「文件出口」要落在这个目录里（MCP 子进程不受那一轮沙箱限制） */
        `          BILI_DUTY_HOME: '${posix(stateDir)}'`,
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
        `# B站鱼塘 · ${dayKey()} —— 这一轮没写出报告`,
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

  /* ⭐ 本轮运行状态（2026-10-20）：设置页要能实时看到"跑到哪了"
   *   只记开始时间 + 触发原因；日志尾部从 duty.log 现读，不用把输出全攒在内存里。 */
  let dutyRun = null            // { startedAt: ms, why: 'manual' | 'auto' | … }

  /* ⭐ 把人看不懂的失败翻成一句人话（2026-10-20）
   *    以前一轮失败，界面只说"未启动，详见 duty.log" —— 使用者得自己去翻日志才知道是没登录、
   *    还是模型线路不通、还是一睁眼就退出。这里按退出码 + 用时 + run.log 关键字分类。 */
  const fmtDur = (sec) => {
    const s = Math.max(0, Number(sec) || 0)
    if (s < 60) return s + ' 秒'
    const m = Math.floor(s / 60)
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
  }
  const classifyRunFailure = (code, tookSec) => {
    let tail = ''
    try { tail = readFileSync(runLogFile, 'utf8').slice(-4000) } catch { /* 没有 run.log 就算了 */ }
    const has = (re) => re.test(tail)
    if (code === 0 && !has(/报告|out\/|###\s*BV/i) && tookSec < 20) {
      return { code: 'too_fast', hint: '开跑几秒就以成功退出，但没写报告 —— 多半是 dsh 或模型线路没配好（可点「连通性检测」）' }
    }
    if (has(/NO_ADAPTER|ACCOUNT_SIGN_IN_REQUIRED|401|403/)) {
      return { code: 'model', hint: '模型线路没通（凭据/线路名不对）—— 到「高级设置 → 运行模型线路」重新选一条' }
    }
    if (has(/MISSING_CREDENTIAL|未登录|401/)) {
      return { code: 'login', hint: 'B站 没登录或凭证失效 —— 点「扫码登录」重扫一次' }
    }
    if (has(/ETIMEDOUT|ENOTFOUND|ECONNRESET|fetch failed/i)) {
      return { code: 'network', hint: '网络请求失败（连不上 B站 或模型服务）—— 稍后重试，或检查代理' }
    }
    if (code !== 0) {
      return { code: 'exit_' + code, hint: `子进程异常退出（code=${code}）—— 详情在 run.log 的末尾` }
    }
    return null
  }

  /**
   * ⭐ 「值班/私信轮跑在哪个目录」（2026-10-22 用户：「不能直接显示吗？我工作区列表没有这个」）
   *    会话是按 cwd 分桶的（`%DSH_HOME%/sessions/--D-harness--`），跑在哪个目录，会话就出现在
   *    哪个工作区的列表里。他不想为了看会话去切工作区 ⇒ 单独给一个「跑在哪个目录」：
   *      ① 填了且存在 → 用它 ② 没填 → 用「工作区」 ③ 都没有 → 插件家（stateDir）
   *    ⚠️ 人设（AGENTS.md）仍然只从「工作区」读，跟跑在哪无关 —— 这两件事别再绑一起。
   */
  const runDir = () => {
    const c = String(cfg.dutyCwd || '').trim()
    if (c && existsSync(c)) return c
    const w = String(cfg.workspace || '').trim()
    if (w && existsSync(w)) return w
    return stateDir
  }

  const runDuty = (why = 'window') => {
   try {
    /* ⭐ 同一时间只允许一轮（2026-10-20）：按钮灰掉只是防手滑，
     *    真正的闸必须在这里 —— 网页、bili_run 工具、定时器三条路都走这个函数。
     *    上一轮没结束时再开一轮 = 两个 headless 进程同时烧模型额度、同时写同一份报告。 */
    if (dutyRun) {
      const el = Math.round((Date.now() - dutyRun.startedAt) / 1000)
      log(`这一轮没跑：上一轮还在跑（已 ${el} 秒，来源 ${dutyRun.why}）`)
      return {
        started: false, busy: true, why,
        elapsedSec: el, runningWhy: dutyRun.why,
        error: `上一轮还在跑（已 ${el} 秒），等它结束再开`,
      }
    }
    refreshCfg()          // ⭐ 设置页刚改过的值要立刻生效（config 是就地改的，快照会过期）
    const dsh = resolveDsh()
    const overlay = ensureOverlay(why)
    const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
    if (overlay) args.push('--patch', overlay)
    /* ⭐ 值班轮**固定一条会话**（2026-10-22 用户：「值班轮也进对话，不是新建，不然怎么对话上下文啊」）：
     *    第一轮跑完把 sessionId 记下来，之后每轮 `--session-id` 续同一条 ——
     *    会话列表里始终只有那一条，模型也真的记得前几轮干了什么（不再每轮从零开始）。
     *    ⚠️ 顺序：`--patch` 必须在 `--json` 之前（2026-10-22 实测：`--json` 后面的 `--patch` 会被拒，
     *      报 `unknown option '--patch'`，整轮 3 秒就退）。 */
    const dutySessFile = join(stateDir, 'duty-session.json')
    let dutySess = ''
    try {
      const o = readJson(dutySessFile, {})
      /* ⚠️ 只在**同一个目录**下复用：会话是按 cwd 分桶的，换了目录再拿旧 id 续会报错 */
      if (String(o.cwd || '') === cwd) dutySess = String(o.sessionId || '')
      else if (o.sessionId) log(`值班那条会话建在别的目录（${o.cwd || '?'}），这次工作目录是 ${cwd}，所以另起一条`)
    } catch { dutySess = '' }
    if (dutySess) args.push('--session-id', dutySess)
    args.push('--json')
    args.push(promptFor(why))    // ⭐ 这一轮的工作目录 = 使用者（或别的用户）的**工作区** —— 只有这样它的 `AGENTS.md` 才会自动加载。
    // ⭐ 工作目录 = **插件家**：那一轮**被沙箱关着**，只写得了自己工作目录里的东西 ✗
    //    （2026-10-14 教训：为了让它读工作区里的 AGENTS.md 把 cwd 改成工作区 ⇒
    //      它写不了家目录里的 out/ 报告、整轮卡在"我是被沙箱关着的"上面打转 ✗；
    //      现在改成"设定由插件读进来、内联进提示词" ✓，cwd 回到插件家 ✓）
    /* ⭐ 工作目录 = **使用者的工作区**（2026-10-22 用户：「都搬进工作区哇，不然都要打开插件才能看到」）：
     *    会话是按 cwd 分桶的（`%DSH_HOME%/sessions/--D-harness-bili-dsh--`），跑在插件家里
     *    那些会话在界面里根本翻不到。
     *    ⚠️ 但工作区的沙箱只让写 cwd ⇒ 报告/判重表/归档写不进插件家目录，
     *      所以这三样改由 MCP 工具代写（见 promptFor 里那段「怎么交作业」）。
     *    ⭐ 2026-10-22 再加一层：「跑在哪个目录」单独可配（`dutyCwd`）——
     *      人设仍从「工作区」读，跑的位置可以是他日常那个目录，两者不再绑死。
     *    ⚠️ 都没配或不存在时退回插件家（老行为，报告照样能写）。 */
    const cwd = runDir()
    log(`开跑（${why === 'manual' ? '手动' : why === 'noon' ? '中午' : why === 'night' ? '夜间' : why}）· 模型 ${cfg.dutyProvider || '跟随默认'}/${cfg.dutyModel || '默认'} · 本轮上限 ${Number(cfg.perRoundMax) || 0} 条`)
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
    /* ⭐ 子进程输出写 run.log（不是 duty.log）—— 那是"原始输出流"，不是事件。
     *    每轮开跑前先清空 ⇒ 这个文件永远只装**最近一轮**，不会越长越大。
     *    写不进去就丢：这里是 stream 回调，抛一次就把整个宿主带走。 */
    try { writeFileSync(runLogFile, '', 'utf8') } catch { /* 清不掉也无所谓，继续追加 */ }
    let pickBuf = ''   // stdout 是按块来的，事件行可能被切断 ⇒ 先攒着，按 \n 切
    let sawSession = false
    const pick = (buf) => {
      const s = String(buf)
      try { appendFileSync(runLogFile, s, 'utf8') } catch { /* 绝不能抛 */ }
      /* ⭐ 顺手从事件流里捞 sessionId（第一轮才有），记下来供以后每轮续用。
       *    这里是 stream 回调 —— 任何异常都会带走整个宿主，所以整段包住、逐行 try。 */
      try {
        pickBuf += s
        const lines = pickBuf.split('\n')
        pickBuf = lines.pop() || ''
        for (const ln of lines) {
          const t = ln.trim()
          if (!t.startsWith('{')) continue
          try {
            const ev = JSON.parse(t)
            if (ev && ev.type === 'session' && ev.sessionId) {
              sawSession = true
            }
            if (ev && ev.type === 'session' && ev.sessionId && String(ev.sessionId) !== dutySess) {
              dutySess = String(ev.sessionId)
              try { writeJson(dutySessFile, { sessionId: dutySess, cwd, at: new Date().toISOString() }) } catch { /* 记不下来就下一轮再说 */ }
              log(`值班会话固定为 ${dutySess}（以后每轮都接着这条）`)
            }
          } catch { /* 半行/非 JSON 行跳过 */ }
        }
      } catch { /* 绝不能抛 */ }
    }
    child.stdout?.on('data', pick)
    child.stderr?.on('data', pick)
    dutyRun = { startedAt: Date.now(), why }
    const startedMs = Date.now()
    child.on('exit', (code) => {
      const tookSec = Math.round((Date.now() - startedMs) / 1000)
      dutyRun = null
      /* ⭐ 误删自愈（用户 2026-10-22：「误删了重启会自动创建」）：带 --session-id 跑完却一个
       *    session 事件都没拿到 ⇒ 那条会话被删了 ⇒ 把 id 清掉，下一轮自动新建一条。 */
      if (dutySess && !sawSession) {
        try { rmSync(dutySessFile, { force: true }); log('值守那条会话不见了（可能被删了），下一轮自动重建') } catch { /* 删不掉也无妨 */ }
      }
      stubReportIfMissing(code)   // ⭐ 没写报告就补一份占位 —— 别让使用者什么都看不到
      /* ⭐ 守护：这一轮的待回复清单用完就删 —— 留着的话下一轮会把同一批再塞进提示词，
       *    模型就会重复回同一批人（seen 表只挡"再扫出来"，挡不住"清单还在"） */
      try { rmSync(guardQueueFile, { force: true }) } catch { /* 删不掉也不影响这一轮 */ }
      rotateLogIfBig()            // ⭐ 日志别无声地长（三天 797KB ⇒ 一年约 100MB）
      /* ⭐ 结束事件带上"用时 + 挑中数 + 失败分类" —— 界面上直接能给一句人话，
       *    不用使用者自己去 duty.log 里翻。 */
      let pickedNow = 0
      try {
        const st = readJson(dutyStateFile, {})
        const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
        const picked = countPickedToday()   // 报告是事实来源、state 只是兜底（跟闸门同一个算法）
        pickedNow = picked
        if (picked > prev) bumpState({ picked })
      } catch (e) { log(`数挑了几条时出错（不影响这一轮）：${e?.message ?? e}`) }
      const fail = classifyRunFailure(code, tookSec)
      if (!fail) {
        log(`结束 · 用时 ${fmtDur(tookSec)} · 本轮挑中 ${pickedNow} 条（今天共 ${countPickedToday()} 条）`)
        // 这一轮成了 ⇒ 清掉上一次的失败记录（否则界面会一直挂着早就好了的错误）
        try { if (readJson(dutyStateFile, {}).lastError) bumpState({ lastError: null }) } catch { /* 清不掉也不影响 */ }
      } else {
        log(`结束但没成功 · 用时 ${fmtDur(tookSec)} · ${fail.hint}`)
        bumpState({ lastError: { at: new Date().toISOString(), ...fail } })
      }
      // ⭐ 发完评论之后**过一会儿再核一次**（2026-10-16 加的「评论发出后复核」）：
      //    接口回"发送成功"≠ 公开可见（新号/风控会进审核）；而"不公开"时连 @ 通知都不会推 ⇒
      //    插件会以为发了、下一轮不再发 ⇒ 一条都没到人。等 90 秒再查，避免把"还在审核"误判成"没发出去"。
      const verifyTimer = setTimeout(() => { Promise.resolve(runVerify('round')).catch((e) => log('复核异常：' + (e?.message ?? e))) }, 90_000)
      verifyTimer.unref?.()   // 别为了一次复核把宿主进程的退出拖住 90 秒
    })
    child.on('error', (e) => {
      dutyRun = null
      const err = String(e?.message ?? e)
      log(`起不来 · ${err}`)
      bumpState({ lastError: { at: new Date().toISOString(), code: 'spawn_failed', hint: '子进程起不来：' + err } })
    })
    return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile }
   } catch (e) {
    dutyRun = null
    log(`B站鱼塘开跑失败（${why}）：${e?.stack ?? e}`)
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
      if (chk.warn) log(chk.warn)
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

  /* ═══════════════════════════════════════════════════════════════════
   * 守护评论区（骑士团，2026-10-22）
   *
   * 要解决的事：使用者有个大号在发视频，想让**另一个号（骑士号）**替他盯着评论区 ——
   *   白名单里的人 @ 这个号（或在大号视频下评论）时，自动回一条像人说的话。
   *
   * 为什么不用骑士团权限（删评/删弹幕）：那套要粉丝数 + 实名认证，而且是在替大号管别人；
   *   这里要的是「这个号自己会说话」，只需要它自己的登录态 ⇒ 零门槛 ✓
   *
   * 两条输入（都只读，不改别人的东西）：
   *   ① @ 通知：`bili_guard_scan` 里走 `session.get_at` 增量拉（水位 = at_cursor）
   *   ② 评论区：大号最近 N 条视频按时间倒序翻页，只认白名单 UID
   *
   * 三道闸：白名单 UID（空 = 只认「要 @ 谁」那个）· 每轮条数上限 · 同一条评论只回一次（seen 表）
   * ⚠️ 幂等是硬要求：重复回同一条 = 在人家评论区刷屏，比不回更糟。
   * ⚠️ 定时器回调里绝不让异常外冒（2026-10-14 事故：未捕获异常杀掉整个宿主）。
   * ═══════════════════════════════════════════════════════════════════ */
  const guardStateFile = join(stateDir, 'guard-state.json')
  const guardQueueFile = join(stateDir, 'guard-queue.json')
  /* 守护记录：一行一条 JSON（jsonl）。**由两个进程写**：
   *   宿主写「扫到了什么、判成什么」（scan / queue），MCP 子进程写「实际发出去了什么」（reply）。
   *   为什么不靠模型自述：模型说「回了」不等于真发出去了，记录要能对得上 B站 那边的结果。 */
  const guardLogFile = join(stateDir, 'guard-log.jsonl')
  let guardLastAt = 0                    // 上次扫描的毫秒时间戳（轮询节流）
  let guardLast = { at: 0, queued: 0, skipped: '', error: '' }

  /** 当前守护配置（白名单解析 + 范围钳制都在这里，别在调用处再算一遍） */
  const guardCfg = () => {
    const wl = String(cfg.guardWhitelist || '')
      .split(/[\s,，、;；]+/)
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    /* ⭐ 白名单留空 = 只认「要 @ 谁」那个 UID（多数人只关心自己一个人 @ 它） */
    if (!wl.length && Number(cfg.mentionUid) > 0) wl.push(Number(cfg.mentionUid))
    /* ⭐ 自己的 UID：用来跳过「自己回自己」（否则模型一回，下一轮又把自己的回复当成新评论） */
    let selfUid = 0
    try { selfUid = Number(readJson(join(stateDir, 'bili_credential.json'), {}).dedeuserid || 0) || 0 } catch { selfUid = 0 }
    return {
      on: cfg.guardOn === true,
      whitelist: new Set(wl),
      ownerUid: Number(cfg.mentionUid) || 0,          // 大号：守它的投稿
      selfUid,                                        // 骑士号自己：跳过
      ownAll: cfg.guardOwnAll !== false,              // 大号视频下不用 @ 也回
      dailyCap: Math.max(0, Math.min(500, Number(cfg.guardDailyCap) || 0)),
      scope: Math.max(1, Math.min(10, Number(cfg.guardScope) || 1)),
      perRound: Math.max(1, Math.min(20, Number(cfg.guardPerRound) || 3)),
      pollMs: Math.max(1, Math.min(240, Number(cfg.guardPollMinutes) || 3)) * 60_000,
      emoji: cfg.guardEmoji !== false,
    }
  }

  /* ── 「这条评论值不值得回」───────────────────────────────────────
   * 用户 2026-10-22 定的口径：大号视频下**不用 @ 也回**，但「只回有内容的」——
   * 纯水（哈哈哈/666/顶/前排/纯表情）和广告不回。为什么不回纯水：
   *   一条热门视频下几十条「哈哈哈」全回，观感就是机器人，而且 B站 对高频回复有风控。
   * 判据：剥掉 @前缀/表情/标点后剩多少「话」；不足 6 个字但有问号（提问）也算有内容。
   * ──────────────────────────────────────────────────────────── */
  const GUARD_JUNK = /^(哈+|6+|顶+|第一|前排|来了|打卡|好耶|太棒了|支持|赞+|牛+|沙发|马克|mark|围观|路过|水)+$/i
  const GUARD_AD = /(加群|私信我|微信|vx|v信|qq群|代刷|互粉|互关|链接|https?:\/\/|www\.|淘|优惠券)/i
  const worthReplying = (text) => {
    if (typeof text !== 'string') return false      // 接口/老数据可能给 null/对象，别让 String() 把它们变成「有内容」
    /* ⚠️ 2026-10-22 实测踩到：B站的 @ 文本**没有分隔符** —— 真实数据是
     *    `@我的主人是吴彦祖总结这个视频`，昵称和正文粘在一起，按 `@\\S+` 剥会把正文一起吃掉
     *    （实测「总结这个视频」被判成纯水跳过）。所以这里**不剥 @ 前缀**：
     *    被 @ 到本身就说明有人想找你，字数判据对它天然成立。 */
    const t = text
    const core = t
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')   // 表情
      .replace(/[^\p{L}\p{N}?？!！,，.。~～]/gu, '')                              // 标点/空白
      .trim()
    if (!core) return false
    if (GUARD_JUNK.test(core)) return false
    if (GUARD_AD.test(t)) return false
    const han = (core.match(/[\u4e00-\u9fa5]/g) || []).length
    const len = core.length
    if (/[?？]/.test(t)) return len >= 3                       // 提问：短也算
    if (han >= 6 || len >= 8) return true                      // 有话说
    return /(吗|呢|么|怎么|如何|为什么|求|请问|能不能|有没有|多少|哪个)/.test(t)
  }

  const readGuard = () => {
    const d = readJson(guardStateFile, {})
    const daily = (d.daily && typeof d.daily === 'object') ? d.daily : {}
    return {
      atId: Number(d.atId) || 0,
      atTime: Number(d.atTime) || 0,
      ctimes: (d.ctimes && typeof d.ctimes === 'object') ? d.ctimes : {},
      seen: (d.seen && typeof d.seen === 'object') ? d.seen : {},
      /* ⭐ 已派出去、但**还没真发出去**的那些（rpid → {at: 派发时间, n: 第几次尝试}）。
       *    2026-10-22 用户实测：派发后值班进程 exit 1，一条都没发出去，
       *    可水位已经推进、seen 也记了 ⇒ 那几条永远丢了。有这张表才能补回重试。 */
      pending: (() => {
        const out = {}
        const raw = (d.pending && typeof d.pending === 'object') ? d.pending : {}
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string') out[k] = { at: v, n: 1 }          // 兼容第一版的纯时间戳写法
          else if (v && typeof v === 'object') out[k] = { at: String(v.at || new Date().toISOString()), n: Math.max(1, Number(v.n) || 1) }
        }
        return out
      })(),
      daily: { date: String(daily.date || ''), count: Number(daily.count) || 0 },
    }
  }

  /**
   * ⭐ 「今天已经回了几条」——**从守护记录里数真发出去的**（reply + ok:true），
   *    不以「派出去几条」为准。2026-10-22 用户抓到：界面显示「今天已回 3 条」，
   *    实际一条都没发出去（那次值班 exit 1）。计数必须能对账，否则这个数字就是骗人的。
   */
  const guardAnswered = () => {
    const today = dayKey(new Date())
    const all = new Set()
    const todaySet = new Set()
    for (const e of readGuardLog(500)) {
      if (e?.type !== 'reply' || e.ok !== true) continue
      const r = String(e.rpid || '')
      if (!r) continue
      all.add(r)
      if (dayKey(new Date(Number(e.ts) || 0)) === today) todaySet.add(r)
    }
    return { all, today: todaySet }
  }

  /** seen 表只留最近 7 天、最多 800 条 —— 它是「别重复回」的台账，不是档案 */
  const pruneSeen = (seen) => {
    const cut = Date.now() - 7 * 86_400_000
    const keep = Object.entries(seen)
      .filter(([, iso]) => { const t = Date.parse(String(iso)); return Number.isFinite(t) && t >= cut })
      .sort((a, b) => Date.parse(String(b[1])) - Date.parse(String(a[1])))
      .slice(0, 800)
    return Object.fromEntries(keep)
  }

  const saveGuard = (g) => {
    try { writeJson(guardStateFile, g) } catch (e) { log(`守护：状态写不进去（这一轮的结果会重复，注意）：${e?.message ?? e}`) }
  }

  /** 往守护记录里追加一行（jsonl）。超过 400KB 就轮转一次，只留最近那份 + 上一份 */
  const guardLogAppend = (entry) => {
    try {
      try { if (statSync(guardLogFile).size > 400_000) renameSync(guardLogFile, guardLogFile + '.1') } catch { /* 文件还不存在 */ }
      appendFileSync(guardLogFile, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) { log(`守护：记录写不进去（不影响回话）：${e?.message ?? e}`) }
  }

  /** 读最近 N 条（新的在前）；读坏了就当没有，别让记录把界面拖死 */
  const readGuardLog = (limit = 50) => {
    const out = []
    for (const f of [guardLogFile + '.1', guardLogFile]) {
      let text = ''
      try { text = readFileSync(f, 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 半行（进程被 kill）跳过 */ }
      }
    }
    out.sort((a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0))
    return out.slice(0, Math.max(1, Math.min(500, limit)))
  }

  /**
   * 扫一次（只扫、不回）：返回 { ok, queued, items, error }
   * ⚠️ 水位**无论如何都推进**：否则同一批 @ 会被反复扫出来（评论区那边同理，按 ctime 推进）。
   */
  const guardScan = async () => {
    const g = guardCfg()
    if (!g.on) return { ok: false, skipped: 'off' }
    if (!hasCredential()) return { ok: false, skipped: 'no-cred' }
    /* ⭐ 白名单只在「不开大号视频全回」时才是硬门槛（2026-10-22 用户澄清：
     *    大号视频下不用 @ 也回，所以那条路不需要白名单） */
    if (!g.ownAll && !g.whitelist.size) return { ok: false, skipped: 'no-whitelist' }

    const st = readGuard()

    /* ⭐ 对账（2026-10-22 用户实测抓到的坑）：上一轮**派出去**的，只有真的在守护记录里
     *    出现 `reply ok:true` 才算回过；没发出去的下轮接着回，不能因为「派过」就当成回过。
     *    以前派发即记 seen + 水位同时推进 ⇒ 值班一挂，那几条就永远丢了。 */
    const answered = guardAnswered()
    for (const [rpid, p] of Object.entries(st.pending)) {
      if (answered.all.has(rpid)) { st.seen[rpid] = p.at; delete st.pending[rpid] }
    }
    /* ⭐ 旧版本（1.3.0 早期）「派发即记 seen」留下的账：seen 里有、但守护记录里没有 ok 回执的，
     *    说明当时根本没发出去 —— 把它们当成 pending 补回来（只回溯 2 天，别把陈年老账翻出来重发）。 */
    const legacyCut = Date.now() - 2 * 86_400_000
    for (const [rpid, iso] of Object.entries(st.seen)) {
      if (answered.all.has(rpid) || st.pending[rpid]) continue
      const t = Date.parse(String(iso))
      if (!(t >= legacyCut)) continue
      st.pending[rpid] = { at: String(iso), n: 1 }
      delete st.seen[rpid]
    }
    /* ⭐ 上一轮没发出去的，捞回来重试（水位已经越过它们了，只能从状态里补）。
     *    ⚠️ 2026-10-22 第二轮实测踩到：**不能靠 `guard-queue.json`** —— 提示词一构建清单就被删了，
     *    值班挂了清单也没了，pending 里只剩个 rpid，于是「派 0 条」永远补不回来。
     *    所以：① 派发时把条目细节一起存进 pending ② 老数据没有细节的，从守护记录的 queue 行还原。 */
    let retry = []
    if (Object.keys(st.pending).length) {
      const logged = new Map()
      for (const e of readGuardLog(200)) {
        if (e?.type !== 'queue' || !e.rpid) continue
        if (!logged.has(String(e.rpid))) logged.set(String(e.rpid), e)
      }
      for (const [rpid, p] of Object.entries(st.pending)) {
        const it = p?.item || logged.get(rpid)
        if (!it) { delete st.pending[rpid]; continue }   // 细节还原不出来就别占着重试位
        retry.push({
          kind: String(it.kind || 'comment'),
          bvid: String(it.bvid || ''),
          rpid: Number(it.rpid) || Number(rpid),
          uid: Number(it.uid) || 0,
          uname: String(it.uname || ''),
          text: String(it.text || ''),
        })
      }
    }

    /* ① 守哪几条视频：大号自己的最近投稿（拿不到就只扫 @ 通道） */
    let bvids = []
    if (g.ownerUid > 0) {
      try {
        const uv = await call('bili_user_videos', { uid: g.ownerUid, pn: 1, ps: g.scope, order: 'pubdate' })
        const list = Array.isArray(uv?.videos) ? uv.videos : (Array.isArray(uv) ? uv : [])
        bvids = list.map((v) => String(v?.bvid || '')).filter(Boolean).slice(0, g.scope)
      } catch (e) {
        log(`守护：取大号投稿失败（这次只扫 @ 通道）：${e?.message ?? e}`)
      }
    }
    const sinceCt = {}
    for (const b of bvids) sinceCt[b] = Number(st.ctimes[b] || 0)

    /* ② 扫 */
    let scan = null
    try {
      scan = await call('bili_guard_scan', {
        bvids,
        since_at_id: st.atId || 0,
        since_at_time: st.atTime || 0,
        since_ctimes: sinceCt,
        max_pages: 3,
      }, { timeoutMs: 150_000 })
    } catch (e) {
      const err = String(e?.message ?? e)
      guardLast = { at: Date.now(), queued: 0, skipped: '', error: err }
      return { ok: false, error: err }
    }
    const ats = Array.isArray(scan?.at) ? scan.at : []
    const cms = Array.isArray(scan?.comments) ? scan.comments : []

    /* ③ 过滤：白名单 + 别回自己 + 别重复 */
    const fresh = []
    /* ⭐ 跨通道去重（2026-10-22 实测踩到）：白名单的人 @ 这个号的那条评论，**本身也是**大号视频下的
     *    顶层评论 ⇒ @ 通道和评论通道会给出同一个 rpid。不在这里按 rpid 去重，同一轮就会回两次。 */
    const seenRpid = new Set()
    const skip = { junk: 0, owner: 0, seen: 0, wl: 0 }   // 只为了记进日志：为什么这条没回
    for (const it of ats) {
      const uid = Number(it?.uid || 0)
      const rpid = Number(it?.rpid || 0)
      if (!uid || !rpid) continue
      if (!g.whitelist.has(uid)) { skip.wl++; continue }
      if (g.selfUid && uid === g.selfUid) { skip.owner++; continue }
      if (st.seen[String(rpid)] || seenRpid.has(rpid)) { skip.seen++; continue }
      seenRpid.add(rpid)
      fresh.push({
        kind: 'at', uid, rpid,
        uname: String(it?.uname || ''), bvid: String(it?.bvid || ''),
        title: String(it?.title || ''), text: String(it?.text || ''),
        ctime: Number(it?.at_time || 0),
      })
    }
    for (const c of cms) {
      const uid = Number(c?.uid || 0)
      const rpid = Number(c?.rpid || 0)
      if (!uid || !rpid) continue
      /* ⭐ 大号自己发的评论不用替他回（2026-10-22 实测：他自己在评论区补充技术细节，
       *    小号再去接一句就很怪）。他要是 @ 了小号，走 @ 通道，那边照回。 */
      if (g.ownerUid && uid === g.ownerUid) { skip.owner++; continue }
      /* ⭐ 大号自己的视频下（comments 通道扫的就是大号投稿）：
       *    ownAll 时**不看白名单**，但只回「有内容的」；关掉 ownAll 就退回白名单口径。 */
      if (g.ownAll) {
        if (!worthReplying(c?.text)) { skip.junk++; continue }
      } else if (!g.whitelist.has(uid)) { skip.wl++; continue }
      if (g.selfUid && uid === g.selfUid) { skip.owner++; continue }
      if (st.seen[String(rpid)] || seenRpid.has(rpid)) { skip.seen++; continue }
      seenRpid.add(rpid)
      fresh.push({
        kind: 'comment', uid, rpid,
        uname: String(c?.uname || ''), bvid: String(c?.bvid || ''),
        title: '', text: String(c?.text || ''),
        ctime: Number(c?.ctime || 0),
      })
    }

    /* ④ 推进水位（即使这一轮没东西可回也要推，否则下次还扫同一批） */
    const cur = scan?.at_cursor || {}
    const ctimes = { ...st.ctimes }
    for (const c of cms) {
      const b = String(c?.bvid || '')
      const t = Number(c?.ctime || 0)
      if (b && t > Number(ctimes[b] || 0)) ctimes[b] = t
    }
    const nextAtId = Math.max(st.atId || 0, Number(cur.id) || 0)
    const nextAtTime = Math.max(st.atTime || 0, Number(cur.time) || 0)

    /* ⑤ 取前 N 条入队。**派发只记 pending，不记 seen** —— 只有真发出去（守护记录里 ok:true）
     *    才算回过；没发出去的下一轮从清单里捞回来重试（见上面那段对账）。 */
    /* ⭐ 每日硬上限（用户 2026-10-22：「可以设置啊」）：跨所有视频合计，防止一觉醒来刷几百条。
     *    计数以「真发出去」为准（guardAnswered），不以「派出去」为准。 */
    const today = dayKey(new Date())
    const daily = { date: today, count: answered.today.size }
    const room = g.dailyCap > 0 ? Math.max(0, g.dailyCap - daily.count) : Infinity
    /* 重试的排前面：它们已经等过一轮了；同一 rpid 试满 3 次还发不出去就放弃（评论删了/权限没了，别死循环） */
    const MAX_TRY = 3
    const ordered = []
    const usedRpid = new Set()
    let gaveUp = 0
    for (const it of [...retry, ...fresh]) {
      const k = String(it?.rpid || '')
      if (!k || usedRpid.has(k)) continue
      const p = st.pending[k]
      if (p && p.n >= MAX_TRY) { delete st.pending[k]; gaveUp++; continue }
      usedRpid.add(k)
      ordered.push(it)
    }
    const take = ordered.slice(0, Math.min(g.perRound, room))
    const nowIso = new Date().toISOString()
    for (const t of take) {
      const k = String(t.rpid)
      const p = st.pending[k]
      /* 条目细节跟着 pending 一起存：清单文件会被提示词构建删掉，挂了就只剩这个能还原 */
      st.pending[k] = {
        at: nowIso, n: (p?.n || 0) + 1,
        item: { kind: t.kind, bvid: t.bvid, rpid: t.rpid, uid: t.uid, uname: t.uname, text: String(t.text || '').slice(0, 300) },
      }
    }
    /* pending 只留 2 天：再老的回不动了，别一直占着重试位 */
    const pendCut = Date.now() - 2 * 86_400_000
    for (const [rpid, p] of Object.entries(st.pending)) {
      if (Date.parse(String(p?.at)) < pendCut) delete st.pending[rpid]
    }
    if (gaveUp) log(`守护：${gaveUp} 条试了 ${MAX_TRY} 次都没发出去，放弃（可能评论被删/权限变了）`)
    saveGuard({ atId: nextAtId, atTime: nextAtTime, ctimes, seen: pruneSeen(st.seen), pending: st.pending, daily })

    /* ⑥ 记录：扫了什么、为什么跳过、哪些派出去回了（界面「守护记录」读的就是这份） */
    guardLogAppend({
      ts: Date.now(), type: 'scan', bvids,
      scanned: { at: ats.length, comments: cms.length },
      queued: take.length, skip,
      daily: { date: daily.date, count: daily.count, cap: g.dailyCap },
    })
    for (const t of take) {
      guardLogAppend({
        ts: Date.now(), type: 'queue', kind: t.kind, bvid: t.bvid, rpid: t.rpid,
        uid: t.uid, uname: t.uname, text: String(t.text || '').slice(0, 300),
      })
    }

    guardLast = { at: Date.now(), queued: take.length, skipped: room === 0 ? 'daily-cap' : '', error: '' }
    if (!take.length) {
      if (room === 0) log(`守护：今天的额度用完了（上限 ${g.dailyCap} 条），明天再回`)
      return { ok: true, queued: 0, skipped: room === 0 ? 'daily-cap' : '', daily: { date: daily.date, count: daily.count, cap: g.dailyCap }, scanned: { at: ats.length, comments: cms.length } }
    }

    try {
      writeJson(guardQueueFile, { at: nowIso, items: take })
    } catch (e) {
      return { ok: false, error: `待回复清单写不进去：${e?.message ?? e}` }
    }
    return { ok: true, queued: take.length, items: take, daily: { date: daily.date, count: daily.count, cap: g.dailyCap }, scanned: { at: ats.length, comments: cms.length } }
  }

  /** 提示词里那段「这一轮有 N 条等着你回」——队列空了就一个字都不加 */
  const guardPromptPart = () => {
    if (cfg.guardOn !== true) return ''
    let items = []
    try { const q = readJson(guardQueueFile, {}); items = Array.isArray(q?.items) ? q.items : [] } catch { items = [] }
    if (!items.length) return ''
    const emojiRule = cfg.guardEmoji !== false
      ? '末尾加**一个**贴切的表情（一个就够，别堆）。'
      : '别加表情，就写干净的话。'
    /* 守护口径：用户写几句「我是谁 / 能答什么 / 什么不能答」，比逐条视频描述管用得多 */
    const tone = String(cfg.guardTone || '').trim()
    return `\n\n===== 守护评论区：这一轮有 ${items.length} 条等着你回 =====\n`
      + `你是**这个号本人**（不是大号）。主人这会儿没空看评论，你替他回。**每条都要回一条**，用 \`bili_reply\` 精确回到他那条评论上：\n`
      + items.map((it, i) => `${i + 1}. [${it.kind === 'at' ? '@ 通知' : '评论区'}] ${it.uname}（UID ${it.uid}）· 视频 ${it.bvid}`
        + (it.title ? `《${String(it.title).slice(0, 60)}》` : '')
        + `\n   他说：${String(it.text || '').slice(0, 300)}\n   rpid=${it.rpid}`).join('\n')
      + (tone ? `\n\n主人的口径（照这个说话，别越界；跟这条冲突就以这条为准）：\n${tone}\n` : '')
      + `\n\n怎么回：\n`
      + `① 先看内容：\`bili_subtitle\` 拿字幕；没字幕就只看标题+简介，**别凭空编视频里没有的东西**。\n`
      + `   （「他说」里开头的 \`@某某\` 是 @ 人留下的前缀，不是他要说的话，忽略它。）\n`
      + `② 他给了指令（比如「总结这个视频」）就照做；只是 @ 你一下就简短回应，别硬凑。\n`
      + `③ **开一句说明你是代回**（用户 2026-10-22 定的口径）—— 比如「主人这会儿在忙，我先替他回一句」；`
      + `但别每条都用同一个句式，换着说，别像模板。\n`
      + `④ 一条 1–3 句、**120 字以内**，像人说话，别写成报告。${emojiRule}\n`
      + `⑤ **必须带 rpid**：\`bili_reply(bvid="<上面的 BV 号>", text="...", rpid=<上面的 rpid>)\` —— 不带就是新开一条评论，等于答错地方。\n`
      + `⑥ 每条只回一次；某条回不出去（风控/被删）就记进报告，**别重试刷屏**。\n`
      + `===== 守护任务结束 =====\n`
  }

  let guardBusy = false
  const guardTick = async () => {
    if (guardBusy) return
    guardBusy = true
    try {
      refreshCfg()
      const g = guardCfg()
      if (!g.on) return
      if (Date.now() - guardLastAt < g.pollMs) return     // 没到点
      guardLastAt = Date.now()
      if (dutyRun) { log('守护：上一轮还在跑，这次先不扫'); return }
      const r = await guardScan()
      if (r?.queued > 0) {
        log(`守护：扫到 ${r.queued} 条待回复（${r.items.map((i) => i.uname || i.uid).join('、')}）`)
        const rr = await runDutySafe('guard')
        if (rr && rr.started === false) log(`守护那一轮没跑成：${rr.error || '未知原因'}`)
      } else if (r && r.error) {
        log(`守护：这次没扫成（${r.error}）`)
      }
    } catch (e) {
      log(`守护这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    } finally { guardBusy = false }
  }

  try {
    /* ⭐ 用 60 秒一跳去「看时间到没到」而不是直接把间隔设成 pollMs：
     *    使用者在设置页改「几分钟扫一次」时，不用重启宿主就能生效 ✓ */
    const gt = setInterval(() => { guardTick().catch((e) => log(`守护定时器异常：${e?.message ?? e}`)) }, 60_000)
    gt.unref?.()
    ctx.effect(() => () => clearInterval(gt), 'bili-pond: 守护定时器')
  } catch (e) { log(`守护定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── 私信遥控（2026-10-22 用户的想法）───────────────
   * 主人在手机上给这个小号发一条 `# 状态`，这边扫到就执行、再私信回一条。
   * 第一版**只做只读命令**（状态 / 记录 / 帮助）：私信能控制电脑这件事，
   * 先把通道验通、再放写操作 —— 出错代价比回错一条评论大得多。
   * 闸门：① 只认 owner UID（大号）② 只认 # 前缀 ③ 按 msg_key 去重
   *      ④ 每日条数上限 ⑤ 只处理 24 小时内的消息（第一次打开不会把历史私信全执行一遍）
   */
  const dmStateFile = join(stateDir, 'dm-state.json')
  /* ⭐ 值班那条固定会话的 id（2026-10-22 用户：值班轮也进同一条对话，不然没有上下文） */
  const dutySessFile = join(stateDir, 'duty-session.json')
  const dmCfg = () => {
    const owner = Number(cfg.mentionUid) || 0
    return {
      on: cfg.dmCtlOn === true && owner > 0,
      owner,
      prefix: String(cfg.dmCtlPrefix || '#').trim() || '#',
      pollMs: Math.max(1, Math.min(240, Number(cfg.dmCtlPollMinutes) || 5)) * 60_000,
      dailyCap: Math.max(0, Math.min(500, Number(cfg.dmCtlDailyCap ?? 30))),
      askCap: Math.max(0, Math.min(200, Number(cfg.dmCtlAskCap ?? 20))),
    }
  }
  const readDm = () => {
    const d = readJson(dmStateFile, {})
    const daily = (d.daily && typeof d.daily === 'object') ? d.daily : {}
    const ask = (d.ask && typeof d.ask === 'object') ? d.ask : {}
    return {
      lastTs: Number(d.lastTs) || 0,
      keys: (d.keys && typeof d.keys === 'object') ? d.keys : {},
      daily: { date: String(daily.date || ''), count: Number(daily.count) || 0 },
      /* 「# 问 …」那条会话：固定 id 续着用，别在会话列表里刷一堆 */
      sessionId: String(d.sessionId || ''),
      /* 热窗口：扫到过消息后 10 分钟内改成 20 秒一拉（自适应节奏） */
      hotUntil: Number(d.hotUntil) || 0,
      ask: { date: String(ask.date || ''), count: Number(ask.count) || 0 },
    }
  }
  const saveDm = (s) => {
    try { writeJson(dmStateFile, s) } catch (e) { log(`私信遥控：状态写不进去：${e?.message ?? e}`) }
  }

  /* ⭐ 2026-10-22 用户澄清后重写：这里**不是命令表**，是「跟我聊天」的说明书 ——
   *    他能发视频链接让我分析、能问本地情况、能接着上一句聊。 */
  const dmHelpText = (p) => '私信这边就是跟我聊天：\n'
    + `直接发消息就行，前缀 ${p} 可写可不写（写了当标点，没写也认）。\n`
    + '· 甩个视频链接 / BV 号 —— 我去取字幕和简介，看完再跟你说\n'
    + '· 问我这边的情况 —— 「今天回了多少」「守护开着吗」「最近回了谁」\n'
    + '· 让我查/找 —— 搜 B站、翻某个 UP 的投稿、看某条视频的评论\n'
    + `· ${p} 帮助 —— 这条\n`
    + '只认你本人（大号）发的；别人发什么都不理。\n'
    + '每条消息都会起一轮（视频分析可能等一两分钟，我先回你一句「收到」），'
    + '全部进同一条会话，翻会话就能看到完整聊天记录。\n'
    + '⚠️ 别在私信里发密码/密钥 —— B站私信不加密，存在他们服务器上。'

  const dmStatusText = () => {
    const answered = guardAnswered()
    const g = guardCfg()
    const pend = Object.keys(readGuard().pending).length
    const last = guardLast?.at ? new Date(guardLast.at).toLocaleTimeString('zh-CN', { hour12: false }) : '还没跑过'
    return `今天已回 ${answered.today.size} 条${g.dailyCap ? `（上限 ${g.dailyCap}）` : '（不限）'}`
      + `\n还有 ${pend} 条没回出去，下一轮补`
      + `\n守护：${g.on ? '开着' : '关着'} · 每轮最多回 ${g.perRound} 条`
      + `\n上一轮：${last}`
  }

  const dmLogText = (n = 5) => {
    const items = readGuardLog(60).slice(0, n)
    if (!items.length) return '还没有守护记录。'
    return items.map((e) => {
      const t = new Date(Number(e.ts) || 0).toLocaleTimeString('zh-CN', { hour12: false })
      if (e.type === 'scan') return `${t} 扫 @${e.scanned?.at ?? 0} / 评论 ${e.scanned?.comments ?? 0} → 派 ${e.queued ?? 0} 条`
      if (e.type === 'queue') return `${t} 待回 ${e.uname || e.uid}：${String(e.text || '').slice(0, 24)}`
      if (e.type === 'reply') return `${t} ${e.ok ? '回了' : '没回成'} ${String(e.uname || e.uid || '')}`
      if (e.type === 'dm') return `${t} 私信命令：${String(e.cmd || '').slice(0, 24)}`
      return `${t} ${e.type}`
    }).join('\n')
  }

  /** 纯解析：一条私信 → 该回什么（**前缀可选**：2026-10-22 用户定「不用 #，当聊天」） */
  const dmAnswer = (text) => {
    const { prefix } = dmCfg()
    const raw = String(text || '').trim()
    if (!raw) return ''
    /* 前缀可写可不写：写了就剥掉，没写就整条当命令/聊天 */
    const body = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw
    if (!body) return ''
    const cmd = body.toLowerCase()
    if (/^(状态|status|s)$/.test(cmd)) return dmStatusText()
    if (/^(记录|log|logs)$/.test(cmd)) return dmLogText(5)
    if (/^(帮助|help|\?|？)$/.test(cmd)) return dmHelpText(prefix)
    /* ⭐ 不再回「这条还不认识」（2026-10-22 用户实测：模型轮失败时兜底甩了这句，像机器人）。
     *    现在兜底只负责「状态/记录/帮助」这类本地能答的；别的返回空 ⇒ 上层用「这轮没跑成」的话术。 */
    return ''
  }

  /**
   * 「# 问 …」：真起一轮 headless 去干活（约 10 秒），把最终答复拿回来。
   * 为什么用 `--json`：能同时拿到 ① 这条会话的 sessionId（下次 `--session-id` 续上）
   *   ② `final` 事件里的正文（纯文本模式也行，但那样拿不到会话 id）。
   * 为什么固定一个会话：否则每问一句就在会话列表里留一条新会话，问几次就刷满一屏。
   */
  /**
   * 拼给模型看的「宿主实时数据」——命令轮的回答只能引用这里，别让它编。
   * ⭐ 2026-10-22 用户定的口径：所有私信命令都进同一条会话（面板没人盯，会话才是能翻的记录），
   *    所以状态/记录/帮助这些原本宿主自己就能拼的答案，现在也交给模型「说出来」，
   *    但**数字必须来自这里**，不许它自己编。
   */
  const dmContext = () => {
    const parts = []
    try { parts.push(dmStatusText()) } catch { /* 状态拼不出来就少一段 */ }
    try { parts.push(dmLogText(5)) } catch { /* 记录读不到就只给状态 */ }
    try { parts.push(dmHelpText(String(cfg.dmCtlPrefix || '#'))) } catch { /* 帮助拼不出来也无妨 */ }
    return parts.filter(Boolean).join('\n\n')
  }

  /* ⭐ 发出去 ≠ 送到了（2026-10-22 实测）：`bili_send_message` 回 `success:true`、msg_key 也有，
   *    可 B站 会话里根本没有这条 —— 带链接/偏长的私信会被静默吞掉。
   *    所以发完**回读一次**：没看到就削掉链接、缩短再发一次；两次都不行就当失败记下来。 */
  const dmDeliver = async (text, owner) => {
    const body = String(text || '').slice(0, 480)
    if (!body.trim()) return false
    const probeOf = (s) => String(s).replace(/\s+/g, '').slice(0, 10)
    const seen = async (probe) => {
      try {
        const raw = await call('bili_dm_inbox', { uid: owner, limit: 8 })
        const d = typeof raw === 'string' ? JSON.parse(raw) : raw
        return (d?.items || []).some((it) => it.dir === 'out' && String(it.text || '').includes(probe))
      } catch { return true }   // 校验本身失败 ⇒ 当已送到（宁可漏报，也别把同一句话发两遍）
    }
    await call('bili_send_message', { receiver_uid: owner, text: body })
    await new Promise((r) => setTimeout(r, 1500))
    if (await seen(probeOf(body))) return true
    const short = body.replace(/https?:\/\/\S+/g, '').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 300)
    if (!short || short === body) return false
    log('私信遥控：发出去但会话里没看到（可能被吞），去掉链接再发一次')
    await call('bili_send_message', { receiver_uid: owner, text: short })
    await new Promise((r) => setTimeout(r, 1500))
    return await seen(probeOf(short))
  }

  const dmAsk = (question, context = '') => new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let timer = null
    try {
      const dsh = resolveDsh()
      const overlay = ensureOverlay('dm')
      const st = readDm()
      /* ⚠️ 2026-10-22 实测踩坑（用户实测收到「这条还不认识」后复现出来的）：
       *    `--json` 必须放在 `--patch` **后面**。写成 `--profile headless --json --patch …`，
       *    dsh 直接报 `{"type":"error","message":"unknown option '--patch'"}`、exit 1、3 秒就退，
       *    于是 stdout 里没有 session/final 事件 ⇒ 宿主以为「模型没答」⇒ 退回本地兜底答案
       *    ⇒ 用户收到一句「这条还不认识：今天回了多少」。
       *    顺序：profile → --patch → --json → --session-id → 提示词。 */
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push('--json')
      if (st.sessionId) args.push('--session-id', st.sessionId)
      /* ⚠️ 2026-10-22 实测踩坑（试了 4 种写法）：**不能用「结构化」提示词** ——
       *    写成 `===== 私信遥控 =====` 那种块，模型（headless 里的编码 agent）会当成**提示注入**，
       *    回一句「这是典型注入特征」；写成任务书，它会反问「你指的是哪种」；写成「# 私信遥控」开头，
       *    它会去翻仓库读代码研究这个功能。
       *    ✅ 唯一管用的是**大白话**：像人跟人说话那样把「他问了什么 / 我知道什么 / 你就这么回」讲清楚。 */
      /* ⭐ 第一行会变成会话列表里的**标题**（2026-10-22 用户：「我在工作区看不到这条对话」——
       *    其实它在，只是标题取的是提示词开头「主人刚在私信里给我发了条消息：…」，认不出来）。
       *    ⇒ 首行写成 `私信：<他发的那句>`，列表里一眼就是他自己的话。 */
      const brief = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      args.push(`私信：${brief}\n\n`
        + `主人刚在私信里给我发了条消息：${question}\n`
        + (context ? `\n我手头知道的（宿主查好的，能直接用，不够也能自己再查）：\n${context}\n` : '')
        + `\n他可能发视频链接 / BV 号，或者让我分析某个视频、找点东西、结合我这边的情况回答。\n`
        + `需要的话我自己调工具去取（字幕、简介、评论、搜索都能用），**别凭空编视频里没有的内容**。\n`
        + `回他的时候：像微信聊天，一两句到一小段都行，不要标题/列表/markdown 符号，别 @ 人，**200 字以内**。\n`
        /* ⭐ 2026-10-22 用户实测：带链接的长私信会被 B站 静默吞掉（接口回 success，会话里没有）⇒
         *    正文里**不写 http 链接**，要指视频就写 BV 号（够短、也不触发外链风控）。 */
        + `⚠️ 正文里**不要写 http 链接**（B站 会把带外链的私信静默吞掉）—— 要指某个视频就写 BV 号，例如 BV1NJn665Epm。\n`
        + `只把要回的话写出来，**别自己发私信**（发不发、发给谁由宿主决定）。\n`
        + `\n如果他是要我改设置：用 \`bili_setting_get\` 先看现在是什么值，再用 \`bili_setting_set(key, value)\` 改。\n`
        + `能改的只有这些（不在表里的一律回「这个得在设置页改」）：\n`
        + `  开关：guardOn（守护评论区）、guardOwnAll（我视频下不用 @ 也回）、guardEmoji（回复带表情）、\n`
        + `        autoRun（自动跑）、peakValleyOnly（只在低谷跑）、noon / night（中午 / 夜间跑）、\n`
        + `        transcribe（本地转写）、preferSubtitle（优先字幕）、autoComment（发公开评论）、\n`
        + `        replyToComments（回复评论）、dmOn（值班轮发私信）\n`
        + `  数字：guardDailyCap（守护每天最多几条，0-500）、guardPerRound（每轮几条，1-20）、\n`
        + `        guardScope（守最近几条视频，1-10）、guardPollMinutes（几分钟扫一次，1-240）、\n`
        + `        autoRunsPerDay（一天自动跑几次，0-48）、autoGapMinutes（间隔分钟，5-1440）、\n`
        + `        perRoundMax / perDayMax（每轮 / 每天挑几条）、minDurationMin / maxDurationMin（时长下限/上限分钟）、\n`
        + `        transcribePerDay（每天转写几条）\n`
        + `  文本：keywords（关键词，逗号分隔）、reportLevel（full / brief）、asrModel（tiny/base/small/medium/large）\n`
        + `  ⚠️ autoRun / autoComment / replyToComments / dmOn 这几项会「开始定时花钱」或「对外说话」：\n`
        + `     第一次调用会返回 need_confirm=true，**必须先用一句话问他确认**，他同意了再带 confirm=true 调一次。\n`
        + `  ⚠️ 收件人、目录、白名单、凭证**改不了**（不在表里），别答应他。\n`
        + `  改完回一句人话，例如「好了，守护每天最多 10 条了」。`)
      /* ⚠️ 2026-10-22 实测：cwd 必须是**空目录**。放在 stateDir 里，模型会去翻 duty.md / out/ 报告 /
       *    config.json，然后自己编一段「今天干了什么」的回答（实测它甚至声称「已回复主人私信」）。
       *    空目录里它没东西可翻，就老老实实按上面给的数据回话。 */
      const dmHome = join(stateDir, 'dm-home')
      try { mkdirSync(dmHome, { recursive: true }) } catch { /* 建不出来就用 stateDir 兜底 */ }
      /* ⭐ 2026-10-22 用户问「你测试的那条对话去哪了」—— 真相：会话按 **cwd** 分桶
       *    （%DSH_HOME%/sessions/--D-harness-- 这种）。我测的时候 cwd 是 stateDir 下的空目录，
       *    于是会话落在 bili-duty 那个桶里，他在自己的工作区列表里根本看不到。
       *    ⇒ 这一轮的工作目录用**使用者配的工作区**（那里通常就是他的 AGENTS.md 人设所在，
       *      模型顺便能按人设说话）；工作区没配/不存在时才退回空目录。
       *    ⚠️ 但**绝不能**用 stateDir 本身：那儿有 duty.md / out/ 报告 / config.json，
       *      模型会去翻，然后自己编一段「今天干了什么」（实测它甚至声称「已回复主人私信」）。 */
      /* ⭐ 2026-10-22：「跑在哪个目录」跟值班轮共用同一套（runDir），人设仍从工作区读。 */
      const cwdDir = runDir()
      const child = spawn(dsh.command, args, {
        cwd: cwdDir, shell: dsh.shell, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({ BILI_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
      })
      let acc = ''
      let errAcc = ''
      let finalText = ''
      let sid = ''
      const onLine = (line) => {
        if (!line.trim()) return
        let ev = null
        try { ev = JSON.parse(line) } catch { return }
        if (ev?.sessionId) sid = String(ev.sessionId)   // 事件类型不止一种带 sessionId，见一个记一个
        if (ev?.type === 'session' && ev.sessionId) sid = String(ev.sessionId)
        if (ev?.type === 'final' && typeof ev.text === 'string') finalText = ev.text
      }
      child.stdout?.on('data', (b) => {
        acc += String(b)
        const lines = acc.split('\n')
        acc = lines.pop() ?? ''
        for (const l of lines) onLine(l)
      })
      /* stderr 留着只为诊断（私信正文不用它）：失败时把尾巴写进 duty.log，别让「这一轮为什么没答」没处查 */
      child.stderr?.on('data', (b) => { errAcc = (errAcc + String(b)).slice(-600) })
      timer = setTimeout(() => {
        try { child.kill() } catch { /* 无妨 */ }
        finish({ text: '', error: '超时（300 秒没答完）' })
      }, 300_000)
      timer.unref?.()
      child.on('error', (e) => { if (timer) clearTimeout(timer); finish({ text: '', error: `起不来：${e?.message ?? e}` }) })
      child.on('exit', (code) => {
        if (timer) clearTimeout(timer)
        if (acc.trim()) onLine(acc)
        if (sid) { try { const s = readDm(); s.sessionId = sid; saveDm(s) } catch { /* 记不住就算了 */ } }
        /* ⭐ 误删自愈（用户 2026-10-22：「误删了重启会自动创建」）：
         *    带 --session-id 却一个 session 事件都没拿到 ⇒ 那条会话没了（被删了/换了目录）
         *    ⇒ 把 id 清掉，下一轮自动新建一条。
         *    ⚠️ 2026-10-22 实测踩到：上一轮还没退干净时 dsh 报
         *      `session "…" is already owned by an active write handle` —— 那是**占着**，不是删了。
         *      旧代码不看错误内容就清 id ⇒ 每撞一次锁就丢一条会话（用户看到的就是「一轮对话后又换了」）。 */
        if (!sid) {
          const locked = /already owned|active write handle|locked|in use/i.test(errAcc || '')
          try {
            const s = readDm()
            if (!s.sessionId) { /* 本来就没有，无需处理 */ } else if (locked) {
              log('私信那条会话正被上一轮占着（不是被删），这一轮先不换')
            } else {
              s.sessionId = ''
              saveDm(s)
              log('私信那条会话不见了（可能被删了），下一轮自动重建')
            }
          } catch { /* 清不掉也无妨 */ }
        }
        const text = String(finalText || '').trim()
        if (!text) {
          /* ⭐ 没拿到答复必须留下证据（2026-10-22：用户只看到一句「这条还不认识」，日志里什么都没有） */
          const tail = (errAcc || '').replace(/\s+/g, ' ').trim().slice(0, 300)
          log(`私信遥控：这一轮没跑成（exit=${code}）${tail || 'stdout 里没有 final 事件'}`)
        }
        finish({ text, sessionId: sid, error: text ? '' : `这一轮没答出来（exit=${code}）` })
      })
    } catch (e) {
      if (timer) clearTimeout(timer)
      finish({ text: '', error: String(e?.message ?? e) })
    }
  })

  let dmBusy = false
  let dmLastAt = 0
  /* ⭐ 两条固定会话（用户 2026-10-22：「装完插件自动创建两个对话，名字就是 B站私信和 B站值守，
   *    标题后面写上误删 —— 如果不小心删除了，重启会自动创建」）。
   *    会话标题取**第一条消息**，所以创建时就把标题当首行发出去；之后所有轮次都续这一条。
   *    误删自愈：runDuty / dmAsk 带着 --session-id 却拿不到 session 事件 ⇒ 清掉 id，下一轮重建。 */
  const createSession = (titleLine, bodyLine, why) => new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(String(v || '')) } }
    try {
      const dsh = resolveDsh()
      const overlay = ensureOverlay(why)
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push('--json')
      args.push(`${titleLine}\n\n${bodyLine}\n\n收到就回两个字：好的。`)
      const child = spawn(dsh.command, args, {
        cwd: runDir(), shell: dsh.shell, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({ BILI_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
      })
      let acc = ''
      let sid = ''
      const eat = (line) => {
        const s = String(line || '').trim()
        if (!s) return
        try { const ev = JSON.parse(s); if (ev?.type === 'session' && ev.sessionId) sid = String(ev.sessionId) } catch { /* 半行就跳过 */ }
      }
      const timer = setTimeout(() => { try { child.kill() } catch { /* 无妨 */ } ; finish(sid) }, 180_000)
      timer.unref?.()
      child.stdout?.on('data', (b) => {
        acc += String(b)
        const lines = acc.split('\n')
        acc = lines.pop() ?? ''
        for (const l of lines) eat(l)
      })
      child.stderr?.on('data', () => { /* 只为不让管道堵住 */ })
      child.on('error', () => { clearTimeout(timer); finish('') })
      child.on('exit', () => { clearTimeout(timer); eat(acc); finish(sid) })
    } catch (e) {
      log(`建固定会话失败：${e?.message ?? e}`)
      finish('')
    }
  })

  /* 两条固定会话各建一次（fixed-sessions.json 记下「建过的 id」）；之后靠上面的自愈补。
   * ⚠️ 2026-10-22 教训：旧版只用一个 `done` 总开关 + 「有 sessionId 就跳过」——
   *    用户升级前已经有会话 id（标题是旧的、认不出），于是「B站私信」那条**从来没建**，
   *    值守那条也被一轮值班换成新 id。现在按「这条 id 是不是我建的那条」逐条比对。 */
  const ensureFixedSessions = async () => {
    try {
      const flagFile = join(stateDir, 'fixed-sessions.json')
      const flag = readJson(flagFile, {})
      const dir = runDir()
      const next = { at: new Date().toISOString() }
      const duty = readJson(dutySessFile, {})
      if (!duty.sessionId || String(flag.duty || '') !== String(duty.sessionId)) {
        const sid = await createSession('B站值守 · 误删重启自动重建', '这条对话用来记每一轮定时值班：挑了哪些视频、写了什么报告。', 'window')
        if (sid) {
          writeJson(dutySessFile, { sessionId: sid, cwd: dir, at: new Date().toISOString() })
          next.duty = sid
          log('已建好「B站值守」那条固定会话')
        } else next.duty = String(flag.duty || '')
      } else next.duty = String(flag.duty || '')
      const dm = readDm()
      if (!dm.sessionId || String(flag.dm || '') !== String(dm.sessionId)) {
        const sid = await createSession('B站私信 · 误删重启自动重建', '这条对话用来记你在手机上给 B站 小号发的私信。', 'dm')
        if (sid) {
          const s = readDm()
          s.sessionId = sid
          s.cwd = dir
          saveDm(s)
          next.dm = sid
          log('已建好「B站私信」那条固定会话')
        } else next.dm = String(flag.dm || '')
      } else next.dm = String(flag.dm || '')
      writeJson(flagFile, next)
    } catch (e) {
      log(`建固定会话失败（不影响使用）：${e?.message ?? e}`)
    }
  }

  /* ⭐ 自适应节奏（用户 2026-10-22 选）：B站 没给第三方留私信推送，只能轮询。
   *    闲时按设置（默认 5 分钟）拉；一旦扫到过消息，接下来 10 分钟改成 20 秒一拉
   *    —— 聊天时几乎即时，闲时又不白拉（每小时 12 次 vs 180 次）。
   *    热窗口记在 dm-state.json 的 hotUntil 里：重启宿主也不会丢。 */
  const DM_HOT_MS = 20_000
  const DM_HOT_WINDOW = 10 * 60_000
  const dmTick = async () => {
    if (dmBusy) return
    const c = dmCfg()
    if (!c.on) return
    const st0 = readDm()
    const hot = Number(st0.hotUntil || 0) > Date.now()
    const gap = hot ? Math.min(c.pollMs, DM_HOT_MS) : c.pollMs
    if (Date.now() - dmLastAt < gap) return
    dmBusy = true
    dmLastAt = Date.now()
    try {
      if (!hasCredential()) return
      const st = readDm()
      const first = !st.lastTs
      const r = await call('bili_dm_inbox', { uid: c.owner, limit: 20 })
      if (!r?.ok) { log(`私信遥控：读私信失败（${r?.error || '未知原因'}）`); return }
      const items = Array.isArray(r.items) ? r.items : []
      const now = Date.now()
      const cut = now - 24 * 3600_000
      const baseline = now - 120_000        // 第一次打开：2 分钟前的都当历史，不执行
      let handled = 0
      for (const it of items) {
        const key = String(it?.key || '')
        if (!key || st.keys[key]) continue
        const ts = Number(it?.ts || 0) * 1000
        const text = String(it?.text || '')
        if (String(it?.dir || '') !== 'in') { st.keys[key] = ts || now; continue }   // 自己发出去的不算
        st.hotUntil = now + DM_HOT_WINDOW      // 有人跟我说话 ⇒ 接下来 10 分钟加密扫描
        if (ts < cut || (first && ts < baseline)) { st.keys[key] = ts || now; continue }
        const raw = String(text || '').trim()
        /* ⭐ 前缀可选（2026-10-22 用户定：「不用 #，当聊天」）—— 写了就剥掉，没写就整条当命令/聊天。
         *    安全边界不靠前缀：只认 owner UID（大号）发来的，别人发什么都不理。 */
        const cmdText = raw.startsWith(c.prefix) ? raw.slice(c.prefix.length).trim() : raw
        if (!cmdText) { st.keys[key] = ts || now; continue }
        let reply = ''
        /* 空格可有可无：`问 …` 和 `问…` 都认（后者正文至少 4 个字，免得「问题」这种被当成提问） */
        const mAsk = /^(问|ask|q)\s+([\s\S]+)$/i.exec(cmdText)
          || /^(问|ask|q)([\s\S]{4,})$/i.exec(cmdText)
        const isAsk = Boolean(mAsk)
        const today0 = dayKey(new Date())
        /* ⭐ 2026-10-22 改成「所有私信都起一轮」之后，两条额度都得**在起轮之前**判 ——
         *    否则先把模型轮烧了，再发现今天额度用完、把结果丢掉（白烧）。 */
        const rounds = st.ask?.date === today0 ? st.ask : { date: today0, count: 0 }
        const todayA = dayKey(new Date())
        const dailyA = st.daily?.date === todayA ? st.daily : { date: todayA, count: 0 }
        if (c.dailyCap > 0 && dailyA.count >= c.dailyCap) {
          log('私信遥控：今天的额度用完了')
          break
        }
        if (c.askCap > 0 && rounds.count >= c.askCap) {
          reply = `今天的额度用完了（上限 ${c.askCap} 轮，明天再来）。`
        } else {
          /* ⭐ 2026-10-22 用户定：所有私信都进会话（「没有人会一直盯着那个插件的面板，
           *    反而是新建的对话能看得更清楚」）。代价是每条多等约 10 秒；
           *    跑不成时才退回宿主自己拼的只读答案（dmAnswer）。 */
          /* ⭐ 重活先回一句「收到」（2026-10-22 用户要的是「跟 AI 聊天」：发个视频让它分析，
           *    一轮要取字幕+读内容，1~2 分钟。干等两分钟像断了，先应一声。） */
          if (/(BV[0-9A-Za-z]{10}|bilibili\.com|b23\.tv|分析|总结|看看|讲讲)/.test(cmdText)) {
            try { await call('bili_send_message', { receiver_uid: c.owner, text: '收到，我看一下，一会儿回你～' }) } catch { /* 应一声失败不影响正文 */ }
          }
          log(`私信遥控：起一轮处理「${cmdText.slice(0, 30)}」`)
          const r = await dmAsk(isAsk ? mAsk[2] : cmdText, dmContext())
          /* ⭐ 把这一轮的 sessionId 接回本地状态（2026-10-22 实测：dmAsk 里已经存进文件了，
           *    可本跳末尾 `saveDm(st)` 用的还是**开跳时读的旧 st**，sessionId 是空 ⇒ 又被覆盖回去，
           *    结果每条私信都新建一个会话）。 */
          if (r?.sessionId) st.sessionId = String(r.sessionId)
          rounds.count += 1; st.ask = rounds      // 每起一轮都算（不管是不是「问」）
          reply = r?.text ? r.text : (dmAnswer(cmdText) || `我这轮没跑成（${r?.error || '没有答复'}），过会儿再发我一次？`)
        }
        if (!reply) { st.keys[key] = ts || now; continue }                            // 兜底：实在没内容就不回
        const today = dayKey(new Date())
        const daily = st.daily?.date === today ? st.daily : { date: today, count: 0 }
        try {
          const delivered = await dmDeliver(reply, c.owner)
          if (!delivered) throw new Error('发出去但会话里没看到（被 B站 吞了？）')
          daily.count += 1
          handled += 1
          guardLogAppend({ ts: Date.now(), type: 'dm', cmd: text.slice(0, 80), ok: true })
          log(`私信遥控：回了「${text.slice(0, 30)}」`)
        } catch (e) {
          guardLogAppend({ ts: Date.now(), type: 'dm', cmd: text.slice(0, 80), ok: false, error: String(e?.message ?? e) })
          log(`私信遥控：回不出去（${e?.message ?? e}）`)
        }
        st.daily = daily
        st.keys[key] = ts || now
        if (handled >= 5) break            // 一轮最多处理 5 条，别一次刷屏
      }
      st.lastTs = now
      const keep = now - 3 * 86400_000     // msg_key 只留 3 天
      for (const [k, v] of Object.entries(st.keys)) if (!(Number(v) >= keep)) delete st.keys[k]
      saveDm(st)
      if (first) log('私信遥控：已就绪，从现在开始听（历史私信不回）')
    } catch (e) {
      log(`私信遥控这一跳出错（已兜住，不影响宿主）：${e?.message ?? e}`)
    } finally { dmBusy = false }
  }

  try {
    /* 10 秒一跳（不是 60 秒）：热窗口里要 20 秒一拉，跳太粗就退化成 60 秒了 */
    const dt = setInterval(() => { dmTick().catch((e) => log(`私信遥控定时器异常：${e?.message ?? e}`)) }, 10_000)
    dt.unref?.()
    ctx.effect(() => () => clearInterval(dt), 'bili-pond: 私信遥控定时器')
  } catch (e) { log(`私信遥控定时器没起来：${e?.message ?? e}`) }

  /* ⭐ 两条固定会话：插件加载 20 秒后建一次（错开启动那阵忙；建完打标记，之后不再重复）。
   *    用户 2026-10-22：「安装完插件自动创建两个对话」。 */
  try {
    const st0 = setTimeout(() => { ensureFixedSessions().catch((e) => log(`建固定会话异常：${e?.message ?? e}`)) }, 20_000)
    st0.unref?.()
    ctx.effect(() => () => clearTimeout(st0), 'bili-pond: 建固定会话')
  } catch (e) { log(`建固定会话的定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  /**
   * ⭐ 「值班用哪个模型」下拉的数据源 —— **不写死任何线路**，直接问 DSH 当前注册了什么。
   *
   *    ⚠️⚠️ 这里必须用**两个**方法取并集（2026-10-20 用户实测反馈：装了 workbuddy 却看不到）：
   *      · `listProviders()`            —— 只列出**适配器已注册**的线路（真正激活的）
   *      · `listConfigurableProviders()` —— 列出**所有声明过的**线路，含尚未激活（dormant）的
   *    只问前者的话：插件装了、但适配器还没注册（比如还没配置/还没激活）时，
   *    那条线路**完全不会出现**；而 DSH 右下角的模型选择器读的是后者 ⇒ 两边不一致 ✗
   *    ⇒ 并集：先放已激活的，再补上"声明了但没激活"的（active: false，界面上标注"未启用"）。
   *
   *    ⚠️ llm 是**可选**依赖：拿不到（老版本 / 没挂 llm）就回空列表，设置页照样能用，
   *       只是没有下拉 —— 绝不能让整条插件因为这个不激活。
   */
  const modelsHere = async () => {
    const llm = ctx.get?.('llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      return { ok: false, providers: [], error: '这个 DSH 没有提供 llm 服务，无法列模型' }
    }
    try {
      const active = llm.listProviders() || []
      let declared = []
      try {
        if (typeof llm.listConfigurableProviders === 'function') declared = llm.listConfigurableProviders() || []
      } catch { /* 老版本没有这个方法：只列已激活的 */ }

      const byId = new Map()
      for (const p of active) {
        const id = String(p?.id || '')
        if (!id) continue
        byId.set(id, { id, name: String(p?.name || id), active: true, error: '' })
      }
      for (const c of declared) {
        const id = String(c?.provider || '')
        if (!id) continue
        if (byId.has(id)) continue               // 已激活的优先，别被 dormant 条目覆盖
        /* ⚠️⚠️ 关键过滤（2026-10-20 第二次修）：`listConfigurableProviders()` 会把 DSH
         *    内置的**全部**线路都列出来（40 多条：amazon-bedrock、openai、xai…），
         *    这些对使用者毫无意义 —— 全塞进下拉会变成一长串灰条目，比"看不到 workbuddy"更糟 ✗
         *    ⇒ 只收「用户显式声明过」的那些（`declared: true`）。
         *      实测：用户装过的 workbuddy 会带 declared:true，内置的那些没有。 */
        if (c?.declared !== true) continue
        byId.set(id, {
          id,
          name: String(c?.displayName || id),
          active: false,                         // 声明了，但适配器没注册 ⇒ 现在还不能用
          error: String(c?.error || ''),
        })
      }

      const out = []
      for (const p of byId.values()) {
        let models = []
        try {
          const list = await llm.listModels(p.id)
          models = (list || []).map((m) => ({ id: String(m?.id || ''), name: String(m?.name || m?.id || '') }))
            .filter((m) => m.id)
        } catch { /* 没激活的线路列不出模型是正常的；别的线路出错也不该连坐 */ }
        out.push({ ...p, models })
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
  const modelsInProfile = async (profileName, opts = {}) => {
    const dsh = resolveDsh()
    const name = String(profileName || '').trim() || 'headless'
    const args = [...dsh.args, '--profile', name]
    /* ⭐ opts.patch：探测「带上宿主线路之后」到底能解析到哪些 —— 值班真的会带那份 overlay，
     *    不带的话探测结果就是假的（用户看到灰着，其实跑起来是好的）。 */
    if (opts.patch) args.push('--patch', String(opts.patch))
    args.push('--dump-config')
    const out = await new Promise((resolve) => {
      let child
      try {
        child = spawn(dsh.command, args, {
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
    /* ⚠️ 必须**行首锚定**：不锚定的话 `searchProvider:` / `fetchProvider:` 也会被吃进来
     *    （实测 dump 里 web-fetch 那行就带出了一个叫 http 的假线路）。 */
    const prov = new Set()
    for (const m of out.text.matchAll(/^[ \t]*provider:[ \t]*['"]?([A-Za-z0-9_.-]+)/gm)) prov.add(m[1])
    /* ⚠️ 剩下的 `provider:` 也不全是「模型线路」：subagent 那几行写的是 spawn / fork。
     *    这些 id 真要塞进下拉，用户选了也只会 NO_ADAPTER，属于纯噪音。 */
    const NOT_A_ROUTE = new Set(['spawn', 'fork', 'http', 'https', 'none', 'auto'])
    const routes = [...prov].filter((x) => !NOT_A_ROUTE.has(String(x).toLowerCase()))
    /* ⭐⭐ pi-ai 这类「一个插件带多条线路」的配置：线路名是 `providers:` 下面的**映射键**，
     *    并不是 `provider:` 字段 ⇒ 上面那套正则完全看不见它们（WorkBuddy 本地反代就是这样丢的）。
     *    只认 `providers:` 下一层（缩进正好 +2）的键，免得把 models: / caps: 也当成线路。 */
    const declared = new Set()
    {
      const lines = out.text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const head = /^(\s*)providers:\s*$/.exec(lines[i])
        if (!head) continue
        const base = head[1].length
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j]
          if (!l.trim()) continue
          const ind = /^\s*/.exec(l)[0].length
          if (ind <= base) break
          if (ind !== base + 2) continue
          const m = /^\s*['"]?([A-Za-z0-9_@.-]+)['"]?:\s*$/.exec(l)
          if (m) declared.add(m[1])
        }
      }
    }
    /* ⭐ 有些线路在 profile 里**根本没起来**（插件被版本检查跳过之类），
     *    这时 dump 里只剩一句 "skipping profile bundle …"，
     *    不给用户看的话他只会觉得「我明明装了，怎么这里没有」。 */
    const warnings = []
    for (const m of out.text.matchAll(/skipping profile bundle\s+"([^"]+)":?\s*Error:\s*([\s\S]{0,260})/g)) {
      let why = String(m[2]).split('\n')[0].replace(/\s+/g, ' ').trim()
      // 后面常跟一长串 requirements 清单，界面上一行就够 —— 只留结论那半句
      const cut = why.indexOf(': requirements')
      if (cut > 0) why = why.slice(0, cut)
      else if (why.length > 180) why = why.slice(0, 180) + '…'
      warnings.push(`${m[1]}：${why}`)
    }
    const plugins = new Set()
    for (const m of out.text.matchAll(/name:\s*['"]?((?:@[^/]+\/)?[A-Za-z0-9_.-]+)['"]?/g)) {
      const n = String(m[1]).trim()
      if (/workbuddy|deepseek|llm|assistant|connect/i.test(n)) {
        plugins.add(n)
        plugins.add(n.replace(/^@[^/]+\//, ''))
      }
    }
    return { ok: true, providers: routes, declared: [...declared], plugins: [...plugins], warnings, text: out.text }
  }

  /**
   * ⭐ 开跑前校验：设置页选了线路，就去 headless profile 里确认它真能解析到。
   *    解析不到 ⇒ 直接拒绝开跑并说清楚（别让它空跑半小时才发现 NO_ADAPTER）。
   *    ⚠️ 查不到（dump-config 失败）时不拦 —— 宁可按老行为跑，也不要因为校验器自己坏了而跑不了。
   */
  const checkDutyModel = async () => {
    const prov = String(cfg.dutyProvider || '').trim()
    if (!prov) return { ok: true }
    /* ⚠️ 只选了线路没选模型：不拦（这一轮跟随 profile 默认模型），但要说清楚，
     *    否则用户会以为「我明明选了 workbuddy-local」却没生效 */
    if (!String(cfg.dutyModel || '').trim()) {
      return { ok: true, warn: `线路选了「${prov}」但没选具体模型 —— 这一轮会用 profile 默认模型` }
    }
    /* ⭐ 校验要看「带上宿主线路之后」的样子：值班真的会带那份 overlay（routeOverlayYml），
     *    不带给它的话，用户明明能用却被告知「这个 profile 里没有这条线路」 */
    const probe = writeRouteOverlay()
    let r
    try { r = await modelsInProfile(cfg.headlessProfile, probe ? { patch: probe } : {}) }
    finally { if (probe) { try { rmSync(probe, { force: true }) } catch { /* 删不掉也无所谓 */ } } }
    if (!r.ok) return { ok: true, unchecked: true, why: r.error }
    const hit = (r.providers || []).includes(prov)
      || (r.declared || []).includes(prov)
      || (r.plugins || []).some((n) => n === prov || n.includes(prov))
    if (!hit) {
      const known = [...new Set([...(r.providers || []), ...(r.declared || []), ...(r.plugins || [])])].slice(0, 20)
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
        '# B站鱼塘 · 判重表（宿主预建，那一轮只往后面追加）',
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
    appendInstall('这台机器上没有 uv —— 我下一份放进插件数据目录（单文件、免管理员、约 15MB，只需要一次）…\n')
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
        appendAsr('装 faster-whisper + yt-dlp（依次尝试多个镜像）…\n')
        let code = 1
        // ⚠️ av 必须钉在 17 以下：faster-whisper 1.2.1 会调 av.open(metadata_errors=…)，
        //    而 av 17+ 不再接受这个参数 ⇒ 装了最新的 av 反而转不了（2026-10-14 在主人机器上实证）
        const AV_PIN = process.env.BILI_DUTY_AV_PIN || 'av>=12,<17'
        // ⭐ 2026-10-20：跟主依赖安装一样，一个镜像失败就换下一个。
        //    实测清华镜像会对部分 IP 回 403，而 pip 把它写成「这个包不存在」，非常误导。
        const mirrors = [...new Set([
          mirror,
          'https://mirrors.ustc.edu.cn/pypi/simple',
          'https://mirrors.aliyun.com/pypi/simple',
          'https://pypi.org/simple',
        ])]
        for (let i = 0; i < mirrors.length && code !== 0; i++) {
          const m = mirrors[i]
          appendAsr((i === 0 ? '镜像：' : '换个镜像再试：') + m + '\n')
          if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', py, '-i', m, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr })
          if (code !== 0) code = await spawnTo(py, ['-m', 'pip', 'install', '-i', m, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr })
          if (code === 0) appendAsr('镜像可用：' + m + '\n')
        }
        if (code !== 0) { appendAsr('所有镜像都失败了 —— 看上面的报错\n'); log('转写：装包失败（所有镜像）'); return }
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
      notSynced: Object.keys(readSyncFailed()),
      installFailed: !installing && !venvReadyNow() && (() => { try { return readFileSync(installLogFile, 'utf8').length > 0 } catch { return false } })(),
      installing,
      // ── 2026-10-20 自动运行 / 配额 / 熔断 的可观测值 ──
      asrUsedToday: asrUsedToday(),
      roundsToday: roundsToday(),
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      // ⭐ 实时进度（2026-10-20）：这一轮在不在跑、跑了多久 —— 设置页据此决定要不要轮询日志
      running: Boolean(dutyRun),
      runStartedAt: dutyRun ? new Date(dutyRun.startedAt).toISOString() : null,
      runElapsedSec: dutyRun ? Math.round((Date.now() - dutyRun.startedAt) / 1000) : 0,
      runWhy: dutyRun ? dutyRun.why : null,
      /* ⭐ 上一轮为什么没成功（分类 + 一句人话），成功跑完会自动清掉 */
      lastError: (() => {
        const e = readJson(dutyStateFile, {}).lastError
        return e && e.at ? e : null
      })(),
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
      // ⭐ 人设是否真的读得到（设置页要能回答"我的人设生效了吗"）
      workspace: String(cfg.workspace || '').trim(),
      /* ⭐ 跑在哪个目录（空 = 跟随工作区）：界面要显示它，并说明会话会出现在哪个列表里 */
      dutyCwd: String(cfg.dutyCwd || '').trim(),
      runDir: runDir(),
      agentsFound: (() => {
        const ws = String(cfg.workspace || '').trim()
        return Boolean(ws && existsSync(join(ws, 'AGENTS.md')))
      })(),
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-pond/status') return sendJson(res, 200, status())

    /* ⭐ 「本轮进度」（2026-10-20）：设置页在跑的时候轮询这个。
     *    数据源是 **run.log**（那一轮的原始输出，每轮清空），不是 duty.log（结构化事件）。
     *    两者分开之后，这里显示的就是"这一轮在干什么"，不会掺进重启噪音和上一个月的记录。 */
    if (req.method === 'GET' && path === '/api/bili-pond/runlog') {
      const n = Math.max(5, Math.min(Number(url.searchParams.get('n')) || 30, 200))
      let lines = []
      try {
        const raw = readFileSync(runLogFile, 'utf8')
        lines = raw.split('\n').filter((l) => l.trim()).slice(-n)
          .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 300))
      } catch { lines = [] }
      const tailTxt = lines.slice(-40).join('\n')
      const stage = /bili_send_message|私信/.test(tailTxt) ? '发私信'
        : /bili_reply|发布评论|发评论/.test(tailTxt) ? '发评论'
          : /报告|digest\/|out\//.test(tailTxt) ? '写报告'
            : /转写|whisper|asr/i.test(tailTxt) ? '转写'
              : /bili_subtitle|字幕/.test(tailTxt) ? '读字幕'
                : /bili_search|搜索/.test(tailTxt) ? '检索'
                  : ''
      return sendJson(res, 200, {
        ok: true,
        running: Boolean(dutyRun),
        startedAt: dutyRun ? new Date(dutyRun.startedAt).toISOString() : null,
        elapsedSec: dutyRun ? Math.round((Date.now() - dutyRun.startedAt) / 1000) : 0,
        why: dutyRun ? dutyRun.why : null,
        pickedToday: countPickedToday(),
        stage,
        lines,
      })
    }

    /* ⭐ 「建一份 AGENTS.md 模板」：写人设不知道该写什么格式 ⇒ 给一份能直接改的骨架（不覆盖已有文件） */
    if (req.method === 'POST' && path === '/api/bili-pond/agents-template') {
      const ws = String(cfg.workspace || '').trim()
      if (!ws) return sendJson(res, 200, { ok: false, error: '先填「工作区路径」，再建模板' })
      const f = join(ws, 'AGENTS.md')
      if (existsSync(f)) return sendJson(res, 200, { ok: false, exists: true, path: f, error: '工作区里已经有 AGENTS.md 了（不会覆盖）' })
      try {
        mkdirSync(ws, { recursive: true })
        writeFileSync(f, AGENTS_TEMPLATE, 'utf8')
        log(`已写入 AGENTS.md 模板：${f}`)
        return sendJson(res, 200, { ok: true, path: f })
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }) }
    }

    // ⭐ 「@ 谁」：前端填 UID，后端解析出昵称写进 mentionName
    //    （B站 评论只认昵称文本，所以最终还得有昵称；但让用户记 UID 比记昵称可靠）
    if (req.method === 'POST' && path === '/api/bili-pond/resolve-user') {
      const body = await readBody(req)
      const uid = Math.max(0, Number(body?.uid) || 0)
      // ⭐ 这个接口被两处用：@ 谁（写 mentionName）+ 私信收件人（只回昵称，不覆盖 mentionName）
      const target = String(body?.target || 'mention')
      if (!uid) return sendJson(res, 200, { ok: false, error: 'UID 为空' })
      try {
        const raw = await call('bili_user_info', { uid })
        let info = raw
        if (typeof raw === 'string') { try { info = JSON.parse(raw) } catch { /* 保持原样 */ } }
        const name = String(info?.name || '').trim()
        if (!name) return sendJson(res, 200, { ok: false, error: '解析不到昵称（UID 可能不存在）', raw: String(raw).slice(0, 200) })
        if (target === 'mention') {
          // 解析成功 ⇒ 顺手把两个字段都落盘（外加深链到 DSH 设置层）
          await persistCfg({ mentionUid: uid, mentionName: name })
        } else {
          // 私信收件人：只记 UID，昵称只回给界面显示（不写 mentionName，否则会串到评论的 @ 上）
          await persistCfg({ dmUid: uid })
        }
        return sendJson(res, 200, { ok: true, uid, name, face: info?.face || '', level: info?.level ?? null })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ⭐ 「值班用哪个模型」下拉的数据源：当前进程真实注册的线路 + 模型（不写死）
    if (req.method === 'GET' && path === '/api/bili-pond/models') {
      const here = await modelsHere()
      /* ⭐ 探测必须**带上值班真会带的那份 overlay**，否则从这里看到的「能不能用」是假象：
       *    界面上线路灰着，可值班跑起来其实是好的（用户 2026-10-21 就是被这个吓过）。 */
      const probe = writeRouteOverlay()
      let inProfile
      try { inProfile = await modelsInProfile(cfg.headlessProfile, probe ? { patch: probe } : {}) }
      finally { if (probe) { try { rmSync(probe, { force: true }) } catch { /* 无妨 */ } } }
      const usable = new Set([
        ...((inProfile.providers) || []),
        ...((inProfile.declared) || []),
        ...((inProfile.plugins) || []),
      ])
      const providers = (here.providers || []).map((p) => {
        // 这条线路在值班那个 profile 里能不能用（不能就置灰/提示）
        const canUse = !inProfile.ok ? null : (usable.has(p.id) || [...usable].some((n) => n.includes(p.id)))
        return {
          ...p,
          source: 'here',
          usable: canUse,
          // ⭐ 前端用：这条线路只在当前进程有、值班 profile 没有时，给一个「装过去」的包名
          package: PROVIDER_PACKAGES[p.id] || '',
          reason: canUse === false ? 'not-in-profile' : '',
        }
      })
      /* ⭐⭐ 只装在「值班那个 profile」里的线路（典型：headless 只挂了 workbuddy 连接器，
       *     它注册的线路叫 `workbuddy`，而桌面进程里根本没这个 provider）。
       *     以前这些线路在下拉里**完全不存在** ⇒ 用户选不到、也以为插件没识别到 ✗
       *     现在补进来并标 source: 'profile'：能选，但模型列表读不到（那是另一个进程的事），
       *     所以「具体模型」在那儿改成可手填。 */
      if (inProfile.ok) {
        const seen = new Set(providers.map((p) => p.id))
        for (const id of [...(inProfile.providers || []), ...(inProfile.declared || [])]) {
          if (!id || seen.has(id)) continue
          seen.add(id)
          providers.push({ id, name: id, active: false, error: '', usable: true, source: 'profile', models: [] })
        }
      }
      return sendJson(res, 200, {
        ok: true,
        current: { provider: cfg.dutyProvider || '', model: cfg.dutyModel || '' },
        profile: cfg.headlessProfile,
        profileKnown: Boolean(inProfile.ok),
        profileError: inProfile.ok ? '' : (inProfile.error || ''),
        warnings: inProfile.ok ? (inProfile.warnings || []) : [],
        /* ⭐ 给界面的一句话提示：这些线路是"从你界面那份配置自动带进值班的" */
        reuseRoutes: cfg.reuseRoutes !== false,
        reusedRoutes: inProfile.ok ? (inProfile.declared || []) : [],
        /* ⭐ 排错用（2026-10-21：Electron 宿主里没有 DSH_PROFILE_DIR，功能静默失效过一次）：
         *    从哪个文件抄的、抄了哪几个 entry、这次探测用的 overlay 有没有生成。
         *    界面不一定要显示，但「为什么没带上」看一眼就知道。 */
        routePatch: hostPatchFile(),
        routeIds: routeIdsSeen.slice(),
        routeProbe: probe ? 'overlay' : 'none',
        routeCandidates: patchCandsSeen,
        providers,
      })
    }

    /**
     * ⭐ 把「提供某条线路的插件」装进值班 profile。
     *    起因（2026-10-20）：用户先装了 WorkBuddy（desktop），再装鱼塘；
     *    鱼塘跑 headless，那边没有 WorkBuddy ⇒ 设置页里 WorkBuddy 灰着，
     *    但提示只说「该 profile 未安装」，用户不知道该怎么装。
     *    这里由前端点按钮触发；**不自动装**（会往用户机器里装第三方包）。
     */
    if (req.method === 'POST' && path === '/api/bili-pond/profile-add') {
      const body = await readBody(req)
      const pkg = String(body?.package || '').trim()
      const profile = String(body?.profile || cfg.headlessProfile || 'headless').trim()
      if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(pkg)) {
        return sendJson(res, 200, { ok: false, error: '包名不合法：' + pkg })
      }
      if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
        return sendJson(res, 200, { ok: false, error: 'profile 名不合法：' + profile })
      }
      log(`装线路插件到 profile「${profile}」：${pkg}`)
      const r = await runDshCapture(['plugin', '--profile', profile, 'add', pkg])
      log(`装线路插件结束：${pkg} → ${profile}，code=${r.code}`)
      return sendJson(res, 200, {
        ok: r.ok,
        code: r.code,
        profile,
        package: pkg,
        error: r.ok ? '' : '安装失败（code=' + r.code + '）',
        output: String(r.text || '').slice(-6000),
      })
    }

    /* ⭐ 守护评论区（2026-10-22）：状态 + 手动扫一次。
     *    手动扫**只入队、不立刻开跑** —— 跑一轮要花模型额度，让使用者自己决定什么时候跑。 */
    if (req.method === 'GET' && path === '/api/bili-pond/guard') {
      const g = guardCfg()
      const st = readGuard()
      let q = []
      try { const j = readJson(guardQueueFile, {}); q = Array.isArray(j?.items) ? j.items : [] } catch { q = [] }
      return sendJson(res, 200, {
        ok: true,
        on: g.on,
        whitelist: [...g.whitelist],
        ownerUid: g.ownerUid,
        selfUid: g.selfUid,
        ownAll: g.ownAll,
        dailyCap: g.dailyCap,
        daily: st.daily,
        scope: g.scope,
        perRound: g.perRound,
        pollMinutes: Math.round(g.pollMs / 60_000),
        emoji: g.emoji,
        seenCount: Object.keys(st.seen).length,
        watermark: { atId: st.atId, atTime: st.atTime },
        queue: q,
        last: guardLast,
      })
    }
    /* ⭐ 守护记录：扫到什么 / 判成什么 / 真发出去什么（回复那一行由 MCP 子进程写，见 bili_reply） */
    if (req.method === 'GET' && path === '/api/bili-pond/guard/log') {
      const url = new URL(req.url, 'http://127.0.0.1')
      const limit = Number(url.searchParams.get('limit') || 50)
      const st = readGuard()
      const answered = guardAnswered()
      return sendJson(res, 200, {
        ok: true,
        /* ⚠️ 这里的数是从守护记录里数出来的**真发出去**的条数，不是「派出去」的条数 */
        daily: { date: dayKey(new Date()), count: answered.today.size },
        pending: Object.keys(st.pending).length,
        dailyCap: Math.max(0, Math.min(500, Number(cfg.guardDailyCap) || 0)),
        file: guardLogFile,
        items: readGuardLog(Number.isFinite(limit) ? limit : 50),
      })
    }
    if (req.method === 'POST' && path === '/api/bili-pond/guard/scan') {
      try {
        const r = await guardScan()
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'GET' && path === '/api/bili-pond/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home: stateDir })
    }

    if (req.method === 'POST' && path === '/api/bili-pond/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of ['perDay', 'peakValley', 'noon', 'night', 'autoComment', 'transcribe', 'asrModel',
        'commentPerRound', 'mentionName', 'mentionUid', 'dmOn', 'dmMode', 'dmUid',
        // 2026-10-20 自动运行 / 配额 / 时长 / 字幕优先 / 熔断
        'autoRun', 'autoRunsPerDay', 'autoGapMinutes', 'peakValleyOnly',
        'perRoundMax', 'perDayMax', 'transcribePerDay',
        'minDurationMin', 'maxDurationMin', 'preferSubtitle', 'subtitleProbeMax',
        'keywords', 'pythonPath', 'dshBin', 'headlessProfile', 'dutyProvider', 'dutyModel', 'workspace', 'dutyCwd', 'reportLevel', 'replyToComments', 'replyPerRound',
        // 2026-10-22 守护评论区（骑士团）
        'guardOn', 'guardWhitelist', 'guardOwnAll', 'guardDailyCap', 'guardScope', 'guardPerRound', 'guardPollMinutes', 'guardEmoji', 'guardTone',
    'dmCtlOn', 'dmCtlPrefix', 'dmCtlPollMinutes', 'dmCtlDailyCap', 'dmCtlAskCap']) {
        if (k in body) patch[k] = body[k]
      }
      // ⭐ 范围钳制 + 两份都写（config.json / DSH 原生设置页），统一走 persistCfg —— 见文件上方
      // ⭐ 私信字段的合法值（2026-10-17 摘 PR #9；其余范围钳制统一在 persistCfg 里）
      if ('dmOn' in patch) patch.dmOn = Boolean(patch.dmOn)
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
      const out = { ok: true, current: myVersion(), latest: '', hasNew: false, selfUpgrade: !isDesktopApp, page: 'https://www.npmjs.com/package/dsh-bili-pond' }
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
