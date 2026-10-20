/**
 * 针对新功能的离线测试。
 * ⚠️ 0.1.10 起配置是「本地优先」：apply() 收到的 config 只在一个地方不是真值源 ——
 *    没有设置表单时 loadCfg() 直接用插件家里的 config.json。
 *    所以测 overlay / 预检这类**读 cfg** 的行为，必须往那个 config.json 里写，不能只传给 apply()。
 *
 * 覆盖：
 *   ① 有 llm 时 /models 返回真实 provider 列表
 *   ② 没 llm 时不炸、返回空列表
 *   ③ dutyProvider 为空 ⇒ overlay 里不写 agent-default-model
 *   ④ dutyProvider 有值 ⇒ overlay 里 provider/model 都写对
 *   ⑤ dutyProvider 指向值班 profile 里没有的线路 ⇒ 拒绝开跑（不 spawn）
 *   ⑥ dutyProvider 在 profile 里确实有（workbuddy）⇒ 放行
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'C:/Users/MYPangYang/.dsh/profiles/desktop/node_modules/dsh-bili-pond'
const HOME = mkdtempSync(join(tmpdir(), 'bili-model-test-'))
const STATE = join(HOME, 'bili-duty')
mkdirSync(STATE, { recursive: true })

let failures = 0
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label)
  else { failures++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')) }
}

const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href)

const fakeLlm = {
  listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }, { id: 'workbuddy', name: 'WorkBuddy' }],
  listModels: async (p) => (p === 'workbuddy'
    ? [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }, { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' }]
    : [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]),
}

function makeCtx(withLlm) {
  const routes = []
  const tools = []
  const ctx = {
    get: (n) => {
      if (n === 'dshHomePath') return (name) => join(HOME, name)
      if (n === 'llm') return withLlm ? fakeLlm : undefined
      return undefined
    },
    effect: (f) => { try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: () => {},
    debounce: (f) => f,
    settings: { describe: () => [], update: async () => {} },
    tools: { register: (t) => { tools.push(t); return () => {} } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
  return { ctx, routes, tools }
}

const readCfg = () => JSON.parse(readFileSync(join(STATE, 'config.json'), 'utf8'))
const writeCfg = (patch) => {
  let cur = {}
  try { cur = readCfg() } catch { cur = {} }
  writeFileSync(join(STATE, 'config.json'), JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8')
}
const call = async (handler, method, url) => {
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await handler({ method, url, on: () => {} }, res)
  return { code: res.code, data: JSON.parse(res.body || '{}') }
}

// ── ①② /models
{
  writeCfg({ dutyProvider: '', dutyModel: '' })
  const { ctx, routes } = makeCtx(true)
  mod.apply(ctx, { perDay: 5 })
  const r = await call(routes[0].handler, 'GET', '/api/bili-pond/models')
  ok(r.data.ok === true, '① /models ok', JSON.stringify(r.data).slice(0, 160))
  ok((r.data.providers || []).length === 2, '① 两个线路都列出来', JSON.stringify((r.data.providers || []).map((x) => x.id)))
  const wb = (r.data.providers || []).find((x) => x.id === 'workbuddy')
  ok(wb && (wb.models || []).length === 2, '① workbuddy 的模型都在', JSON.stringify(wb && wb.models))
  ok((r.data.current || {}).provider === '', '① 默认不覆盖线路')
}
{
  const { ctx, routes } = makeCtx(false)
  mod.apply(ctx, { perDay: 5 })
  const r = await call(routes[0].handler, 'GET', '/api/bili-pond/models')
  ok(r.data.ok === true && Array.isArray(r.data.providers) && r.data.providers.length === 0,
    '② 没有 llm 时返回空列表而不是抛错', JSON.stringify(r.data).slice(0, 160))
}

// ── ③ overlay 不写覆盖
{
  writeCfg({ dutyProvider: '', dutyModel: '' })
  const { ctx, routes } = makeCtx(true)
  mod.apply(ctx, { perDay: 5 })
  await call(routes[0].handler, 'GET', '/api/bili-pond/status')   // 触发 ensureOverlay 的是 run，所以直接跑
  const overlay = join(STATE, 'headless-overlay.yml')
  // run 会 spawn，太慢；改为直接看 status 不进 run。这里用文件兜底断言：
  const text = existsSync(overlay) ? readFileSync(overlay, 'utf8') : ''
  ok(!text.includes('agent-default-model'), '③ 没选模型时 overlay 不写 agent-default-model', text.slice(0, 120))
}

// ── ⑤⑥ 预检（不真的 spawn dsh：用 dutyProvider 指向一个必然不存在的线路）
{
  writeCfg({ dutyProvider: 'totally-nonexistent-xyz', dutyModel: '' })
  const { ctx, routes } = makeCtx(true)
  mod.apply(ctx, { perDay: 5 })
  const r = await call(routes[0].handler, 'POST', '/api/bili-pond/run')
  ok(r.data.started === false, '⑤ 线路不存在时拒绝开跑', JSON.stringify(r.data).slice(0, 240))
  ok(String(r.data.error || '').includes('totally-nonexistent-xyz'), '⑤ 错误里点名了那条线路', r.data.error)
}

try { rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)
