# U3：预览 acquire 的 370 ms —— 落在"解析"里，但**不是**整文件读取与校验（已证伪）

- 日期：2026-09-18
- 实例：`electron-vite dev` 带窗口，独立端口 44105 / 独立 profile / CDP 9336；语料＝真实数据根副本
- 起点（U1）：`preview-resources:acquire` 5 次、单次 ~370 ms，与打包版"文件面板最差帧 432 ms"量级吻合 —— 这是**唯一落在点击路径上**的未解释数字。

## 一、新仪器（已随提交落地）

`ManagedPreviewResources.acquire` 把一次 acquire 拆成 **resolve / stat** 两段并带上 `source`，≥50 ms 记 `managed preview acquire was slow {source,resolveMs,statMs}`（**不记路径**，路径是用户数据）。

## 二、实测（本次运行驱动了文件面板与会话打开，捕获 1 次慢 acquire）

| 段 | 值 |
|---|---|
| `resolvePath`（`source: 'artifact'`） | **163 ms** |
| `stat` | **4 ms** |
| 同一调用的 IPC 层所见 | 169.4 ms（与 163+4+开销 一致） |

## 三、被证伪的解释（留档）

| 解释 | 判据 | 结果 |
|---|---|---|
| **每次 acquire 都把产物整文件读进来算 SHA-256，所以慢** | 在真实语料上直测 `readFile`+`sha256` | **否**：最大产物 **6.30 MB → 5.4 ms**（2.72 MB → 2.6 ms）。字节侧最多 5 ms 量级，解释不了 163 ms |
| stat 慢（大文件元数据） | 同一次 acquire 的 `statMs` | **否**：**4 ms** |

## 四、代码路径（静态核对，用于缩小剩余范围）

`artifactProvenanceRepository.resolveVersionContent()` =
**1 次查询**（`artifactVersion.findFirst`，带嵌套关系过滤 `artifact: { is: { projectId, sessionId } }` + `include: { artifact: true }`）
**+ 1 次 `readFile(path)` + 1 次 `sha256(bytes)`**（完整性校验，无任何缓存）。

字节侧已测为便宜（≤5.4 ms），所以**代价在查询/引擎这一段**。

## 五、仍未定论（下一条仪器已具名）

163 ms 里，**查询本身**尚未单独测出。两个存活候选：
1. **带关系过滤 + include 的那条 `findFirst`** 在引擎侧就是贵（同一 App 内测得的单次往返地板值：U2b 里单条 `fileOriginSession.findMany` 中位 **29 ms**）；
2. **该次调用是进程启动后较早的一次 DB 往返**，把引擎预热/冷页读一并算进去了（U2b 里 `clientMs` 中位 0 ms 是在客户端已暖的情况下）。

**下一条仪器**：把 `resolveVersionContent` 拆成 `asserts / query / read+hash` 三段（与 `listFiles`、`acquire` 同一套写法），并在**一次运行内驱动多次 acquire**（本次驱动只捕获到 1 次 ≥50 ms 的调用）。这两点做完，163 ms 就能落地到段；在此之前不宣称是哪一半。

## 六、诚实边界

1. 本次仅 1 个样本（阈值 50 ms）；`370 ms`（U1）与 `163 ms`（本次）来自不同负载的两趟，**不可直接相减**。
2. dev 构建；打包版同表未采。
3. 字节侧直测用的是**语料副本**的产物文件（最大 6.30 MB；语料产物合计 173.93 MB / 2,560 个文件），页面缓存状态与本机一致但非打包版进程内。
4. **未做任何优化**。本单元交付：acquire 的分段仪器 + 一条被证伪的"整文件校验"解释 + 已缩小的下一步。
