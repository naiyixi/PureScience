# A7 外部锁导入 · 真机读数（2026-10-03）

> 载体：`src/main/notebook/lock-import.realmachine.test.ts`（`npx vitest run <该文件> --reporter=verbose`）。
> **这是真机运行，不是 mock**：真 `micromamba` 二进制、真 `@EXPLICIT` 锁、真 tar 包、
> 隔离运行根（scratch 下的 `mkdtemp`），`micromamba create --file <lock> --offline` 真的建出前缀，
> 再真的执行建出的解释器。隔离与清理：每个用例 `finally` 递归删掉自己的根。

## 0. 夹具与「为什么不拿 default-python 的锁」

- 本机下载缓存**只剩解释器闭包的一部分**：`default-python` 的 350 条锁记录里，本机只有 **76** 个 tar 包
  （其余 274 条既不在应用包的下载缓存 `~/.purescience/runtime/pkgs/https/**` 里，也不在另一处本机
  conda 归档缓存里——后者路径含被本仓术语门禁禁用的产品名词，故此处不写路径）。
- 唯一**自包含**的解释器锁是应用自己的语言包：`~/.purescience/runtime/packs/1/osx-arm64/python-3.12/`
  —— **82 条 `@EXPLICIT` 锁 + 全部 tar 包**（75 MB，逐条 md5 齐）。因此夹具用它。
- 诚实边界：该锁来自应用随包资产（本机唯一的完整归档集），**不是从别的机器导出的第三方锁**；
  被测代码只消费**调用方传入的锁文本**，故代码路径与「外部锁」完全一致。**下载路径本片未实测**（见 §3）。

## 1. 用例一：离线导入真锁 → 建成环境 → 解释器真跑

命令与读数（原样，未加工）：

```
[a7-real] lock entries=82 conda-meta records=82
[a7-real] interpreter version=[3, 12, 13]
✓ offline-imports a real lock, matching it package-for-package, and the built interpreter runs 16178ms
```

断言口径（全部通过）：

| 判据       | 读数                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| coverage   | `{ total: 82, fromCache: 82, downloaded: 0, missing: [] }` ⇒ **0 下载 = 0 网络字节**                    |
| 环境等于锁 | `envs/lock-import-env/conda-meta/*.json` = **82**，与锁条目数**逐条一致**                               |
| 真执行     | `envs/lock-import-env/bin/python -c '…sys.version_info[:3]…'` → **`[3, 12, 13]`**（与锁钉住的版本一致） |
| 耗时       | 16.2 s（含 82 个 tar 包的 md5 复算 + 离线硬链接建前缀 + 解释器启动）                                    |

## 2. 用例二/三：缺校验与缺件都**具名失败、且什么都不建**

```
[a7-real] bad-md5 refusal: file=nomkl-1.0-h5ca1d4c_0.tar.bz2 reason=The cached copy does not match the md5 in the lock (discarded) and downloads are disabled for this import
[a7-real] offline missing: file=nomkl-1.0-h5ca1d4c_0.tar.bz2 reason=Not in the local cache and downloads are disabled for this import
```

- 用例二（**把锁里一条真 md5 改成全 0**，缓存里的包是真的）：整份拒绝，`missing` 恰好一条并点名该文件，
  **不建前缀**（`envs/bad-md5-env` 不存在），且**把不合规的缓存副本删掉**（`pkgs/<file>` 不再存在）。
- 用例三（**缓存里少放一个 tar**，`allowDownload:false`）：点名该文件为「Not in the local cache」，
  **不建前缀**（`envs/missing-env` 不存在）——不静默建出一个更小的环境。

## 3. 本轮**没取到**的读数（不许当已验）

1. **下载路径**（`allowDownload:true` 时从锁里的 URL 取包 + md5 校验后落缓存）：本机未实测。
   原因：完整闭包缺失 274 个包（≈1 GB 级），且锁 URL 指向 `conda.anaconda.org`（本机在 CN 很慢）；
   单包锁虽能证明「取回 + 校验」，但建前缀会因缺解释器在 `verify` 处具名失败，不是一条完整的成功读数。
   ⇒ **立案：下一轮用「小闭包 + 已发布 md5」的锁测下载路径**（或加镜像重写后再测）。
2. **真窗口（点得动）读数**：本片 S3 的界面只有渲染测试（jsdom + mock 桥）与真机主进程读数；
   **还没在打包/开发版窗口里点过**。⇒ 立案：按 `e2e/certification/` 的方式补一条真窗口读数。
