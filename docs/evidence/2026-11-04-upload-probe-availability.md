# 上传件的可用性探针：为什么界面上每个上传文件都显示为 Missing

> 结论：`artifacts:probe-availability` 把**上传物**交给了 **artifact 根**解析器，而上传字节住在 `uploads/` 根下、
> 只有上传仓库答得出来。于是探针把每一条上传都判成「不可用」，Files 面板给磁贴打上 `Missing` 角标，
> 下载 / 分栏预览 / 识别文字（OCR）统统 `disabled`。修法是把这一类条目路由到上传仓库，本档记录读数与边界。

## 1. 症状与发现路径

真机认证规格 `e2e/certification/file-ocr.spec.ts` 在车道上第一次真的点到这一格时，以具名句失败：

```
[ocr-cert] the upload tile reads "missing": an uploaded file was probed as unavailable, which disables
every action on it. The probe has to resolve uploads through the upload repository, not the artifact root.
```

出处：`Nightly` run `41776743397`（提交 `20746bcf`）的 `build / Build macos-arm64` 作业日志。
`Verify`（lint + typecheck + 单测 + 打包）同一次运行是 **success** —— 这个缺陷只有真窗口里看得见，
单测与类型检查都碰不到它。

## 2. 根因（file:line）

- `src/main/artifacts/ipc.ts` 的 `probeAvailability`：对每一条 item 先 `parseArtifactVersionLocator(item.path)`；
  不是 artifact 版本定位符的，一律交给 `repository.resolveManagedFilePath({ path })`。
- 上传物自带定位符 `upload-version:<project>/<session>/<version>`，它不是 artifact 版本定位符 ⇒ 落进上面那一支
  ⇒ artifact 根解析器按设计拒收根外路径 ⇒ 该条不进 `resolved` ⇒ 探针把它记进 `unavailable`。
- 渲染层的 `useUnavailablePreviewProbe` 据此判 `missing`，磁贴打角标、动作全灰。

## 3. 修法（产品行为只改这一处路由）

| 位置 | 改动 |
| --- | --- |
| `src/main/artifacts/ipc.ts` | `ArtifactHandlerDependencies` 新增 `resolveUploadPath`；`source === 'upload'` 的条目走它，不再进 artifact 根解析器。解析失败仍按「不可用」这一**答案**处理（调用方问的就是它在不在），不向上抛。 |
| `src/main/ipc.ts` | 组合根接线：`resolveUploadPath: (request, scope) => uploadRepository.resolveManagedUploadPath(request, scope)`（上传仓库本来就是唯一能对 `uploads/` 根作答的那一层）。 |
| `src/main/artifacts/probe-availability.test.ts` | 新增一条「上传走上传仓库、且不碰 artifact 解析器」的用例；既有用例里三条把 managed 路径标成 `source:'upload'` 的条目更正为 `source:'artifact'`（它们本来就是 artifact 根下的路径，标错的是夹具）。 |

提交：`cf477225`（`fix(artifacts): 上传件的可用性探针改问上传仓库`）。这处修复最早由并行会话写在工作区里
（05:45 落盘后 9 小时未提交），本轮认领并补齐门禁与读数，不是第二套实现。

## 4. 门禁读数（隔离工作树 `/tmp/ps-ocr-rb` @ `cf477225`）

| 环 | 读数 |
| --- | --- |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **0 error**，exit 0 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **0 error**，exit 0 |
| 全量 `npx vitest run --maxWorkers=4`（堆 8192） | **1452 文件 / 18212 passed / 227 skipped**，`EXIT=0` |
| `npx eslint --no-cache .` | **0 error**（96 条既有 prettier warning，全仓口径） |
| `bash scripts/pre-push-checks.sh` | 通过（品牌扫描零命中、双语 README 一致、60 个脚本入口可解析、本次 3 个文件 lint 0） |
| `src/main/artifacts`（定向） | 20 文件 / 287 例全绿 |

**真机读数（同一棵提交上的隔离工作树）**：

| 项 | 读数 |
| --- | --- |
| 命令 | `npm run build:e2e`（`✓ built in 22.93s`）→ `npx playwright test e2e/certification/file-ocr.spec.ts --reporter=list` |
| 判决 | **1 passed (18.9s)**，`EXIT=0` |
| 磁贴 | `[ocr-cert] tile=ready before the read`（修复前同一句读作 `tile=missing`） |
| 实际分支 | `[ocr-cert] rendered=true branch=text` |
| 正文与出处 | `Read with eng.traineddata (tesseract eng) in 95 ms. This text came from an image, not from a text layer.` + `HEMOGLOBIN 12.4 g/dL PLATELETS 210 K/uL` |

## 5. 取证陷阱：共享工作树里的全量读数会被**未提交的 schema**污染

第一次在软链共享 `node_modules` 的工作树里跑全量，得到 **7 文件 / 93 例失败**，全部是
`The column main.Project.caseTitle does not exist in the current database`：
并行会话在工作区里给 `prisma/schema.prisma` 加了 `caseTitle` 并（隐含地）重新生成过客户端，
于是**共享** `node_modules` 里的 Prisma Client 认这个列，而本提交自己的运行时 DDL（`ensureProjectSchema`）
不建这个列 ⇒ 数据库分片整片红。**这和我这笔改动没有任何关系。**

正确取法（本轮采用）：把 `node_modules` 用 APFS 克隆复制进工作树（`cp -cR`，2.2 GB 用 16 s），
在该副本里对本提交自己的 schema 跑 `npx prisma generate`，然后重跑 —— 同样 7 个文件 **152 例全绿**，
再跑全量得到上表的 18212 例绿。
**不要在共享 `node_modules` 里重新生成**：那会把并行会话正在飞的 `caseTitle` 代码变成类型错误。

## 6. 边界（不许读成更强）

- 本笔只改**一次路由**：探针现在问对了地方。上传物本身的写盘、校验、下载路径一个字节没改。
- 车道判决（`Nightly` 的 `Build macos-arm64` 里那条 P0）要等 `cf477225` 这次推送跑完才存在；
  本档成文时两条车道（`Nightly` 41788542097 / `Windows Full Test` 41788542000）都还在 `in_progress`。
- CI 的 macos-arm64 上有没有 `tesseract` 仍未知 ⇒ 认证规格接受「缺引擎」这一支，只要求把**实际分支**打进日志。
- 已知的**潜在**缺口（不是今天用户可见的缺陷）：`source: 'notebook-input'` 的条目仍会落进 artifact 根解析器；
  目前没有界面在探它（`NotebookInputDataStrip` 走自己的预览读取器），故不在本笔扩大改动面。
