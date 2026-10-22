/* 私信遥控校验（2026-10-22 用户的想法：大号发私信 → 小号执行 → 私信回结果）
 *
 * 这一版只做**只读命令**（# 状态 / # 记录 / # 帮助），所以这里盯的是「闸门」而不是功能：
 *   ① 只认 owner UID（大号）② 只认前缀 ③ 按 msg_key 去重 ④ 每日上限
 *   ⑤ 第一次打开不能把历史私信全执行一遍（否则一开开关就刷屏）
 * 这几条任意一条被改掉，这个功能就会变成「任何人的私信都能遥控这台电脑」——
 * 所以必须是断言，不能只靠注释。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'index.js'), 'utf8')
const py = readFileSync(join(here, '..', 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const client = readFileSync(join(here, '..', 'client.js'), 'utf8')

let n = 0
let fails = 0
const ok = (cond, msg) => {
  n += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else { fails += 1; console.error(`  ✗ ${msg}`) }
}

console.log('=== 私信遥控：闸门 ===')
ok(/dmCtlOn: z\.boolean\(\)\.default\(false\)/.test(src), '私信遥控默认必须是关的（打开才听）')
ok(/const owner = Number\(cfg\.mentionUid\) \|\| 0/.test(src), '收件人只认 cfg.mentionUid（大号），不能是任意 UID')
ok(/on: cfg\.dmCtlOn === true && owner > 0/.test(src), '没有 owner UID 就不该生效（否则谁发都听）')
ok(/const body = raw\.startsWith\(prefix\) \? raw\.slice\(prefix\.length\)\.trim\(\) : raw/.test(src),
  '前缀可选（2026-10-22 用户定「不用 #，当聊天」）：写了就剥掉，没写整条当命令')
ok(/if \(String\(it\?\.dir \|\| ''\) !== 'in'\)/.test(src), '只处理「他发给我的」，自己发出去的不算命令')
ok(/if \(!key \|\| st\.keys\[key\]\) continue/.test(src), '同一条私信按 msg_key 去重，不能重复执行')
ok(/const cut = now - 24 \* 3600_000/.test(src), '只处理 24 小时内的私信')
ok(/const baseline = now - 120_000/.test(src) && /first && ts < baseline/.test(src),
  '第一次打开时，2 分钟前的历史私信只记基线、不执行（否则一开开关就刷屏）')
ok(/c\.dailyCap > 0 && dailyA\.count >= c\.dailyCap/.test(src) && /dailyA\.count >= c\.dailyCap[\s\S]{0,80}break/.test(src),
  '私信遥控也要有每日上限，而且必须**在起模型轮之前**判（否则白烧一轮再把结果丢掉）')
ok(/if \(handled >= 5\) break/.test(src), '一轮最多处理 5 条，别一次刷屏')
ok(/const body = String\(text \|\| ''\)\.slice\(0, 480\)/.test(src), '回信要截断到 500 字以内（B站私信上限）')
ok(/}, 300_000\)/.test(src), '一轮最多等 5 分钟（用户 2026-10-22 定：分析视频要取字幕+读内容）')

ok(/if \(r\?\.sessionId\) st\.sessionId = String\(r\.sessionId\)/.test(src),
  '每轮要把 sessionId 接回状态（否则末尾 saveDm 会把新 id 覆盖成空 ⇒ 每条私信都新建会话）')

ok(/const dmDeliver = async \(text, owner\) =>/.test(src), '发私信要回读校验（接口说成功不代表送到）')
ok(/去掉链接再发一次/.test(src), '没送到时应去掉链接重发一次')
ok(/const delivered = await dmDeliver\(reply, c\.owner\)/.test(src), '回信必须走 dmDeliver，不能直接 call(bili_send_message)')

console.log('=== 私信遥控：只读命令 ===')
ok(/if \(\/\^\(状态\|status\|s\)\$\/\.test\(cmd\)\) return dmStatusText\(\)/.test(src), '应支持「# 状态」')
ok(/if \(\/\^\(记录\|log\|logs\)\$\/\.test\(cmd\)\) return dmLogText\(5\)/.test(src), '应支持「# 记录」')
ok(/if \(\/\^\(帮助\|help\|\\\?\|？\)\$\/\.test\(cmd\)\) return dmHelpText\(prefix\)/.test(src), '应支持「# 帮助」')
ok(!/return `这条还不认识/.test(src), '兜底不许再回「这条还不认识」（用户实测被这句机器话怼过）')
ok(/我这轮没跑成/.test(src), '跑不成要说人话：我这轮没跑成，过会儿再发我一次')
ok(!/dmAnswer[\s\S]{0,400}?bili_upload_video/.test(src), '第一版不允许私信触发上传（写操作还没放）')

console.log('=== 接线 ===')
ok(/await call\('bili_dm_inbox', \{ uid: c\.owner, limit: 20 \}\)/.test(src), '宿主应通过 bili_dm_inbox 读私信')
ok(/await call\('bili_send_message', \{ receiver_uid: c\.owner/.test(src), '回信应发给 owner（不能发给别人）')
ok(/收到，我看一下，一会儿回你/.test(src), '视频/分析这类重活要先应一声，别让人干等')
ok(/type: 'dm', cmd: text\.slice\(0, 80\), ok: true/.test(src), '回成功要写进守护记录（界面能看见）')

console.log('=== 全部进会话（2026-10-22 用户口径） ===')
ok(/const r = await dmAsk\(isAsk \? mAsk\[2\] : cmdText, dmContext\(\)\)/.test(src),
  '只读命令（状态/记录/帮助）也要起一轮、进同一条会话 —— 面板没人盯，会话才是能翻的记录')
ok(/主人刚在私信里给我发了条消息：\$\{question\}/.test(src) && /私信：\$\{brief\}/.test(src),
  '提示词要用大白话（结构化块会被当成提示注入，实测踩过 4 种写法）')
ok(/别自己发私信/.test(src), '要明确告诉它「别自己发私信」，发不发由宿主决定')
const dmList = (/if \(why === 'dm'\)[\s\S]{0,700}?return \[([^\]]*)\]/.exec(src) || [])[1] || ''
ok(dmList.length > 0 && !/bili_send_message/.test(dmList) && !/bili_reply/.test(dmList),
  '私信遥控轮的工具白名单里不能有写工具（bili_send_message / bili_reply）—— 回信由宿主发，公开说话是守护轮的活')
ok(/const dmContext = \(\) => \{/.test(src) && /dmStatusText\(\)[\s\S]{0,200}dmLogText\(5\)[\s\S]{0,200}dmHelpText/.test(src),
  'dmContext 要把状态/记录/帮助拼进提示词（模型只能引用这些数字，不能编）')
ok(/if \(!cmdText\) \{ st\.keys\[key\] = ts \|\| now; continue \}/.test(src),
  '空消息（表情/空白）不能起轮，否则白烧额度')
ok(/const r = await dmAsk\(isAsk \? mAsk\[2\] : cmdText, dmContext\(\)\)/.test(src),
  '不带前缀的私信也要起轮（当聊天处理）')
ok(/reply = r\?\.text \? r\.text : \(dmAnswer\(cmdText\) \|\| /.test(src),
  '模型轮失败时要退回宿主自己拼的只读答案（dmAnswer）')

console.log('=== 接线（续） ===')
ok(/dmCtlOn: false, dmCtlPrefix: '#', dmCtlPollMinutes: 5, dmCtlDailyCap: 30,/.test(src), 'DEFAULTS 里要有这四个字段')
ok(/'dmCtlOn', 'dmCtlPrefix', 'dmCtlPollMinutes', 'dmCtlDailyCap'/.test(src), 'persistCfg 白名单里要有这四个字段')
ok(/setInterval\(\(\) => \{ dmTick\(\)/.test(src), '私信遥控要有自己的定时器')
/* 2026-10-22 用户实测：「你测试的那条对话去哪了？」—— 会话按 cwd 分桶，跑在 stateDir 下用户看不到 */
ok(/const cwdDir = runDir\(\)/.test(src) && /cwd: cwdDir/.test(src),
  '私信轮要跑在「值班跑在哪个目录」里（会话按 cwd 分桶，否则用户在会话列表里根本看不到）')
