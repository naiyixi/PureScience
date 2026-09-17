# 环境锁与重跑隔离：从"永远赚不到"到真机 applied（2026-09-17）

v1.62.0 发布后继续 v1.63 第一单元。三处都是**真机量出来的**，不是推断。

## 一、量清的两个真缺陷

### 1.1 环境锁**从设计上不可达**

`replay-owner.ts` 判定 `environmentLock: 'applied'` 的条件是两侧 `environmentManifestChecksum` 相等。而该摘要是 `sha256(整个环境清单文档)`，清单里含 `capturedAt` / `installedInventory.capturedAt`。

**真机证据**：同一个会话、同一个解释器、相隔几分钟的两次运行：

```
notebook-run-…-4  manifest: b6d0cf0476676b523888469a9657b6f99136eada91981e841cb088e85b4241e6
notebook-run-…-5  manifest: cc324682429bb1f6875505b21409d857e33c268fdf37af59c2fc1bcc454345a4
```

⇒ 同环境永远算不出同一个摘要 ⇒ `applied` **永远不可能出现**。一个永远无法成立的比较不是检查。

### 1.2 重跑跑在"评分目录之外"（v1.62.0 已修的一部分，本轮补完环境维度）

重跑经 `executeNotebook({sessionId: 原会话 id, workspaceCwd: /tmp/…})` 执行，而 notebook 的 kernel **cwd 是 spawn 时定的进程属性**（`session-lifecycle.ts` 取 `document.dataRoot`；`kernel-executor.ts` 用它 spawn），`workspaceCwd` 根本不参与 ⇒ 代码写在会话数据根、评分读 `/tmp` ⇒ 结论只能是 `unverifiable`。

## 二、修法（两个值各司其职）

| 值 | 职责 | 载体 |
|---|---|---|
| `environmentManifestChecksum` | **存储/校验**：读方按它取文件并重新哈希证明未被改动 | 不变 |
| `environmentFingerprint`（新） | **比较**：runtime 名/来源/版本 + kernel kind + platform + architecture + **排序后的包列表** | capture → run record → 版本证据 `producer.environment_fingerprint` → 重跑比较 |

结论词表：两侧**任一没有**指纹 ⇒ `not-applied`（含义是"无法比较"），**不得**读成"环境一致"。

## 三、过程中的回归（自己捅的，真机当场抓到）

第一版把**规范化摘要直接当成** `environmentManifestChecksum` 发布 ⇒ 读方不变量 `sha256(serialized) === checksum`（`provenance-repository.ts` 的 `manifestIsValid`）不成立 ⇒ **每次采集塌成 `environment-manifest-publication-failed`、证据丢掉整个环境块**。

```
原跑 run.json：  {"state":"unavailable","reason":"environment-manifest-publication-failed"}
DB 证据：        environment_status = unavailable；producer 里没有 environment_manifest_checksum
```

**单测全绿**（1573 通过），是现场复验抓到的。随后改为"存储路径仍按文档哈希、发布值另出指纹"（`2de1611` + `959d507`）。

## 四、真机复验（最终态）

```
$ purescience replay cef674a4… --project … --session … --artifact …

记录侧采集：    partial | kind: completed-run | default-python 3.12.13
run -1 manifest: baf496a9dd1a99f3b37963fbe39135f5fa0158ee827ef22655e739a8422d8b3a
run -2 manifest: 5e12c378224821b328f027ee6dd9194662da0d91929489d45fc66d3ffcacc19c   ← 同环境、不同文档
run 记录键含 environmentManifestFingerprint                                             ← 新字段已落盘

verdict:        reproduced
environmentLock: applied                                                                ← 以前永远不可能
```

配套（同一轮现场核验）：重跑会话跑完即清（`replay-*` 计数 0）、原会话文件未被触碰、`env lock` 判定用的是指纹而非文档哈希。

**诚实边界**：本次改动**之前**记录的版本没有指纹 ⇒ 它们的锁仍会显示 `not-applied`，准确含义是"无法比较"，而不是"环境不同"。这是刻意的：宁可说无法比较，也不拿文档哈希冒充环境一致性。

## 五、运维坑（本轮踩过，已固化进技能）

- **dev 实例启动竞态**：清 `out/main` 后 Electron 可能先于 main 打包完成启动 ⇒ `Cannot find module './application-shutdown-trigger-*.js'`，看着像源码坏了。带重试的启动脚本一次通过（第一次没起、第二次就绪）。
- **`docs/evidence/*.log` 与 `docs/competitive-tracking/` 都在 .gitignore**：要入库的证据写 `.md`。
- lint 失败必须挡住提交：命令链用 `&&`（我用 `;` 放过去一个带 lint error 的文件，CI 一次后才暴露）。
