# V5 / A7 下载路径 —— 真机读数（2026-10-04）

## 之前为什么没取

v1.81.0 的验收刻意**关掉下载**（`disableDownloads`）以保证与网络无关——锁里的 URL 指向公网主机，
本机访问很慢。于是「`allowDownload:true` 时从锁里的 URL 取包 → 校验 → 建成环境」这条路**从未实测**，
在发布页上挂着立案。

## 取法（比原配方更干净）

原配方说「把缓存里同一个包复制到临时目录、只改 URL 指向本地服务」——但**缓存是按文件名键的平铺目录**，
同名文件还在缓存里，这条路永远走不到下载分支。改成：

- **只铺 81 条进缓存**，故意漏掉一条（挑**最小**的那个包，`fonts-conda-ecosystem-1-0.tar.bz2`，3667 字节）；
- 漏掉那条用本地 `node:http`（`127.0.0.1:0`）按**同名同路径**供应；
- 锁里**只改该条的 host**，文件名、URL 形态与 `#md5` 片段**一字未动** ⇒ 下载下来的字节必须真的通过校验。

`node scripts/stage-default-envs.mjs` 铺的是 `~/.purescience/runtime/packs/1/<subdir>/python-3.12/`，
`@EXPLICIT` 锁 82 条，md5 是每行 `#` 之后的 32 位片段。

## 三支读数（`npx playwright test e2e/certification/lock-import-download.spec.ts --workers=1`）

**3 passed (46.2s)**

### ① 下载路径真的走通，且过了 md5 校验

```
[v5] entries=82 seeded=81 downloadTarget=fonts-conda-ecosystem-1-0.tar.bz2 (3667B) via 127.0.0.1:49379
[v5] status: Imported “download-env” — 82 packages (81 from cache, 1 downloaded).
[v5] environment built from a verified download
```

`1 downloaded` 与「恰好一条需要走网络」的设计**完全对上**；无具名缺失项；环境的
`bin/python` 真在盘上（非空）。**顺带解掉一个未知项**：应用有出网管制（审批卡那套），
而**本地回环是被放行的**——这条 spec 就是证据（它真的把 3667 字节从 127.0.0.1 取了下来）。

### ② 关掉下载时，缺失的那条**具名报缺**，不建半成品

```
[v5-off] withheld=nomkl-1.0-h5ca1d4c_0.tar.bz2
[v5-off] named missing entry: nomkl-1.0-h5ca1d4c_0.tar.bz2 — Not in the local cache and downloads
         are disabled for this import
```

### ③ 坏一个字节 ⇒ **整份拒绝**，并且把两个哈希都摆出来

```
[v5-bad] corrupted=fonts-conda-ecosystem-1-0.tar.bz2 (md5 in lock stays fee5683a…)
[v5-bad] named: fonts-conda-ecosystem-1-0.tar.bz2 — md5 mismatch
         (expected fee5683a3f04bd15cbd8318b096a27ab, got d54c9a0db40bb54ef8745952d74b50b6) — discarded
[v5-bad] no environment was built
```

**期望值与实得值都被打印**（不是一句「校验失败」），且 `envs/bad-md5-env` **不存在**——
「整份拒绝」不是安慰话，是文件系统上的事实。

## 结论

v1.81.0 立案清单里的 **A7 下载路径已取到读数并可结案**。剩下的立案项都是**环境受限**而非未做：
IC6 的真机收割读数（需一台远程主机）、V8 的窗口侧 60 秒（需沙箱子进程的被拦请求触发）、
M2（需发布方给出权重校验值）。
