// 改动校验（2026-10-21）：把「界面里在用的模型线路」自动带进值班那一轮。
//
// 背景（用户原话，m00695）：插件是给很多人用的，要一个对所有人都好用的办法 ——
// 不去猜线路叫什么名字、也不要让人一步步手配。
// 做法：把宿主（用户界面所在的 profile）cordis.patch.yml 里**模型相关**的 entry 原样抄进 --patch overlay。
//
// ⚠️ 这里不是"源码里有没有这句话"的字符串检查：那套只能防手滑，防不住逻辑写错。
//    所以把 index.js 里那几段**真源码**切出来，塞进沙箱里跑，用临时目录当宿主 profile 验证行为。
//
// ⚠️⚠️ 2026-10-21 补的教训：沙箱没喂 `existsSync` / `pluginDir` 时，`hostPatchFile()` 一走就抛，
//    测试照样"通过"（只覆盖了 env 分支）—— 真实 Electron 宿主里 `DSH_PROFILE_DIR` 是空的，
//    结果线上整块功能静默失效。所以下面 ①/⑤ 专门跑"没有任何 DSH_* 环境变量"的情形。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..')
const idx = readFileSync(join(P, 'index.js'), 'utf8')

const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }

// ── 切出真源码：从 ROUTE_BLOCK_HINT 到 writeRouteOverlay 之前（后者会写盘，这里不需要） ──
const a = idx.indexOf('const ROUTE_BLOCK_HINT')
const b = idx.indexOf('const writeRouteOverlay')
ok(a > 0, 'index.js 里找不到 ROUTE_BLOCK_HINT（线路 overlay 的核心逻辑没了？）')
ok(b > a, 'index.js 里找不到 writeRouteOverlay')
const src = idx.slice(a, idx.lastIndexOf('/**', b) > a ? idx.lastIndexOf('/**', b) : b)

const logs = []
/* ⚠️ 沙箱必须把源码里用到的依赖都喂进去，否则"通过"只是恰好没走到那条路。 */
const build = (cfg, pluginDir) => new Function(
  'cfg', 'log', 'readFileSync', 'join', 'process', 'existsSync', 'pluginDir',
  src + '\nreturn { splitPatchBlocks, routeOverlayYml, hostPatchFile, ROUTE_SKIP_IDS }',
)(cfg, (m) => logs.push(String(m)), readFileSync, join, process, existsSync, pluginDir)

// ── 造一个假的宿主 profile 补丁层 ──
const dir = mkdtempSync(join(tmpdir(), 'pond-routes-'))
const profileDir = join(dir, 'profiles', 'desktop')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
const patch = `- id: agent-default-model
  config:
    provider: workbuddy-local
    model: deepseek-v4.1-flash
- id: ui-chat
  config:
    provider: whatever
- id: permission
  config:
    mode: ask
- id: llm-pi-ai
  config:
    providers:
      workbuddy-local:
        displayName: WorkBuddy 本地反代
        api: openai-completions
        baseURL: http://127.0.0.1:8788/v1
        apiKeyEnv: WORKBUDDY_LOCAL_API_KEY
      my-gateway:
        displayName: 我自己起的网关
        baseURL: http://10.0.0.5:8080/v1
- id: llm-off
  disabled: true
  config:
    providers:
      dead-route:
        baseURL: http://127.0.0.1:1/v1
- id: llm-extra
  config:
    providers:
      second-route:
        baseURL: http://10.0.0.9:1/v1
- insert:
    - id: some-inserted
      name: '@x/y'
`
writeFileSync(join(profileDir, 'cordis.patch.yml'), patch, 'utf8')

/** 插件装在 `<profile>/node_modules/dsh-bili-pond` ⇒ 源码靠这个位置倒推 profile 根 */
const PLUGIN_DIR = join(profileDir, 'node_modules', 'dsh-bili-pond')

