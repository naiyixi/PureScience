# 交接：给下一个会话（2026-10-09）

## 一句话状态

**用户三条批次（① 中文医学场景 / ② 溯源 / ③ 权限门）已全部交付并发版**（v1.91.0 / v1.92.0 / v1.93.0，
外加执行器补界面半边的 v1.93.1）。**当前没有在跑的活**；剩下的都是**被环境或并发挡住**的具名项（见 §三）。

## 二、环境与并发纪律（动手前先核这三条）

1. **并发执行器**：`hermes cron list` 看 `2be4405e5dc6`。2026-10-09 11:14 那轮 `ok`，
   **工作区留着它 7 个未提交在制品**：`src/main/artifacts/{code-reconstruction,provenance-repository,reproducibility-service}.ts`
   与对应 `*.test.ts`、`src/main/ipc.ts`。**那些不是你的**：不 stash、不提交、不据它们声称读数；
   要么等它落定，要么只动**与它们不相交**的路径（提交只用显式路径，永不用 `-a`/`.`）。
   它那批此刻**类型自洽**（`tsc -p tsconfig.node.json --composite false` exit 0）。
2. **内存就是闸门**：`sysctl vm.swapusage` + `vm_stat`。2026-10-09 本机 swap 9.77G/11.26G 已用、
   空闲物理页 **5907（≈92 MB）** ⇒ **不够起 `build:e2e` + Electron**。真机读数要等空闲页上到数万。
3. **看门脚本别用短 SHA**：`gh api …/actions/runs?head_sha=<完整 40 位>`；8 位短 SHA **永远返回空**，
   会被读成"没触发/已结束"。另：**空响应 ≠ 判完** —— 刚推上去那一秒 API 还没索引出来，
   把空当结论会打出一张假 FINAL 表（本轮咬了两次，修法是"空就继续等，连续多次空才放弃"）。

## 三、已交付（逐笔点名，按完整 40 位 SHA；`cancelled` 不算绿）

| 版本/提交 | 内容 | CI 证据 |
| --- | --- | --- |
| **v1.91.0** `1b757189` | 中文术语单一来源表（217 条/285 键）+ PubMed 中文查询；zh_medical_terms 跨语连接器 | 三车道全绿（Nightly 曾因 electron-builder 600s 下载超时红，**零改动复跑即绿**）|
| **v1.92.0** `cfdb8aff` | 审批卡说出「这次调用会在服务上留下东西」（只标真有写路径的那一个工具） | Release success；Windows 有 2 片红 ⇒ **复跑 8/8 全 success**（判为抖动）|
| **v1.93.0** `6c18d4db` | 从产物版本走回读数（会话读数日志 + 投影 `readings` 段）；GB/T 7714 电子资源块补发布机构 | Release success，21 资产 |
| **v1.93.1** `e2590ab0`（**执行器**） | 溯源面板新增「读数」分区 —— 补 v1.93.0 正文承诺的**界面半边** | 三车道全绿 |
| `3d01bf7a` | ②③ 引用链本体 | **自身两条车道被后一笔推送 `cancelled`（无判决）**；证据由包含它的 `395d3e17` 给出（已核祖先为真）|
| `ba65d723` | 自查收口：撤掉零消费方的判决器；形状守卫改挂日志读取路径 | **自身双绿**（Nightly 37882463045 / Windows 37882462504）|

**真机/实跑读数（②的证据）**：外部人按已发布配方手写实现复算同一 URL → 1118 字节、摘要**逐字符相同**
（`identical = true`）。**④ 缺态**：`not-recorded` / `not-loaded` / `unreadable` 三态分开，空列表不冒充"没读过"。

## 四、未闭项（每条写明 blocked-by，不许含糊）

| # | 项 | 判据 | blocked-by |
| --- | --- | --- | --- |
| 1 | ~~「读数」面板分区的真机读数~~ **已闭（2026-10-09 更正）** | 真机打开产物溯源 → 读数分区渲染配方常量 + 逐条读数 | **不是缺项**：`e2e/certification/artifact-provenance.spec.ts` 已在 Release 运行的 `macos-arm64` 认证步骤里跑过并绿（真窗口 + 真点击路径，运行时打印条目与配方行；同批 `electron_p0=passed`）。覆盖**显示半边**；真服务半边由真 PubMed 探针覆盖（1118 字节、复算 `identical = true`）。**我一度把这条写成"未取"，那是把已交付的写成未做 —— 已更正** |
| 2 | **读数归属细化到逐 run** | 产物版本的 `producer_run_id` 与读数条目精确对上（现在只到**会话+时间窗**） | **投影 `src/main/artifacts/provenance-repository.ts` 正被另一轮改**；且需要一条**可信**的 run id 通道（RPC 参数不算权威）|
| 3 | **校验器回挂**（把「核对一个已记录的读数」做成界面动作：重发同一请求比摘要） | 需要主进程通道 | **`src/main/ipc.ts` 同上被占** |
| 4 | **Windows `database` 分片家族** | 只能由 Windows 车道判决；**修法不许是加大超时**（仓规与仓内注释双重否掉）| 需要 Windows 车道；分诊档 `docs/plan-2026-10-08-windows-database-shard-triage.md` |
| 5 | **中文源四家连接器** | — | **外部条件**：执行器 2026-10-09 02:2x 复测，四源仍全部只回 `text/html`（chictr 34719 B / nmpa 54789 B / cde 86080 B / cma 89215 B），**无机器可读契约** ⇒ 维持挂账，不写只读抓取器 |

## 五、坑位（本轮真踩过的，写给下一次别重犯）

