/* 值班轮「跑在工作区」校验（2026-10-22 用户：「都搬进工作区哇，不然都要打开插件才能看到」）
 *
 * 这一改动的风险点全在**沙箱边界**上：
 *   跑在工作区 ⇒ 会话能出现在用户的会话列表 ✓，但那一轮的沙箱只让写 cwd
 *   ⇒ 报告 / 判重表 / 归档必须改由 MCP 子进程代写（子进程是宿主起的，不受沙箱限制）。
 * 下面每一条都对应一个曾经真实踩到的坑，改坏了就是「报告写不进去、判重表丢、评论重复发」。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'index.js'), 'utf8')
const py = readFileSync(join(here, '..', 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const duty = readFileSync(join(here, '..', 'prompts', 'duty.md'), 'utf8')

let n = 0
let fails = 0
const ok = (cond, msg) => {
  n += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else { fails += 1; console.error(`  ✗ ${msg}`) }
}

console.log('=== 值班轮的 cwd 是插件家（不进用户工作区记录）===')
ok(/const cwd = stateDir/.test(src),
  '值班轮 cwd 应是插件家（2026-10-22 用户：「现在对话不进工作区记录了吧？不要进了」）')
ok(!/dutyCwd/.test(src), '不该再有「跑在哪个目录」这个设置项')

console.log('=== 值班轮不再固定会话（2026-10-22 用户：固定会话拿掉）===')
ok(!/duty-session\.json/.test(src), '不该再读写 duty-session.json')
ok(!/--session-id/.test(src), '不该再带 --session-id 续会话')
ok(/id: session-persistence-jsonl/.test(src) && /headless-sessions/.test(src), 'headless 会话应存到插件目录，不进入 DSH 主界面右侧对话任务')
ok(/args\.push\('--json'\)/.test(src), '要带 --json 才能从事件流里拿到结果')
const iPatch = src.indexOf("args.push('--patch', overlay)")
const iJson = src.indexOf("args.push('--json')")
ok(iPatch > 0 && iJson > iPatch, '--patch 必须排在 --json 前面（实测 --json 之后不认 --patch，整轮 3 秒就退）')
ok(/守护评论区：替我回几条评论/.test(src) && /值班：刷一轮 B站/.test(src),
  '提示词首行应是可读标题（会话列表里显示的就是它）')

console.log('=== 文件出口（MCP 代写）===')
ok(/BILI_DUTY_HOME: '\$\{posix\(stateDir\)\}'/.test(src), 'overlay 应把 BILI_DUTY_HOME 传给 MCP 子进程')
ok(/'bili_report_save', 'bili_seen_read', 'bili_seen_append', 'bili_archive_append'/.test(src),
  '值班轮白名单里要有这四只代写工具')
ok(/bili_report_save\(markdown\)/.test(src), '提示词应告诉模型用 bili_report_save 交报告')
ok(/这一轮的工作目录就是插件数据目录/.test(src), '提示词应说明这一轮的工作目录就是插件家')
ok(/bili_archive_append/.test(src) && /bili_seen_append\(lines\)/.test(src), '判重表与归档也要走工具')
ok(/「评论记录」[\s\S]*真正通过 `bili_reply` 成功发出去/.test(duty),
  '章程必须明确：评论记录只记真正发出去的评论')
ok(/「看过的视频」[\s\S]*“挑中”绝对不等于“已评论”/.test(duty),
  '章程必须明确：看过的视频里的挑中不代表已评论')
ok(/想补评论时，只检查「评论记录」/.test(duty),
  '章程必须明确：补评论只查评论记录，不受看过的视频拦截')

console.log('=== MCP 侧实现 ===')
ok(/_DUTY_HOME = Path\(os\.environ\.get\("BILI_DUTY_HOME"\) or Path\(__file__\)\.resolve\(\)\.parent\)/.test(py),
  '_DUTY_HOME 应优先读 BILI_DUTY_HOME，否则取本文件所在目录')
ok(/@tool\(\)\r?\nasync def bili_report_save\(markdown: str\)/.test(py), 'bili_report_save 必须挂 @tool()')
ok(/@tool\(\)\r?\nasync def bili_seen_read\(limit_chars: int = 20000\)/.test(py), 'bili_seen_read 必须挂 @tool()')
ok(/@tool\(\)\r?\nasync def bili_seen_append\(lines: str\)/.test(py), 'bili_seen_append 必须挂 @tool()')
ok(/@tool\(\)\r?\nasync def bili_archive_append\(lines: str\)/.test(py), 'bili_archive_append 必须挂 @tool()')
ok(/_duty_write\(\["out", f"\{day\}\.md"\], str\(markdown or ""\)\)/.test(py), '报告写到 out/<今天>.md（覆盖）')
ok(/_duty_write\(\["seen\.md"\], text, append=True\)/.test(py), '判重表追加到 seen.md')
ok(/_duty_write\(\["out", f"\{month\}\.md"\], text, append=True\)/.test(py), '归档追加到 out/<YYYY-MM>.md')
/* ⚠️ 关键安全断言：这四只工具**不能**接受任意路径参数，否则等于给那一轮开了一个任意写口子 */
ok(!/async def bili_report_save\([^)]*\b(path|file|dir|filename)\b/.test(py), 'bili_report_save 不许接受路径参数')
ok(!/async def bili_seen_append\([^)]*\b(path|file|dir|filename)\b/.test(py), 'bili_seen_append 不许接受路径参数')
ok(!/async def bili_archive_append\([^)]*\b(path|file|dir|filename)\b/.test(py), 'bili_archive_append 不许接受路径参数')

if (fails) {
  console.error(`\n❌ 值班轮工作区校验失败：${fails}/${n} 条`)
  process.exit(1)
}
console.log(`✅ 值班轮工作区校验通过（${n} 条断言）`)