const envBackup = {}
for (const k of ['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_PROFILE']) envBackup[k] = process.env[k]
/** 模拟 Electron 宿主：一个 DSH_* 环境变量都没有 */
const noEnv = () => { for (const k of Object.keys(envBackup)) delete process.env[k] }

// ① 真实场景：**没有任何 DSH_* 环境变量**，只靠插件自己的位置倒推（线上就是这么坏的）
{
  noEnv()
  const h = build({ reuseRoutes: true }, PLUGIN_DIR)
  ok(h.hostPatchFile() === join(profileDir, 'cordis.patch.yml'),
    '没有 DSH_* 环境变量时找不到宿主补丁层（Electron 宿主就是这种情形 ⇒ 整块功能静默失效）')
  const yml = h.routeOverlayYml()
  const text = yml.join('\n')
  ok(yml.length > 0, 'routeOverlayYml() 什么都没生成（宿主明明有 llm-pi-ai 那块）')
  ok(text.includes('- id: llm-pi-ai'), '没带上 llm-pi-ai 这块')
  ok(text.includes('workbuddy-local:'), '没带上 workbuddy-local 这条线路')
  ok(text.includes('my-gateway:'), '没带上用户自己起的第二条线路（名字任意也得带上）')
  ok(!text.includes('- id: agent-default-model'), '把宿主默认模型也抄过去了（会悄悄改掉设置页选的模型）')
  ok(!text.includes('- id: permission'), '把权限策略那块也抄过去了（用户明确说只要模型相关）')
  ok(!text.includes('- id: ui-chat'), '把 UI 配置抄过去了')
  ok(!text.includes('- id: llm-off'), '把宿主那边 disabled 的 entry 也抄了（等于强行打开）')
  ok(!text.includes('dead-route'), '把 disabled 块里的线路也带上了')
  ok(!text.includes('some-inserted'), '把 `- insert:` 那种条目也抄了（那不是 config 覆盖）')
  // 生成的东西必须是"整块原样搬运"：缩进/字段一个不差
  ok(text.includes('        baseURL: http://127.0.0.1:8788/v1'), '块内的缩进被改过（原样搬运才对）')
  // 每块之间用空行隔开，否则相邻 entry 会粘成一条
  ok(text.includes('- id: llm-extra'), '第二块模型配置没带上（只认一块就说明切块切坏了）')
  ok(/^- id: llm-pi-ai[\s\S]*\n\n- id: llm-extra/m.test(text), '块之间没有空行分隔')
  ok(yml[yml.length - 1] === '', '最后一块没留结尾空行（拼进 headless-overlay.yml 时会和下一条粘住）')
}

// ② 关掉开关 ⇒ 一个字都不带（用户另一个选择：失败也照旧跑）
{
  noEnv()
  const h = build({ reuseRoutes: false }, PLUGIN_DIR)
  ok(h.routeOverlayYml().length === 0, 'reuseRoutes=false 时还在往 overlay 里塞东西')
}

// ③ 哪都找不到补丁层 ⇒ 静默返回空（不许因此让值班跑不起来）
{
  noEnv()
  process.env.DSH_PROFILE_DIR = join(dir, 'profiles', 'nope')
  const h = build({ reuseRoutes: true }, join(dir, 'not-a-profile', 'node_modules', 'dsh-bili-pond'))
  let threw = null
  let yml = []
  try { yml = h.routeOverlayYml() } catch (e) { threw = e }
  ok(!threw, '补丁文件不存在时抛异常了（会把整个值班卡死）: ' + (threw && threw.message))
  ok(yml.length === 0, '补丁文件不存在时还生成了内容')
}

// ④ 只有 DSH_HOME + DSH_PROFILE 时也要能找到（CLI 版没有 DSH_PROFILE_DIR）
{
  noEnv()
  process.env.DSH_HOME = dir
  process.env.DSH_PROFILE = 'desktop'
  const h = build({ reuseRoutes: true }, join(dir, 'not-a-profile', 'node_modules', 'dsh-bili-pond'))
  ok(h.hostPatchFile().endsWith('cordis.patch.yml'), 'DSH_HOME+DSH_PROFILE 兜底路径没算出来')
  ok(h.routeOverlayYml().length > 0, '走 DSH_HOME 兜底时没生成 overlay')
}

