import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, enrich, harvestReport, readHistory, replaceHistory } from '../lib/history.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-history-test-'))
try {
  const report = `# 刷B站值班 · 2026-10-23

## 挑中（值得你看）

### 1. 第一条测试标题 — 甲 — 1.5万播放 / 12评
\`BV1JcnW6pEFT\` https://www.bilibili.com/video/BV1JcnW6pEFT
- 内容：第一条内容
- 为什么值得：第一条理由
- 已评论 \`rpid\`

### 2. 第二条测试标题 — 乙 — 6953播放 / 199评
\`BV1bNns6BEEA\` https://www.bilibili.com/video/BV1bNns6BEEA
- 内容：第二条内容

### 3. 第三条测试标题 — 丙 — 2314播放 / 161评
\`BV1Qrni6kETb\` https://www.bilibili.com/video/BV1Qrni6kETb
- 内容：第三条内容

## 备选（没评论，留下一轮）
- \`BV18knp6vED8\` 第一条备选
- \`BV1jen464ELX\` 第二条备选

## 这轮没碰 / 过滤掉的
- 已看过的 \`BV16WnV6dEmb\`、\`BV1SFaS6MEdd\`
`
  const file = join(root, '2026-10-23.md')
  writeFileSync(file, report, 'utf8')

  const items = harvestReport(file)
  assert.equal(items.length, 7, '三条挑中 + 两条备选 + 两条已看')
  const picked = items.filter((x) => x.picked)
  assert.deepEqual(picked.map((x) => x.bvid), ['BV1JcnW6pEFT', 'BV1bNns6BEEA', 'BV1Qrni6kETb'])
  assert.equal(picked[0].title, '第一条测试标题')
  assert.equal(picked[0].owner, '甲')
  assert.equal(picked[0].views, 15000)
  assert.equal(picked[0].replyCount, 1)
  assert.equal(items.find((x) => x.bvid === 'BV18knp6vED8').skipReason, '备选')
  assert.equal(items.find((x) => x.bvid === 'BV16WnV6dEmb').skipReason, '已看过')

  // 章程规定的标准格式 + 旧日报的粗体字段。
  const canonical = join(root, '2026-10-22.md')
  writeFileSync(canonical, `# 旧日报\n\n## 这一轮挑中的\n\n### BV18Ubv6tEWN\n\n- **标题**：测试标题\n- **UP**：测试UP ｜ **播放**：116 ｜ **时长**：7:11\n- **为什么值得**：旧格式理由\n`, 'utf8')
  const [old] = harvestReport(canonical)
  assert.equal(old.bvid, 'BV18Ubv6tEWN', '标准 ### BV号 必须保留 BV 前缀')
  assert.equal(old.title, '测试标题')
  assert.equal(old.owner, '测试UP')
  assert.equal(old.views, 116)
  assert.equal(old.duration, 431)
  assert.equal(old.note, '旧格式理由')

  // 标题里的关键词不能改变分组。
  const edge = join(root, '2026-10-21.md')
  writeFileSync(edge, `# 边界\n\n## 挑中\n\n### 1. 这集千万别跳过 — UP — 1万播放\n\`BV1aaaaaaaaa\`\n\n### 推荐系统入门 — UP — 2万播放\n\`BV1eeeeeeeee\`\n\n## 备选\n### BV1bbbbbbbbb\n- 标题：备选也带标题\n\n### 其他搜索结果处理\n- \`BV1ccccccccc\` 超时长\n`, 'utf8')
  const edgeItems = harvestReport(edge)
  assert.equal(edgeItems.find((x) => x.bvid === 'BV1aaaaaaaaa').picked, true)
  assert.equal(edgeItems.find((x) => x.bvid === 'BV1eeeeeeeee').picked, true)
  assert.equal(edgeItems.find((x) => x.bvid === 'BV1bbbbbbbbb').picked, false)
  assert.equal(edgeItems.find((x) => x.bvid === 'BV1bbbbbbbbb').skipReason, '备选')
  assert.equal(edgeItems.find((x) => x.bvid === 'BV1ccccccccc').picked, false)
  assert.equal(edgeItems.find((x) => x.bvid === 'BV1ccccccccc').skipReason, '超出时长窗口')

  // 同一 BV 先备选后挑中：最终必须是挑中，且清掉旧原因。
  const dup = join(root, '2026-10-20.md')
  writeFileSync(dup, `# 重复\n\n## 备选\n- \`BV1JcnW6pEFT\` 备选\n\n## 挑中\n### 1. 最终挑中 — UP — 1万播放\n\`BV1JcnW6pEFT\`\n`, 'utf8')
  const [merged] = harvestReport(dup)
  assert.equal(merged.picked, true)
  assert.equal(merged.skipReason, '')
  assert.equal(merged.title, '最终挑中')

  assert.equal(appendHistory(root, items), 7)
  assert.equal(readHistory(root).length, 7)
  assert.equal(appendHistory(root, items), 7)
  assert.equal(readHistory(root).length, 7, '同日期同 BV 不应重复')

  appendHistory(root, harvestReport(canonical))
  appendHistory(root, [harvestReport(edge)[0]])
  const ordered = readHistory(root)
  assert.equal(ordered[0].date, '2026-10-23', '历史应按日期从新到旧')

  // 非法 BVID 不落盘，写一次后旧坏行也会被清掉。
  appendHistory(root, [{ date: '2026-10-19', bvid: '1aaaaaaaaa', title: '坏数据' }])
  assert.equal(readHistory(root).some((x) => x.bvid === '1aaaaaaaaa'), false)

  const rewritten = replaceHistory(root, ordered)
  assert.equal(rewritten, ordered.length)
  assert.deepEqual(readHistory(root).map((x) => `${x.date}|${x.bvid}`), ordered.map((x) => `${x.date}|${x.bvid}`))

  // 接口挂住时必须由 AbortSignal 截断，不能把值班收尾无限卡住。
  const realFetch = globalThis.fetch
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake timeout')), 1000)
    opts?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
  try {
    const started = Date.now()
    await enrich(root, [{ bvid: 'BV1ddddddddd', title: '超时测试' }], { limit: 1, timeoutMs: 50, gapMs: 0 })
    assert.ok(Date.now() - started < 1000, '封面上限请求应快速超时')
    const cache = JSON.parse(readFileSync(join(root, 'video-cache.json'), 'utf8'))
    assert.equal(cache.BV1ddddddddd.fail, true)
  } finally {
    globalThis.fetch = realFetch
  }

  console.log('✅ 历史解析通过（新旧格式、分组、重复状态、排序、坏数据、收尾超时）')
} finally {
  rmSync(root, { recursive: true, force: true })
}
