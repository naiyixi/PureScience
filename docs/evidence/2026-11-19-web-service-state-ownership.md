# web-service 状态文件：发布路径是好的，删除路径不认主

日期：2026-11-19（执行器轮次）
起点：`docs/evidence/2026-11-19-sdk-declaration-surface-and-daemon-discovery.md` §三 的具名缺口 ——
「实例在听、`web-service.json` 不存在，`purescience status` 与 `connectToPureScience()` 都报 not running」。

## 一 先把「谁没做事」分开：发布路径是好的（真机读数）

上一轮缺的是一条可控实例上的读数，本轮没有重启任何实例，直接用了已经在跑的隔离实例：

| 读数 | 值 | 取法 |
| --- | --- | --- |
| 隔离实例的配置根 | `/tmp/ps-verify23-config` | `ps -Eww -p 24528` 的 `PURESCIENCE_STORAGE_ROOT`（进程 `--serve=44222`） |
| 该根里的登记 | `{"pid":24530,"port":44222,"startedAt":"2026-11-18T17:43:03.750Z","appVersion":"2.30.2","attached":false,"configRoot":"/tmp/ps-verify23-config"}` | 直接读文件 |
| 端口在听 | `Electron 24530 … TCP 127.0.0.1:44222 (LISTEN)` | `lsof -nP -p 24530` |
| CLI 发现 | `PureScience is running (PID 24530, port 44222).` | `PURESCIENCE_STORAGE_ROOT=/tmp/ps-verify23-config node packages/purescience/cli.mjs status` |
| 对照（用户实例） | `~/.purescience-project/web-service.json` 不存在，而同目录的 `web-token` 在；44100 仍在听 | `ls -la ~/.purescience-project` + 端口 |

结论分两层：**写侧没坏**（无窗口实例确实发布了登记，CLI 也能读到）；**坏的是「登记会被别人删掉」**。

## 二 缺陷（读码即证，且被变异证明过）

`src/main/web-service/state-file.ts` 的 `removeWebServiceState` 无条件删文件，而它唯一的调用方是控制器的
`close()`（`src/main/web-service/index.ts` 里 `running.close` 的 `finally`）。两代进程可以短暂重叠——
dev 重启（`electron-vite` 改主进程即重启）、或更新时新进程先起、旧进程后退出——旧一代收尾时执行
`removeState(configRoot)`，删掉的正是新一代刚写的登记。

这条删除**没有任何输出**（`close()` 不记日志，删除本身也不记），所以事后只能看到「服务在听、客户端说
not running」，与「从来没写过」完全同形。全仓只有这一处会删该文件：`readWebServiceState` 虽也删，但它
零生产调用方（只在用例里出现）。

## 三 修法

删除改成**认主**：`removeWebServiceStateIfOwned(configRoot, pid)` —— 读当前登记，`pid` 不是调用者就一个
字节不动；记录读不出来（写入半截 / JSON 坏）也不在这里删，交给读路径按它自己的规则清理，免得把「我们
自己写失败」误判成「别人的记录」而删掉。控制器把自己的 `appInfo().pid` 带进这条路径。

## 四 门禁与变异自证

| 项 | 读数 |
| --- | --- |
| `npx vitest run src/main/web-service` | 10 文件 **83 passed** |
| `npx vitest run src/main/application-command-wiring.test.ts` | 5 passed（装配面源码断言未受影响） |
| `typecheck:node` / `typecheck:web` | exit 0 / exit 0（0 诊断） |
| `npx eslint --no-cache`（四个改动文件） | 0 problem |
| 变异：把认主判据改成恒真（等价旧行为） | 新增两条用例 **2 failed**，恢复后全绿 |

新增用例两条：
- `state-file.test.ts`「只删仍然写着调用者 pid 的登记」+「读不出来的登记不在此处删」；
- `controller.test.ts`「旧一代关停不删新一代刚发布的登记」——两代控制器共用一个临时根，跑的是**真的**
  `writeWebServiceState` / `removeWebServiceStateIfOwned`（不是替身），断言旧一代 close 之后文件里是新一代的
  pid/port，新一代 close 之后文件消失。

## 五 边界（不许读成更强）

1. **重叠窗口本身无法事后证明**：用户那个实例的登记是几小时前就没的，日志里也没有那一代的收尾记录。
   所以「44100 这次就是这条」仍属**推断**；本文断言的是「这条缺陷真实存在、可被变异证明、已修」。
2. **真机复现两代重叠要重启实例**（旧一代收尾 + 新一代起），本轮负载闸下没做（空闲页 ~150 MB、
   swap 已用 7.5/8.2 GB，桌面会话还有两条 Electron 在跑）。下一轮若负载解除，判据是：起 A（隔离根、
   端口 a）→ 起 B（同根、端口 b）→ 关 A → 文件里仍是 B；`purescience status` 仍报 running。
3. **修复要等下一次 dev 重启或发版才生效**：当前 44100 那个实例跑的是旧代码，它的登记不会自己回来；
   下一次正常重启即会重新发布。
4. 本单元没有界面改动，也没有新通道；`purescience status` 的文案与判据都不变。
