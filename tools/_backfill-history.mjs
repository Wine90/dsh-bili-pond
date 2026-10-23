import { homedir } from 'node:os'
import { join } from 'node:path'
import { backfillReports, enrich, readHistory, replaceHistory } from '../lib/history.mjs'

const stateDir = process.argv[2]
  || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'bili-duty') : join(homedir(), '.dsh', 'bili-duty'))
const log = (m) => console.log('[history]', m)

const before = readHistory(stateDir)
const harvested = backfillReports(stateDir, { log })
log(`从 ${new Set(harvested.map((e) => e.reportRef)).size} 份日报解析出 ${harvested.length} 条`)

// 日报是新解析器的结果，优先覆盖旧记录；无法从日报重建的历史仍然保留。
const merged = [...before, ...harvested]
const written = replaceHistory(stateDir, merged)
log(`重写 ${written} 条（修复无 BV 前缀 / 旧坏行）`)

const all = readHistory(stateDir)
const beforePic = all.filter((e) => e.pic).length
await enrich(stateDir, all, { timeoutMs: 4000, log })
const afterPic = all.filter((e) => e.pic).length
log(`封面覆盖：${beforePic} → ${afterPic} / ${all.length}`)

replaceHistory(stateDir, all)
const picked = all.filter((e) => e.picked).length
log(`总计 ${all.length} 条（挑中 ${picked} / 跳过 ${all.length - picked}）`)
const byDate = {}
for (const e of all) byDate[e.date] = (byDate[e.date] || 0) + 1
log('按天：' + Object.entries(byDate).sort().map(([d, n]) => `${d}=${n}`).join(' '))