const dmAskSrc = (src.slice(src.indexOf('const dmAsk ='), src.indexOf('const dmTick')) || '')
ok(dmAskSrc.length > 0 && !/cwd: stateDir/.test(dmAskSrc),
  'dmAsk 里绝不能拿 stateDir 当 cwd：那儿有 duty.md / out 报告，模型会去翻然后自己编')
ok(/return \['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_user_info', 'bili_user_videos', 'bili_guard_scan'\]/.test(src),
  '私信轮要能取字幕/简介/搜索/守护数据（用户 2026-10-22：私信是跟 AI 聊天，不是查询命令）')

console.log('=== MCP 侧 ===')
ok(/async def bili_dm_inbox\(uid: int = 0, limit: int = 20\)/.test(py), 'mcp_server.py 应有 bili_dm_inbox')
ok(/@tool\(\)\r?\nasync def bili_dm_inbox/.test(py), 'bili_dm_inbox 必须挂着 @tool()（不然不注册）')
ok(/session\.fetch_session_msgs\(talker_id=int\(uid\), credential=cred, session_type=1\)/.test(py),
  '应走 session.fetch_session_msgs 读私信')
ok(/"dir": "in" if int\(m\.get\("sender_uid"\) or 0\) == int\(uid\) else "out"/.test(py), '方向要按 sender_uid 判，不能猜')

