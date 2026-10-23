/**
 * 守护评论区：「这条评论值不值得回」的判据测试
 *
 * 为什么单独测这个：`worthReplying()` 决定**会不会以账号的嘴说话**。
 *   判松了 → 一条视频下几十条「哈哈哈」全被回，观感像机器人 + 撞风控；
 *   判紧了 → 真提问的人被漏掉，守护等于没开。两头都是使用者能立刻感知的错。
 *
 * 做法：从 index.js 里切出真源码（不是复制一份），在沙箱里执行 —— 保证测的就是线上那份。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'index.js'), 'utf8')

const START = 'const GUARD_JUNK'
const END = 'const readGuard'
const a = src.indexOf(START)
const b = src.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
  console.error('✗ 切不到 worthReplying 的源码段（index.js 结构变了？找 const GUARD_JUNK / const readGuard）')
  process.exit(1)
}
const slice = src.slice(a, b)

let fails = 0
let n = 0
const ok = (cond, msg) => {
  n++
  if (!cond) { fails++; console.error(`  ✗ ${msg}`) }
}

// 沙箱里只需要这几个常量，别的依赖一个都不给 —— 给了就说明这段代码偷偷依赖了外部状态
const worthReplying = new Function(`${slice}\nreturn worthReplying`)()

const cases = [
  // 纯水：不回
  ['哈哈哈', false, '纯哈哈哈'],
  ['哈哈哈哈哈', false, '长哈哈哈'],
  ['666', false, '纯 666'],
  ['6666666', false, '长 666'],
  ['顶', false, '顶'],
  ['第一', false, '抢第一'],
  ['前排', false, '前排'],
  ['沙发', false, '沙发'],
  ['打卡', false, '打卡'],
  ['😀😀😀', false, '纯表情'],
  ['！！！', false, '纯标点'],
  ['', false, '空'],
  ['   ', false, '纯空白'],
  ['你好', false, '只有两个字的寒暄'],

  // 有内容：回
  ['这个视频里的漏洞能复现吗？', true, '提问'],
  ['请问怎么复现', true, '短提问（有问词）'],
  ['视频做得挺好的，就是声音有点小', true, '有实质反馈'],
  ['不错不错，学到了很多', true, '正向但够长'],
  ['为什么我照着做会报错呢', true, '提问 + 问词'],
  ['@我的主人是吴彦祖总结这个视频', true, '真实 @ 文本：昵称和正文粘在一起（不剥前缀，否则正文被吃掉）'],
  ['@某个路人 总结这个视频', true, '@ 前缀带空格'],
  ['@某人 @另一个人 这个思路可行', true, '多个 @ 前缀'],

  // 广告：不回
  ['加群一起交流', false, '广告：加群'],
  ['私信我给你资源', false, '广告：私信'],
  ['看我主页 vx', false, '广告：vx'],
  ['https://example.com/abc 这里有', false, '广告：链接'],
]

for (const [text, want, label] of cases) {
  const got = worthReplying(text)
  ok(got === want, `${label}：期望 ${want}，实际 ${got}（原文「${text}」）`)
}

// 边界：非字符串输入不许抛（接口/老数据都可能给 null）
for (const bad of [null, undefined, 0, {}]) {
  let threw = false
  let r
  try { r = worthReplying(bad) } catch { threw = true }
  ok(!threw && r === false, `非字符串输入 ${JSON.stringify(bad)} 应返回 false 且不抛`)
}

// 接线：index.js 里评论通道必须走这个判据，且白名单在大号视频下要让路
ok(/if \(g\.ownAll\) \{\s*\n\s*if \(!worthReplying\(c\?\.text\)\) \{ skip\.junk\+\+; continue \}/.test(src),
  '评论通道应写成：ownAll 时只按 worthReplying 过滤（跳过原因也要计数）')
ok(/if \(!g\.ownAll && !g\.whitelist\.size\) return \{ ok: false, skipped: 'no-whitelist' \}/.test(src),
  '白名单只在「不开大号视频全回」时才是硬门槛')
ok(/const room = g\.dailyCap > 0 \? Math\.max\(0, g\.dailyCap - daily\.count\) : Infinity/.test(src),
  '每日上限应参与「这一轮取几条」的计算')
ok(/guardDailyCap: z\.natural\(\)\.default\(30\)/.test(src), 'schema 应有 guardDailyCap 默认 30')
ok(/guardOwnAll: z\.boolean\(\)\.default\(true\)/.test(src), 'schema 应有 guardOwnAll 默认开')

/* ── 守护记录 + 守护口径（2026-10-22 用户提的第二个需求）────────────────────
 * 记录必须由**真正发回复的那一层**写，否则「模型说回了」就成了唯一证据。
 * 所以这里断言三件事：宿主注入日志路径 → MCP 子进程写 → 宿主能读出来给界面。 */
