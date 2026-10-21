// 改动校验（2026-10-21）：把「界面里在用的模型线路」自动带进值班那一轮。
//
// 背景（用户原话，m00695）：插件是给很多人用的，要一个对所有人都好用的办法 ——
// 不去猜线路叫什么名字、也不要让人一步步手配。
// 做法：把宿主（用户界面所在的 profile）cordis.patch.yml 里**模型相关**的 entry 原样抄进 --patch overlay。
//
// ⚠️ 这里不是"源码里有没有这句话"的字符串检查：那套只能防手滑，防不住逻辑写错。
//    所以把 index.js 里那几段**真源码**切出来，塞进沙箱里跑，用临时目录当宿主 profile 验证行为。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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
const build = (cfg) => new Function(
  'cfg', 'log', 'readFileSync', 'join', 'process',
  src + '\nreturn { splitPatchBlocks, routeOverlayYml, hostPatchFile, ROUTE_SKIP_IDS }',
)(cfg, (m) => logs.push(String(m)), readFileSync, join, process)

// ── 造一个假的宿主 profile 补丁层 ──
const dir = mkdtempSync(join(tmpdir(), 'pond-routes-'))
mkdirSync(join(dir, 'profiles', 'desktop'), { recursive: true })
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
const patchFile = join(dir, 'profiles', 'desktop', 'cordis.patch.yml')
writeFileSync(patchFile, patch, 'utf8')

const oldDir = process.env.DSH_PROFILE_DIR
process.env.DSH_PROFILE_DIR = join(dir, 'profiles', 'desktop')

// ① 正常情况：只带模型相关、且没被 disabled 的那块
{
  const h = build({ reuseRoutes: true })
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
  const h = build({ reuseRoutes: false })
  ok(h.routeOverlayYml().length === 0, 'reuseRoutes=false 时还在往 overlay 里塞东西')
}

// ③ 宿主补丁层读不到 ⇒ 静默返回空（不许因此让值班跑不起来）
{
  process.env.DSH_PROFILE_DIR = join(dir, 'profiles', 'nope')
  const h = build({ reuseRoutes: true })
  let threw = null
  let yml = []
  try { yml = h.routeOverlayYml() } catch (e) { threw = e }
  ok(!threw, '补丁文件不存在时抛异常了（会把整个值班卡死）: ' + (threw && threw.message))
  ok(yml.length === 0, '补丁文件不存在时还生成了内容')
}

// ④ 只有 DSH_HOME + DSH_PROFILE 时也要能找到（CLI 版没有 DSH_PROFILE_DIR）
{
  delete process.env.DSH_PROFILE_DIR
  const oldHome = process.env.DSH_HOME
  const oldProf = process.env.DSH_PROFILE
  process.env.DSH_HOME = dir
  process.env.DSH_PROFILE = 'desktop'
  const h = build({ reuseRoutes: true })
  ok(h.hostPatchFile().endsWith('cordis.patch.yml'), 'DSH_HOME+DSH_PROFILE 兜底路径没算出来')
  ok(h.routeOverlayYml().length > 0, '走 DSH_HOME 兜底时没生成 overlay')
  process.env.DSH_HOME = oldHome
  process.env.DSH_PROFILE = oldProf
}

// ⑤ 接线检查：这三处不接上，前面再对也没用
ok(/const routeYml = routeOverlayYml\(\)/.test(idx), 'ensureOverlay 没调用 routeOverlayYml（值班拿不到线路）')
ok(/const probe = writeRouteOverlay\(\)/.test(idx), '/api/bili-pond/models 探测没带 overlay（界面上的灰/亮会是假象）')
ok(/modelsInProfile\(cfg\.headlessProfile, probe \? \{ patch: probe \} : \{\}\)/.test(idx), '两个探测点没把 patch 传进 modelsInProfile')
ok(idx.includes('const declared = new Set()'), 'modelsInProfile 没解析 providers: 下的线路名（pi-ai 那类线路会看不见）')
ok(/declared: \[\.\.\.declared\]/.test(idx), 'modelsInProfile 没把 declared 返回出去')
ok(/reuseRoutes: z\.boolean\(\)/.test(idx), '设置项 reuseRoutes 没进 schema')

// 收尾
if (oldDir === undefined) delete process.env.DSH_PROFILE_DIR
else process.env.DSH_PROFILE_DIR = oldDir
rmSync(dir, { recursive: true, force: true })

if (fail.length) {
  console.error('❌ 线路复用校验失败：')
  for (const f of fail) console.error('   - ' + f)
  process.exit(1)
}
console.log(`✅ 线路复用校验通过（${total} 条断言）`)