console.log('=== 私信遥控：问（B 方案，真起一轮）===')
ok(/\^\(问\|ask\|q\)\\s\+\(\[\\s\\S\]\+\)\$/.test(src), '应支持「# 问 <一句话>」')
ok(/const dmAsk = \(question, context = ''\) => new Promise/.test(src), '「问」要真起一轮（异步），不能只回固定文案')
ok(/args\.push\('--json'\)|'--json'\]/.test(src), '要用 --json 才能拿到会话 id 和 final 正文')
ok(/if \(st\.sessionId\) args\.push\('--session-id', st\.sessionId\)/.test(src),
  '有会话 id 就要续上（别每问一句新建一条会话）')
ok(/s\.sessionId = sid; saveDm\(s\)/.test(src), '第一次跑完要把会话 id 存下来')
ok(/ev\?\.type === 'final' && typeof ev\.text === 'string'/.test(src), '答复取自 final 事件，不是自己拼')
ok(/300_000/.test(src) && /超时（300 秒没答完）/.test(src), '「问」要有超时兜底（5 分钟，分析视频要时间）')
ok(/c\.askCap > 0 && rounds\.count >= c\.askCap/.test(src) && /rounds\.count \+= 1; st\.ask = rounds/.test(src),
  '每起一轮都要计数（不只「问」）—— 所有私信都起一轮之后，「问」的额度就是「轮」的额度')
ok(/askCap: Math\.max\(0, Math\.min\(200, Number\(cfg\.dmCtlAskCap \?\? 20\)\)\)/.test(src), 'askCap 要能配（默认 20）')
ok(/私信这边就是跟我聊天/.test(src) && /视频链接 \/ BV 号/.test(src), '帮助要按「聊天」写：能甩视频链接、能问本地情况、能让我查')

console.log('=== 自适应节奏（B站 没有私信推送，只能轮询）===')
ok(/const DM_HOT_MS = 20_000/.test(src), '热窗口间隔 20 秒')
ok(/const DM_HOT_WINDOW = 10 \* 60_000/.test(src), '热窗口持续 10 分钟')
ok(/const gap = hot \? Math\.min\(c\.pollMs, DM_HOT_MS\) : c\.pollMs/.test(src),
  '热的时候取「设置值与 20 秒的较小者」，冷的时候按设置')
ok(/hotUntil: Number\(d\.hotUntil\) \|\| 0/.test(src), '热窗口要落盘（重启不丢）')
ok(/st\.hotUntil = now \+ DM_HOT_WINDOW/.test(src), '扫到入站消息就该进热窗口')
ok(/\}, 10_000\)/.test(src), '定时器跳 10 秒，否则热窗口退化成 60 秒')

console.log('=== 前缀与空格容错 ===')
ok(/\|\| \/\^\(问\|ask\|q\)\(\[\\s\\S\]\{4,\}\)\$\/i\.exec\(cmdText\)/.test(src),
  '「问」不跟空格也认，但正文至少 4 个字（否则「#问题」会被当成提问）')
{
  // 镜像宿主那两条正则，确认容错符合预期
  const A = /^(问|ask|q)\s+([\s\S]+)$/i
  const B = /^(问|ask|q)([\s\S]{4,})$/i
  const pick = (s) => A.exec(s) || B.exec(s)
  ok(pick('问 今天值得看什么')?.[2] === '今天值得看什么', '「问 今天…」认')
  ok(pick('问今天值得看什么')?.[2] === '今天值得看什么', '「问今天…」（无空格）也认')
  ok(pick('问题') === null, '「问题」两个字不当成提问（正文太短）')
  ok(pick('ask what is new')?.[2] === 'what is new', '英文 ask 一样')
}

console.log('=== 设置页 ===')
ok(/const \[dmCtlOn, setDmCtlOn\] = React\.useState\(null\)/.test(client), '设置页应有 dmCtlOn 草稿 state')
ok(/patch\(\{ dmCtlOn: v \}, '私信遥控'\)/.test(client), '开关要能存回去')
ok(/patch\(\{ dmCtlPrefix: v \}, '命令前缀'\)/.test(client), '前缀要能存回去')
ok(/像微信聊天/.test(src), '提示词要按聊天写（用户 2026-10-22 澄清：私信 = 对话入口）')

if (fails) {
  console.error(`\n❌ 私信遥控校验失败：${fails}/${n} 条`)
  process.exit(1)
}
console.log(`✅ 私信遥控校验通过（${n} 条断言）`)