const py = readFileSync(join(here, '..', 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
ok(/BILI_GUARD_LOG: '\$\{posix\(guardLogFile\)\}'/.test(src), 'overlay 应把日志路径以 BILI_GUARD_LOG 注入 MCP 子进程')
ok(/_guard_log\(\{"type": "reply", "ok": True/.test(py), 'bili_reply 成功后应写一条 ok=True 的记录')
ok(/_guard_log\(\{"type": "reply", "ok": False/.test(py), 'bili_reply 失败后也应写一条 ok=False 的记录（失败要看得见）')
ok(/os\.environ\.get\("BILI_GUARD_LOG"\)/.test(py), 'MCP 侧应从环境变量取日志路径，不硬编码')
ok(/guardLogAppend\(\{\s*\n\s*ts: Date\.now\(\), type: 'scan'/.test(src), '扫完应写一条 scan 记录（含跳过原因计数）')
ok(/type: 'queue'/.test(src), '派出去回的那几条也应各写一条 queue 记录')
ok(/path === '\/api\/bili-pond\/guard\/log'/.test(src), '应有 GET /api/bili-pond/guard/log 给界面读')
ok(/guardTone: z\.string\(\)\.default\(''\)/.test(src), 'schema 应有 guardTone（守护口径）')
ok(/主人的口径（照这个说话/.test(src), '口径应拼进守护提示词')
ok(/guardTone: String\(guardTone \?\? ''\)/.test(readFileSync(join(here, '..', 'client.js'), 'utf8')),
  '设置页应能把口径存回去')

/* ── 对账：只有真发出去才算回过（2026-10-22 用户抓到的假数字）─────────────────
 * 界面显示「今天已回 3 条」，实际一条都没发出去（派发后值班 exit 1）。
 * 现在：① 计数从守护记录里数 reply ok:true ② 派发只记 pending ③ 没发出去的下一轮从清单补回 */
ok(/const guardAnswered = \(\) => \{[\s\S]{0,600}?e\?\.type !== 'reply' \|\| e\.ok !== true/.test(src),
  'guardAnswered 必须只数「reply 且 ok:true」，否则统计又变成派发数')
ok(/daily = \{ date: [^,}]+?, count: answered\.today\.size \}/.test(src),
  '每日计数应取真发出去的条数（answered.today），不能用派发数累加')
ok(/if \(room === 0\) \{[\s\S]{0,220}?skipped: 'daily-cap'/.test(src),
  '日额度用完应直接返回、连扫都不扫（扫了也回不了，还会把水位推过这一批）')
ok(/at: nowIso, n: \(p\?\.n \|\| 0\) \+ 1,/.test(src),
  '派发应只记 pending（含尝试次数），不能直接记 seen（否则失败了永远不重试）')
ok(/item: \{ kind: t\.kind, bvid: t\.bvid, rpid: t\.rpid/.test(src),
  'pending 里要存条目细节：清单文件会被提示词构建删掉，挂了只剩这个能还原')
ok(/const MAX_TRY = 3/.test(src) && /p\.n >= MAX_TRY/.test(src), '同一 rpid 试满 3 次应放弃，避免死循环')
ok(/seen 里有、但守护记录里没有 ok 回执的/.test(src), '旧版「派发即记 seen」的账应能补回成 pending')
ok(/const it = p\?\.item \|\| logged\.get\(rpid\)/.test(src),
  '重试条目应来自 pending 里的细节 / 守护记录 queue 行还原（不能靠 guard-queue.json）')
ok(/if \(!it\) \{ delete st\.pending\[rpid\]; continue \}/.test(src), '细节还原不出来的 pending 应清掉，别占重试位')
ok(/for \(const it of \[\.\.\.retry, \.\.\.fresh\]\)/.test(src), '重试项应排在新项前面')
ok(/pending: Object\.keys\(st\.pending\)\.length/.test(src), '/guard/log 应回 pending 数（界面要显示还有几条没回出去）')
ok(/daily: \{ date: dayKey\(new Date\(\)\), count: answered\.today\.size \}/.test(src),
  '/guard/log 的 daily 也应取真发出去的数量')

/* ── 装饰器被抢走 ⇒ 工具根本没注册（2026-10-22 实测事故）────────────────────────
 * 事故：`@tool()` 原本在 bili_reply 上，新插的 `_guard_log` 把装饰器抢走了，
 *       bili_reply 从此不注册 —— 值班模型手里没有这只工具（它说「我没有 bili_reply」是真的），
 *       于是守护永远回不出去。所以这两条必须盯着。 */
ok(/@tool\(\)\r?\nasync def bili_reply\(/.test(py),
  'bili_reply 必须紧贴 @tool()：装饰器被别的函数抢走就不注册，守护永远回不出去')
ok(!/@tool\(\)\r?\ndef _guard_log\(/.test(py), '_guard_log 是内部辅助函数，不该占 @tool()（占了就把下一个工具挤掉）')

/* ── 守护轮只能干守护的事（2026-10-22 用户：「这个搜索一遍，是从哪来的？我没手动也没开自动」）─────
 * 事故：守护轮把**整份章程**当提示词喂进去，模型顺手把日常流程也跑了 —— 搜视频、写推荐、发私信，
 *       用户莫名其妙收到一条「今天没什么新的了」的私信。两处一起掐：提示词 + 工具白名单。 */
ok(/if \(why === 'guard'\) \{[\s\S]{0,400}?这是\*\*守护评论区\*\*的一轮/.test(src),
  '守护轮应给专用提示词（只回评论），不能把整份章程塞进去')
ok(/不许按关键词搜视频、不许写推荐\/挑片、不许发私信/.test(src), '守护轮提示词应明确禁止搜索/推荐/私信')
ok(/if \(why === 'guard'\) \{\s*\n\s*return \['bili_guard_scan'/.test(src),
  '守护轮的工具白名单应收窄成只读内容 + 回复那几只')
ok(/BILI_MCP_TOOLS: '\$\{mcpWhitelist\(why\)\.join\(','\)\}'/.test(src),
  'overlay 的白名单必须按这一轮的来源（why）算，否则守护轮还是握着搜索/私信的手')
ok(/const overlay = ensureOverlay\(why\)/.test(src) && /(?:args\.push\(promptFor\(why\)\)|const dutyPrompt = promptFor\(why\)[\s\S]{0,220}args\.push\(dutyPrompt\))/.test(src),
  'runDuty 应把 why 一路传进 overlay 与提示词')

if (fails) {
  console.error(`\n❌ 守护判据校验失败：${fails}/${n} 条`)
  process.exit(1)
}
console.log(`✅ 守护判据校验通过（${n} 条断言）`)
