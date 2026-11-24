# Windows 闸门攒到 3/3：三份真机读数、一次 tag 改指、以及正文里那句被撤回的机制

## 一句话

`Release preflight` 卡的那道门（`scripts/windows-gate-streak.mjs --need 3`）现在是 **3/3 satisfied**；
`v2.33.5` 的 tag 改指到「正文已更正」的那一笔 `e668b405` 后重推，Release 车道已经跑起来
（`45351488445`，preflight success、build 在跑）。

## 一、三份读数（逐份现取，判据是 job 自己打印的那一行）

| # | run | 事件 | head | 读数 | 套件 | 预热 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `45329816080` | push | `aedb1337` | `electron P0 reading: passed` | 125 passed (43.2m) | 05:30:56→05:30:58 取齐三个归档，`sha256 ok` |
| 2 | `45340316786` | push | `e94664cf` | `electron P0 reading: passed` | 124 passed (45.2m) | 06:58:07→06:58:09，`sha256 ok` |
| 3 | `45343138992` | workflow_dispatch | `8a047e04` | `electron P0 reading: passed` | 125 passed (29.3m) | 07:16:56→07:17:00，`sha256 ok` |

仪器自己打印的账（本机现取，`--token "$(gh auth token)"`，匿名读作业日志是 403）：

```
windows gate streak: 3/3 (satisfied)
  credited: 45343138992, 45340316786, 45329816080
```

**这份「3/3」证的有一半只是「同一棵树跑两遍都绿」**：#2 与 #3 的应用树是同一条（#3 只多一个 `docs/**`
文件），#1 是另一条。也就是说 run-to-run 的稳定性这次被证了两次，跨树的稳定性只证了一次。写在这里，
免得下一轮把它读成「三条不同的树都绿」。

被跳过的两趟（既不算绿也不算红，按设计）：`45340316786` 是 #2 自己，`45326425150` 被后续推送顶掉
（cancelled ⇒ 没跑出 windows 作业），`45318235934` 是共用运行时那一趟的 `reading=failed`。

## 二、第 3 份读数是 `workflow_dispatch` 带起来的，不是 push

`nightly.yml` 自己的并发组按**事件**分（`nightly-${{ github.event_name }}`），文件注释写明「手动 dispatch 是
唯一能让某一份 head 跑完并落定的方式，发版判据需要它」—— 所以它与在跑的 push 那趟并行、互不取消。
本轮用它补第 3 份，代价是上面那句「同一棵树」的限定。

顺带一条：`v2.33.5` 第一趟 tag 事件带起的 `macOS Upgrade Smoke`（`45339548572`）在等「镜像供出 2.33.5」，
而那一趟的 `publish` 被 preflight 挡下 ⇒ 它只会在 240 分钟后红。已 `gh run cancel`，不留无用的 runner 时间。

## 三、先修正文：CHANGELOG 与双语横幅写了一条**已被撤回**的机制（`e668b405`）

tag 提交 `1034c8c7` 的正文把「整趟认证共用一份装好的运行时」写成三条 P0 用例转绿的原因。那一笔
（`38d8c336`）在 `533f80bd` 已**整笔撤回**：它把四条 spec 的前提换掉了 —— 环境闸门、重试、下载明细、
以及「应用自己装一遍」那条路径，只在**这台机器没有可用运行时**时才出现（`60d4a558` 那一趟
`4 failed / 121 passed` 就是它，撤回之后回到绿）。

判据（本机现取）：`git grep PURESCIENCE_NOTEBOOK_RUNTIME_ROOT` 在 `src/` 与 `scripts/` **零命中**，
只剩 `CHANGELOG.md` 与两份 README 横幅里那两句 —— 也就是说它作为「现在的产品行为」根本不存在。

改法：`CHANGELOG.md` 的「转绿机制」那段与「明确没做 / 边界」那条各改一次，把真正的机制写进去
（同一台 runner 上 `Prewarm the managed runtime pack` 先把三个归档取一次、逐个核 sha256，spec 从本机缓存
复制而不是各自再问一遍公网；P0 从 1.0 小时降到 43.2 / 45.2 / 29.3 分钟），并把「试过又撤回」**具名留下**；
两份 README 的横幅逐字同步（`node scripts/check-readme-sync.mjs` ✓）。`pre-push-checks.sh` 全过。

## 四、tag 改指（`v2.33.5`：`1034c8c7` → `e668b405`）

- 为什么改：Release 正文由**tag 指向的那棵树**里的 CHANGELOG 生成，正文错了就得让 tag 指到改对的那一笔，
  否则只能发完再 `gh release edit` 打补丁 —— 那是把错误发出去再修。
- 为什么可以改：这个 tag **没有 Release 页**（`gh release view v2.33.5` → `release not found`），所以按
  「有页才不许删/移」的口径它可以就地改指；`git merge-base --is-ancestor` 确认新目标在远端 main 上。
- 版本一致性：`package.json` 与 `package-lock.json`（含 `packages[""].version`）都是 `2.33.5`；
  tag 名与版本号一致（tag 事件下 preflight 的第一步就查这条，`45351423917` / `45351488445` 两次都 success）。
- 自 `v2.33.4` 起共 **55** 笔提交。

## 五、边界与具名未办

1. **读数 #2 与 #3 同树**（见第一节）：跨树稳定性的证据只有一条（#1），这不等同于「三条独立的树都绿」。
2. **预热让 P0 不再覆盖「从公开主机下载归档」那一段**：应用仍取 manifest、仍按摘要决定用不用缓存，
   但归档从本机缓存复制 ⇒ 带宽/断流那类缺陷在 P0 里不会再暴露，只由单测与真机更新日志覆盖。
3. **发布尚未落地**：Release 车道 `45351488445` 在跑，页与资产要按「发布核验」口径复核（四平台产物 +
   `SHA256SUMS.txt` + `RELEASE-CERTIFICATION.json` 的 `sourceSha` 与 `git rev-parse 'v2.33.5^{commit}'` 逐字符比对）。
   本轮只取到 preflight success 与 build 起跑，不写「已发布」。
4. **同一 tag 上出现过两趟 Release**（`45351423917` 被 `45351488445` 按 `release-<ref>` 的 cancel-in-progress
   顶掉）：前者 preflight 已 success，被顶掉只说明同一 tag 上新事件取消旧事件，不是判决。
