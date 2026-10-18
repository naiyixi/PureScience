# 知识库孤儿副本：手动清扫入口（v2.10.0 的「明确没做」第一条）

v2.10.0 每次启动清扫一次孤儿副本，并在发布正文里把「没有手动触发清扫的入口」列为**明确没做、下一版再说**。
本文记录这一片的实现与读数。它是**同一份清扫逻辑的第二个入口**，不是第二套清扫。

## 1. 为什么不能新写一套

启动清扫已经在 `KnowledgeRepository.sweepContents()` 里，且它的安全判据（先读登记簿，读不出来就一个字节都不删）
正是这一族逻辑的全部要点。另写一个 `sweepCopies()` 会让两条路径各自演化：一处补了守卫、另一处没补时，
界面上按下按钮的那一次就是没有守卫的那一次。因此本片**只扩展既有方法**：

| 改动 | 内容 |
| --- | --- |
| 返回形状 | `{ scanned, pruned[] }` → `{ scanned, kept, removed[], failed[], bytesFreed, ignored }`，**四个桶相加必须等于 `scanned`** —— 算不清的清扫不许看起来算清了 |
| 目录读失败 | `ENOENT`（从未有过副本）仍是空清扫；其余错误改为具名拒 `copy-store-unreadable`（读不到目录与「没有副本」不同形） |
| 删不掉 | 按**文件名**进 `failed`，绝不进 `removed`、绝不计入 `bytesFreed` |
| 同名逻辑 | 只处理 64 位小写十六进制的**普通文件**；别的条目计入 `ignored`，不动 |
| 启动调用点 | 日志字段跟着改成 `removed.length` + `bytesFreed`（`src/main/ipc.ts`） |

## 2. 新入口（窗口面）

| 面 | 位置 | 说明 |
| --- | --- | --- |
| 通道 | `knowledge:sweep-copies` | **不收参数**：谁能点名摘要谁就能删任意副本；孤儿由主进程按登记簿判定 |
| RPC 调用 | `knowledge-rpc-calls.ts` `sweepCopies()` | 沿用既有 `named()`，拒绝话术与其余知识库动作同一份 |
| preload + d.ts | `window.api.knowledge.sweepCopies()` | d.ts 里 `KnowledgeCopySweep` 是 `import type` 进来的（不是只引用） |
| 契约目录 | `group('knowledge')` 追加一条 | 本地（Electron）通道，进 local-Web `unavailable` 集合 |
| 界面 | 来源区的「清理未引用副本」 | 三态分开：删了 N 份 / 释放多少字节、**没有可清的**、**有几份删不掉仍在盘上**；失败走具名拒绝文案 |
| 文案 | 9 语各 5 键 | 各自撰写，非英文占位；zh 值不等于 en 值 |

## 3. 读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| 存储层用例 | `knowledge-repository-sweep.test.ts` **5 passed**：删孤儿留引用（含桶自洽断言）/ 登记簿坏 ⇒ `record-unreadable` 且**字节仍在** / 无副本库 ⇒ 全 0 / 非摘要条目留下并计数 / POSIX 只读目录删不掉 ⇒ 进 `failed` 且 `bytesFreed: 0` |
| 面板用例 | `KnowledgePanel.render.test.tsx` **4 passed**：计数+字节 / 没有可清 / 部分删不掉 / 拒绝上屏且不出现「Deleted」 |
| 契约涟漪面 | `src/shared src/preload src/renderer/web` ⇒ **141 文件 / 1611 passed**（目录 491→492、preload 491→492、core 契约 246→247、core 请求 208→209、local-Web unavailable 87→88、生成物遗漏清单 +1，逐条按失败读数对齐） |
| 类型检查 | `tsc --noEmit -p tsconfig.node.json --composite false` ⇒ exit 0 / 0 error；`-p tsconfig.web.json` 同上 |
| lint（改动面） | `npx eslint --no-cache <改动路径>` ⇒ **0 error**；i18n 九文件的 prettier warning 数**回到基线 25 条**（本片新增的 5 条已清零，未顺手改别处折行） |
| **真机读数** | `npm run build:e2e` 重建后 `npx playwright test e2e/certification/knowledge-copy-sweep.spec.ts` ⇒ **1 passed (5.5s)**，见下 |

### 真机读数是怎么造的（面板自己的句子不能当证据）

1. 真窗口完成 onboarding，从 `api.storage.getInfo()` 取**真数据根**；
2. 测试进程在 `<数据根>/knowledge/contents` 先种一份**无人引用**的孤儿（摘要命名）；
3. 面板里登记一个**真本地 HTTP 服务**的网址来源 ⇒ 被引用的那份副本是**产品自己**抓取后写下的，不是测试写的；
4. 点「清理未引用副本」⇒ 屏上出现 `Deleted 1 unused copy(ies), freed N byte(s).`；
5. **磁盘由测试进程自己 `readdir` 复核**：孤儿消失、被引用的那份还在。

即：屏上一句话 + 盘上一次独立读，两者都成立才算这一片跑通。

## 4. 边界（不许读成更强）

- 启动清扫的**语义未变**：仍是每次启动一次、不 await、有清理时一条日志。本片只让它的返回值更可算（多了
  `bytesFreed` / `failed` / `ignored`），并多了一个用户可达的触发点。
- `failed` 只覆盖「文件存在但删不掉」。「名字不对/是目录」归 `ignored`，不是失败；两者在界面上分别是
  「有几份删不掉」与不出现任何数（只计入 `scanned`）。
- 只读目录那条用例按 `runIf(process.platform !== 'win32')` 跳过 Windows：删文件在 Windows 不是目录权限
  语义。跳过的是**该平台上的这条造法**，不是断言。
- 清扫只按**摘要名**匹配，不校验文件内容（v2.10.0 已归档的同一条限制，本片未改）。
- 本片不占版本号：发版由会话在版本边界统一切。
