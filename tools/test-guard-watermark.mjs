/**
 * 守护评论区：水位推进（advanceWatermarks）的判据测试
 *
 * 为什么单独测这个：水位决定「下一轮还扫不扫得到这条评论」。
 *   推早了 → 超出本轮配额的那些评论**永久丢失**，而且一条日志都不留（1.3.0 的真实 bug：
 *            默认 perRound=3，一次来 10 条有内容的评论 ⇒ 回 3 条、丢 7 条）；
 *   不推   → 每 3 分钟重新扫同一批，白烧风控额度、还可能重复回。
 *   两头都是使用者感知不到、但账号会慢慢废掉的错。
 *
 * 做法：从 index.js 里切出真源码（不是复制一份），在沙箱里执行 —— 保证测的就是线上那份。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'index.js'), 'utf8')

const START = 'const advanceWatermarks = ('
const END = 'const guardScan = async'
const a = src.indexOf(START)
const b = src.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
  console.error('✗ 切不到 advanceWatermarks 的源码段（index.js 结构变了？找 const advanceWatermarks / const guardScan）')
  process.exit(1)
}
const slice = src.slice(a, b)

let fails = 0
let n = 0
const ok = (cond, msg) => {
  n++
  if (!cond) { fails++; console.error(`  ✗ ${msg}`) }
}
const eq = (got, want, msg) => ok(got === want, `${msg}（期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}）`)

const advanceWatermarks = new Function(`${slice}\nreturn advanceWatermarks`)()

/** 造 n 条评论：ctime 从 base 起逐秒递增 */
const mkComments = (bvid, base, n) =>
  Array.from({ length: n }, (_, i) => ({ bvid, ctime: base + i, rpid: base + i }))
const toQueue = (cms) => cms.map((c) => ({ kind: 'comment', bvid: c.bvid, rpid: c.rpid, ctime: c.ctime }))

const baseState = (over = {}) => ({ atId: 0, atTime: 0, ctimes: {}, ...over })

/* ① 经典丢失场景：10 条评论、本轮只回 3 条 ⇒ 水位必须退回到第 4 条之前 */
{
  const cms = mkComments('BV1', 100, 10)
  const ordered = toQueue(cms)
  const take = ordered.slice(0, 3)
  const r = advanceWatermarks({ st: baseState(), cur: {}, cms, ordered, take, room: Infinity })
  eq(r.ctimes.BV1, 102, '10 条只回 3 条 ⇒ 水位退到第 4 条之前（103 - 1）')
  eq(r.deferred, 7, '推迟 7 条')
  const nextScan = cms.filter((c) => c.ctime > r.ctimes.BV1)
  eq(nextScan.length, 7, '下一轮按新水位重新扫，能捞回全部 7 条')
  ok(nextScan[0].ctime === 103, '捞回的第一条就是被推迟的那条')
}

/* ② 整批都回完了 ⇒ 按扫到的最大值推进（不能倒退，否则每轮重扫） */
{
  const cms = mkComments('BV1', 100, 3)
  const ordered = toQueue(cms)
  const r = advanceWatermarks({ st: baseState(), cur: {}, cms, ordered, take: ordered, room: Infinity })
  eq(r.ctimes.BV1, 102, '全部回完 ⇒ 水位推进到最大 ctime')
  eq(r.deferred, 0, '没有推迟')
}

/* ③ 日额度用完（room=0）⇒ 不回退。这是「今天到此为止」，回退只会白烧风控额度 */
{
  const cms = mkComments('BV1', 100, 10)
  const ordered = toQueue(cms)
  const r = advanceWatermarks({ st: baseState(), cur: {}, cms, ordered, take: [], room: 0 })
  eq(r.ctimes.BV1, 109, 'room=0 ⇒ 水位照常推到最大，不退')
  eq(r.deferred, 0, 'room=0 不算推迟')
}

/* ④ 多个视频各推进各的 */
{
  const cms = [...mkComments('BV1', 100, 5), ...mkComments('BV2', 900, 5)]
  const ordered = toQueue(cms)
  const take = [ordered[0], ordered[5]] // BV1 的第 1 条 + BV2 的第 1 条
  const r = advanceWatermarks({ st: baseState(), cur: {}, cms, ordered, take, room: Infinity })
  eq(r.ctimes.BV1, 100, 'BV1 回 1 条 ⇒ 水位退到 101-1')
  eq(r.ctimes.BV2, 900, 'BV2 回 1 条 ⇒ 水位退到 901-1')
}

/* ⑤ @ 通道：按 atId / atTime 退，而不是按 ctime */
{
  const ordered = Array.from({ length: 5 }, (_, i) => ({ kind: 'at', rpid: 500 + i, atId: 10 + i, ctime: 1000 + i }))
  const take = ordered.slice(0, 2)
  const r = advanceWatermarks({ st: baseState({ atId: 0, atTime: 0 }), cur: { id: 14, time: 1004 }, cms: [], ordered, take, room: Infinity })
  eq(r.nextAtId, 11, '@ 回 2 条（id 10、11）⇒ nextAtId 退到 12-1')
  eq(r.nextAtTime, 1001, '@ 回 2 条（time 1000、1001）⇒ nextAtTime 退到 1002-1')
  eq(r.deferred, 3, '推迟 3 条 @')
}

/* ⑥ @ 全部回完 ⇒ 按 cursor 推进 */
{
  const ordered = [{ kind: 'at', rpid: 500, atId: 10, ctime: 1000 }]
  const r = advanceWatermarks({ st: baseState({ atId: 0, atTime: 0 }), cur: { id: 10, time: 1000 }, cms: [], ordered, take: ordered, room: Infinity })
  eq(r.nextAtId, 10, '@ 全回完 ⇒ nextAtId = cursor.id')
  eq(r.nextAtTime, 1000, '@ 全回完 ⇒ nextAtTime = cursor.time')
}

/* ⑦ 已有水位更高时不许倒退（正常不会出现，防手改 state 后把水位打回去） */
{
  const r = advanceWatermarks({ st: baseState({ ctimes: { BV1: 500 } }), cur: {}, cms: mkComments('BV1', 100, 2), ordered: [], take: [], room: Infinity })
  eq(r.ctimes.BV1, 500, '扫到的 ctime 比已有水位低 ⇒ 水位不动')
}

/* ⑧ 空输入不炸 */
{
  const r = advanceWatermarks({ st: baseState(), cur: {}, cms: [], ordered: [], take: [], room: Infinity })
  eq(r.ctimes.BV1, undefined, '空输入 ⇒ ctimes 里没有这个视频')
  eq(r.nextAtId, 0, '空输入 ⇒ nextAtId 保持 0')
  eq(r.nextAtTime, 0, '空输入 ⇒ nextAtTime 保持 0')
}

/* ⑨ 脏数据（缺 bvid / ctime=0）不能把水位写成 NaN */
{
  const cms = [{ bvid: '', ctime: 100 }, { bvid: 'BV9', ctime: 0 }, { bvid: 'BV9' }]
  const r = advanceWatermarks({ st: baseState(), cur: {}, cms, ordered: [], take: [], room: Infinity })
  ok(!Number.isNaN(r.ctimes.BV9), 'ctime 缺失不写成 NaN')
  eq(r.ctimes[''], undefined, '空 bvid 不写进 ctimes')
}

if (fails) {
  console.error(`\n✗ 水位推进：${n - fails}/${n} 通过，${fails} 条失败`)
  process.exit(1)
}
console.log(`✓ 水位推进：${n} 条断言全过`)
