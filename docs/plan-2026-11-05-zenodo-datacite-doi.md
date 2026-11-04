# 认领与结论：Zenodo（DataCite）DOI 可引用（2026-11-05 / 执行器）

> 为什么单写一份：共享台账 `docs/plan-2026-10-03-next-queue-and-round-convention.md` 此刻被并行会话持有
> （工作树里是一批未提交在制），按约定不代别人落笔，本档声明本单元的归属、边界与下一轮第一步。

## 一 开工核对（防重做 + 并发 + 该谁做）

- `origin/main = 9388544e`。本机主树**停在 `0f5dffb9`、带 42 个并行会话的在制路径**（`git status` 那批
  `src/main/{projects,session-persistence,reviewer}/**`、`src/renderer/src/i18n/**` …）⇒ 一个字节没碰，
  本单元全程在隔离工作树 `/tmp/ps-doi`（`node_modules` 软链，未软链 `out/`：并行会话正在用共享产物目录）。
- **本单元上一轮已经做过一半**（`/tmp/ps-datacite` @ `9d0982b9`，未提交、那轮被超时打断）。本轮的做法是
  **把它接过来而不是重写**：`git diff` 生成补丁 → 在 `9388544e` 上 `git apply --check` 逐个核对
  （`service.ts`/`doi-integrity.ts`/`shared/references.ts`/`import-evidence.ts`/两份测试在 `9d0982b9..9388544e`
  之间**逐字节未变**，所以补丁干净落地）；`src/main/cases/ipc.test.ts` 那一处**丢弃**——`9388544e` 自己已经
  带着定型桩（并行会话落的 `test(cases): 桩按组合自己的类型写`），不需要第二份。
- 与并行会话的路径不相交：本笔只碰 `src/main/references/**`、`src/shared/{references,egress}.ts`、
  `src/main/net/egress.test.ts`、`src/main/session-package/import-evidence.ts`。
- 排期口径核对：v2.26.0 那一行写「技能放量、arXiv/Zenodo 可引用、README 分层」。实测**两半状态不同** ——
  arXiv DOI 已被索引覆盖（真读数 `count = 1`），缺的是 DataCite 那一半（`count = 0`）。本笔只做真缺的那半。

## 二 交付与读数

见 `docs/evidence/2026-11-05-zenodo-datacite-doi.md`（四条端点实测、七个文件的改法、产品路径真网络读数、
门禁读数、变异自证、三条边界）。

## 三 本轮顺手确认的两件事（不是本单元的功能）

1. **`2.26.0` 还没有发布页**：`gh release list` 的 Latest 仍是 `v2.25.0`，而 tag `v2.26.0` 已存在并指向
   `9388544e`；它对应的 tag 事件那条 Release run 被取消，页与资产都没落。发版是并行会话的窗口，本轮**不碰**
   tag、不推 main（推了会顶掉它正在跑的 `Release` 调度），只在汇报里点名。
2. `9388544e` 的 `Windows Full Test` / `Nightly` 当时仍在飞；本笔推送要等它们落定（见 §四 第 1 条）。

## 四 下一轮第一步

1. **推送时机**：等 `9388544e` 的 `Nightly` / `Windows Full Test` 落定、并行会话的 Release 调度结束后再推
   （本笔提交在 `/tmp/ps-doi` 的工作树分支上；若本轮结束前窗口未关，下一轮从这里 `git push origin HEAD:main`）。
2. **真窗口读数**（若要升格为「实机通过」）：`npm run build:e2e` 后走「文献库 → 按 DOI 添加 → 填
   `10.5281/zenodo.8300489`」，断言标题/出版方/年份与出处快照出现在界面上。本轮没做，原因是资源闸门
   （`vm_stat` 空闲页 ~19.8k ≈ 324 MB、`vm.swapusage` 已用 8.3/9.2 GB，而并行会话正在跑打包与全量测试）
   ⇒ 用户口径里这不算「实机通过」，本档如实记为**未取证**。
3. 完整性那一半（DataCite 的撤回语义）仍不做：DataCite 关系词表里没有撤回谓词，硬判 `clean` 就是替用户担保。
