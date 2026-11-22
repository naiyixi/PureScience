# 发布流程：公证跟着 tag 走，不跟着事件走（2026-11-22）

## 事实链

| 时间 | 事 | 读数 |
| --- | --- | --- |
| `44943351879`（tag push, v2.33.0） | macos-x64 的**打包冒烟**卡死 | arm64：`endpoint announced after 11931 ms`、15 个启动阶段全报；x64：**零字节输出**，`nothing arrived on stdout/stderr`、`startup phases: none`，脚本判 `a hang, not slowness` |
| `44951327728`（手动 dispatch on v2.33.0） | `publish = success`，但 **`notarize-mac = skipped`** | 资产为「签名但未公证、未 staple」；记录 `macSignature: signed`（未声称公证） |
| `44959252253`（tag push, v2.33.1） | 两架构公证 + staple + 冒烟全过 | `The staple and validate action worked!` ×2；`macOS DMG and ZIP launch smoke completed successfully.` ×2 |

## 根因

`release.yml` 的守卫写的是「事件 + tag」：

```yaml
if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
```

`workflow_dispatch` 永远不满足第一条 ⇒ 手动发布路径**静默跳过公证**，而 `publish` 照样成功。
更关键的一层：`workflow_dispatch` 跑的是 **ref 自己的 workflow**，所以把守卫改好只 push 到 main
并不会影响在旧 tag 上的 dispatch —— 修复必须处在一个 **tag 指向的提交**上，这就是 v2.33.1 存在的唯一原因。

现在：`startsWith(refs/tags/) && (push || workflow_dispatch)`。分支上的 dispatch 仍跳过（没有 tag 可公证）。
守卫测试断言三条都在（此前只有两条）。

## 本机独立验证（不采信 CI 的自述）

```
$ shasum -a 256 zerolink-purescience-2.33.1-mac-arm64.dmg
0de3ae2deb7a1f62ba3484aa86d62decb4521a0f1114ae9a35d8262f5e35bd19
$ shasum -a 256 <官网 download/v2.33.1/同名文件>
0de3ae2deb7a1f62ba3484aa86d62decb4521a0f1114ae9a35d8262f5e35bd19     ← 与发布页 SHA256SUMS.txt 首条相同
$ xcrun stapler validate site-arm64.dmg
The validate action worked!
$ spctl -a -vv --type install …
zerolink-purescience-2.33.1-mac-arm64.dmg: accepted
source=Notarized Developer ID
origin=Developer ID Application: kai wang (UGQZPJ74DF)
```

## 官网镜像（`.complete` 落于 2026-11-22T09:02:05+08:00）

`versions.json`：`latest = v2.33.1`；`SHA256SUMS.txt` 八条逐一在磁盘上、尺寸与 GitHub 声明**逐条相同**、
无 `*.part`（17 个文件里 8 个是产品包，其余是 yml/json/txt）。

## 教训（写在这里而不是只写在提交里）

1. **「跳过的步骤」不会让 job 变红，而 `publish` 只看产物齐不齐** —— 所以判据必须问「这一版该做的事做了没有」，
   而不是「这一步绿没绿」。
2. **判断网络之前先读退出码**：`gh release download` 在非 git 目录会立刻失败并只打印
   `failed to run git`，我把它读成了「国内直连慢」，白等了十分钟。
3. **同一趟里 arm64 过、x64 零输出**时，先怀疑进程没起来，再怀疑代码——事后 x64 在同一脚本下 45 秒通过。