3. 本机 `default-python` 的锁（350 条）**未**作为夹具（归档不全）；它只用于证明「本机缓存不全」这一事实。

## 4. 真机运行揪出的一个真缺陷（已修）

用例二第一次跑出来的 reason 是 **「Not in the local cache…」**——但那个包**确实在缓存里**，
只是 md5 对不上。即：报告把「缓存里的副本校验失败」与「缓存里没有」混成了一句话。
修法：`provisioner` 的缓存判定从布尔改为三态（`verified` / `mismatch` / `absent`），
`mismatch` 现在如实报「缓存副本与锁里的 md5 不符（已丢弃）」。这一条是**单测没覆盖、只有真机跑才暴露**的
（单测里那条投毒用例原先只断言「文件被删」，不断言文案）。同步补了单测断言。

## 5. 真窗口读数（第二条遗留，**已取**，2026-10-03）

载体：`e2e/certification/lock-import.spec.ts`（真 Electron 窗口 + 夹具隔离根 + **从界面自己的入口**：
Settings → Runtimes →「从锁文件导入…」）。**权威读数 = `2 passed (35.8s)`、0 失败**（Playwright 控制台原文）：

```
[a7-window] instanceRoot=/var/folders/…/purescience-electron-e2e-S9UfCd/storage seeded=82/82
[a7-window] success: Imported “lock-import-env” — 82 packages (82 from cache, 0 downloaded).
[a7-window] missingEntries=0
[a7-window] runtimeCardsForImportedEnv=0
[a7-window] interpreter=[3, 12, 13]
[a7-window] refusal: nomkl-1.0-h5ca1d4c_0.tar.bz2 — The cached copy does not match the md5 in the lock
             (discarded) and downloads are disabled for this import
2 passed (35.8s)
```

逐项：夹具**播种 82/82**；导入读数 **82 from cache / 0 downloaded**（0 下载 = 0 网络字节）；`missingEntries=0`；
建出的解释器真跑出 **`[3,12,13]`**；失败路径**具名原因上屏且什么都不建**。下载开关两条用例都关掉，读数与网络无关。

**`runtimeCardsForImportedEnv=0`**：这条就是我方 spec 亲测出的数字——**导入建出的具名环境在
Settings→Runtimes 里是 0 张卡**（那些卡来自解释器发现，具名环境属笔记本选择的那份列表）。
它与执行器扫描立案的 **D1.3「A7 导入的环境对用户是死路（无删除 / 无用作运行时）」** 是同一片问题的两面：
用户导入成功后，既看不到卡、也没有删除或提升为运行时的入口。**这是我交付的缺口，不是误报。**

### 5.1 这条读数额外揪出的三个真缺陷（全部已修，单测都漏了）

1. **加了通道却没改启动自检 ⇒ 应用起不来**。应用自己的启动期认证钉着应用命令清单
   （`src/main/application-command-composition.ts`），`runtime:import-lock` 让它 344 → 345，于是
   **应用 fail-fast、连窗口都不开**（真机读数：`Application command inventory mismatch: expected 344
commands, received 345`）。修正三处计数（internal 345 / local Web 343 / remote 拒绝集 120，远端 dispatch 与 task 不变）
   —— 这几个数字**只有应用自己的启动认证和真窗口能证伪**，单元测试不会开窗口。
2. **对话框在小窗口里按不到「导入」**。面板没有高度上限与滚动区，锁文本一长，页脚按钮被顶出视口
   （Playwright 读数：`element is outside of the viewport`）。修正：面板 `flex max-h-[85vh] flex-col`，
   中部滚动、页脚常驻。
3. **管理器方法被解引用调用**，丢掉 `this` ⇒ 真机上 `Cannot read properties of undefined (reading 'deps')`
   （界面把它显示成「The import failed: …」。修法：`?.bind(manager)`），并补了一条**替身读 `this`** 的回归用例
   —— 用 `vi.fn()` 的替身永远抓不到这一类。

### 5.2 仍未取的读数（不许当已验）

- **下载路径**（`allowDownload:true` 时从锁 URL 取包 + md5 校验后落缓存）：仍**未实测**。本片两条用例
  刻意关掉下载以保证确定性；真机一次「开着下载」的运行观察到它确实走下载分支并如实报不匹配，
  但**没有**取到「下载成功且校验通过、环境建成」这条读数。⇒ 立案。
- **具名环境是否应出现在 Settings→Runtimes 的卡片列表**：实测**不出现**（那些卡片来自解释器发现，
  而具名环境是笔记本选择的那份列表）。这是产品决策，不是缺陷；本片只在读数里记下，不声称已覆盖。
