# 第三方技能集合：引入规则与归属

`resources/skills/` 下有两个第三方集合的技能，与自有技能一起随包分发：

| 集合                         | 来源仓库                                     | 引入提交                 | 引入数量 |
| ---------------------------- | -------------------------------------------- | ------------------------ | -------- |
| `sci` 第三方科研技能集合     | 见 `scripts/third-party-skills.sources.json` | `ec59a29a`（2026-11-16） | 160      |
| `air` 第三方 AI 研究技能集合 | `aarchila/AI-research-SKILLs`                | `04b11c02`（2026-01-16） | 74       |

逐个技能的来源路径、原作者与许可写在 `resources/skills/ATTRIBUTION.md`；许可全文随包在 `resources/skills/licenses/`。

## 引入规则

1. **看技能自己的许可，不看仓库顶层许可。** 两个仓库顶层都是 MIT，但 `sci` 里混着 GPL、非商业、专有与「未声明」的技能。一个技能只有在它自己的 `SKILL.md` 里写了允许商业再分发的许可（MIT / Apache-2.0 / BSD / ISC / CC-BY-4.0 / Biopython）才会被引入。
2. **读不出来的不装。** 用 app 自己的 frontmatter 解析器（`shared/skill-frontmatter`，FAILSAFE YAML）先读一遍；读不出 `name`/`description` 的技能会被跳过——装进去也只是个空条目。
3. **id 必须等于文件里的 `name`。** 内置技能的目录名与 `name:` 必须一致（`skill-nudge-identity` 用例钉着）。名字被自有技能占用时，引入时给目录名和 `name:` **一起**加集合前缀，本文件与 ATTRIBUTION 都会注明「已加前缀」；其余一切保持原状，署名不变。
4. **不引入的一律记原因。** 17 个技能没进来：GPL 3 个、非商业 2 个、专有 1 个、「未声明 / Unknown」5 个、许可串无法归类 4 个、frontmatter 读不出 2 个。要引入得先找作者澄清或取得授权。

## 重跑

```bash
# 两个来源仓库先放到本地（浅克隆即可）
# 两个来源仓库的地址写在 scripts/third-party-skills.sources.json（本文件不重复仓库名）
git clone --depth 1 <sci 来源仓库> /tmp/src-sci
git clone --depth 1 <air 来源仓库> /tmp/src-air

SKILLS_SOURCE_SCI=/tmp/src-sci SKILLS_SOURCE_AIR=/tmp/src-air node scripts/import-third-party-skills.mjs
```

脚本是幂等的：重跑会重建 manifest 里属于第三方的行、删掉本次没有产出的第三方目录、重写 `ATTRIBUTION.md`。升级到新提交时改 `scripts/third-party-skills.sources.json` 里的 `commit`/`commitDate` 再跑一次。

## 成本（实测）

`SkillRegistry.list()` 会把每个内置技能的整棵目录读一遍做兼容性哈希：

| 规模                 | 文件数 | 体积   | 首次       | 第二次    |
| -------------------- | ------ | ------ | ---------- | --------- |
| 引入前（58 个技能）  | 约 700 | 2.1 MB | —          | —         |
| 引入后（292 个技能） | 2,461  | 32 MB  | **140 ms** | **42 ms** |

这是页缓存热的读数；冷盘约 380 ms。引入 234 个技能把首次目录读取从约 50 ms 推到了 140 ms 量级——可以接受，但已经把「manifest 里存兼容性哈希、跳过整树读取」列为后续优化项。

## 品牌扫描的豁免（以及为什么不是漏洞）

`scripts/pre-push-checks.sh` 会对跟踪范围做一次敏感词扫描，规则是「自有内容不借用别人的产品名与说法」。第三方技能正文里必然出现作者自己的项目名、依赖名等专有说法——那是他们的原文，改掉就等于篡改别人的文件，也与「不改原作者署名」这条相冲突。

所以豁免是**从 manifest 算出来的、窄口子**：`scripts/third-party-skill-paths.mjs` 只吐出 `thirdParty` 行对应的技能目录，加上 `ATTRIBUTION.md`、`licenses/`、`manifest.json`、`scripts/third-party-skills.sources.json`（后两个的全部职责就是写清来源仓库与提交）。自有技能目录、UI 文案、文档一律不在豁免里。要收窄或取消豁免，改这一个脚本即可，不用翻 hook。

配套的一条：manifest 里的 `thirdParty` 存的是**集合标题**（面板上给人看的那一行），不是仓库路径——把别人的仓库名显示到我们界面上，正是这条规则要避免的事。仓库路径与提交哈希只出现在 ATTRIBUTION 与 sources.json 里。

## 护栏

`src/main/skills/third-party-attribution.test.ts` 钉四件事：manifest 行与目录一一对应且没有孤儿目录；每个导入技能都在 `ATTRIBUTION.md` 里有名字；每个集合的许可全文存在且被 ATTRIBUTION 指到；发行树里**没有**任何 `license:` 写着 GPL / 非商业 / 专有的技能（防止有人手工塞进来绕过脚本）。