1. **「投影里有个字段」≠「能力已交付」。** v1.93.0 我写了「读数那一段不再是空的」，而当时**没有任何界面画它**；
   界面半边是执行器在 v1.93.1 补的。**带界面的能力，验收必须走一遍真机 UI 路径** ——
   我当时的判断"这只是投影不是界面"本身就是错的那个环节。
2. **发一个导出之前先问「谁调用」**。我发过 5 个零消费方的导出（含四态判决器），按「提交里不留死代码」撤掉了；
   保留的那一个（`isReadingFingerprint`）现在挂在**日志读取的形状守卫**上（坏指纹 ⇒ 整份日志 `unreadable`，fail-closed）。
3. **`eslint --fix` 会把你没打算动的既有 prettier 漂移一并规整**（v1.92.0 那次：引号风格、模板折行、尾逗号）。
   那不是错，但**必须如实披露**——全仓 warning 128→119 是这个原因，**不是**修了 9 个问题。
4. **双 `tsc` 是唯一能抓「必填字段没补进夹具」的闸门**：`readings` 设必填后四处夹具报 `TS2741`；
   按仓规**补桩**（把字段写进夹具字面量），**不要**把字段改成可选——可选会让"没加载""没有记录"在类型上就分不开。
5. **测试夹具里的编造值会被真闸门拒收**：我写过一个假的 `evidenceChecksum`，仓库的镜像校验当场拒收（`Artifact Version evidence is corrupt`）；
   夹具要**真算**（`createHash('sha256').update(...)`）。
6. **发版窗口三步照旧**：`hermes cron pause`（只挡下一次派发，挡不住已在跑的那轮）→ 全量门禁在**隔离工作树**上对**要打 tag 的那个提交**跑
   （`bash <本技能目录>/scripts/release-gate.sh <sha>`，**仓库里没有这份脚本**）→ `git push origin main` 后核
   `git merge-base --is-ancestor "$(git rev-parse 'vX.Y.Z^{commit}')" origin/main` 为真才打**附注 tag**（查 CI 必须 `<tag>^{commit}`）。
   发布核验只认 Release 页与**资产清单**（`draft=false`/`isPrerelease=false`/四平台产物齐 + `SHA256SUMS.txt`、
   `RELEASE-CERTIFICATION.json`、`latest*.yml`）；**作业 success ≠ 有页有资产**；两条 `notarize-mac` 作业是**具名跳过**（无 Apple 凭据）⇒ **不声称已签名/已公证**。
7. **品牌禁用词扫描会拦你写进正文的「技能目录名」**（`…science…` 形态）⇒ 跟踪文件里只写路径与结论、不写其名；
   本技能自带的脚本用「本技能自带的 `scripts/`」这种说法指代。

8. **「某条读数到底取了没有」先跑一条命令，再决定要不要立案**：`node scripts/ci/harvest-certification-readings.mjs --sha <完整 40 位>`
   （新增，落在 `scripts/ci/`）把该提交的 `macos-arm64` 认证作业日志一次打全 —— 平台判决行 / 跑过的 spec 清单 / run 汇总 /
   按标签分组的读数；**短 SHA 被具名拒绝**（`head_sha` 只匹配完整 40 位，8 位读起来像「没触发」）。
   实测规模：整份日志 **specs=102 / readings=200 / tags=49**（队列档 §四十三）。结案例：队列档 §四十一、§四十三。

9. **本机 git 到不了远端时的推送会静默改掉提交身份（2026-10-10 实测）**：代理没起 / `github.com:443` 被挡时走 Git Database API 是可行的，
   但 `POST /git/commits` **必须显式传 `author`/`committer`**，否则 GitHub 用**账号身份**写提交（`PureScience <…noreply>`），
   而作业、页面、断言全绿、**没有任何地方报错** —— 发现方式只有回读 `gh api repos/…/git/commits/<sha>` 的 author 字段。
   另外：`curl https://github.com` 不能当通路判据（同一分钟内一次 200、随后又超时）；本地 fetch 不了时远端提交可用
   「字节重建 + `git hash-object -t commit -w --stdin` 自证 sha 相等」变成本地对象再 `update-ref` 对齐（GitHub 会给 message 补一个换行，
   本地孪生因此 sha 不同）。整套配方与判据见本技能 `ci-monitoring-and-push-discipline.md`「推送路径」一节。

10. **夹具里的时间戳要**读一次**（2026-10-10）**：`new Date(Date.now() - N).toISOString()` 写两遍（一遍进被测行、一遍算摘要）
    会在跨毫秒时造出「行与摘要差一个字符」，被产品自己的完整性闸门（正确地）判成损坏 —— Windows 片 `3/8` 上一片红就是这个，
    机制已用假时钟端到端复现（队列档 §四十四）。修法 = 提成 `const`、两处共用、断言一字不动。

## 六、下一步建议（按可动手程度排序）

1. ~~补 §四 第 1 项的界面真机读数~~ **已闭**（`artifact-provenance.spec.ts` 在同一作业的 `macos-arm64` 认证步骤里跑过并绿，见 §四 第 1 行）
   ⇒ **不要按它重做**。
2. 等 `artifacts/**` + `ipc.ts` 落定后做 §四 第 2、3 项（逐 run 归属 / 校验器回挂）：动手前先 `git status --short` 认领归属，那批路径正在被改时不要碰。
3. 有 Windows 车道判决时再动 §四 第 4 项；§四 第 5 项（中文源四家连接器）维持挂账（外部条件）。
4. 任何「某条读数没取」的判断，先跑 §五 第 8 条那条命令核一遍 CI 日志。
