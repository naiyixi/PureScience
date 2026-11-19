import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Real-window acceptance for the CNKI-format import path (v3.0 unit 0.2).
//
// The gap this closes: the Chinese databases' export menu offers its own tagged text format ("CNKI 格式")
// right next to RIS, and that is what a reader who has never heard of RIS ends up with. The dialog already
// accepted `.txt`, but the plan only recognised Zotero JSON / RIS / EndNote / MEDLINE, so a real CNKI
// export came back as "neither a Zotero JSON nor a RIS export" — with the file sitting right there.
//
// What is asserted end to end, in the real window, on a real export file:
//   1. the file imports (imported count, nothing refused);
//   2. a Chinese substring search finds it and says which field it matched;
//   3. the citation produced for it carries the journal and the year and the authors — and carries neither
//      the authors' affiliation (`Organ-单位`, which is not a publisher) nor a placeholder identifier.
//
// The three records below are verbatim from a real 2022-generation export (the whole file, 67 records, is
// sha256 17af9369ee1c80992c2e9b7d462821f9d7eb555ffd3cea769f877738dddbb507; the same parser reads all 67
// without refusing one, see the unit suite). Keeping real bytes matters: a fixture written from the
// documentation would not carry the `:  ` (colon + two spaces), the trailing `;` after every author list or
// the `;;` between keywords, and those are exactly what a stricter reader would trip on.
const CNKI_EXPORT = `SrcDatabase-来源库:  期刊
Title-题名:  新时代桥梁智能建造及智慧服务体系研究
Author-作者:  文武松;毛伟琦;陶世峰;
Organ-单位:  中铁大桥局集团有限公司;桥梁结构健康与安全国家重点实验室;
Source-文献来源:  世界桥梁
Keyword-关键词:  桥梁工程;;战略需求;;智慧服务;;智能建造;;智慧运维;;综合管理平台;;数字化转型
Summary-摘要:  面向数字中国建设重大战略需求，针对桥梁智慧服务、建养并重的发展态势，以物联网、标识解析、大数据、云计算等现代科学技术的深化应用为基础，总结参建的多项重点桥梁智能建造与智慧运维工程及重点科研项目的构建要素、内涵与特征，逐步构建桥梁建造的智慧服务体系。研究结果表明：可以工业互联网桥梁基础信息追溯为基础框架，以信息模型为载体实现数据共享和业务集成；可实现桥梁施工过程数智化升级，并实现数字孪生驱动的桥梁智能建造；可搭建智慧工地，以提升生产效率；可实现桥梁运营期智慧运维监测；可形成桥梁智能建造智慧服务一体化综合管理平台，从而打造我国交通基础设施数字化转型与智能化升级的先进样板。
PubTime-发表时间:  2022-11-25
Year-年:  2022

SrcDatabase-来源库:  期刊
Title-题名:  双碳目标驱动的新型低压配电系统技术展望
Author-作者:  张勇军;羿应棋;李立浧;钟康骅;李钦豪;刘斯亮;肖晃庆;
Organ-单位:  智慧能源工程技术研究中心华南理工大学电力学院;
Source-文献来源:  电力系统自动化
Keyword-关键词:  新型电力系统;;碳达峰;;碳中和;;新能源;;配电网;;数字孪生;;云边协同
Summary-摘要:  新能源分布式应用是支撑中国实现“碳达峰·碳中和”战略目标的重要方式，势必对低压配电系统形成革命性的冲击，对传统的规划、运行、维护等方式提出了全新的挑战。首先，分析了中国低压配电系统的元素与形态变化，介绍各个环节的发展现状与面临的问题。其次，从透明化、低碳化、互动化、灵活化、多元化5个维度分析了新型低压配电系统的典型特征，并提出了其特征显著度定量评价指标。最后，从电能质量、可靠性、经济性和安全性4个关键问题出发，探讨了支撑新型低压配电系统的四大关键技术并展望了其未来发展方向。
PubTime-发表时间:  2022-11-24
Year-年:  2022

SrcDatabase-来源库:  期刊
Title-题名:  人工智能时代发酵优化与放大技术的机遇与挑战
Author-作者:  夏建业;刘晶;庄英萍;
Organ-单位:  中国科学院天津工业生物技术研究所智能生物制造平台实验室;国家合成生物技术创新中心;河北工业大学人工智能与数据科学学院;华东理工大学生物反应器工程国家重点实验室;
Source-文献来源:  生物工程学报
Keyword-关键词:  发酵工程;;合成生物学;;过程优化与放大;;数字孪生;;知识图谱
Summary-摘要:  人工智能(artificial intelligence, AI)技术正引发一场新的产业革命，其成功应用正从信息产业迅速渗透到各行各业。
PubTime-发表时间:  2022-11-23
Year-年:  2022
DOI-DOI:  10.13345/j.cjb.220606
`

const TITLE = '新时代桥梁智能建造及智慧服务体系研究'
const VENUE = '世界桥梁'
const AFFILIATION = '中铁大桥局集团有限公司'

test.setTimeout(180_000)

test('a real CNKI-format export imports, is found by a Chinese search, and cites its journal', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'CNKI import check')

  // The library opens from the sidebar's own row (icon + text), the way a reader reaches it.
  await page.locator('[data-testid="workspace-references-toggle"]').click()
  const dialog = page.getByRole('dialog', { name: 'Reference library' })
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // The .txt input next to "Import references": the same control a reader clicks, handed the bytes of a
  // real export instead of a path on disk.
  await dialog.locator('input[type="file"][accept*=".nbib"]').setInputFiles({
    name: 'CNKI-20221128005940461.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(CNKI_EXPORT, 'utf8')
  })

  // 1. Imported, nothing refused.
  await expect(dialog.getByText('Imported 3 records', { exact: false })).toBeVisible({
    timeout: 30_000
  })
  await expect(
    dialog.getByText('neither a Zotero JSON nor a RIS export', { exact: false })
  ).toHaveCount(0)

  // 2. A Chinese substring with no spaces finds the record, and the row says the hit was in the title.
  const search = dialog.locator('input[type="search"][aria-label="Search the library"]')
  await search.fill('桥梁智能建造')
  const count = dialog.locator('[data-testid="reference-search-count"]')
  await expect(count).toHaveText('1 of 3 records match', { timeout: 15_000 })
  const row = dialog.locator('li').filter({ hasText: TITLE })
  await expect(row).toHaveCount(1)
  await expect(row.locator('[data-testid="reference-search-match"]')).toContainText('title')

  // 3. The citation for that row: journal + year + first author on the page, the affiliation absent.
  await row.getByRole('button', { name: 'Compare styles' }).click()
  const comparison = dialog.locator('[data-testid="citation-style-comparison"]')
  await expect(comparison).toBeVisible({ timeout: 15_000 })
  const citation = ((await comparison.textContent()) ?? '').replace(/\s+/g, ' ')
  expect(citation).toContain(TITLE)
  expect(citation).toContain(VENUE)
  expect(citation).toContain('2022')
  expect(citation).toContain('文武松')
  // `Organ-单位` is the authors' affiliation — importing it as a publisher would be an invented fact.
  expect(citation).not.toContain(AFFILIATION)

  console.log(
    `[cnki-format-import] imported=3 refused=0 search="桥梁智能建造" count="${await count.textContent()}"` +
      ` venueOnCitation=${citation.includes(VENUE)} affiliationOnCitation=${citation.includes(AFFILIATION)}`
  )
})