// ⑤ 优先级：env 指向别的 profile（装饰性补丁）时，不能盖掉"加载我的那个 profile"
{
  noEnv()
  const decoy = join(dir, 'profiles', 'web')
  mkdirSync(decoy, { recursive: true })
  writeFileSync(join(decoy, 'cordis.patch.yml'), '- id: llm-decoy\n  config:\n    providers:\n      decoy-route:\n        baseURL: http://9.9.9.9/v1\n', 'utf8')
  process.env.DSH_PROFILE_DIR = decoy
  const h = build({ reuseRoutes: true }, PLUGIN_DIR)
  ok(h.hostPatchFile() === join(profileDir, 'cordis.patch.yml'),
    'env 里的 DSH_PROFILE_DIR 盖过了插件自己所在的 profile（会抄错文件）')
  ok(!h.routeOverlayYml().join('\n').includes('decoy-route'), '把别的 profile 的线路也带上了')
}

// ⑥ 接线检查：这几处不接上，前面再对也没用
ok(/const routeYml = routeOverlayYml\(\)/.test(idx), 'ensureOverlay 没调用 routeOverlayYml（值班拿不到线路）')
ok(/const probe = writeRouteOverlay\(\)/.test(idx), '/api/bili-pond/models 探测没带 overlay（界面上的灰/亮会是假象）')
ok(/modelsInProfile\(cfg\.headlessProfile, probe \? \{ patch: probe \} : \{\}\)/.test(idx), '两个探测点没把 patch 传进 modelsInProfile')
ok(idx.includes('const declared = new Set()'), 'modelsInProfile 没解析 providers: 下的线路名（pi-ai 那类线路会看不见）')
ok(/declared: \[\.\.\.declared\]/.test(idx), 'modelsInProfile 没把 declared 返回出去')
ok(/reuseRoutes: z\.boolean\(\)/.test(idx), '设置项 reuseRoutes 没进 schema')
/* ⭐ 界面/接口能看到"到底带没带上"（上线静默失效过，必须给排错口） */
ok(/routePatch: hostPatchFile\(\)/.test(idx), '/api/bili-pond/models 没回 routePatch（出问题时无法排查）')
ok(/routeIds: routeIdsSeen/.test(idx), '/api/bili-pond/models 没回 routeIds')
ok(/routeCandidates: patchCandsSeen/.test(idx), '/api/bili-pond/models 没回 routeCandidates')
/* 🔴 2026-10-22 实测：agent-default-model 的 model 是必填，只写 provider 会让插件激活失败、
 *    整个值班 exit 1（`$.model missing required value`）。所以「只选线路没选模型」必须**不写**。 */
ok(/if \(!model\) \{[\s\S]{0,240}return \[\]/.test(idx),
  'modelOverrideYml 在没选具体模型时必须返回空（否则写出无效配置把值班打死）')
ok(/这一轮跟随 profile 默认模型（不写 agent-default-model/.test(idx), '没选模型时应写一条日志说清楚这一轮跟随默认')
ok(/warn: `线路选了「\$\{prov\}」但没选具体模型/.test(idx), 'checkDutyModel 应把「只选线路没选模型」当提示返回')

// 收尾
for (const k of Object.keys(envBackup)) {
  if (envBackup[k] === undefined) delete process.env[k]
  else process.env[k] = envBackup[k]
}
rmSync(dir, { recursive: true, force: true })

if (fail.length) {
  console.error('❌ 线路复用校验失败：')
  for (const f of fail) console.error('   - ' + f)
  process.exit(1)
}
console.log(`✅ 线路复用校验通过（${total} 条断言）`)
