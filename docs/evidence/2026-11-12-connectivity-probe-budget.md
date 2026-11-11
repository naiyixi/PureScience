# 连通性探针的 5 秒预算罩不住名字解析，而且「有一个通」要等最慢那条

日期：2026-11-12（执行器单元）· 代码：`src/main/settings/environment-check.ts`、`src/main/net/network-info.ts`

## 一 症状（装机日志，逐行可查）

打包版日志 `~/Library/Logs/PureScience/main{,1,2}.log` 里 `ipc handler was slow` 的
`network:check-connectivity` 共 **122 行**：

| 分桶 | 行数 |
| --- | --- |
| < 1 s | 57 |
| 1–5 s | 52 |
| 5–60 s | 10 |
| > 60 s | 3 |

探针自己写死的预算是 **5 s**（`REGISTRY_PROBE_TIMEOUT_MS`），而 **13 行越过它**。最有力的四行是
**进程确实在跑**的那种（同一行里带 1.5–8.7 s 的 CPU）：

| 时间（UTC） | 时长 | `cpuMs` |
| --- | --- | --- |
| 2026-11-06T04:48:14 | 12.5 s | 1,575 |
| 2026-11-09T03:19:17 | 15.2 s | 8,669 |
| 2026-11-09T15:47:50 | 17.3 s | 6,622 |
| 2026-11-05T03:39:01 | 12.6 s | 5,262 |

另有 3 行 428.4 s / 972.4 s / 980.3 s，其 `attribution` 是 `no-cpu-in-process`（窗口里本进程几乎没被调度，
睡眠/挂起也在这一类）⇒ **不作为主要证据**，只说明「这条探针没有一个与它同名的硬上限」。

代价是用户可见的：`probeConnectivity` 是 `network-store` 的 `connectivity: 'unknown'` 之源，
而 `unknown` 在界面上就是 **「Checking…」**。一次 12–17 秒的探测意味着网络面板十几次刷新都停在检查中。

## 二 机制（两处，各自独立）

**① `request.setTimeout` 不是整体预算。** Node 的文档写明它「在 socket 被分配之后」才生效，
量的是 **socket 空闲**。名字解析（`getaddrinfo` 走线程池）与前 socket 的等待都不在它的射程内 ——
一个解析不出来的名字可以让请求永远不 settle，于是 5 s 形同不存在。

**② `Promise.all(...).some(Boolean)` 让答案等于最慢那条。** 两个 registry 并行探测，但
`Promise.all` 要等**全部**落定才交出答案：只要有一条挂住，即使另一条 100 ms 就答了 200，
调用方仍然等满那条的预算。

## 三 本机真实读数（现取，5 次，只读外网 HEAD）

同一台机器、同一时刻，两处 registry 各探一次（`HEAD`，5 s socket 超时，间隔 200 ms）：

| 次 | npmjs | npmmirror |
| --- | --- | --- |
| 1 | 654 ms | 151 ms |
| 2 | 429 ms | 82 ms |
| 3 | 607 ms | 72 ms |
| 4 | 520 ms | 133 ms |
| 5 | 569 ms | 85 ms |

⇒ **首个成功** 72–151 ms（= npmmirror 那一条），**全部落定** 429–654 ms（= npmjs 那一条）。
在这台机器上改前改后的差距是 **约 4–9 倍**；在探测挂住的那种机器上差距是「5 秒 vs 十几分钟」。

**再用产品自己的函数量一遍**（不是另写一段 https）：同一次运行里，`checkInternetReachability()`
（改后：首个成功即答）与「两个探针都跑完」各量三次，真实外网、真实定时器：

| 次 | `checkInternetReachability()` | 两个探针都跑完 | npmjs / npmmirror |
| --- | --- | --- | --- |
| 1 | 163 ms | 634 ms | 632 ms / 69 ms |
| 2 | 150 ms | 522 ms | 522 ms / 62 ms |
| 3 | 75 ms | 666 ms | 665 ms / 66 ms |

⇒ 走交付的那个函数，答案落在 **75–163 ms**；改前的形状（等两个都落定）是 **522–666 ms**。
口径说明：这是一次性探针文件（量完即删、不进提交）在 vitest 里 import 交付函数量的，
**不是窗口里的读数** —— `network:check-connectivity` 在契约目录里是 Electron-only，
Web RPC 面根本不承载它（实测 `POST /rpc/network:check-connectivity` 回 `method_not_found`）。


复跑配方（只读外网，不写盘）：

```bash
node -e '
const https=require("node:https");
const t={npmjs:"https://registry.npmjs.org",npmmirror:"https://registry.npmmirror.com"};
const one=(u)=>new Promise((r)=>{const s=Date.now();
  const q=https.request(u,{method:"HEAD"},(res)=>{res.resume();r({ms:Date.now()-s,status:res.statusCode})});
  q.setTimeout(5000,()=>q.destroy(new Error("idle")));q.on("error",(e)=>r({ms:Date.now()-s,error:e.message}));q.end()});
(async()=>{for(let i=0;i<5;i++)console.log(await Promise.all([one(t.npmjs),one(t.npmmirror)]))})()'
```

## 四 交付

| 位置 | 改动 |
| --- | --- |
| `environment-check.ts` | `probeRegistryReachability` 拆成 `createRegistryProbe(requestFn = httpsRequest)`（与本仓 `createConnectionTypeResolver(execFileFn)` 同一种注入写法）；预算改成**整条链一条墙钟**（`setTimeout` → `settle` + `request.destroy`），跳转不重新计时；所有出口（成功 / 非 2xx / 跳转过多 / 网络错误 / 超时）汇到一个 `settle`，重复落定一律忽略 |
| `environment-check.ts` | 导出 `createRegistryProbe` 与 `REGISTRY_PROBE_TIMEOUT_MS`（测试直接读源里的那个数，不在测试里再抄一份） |
| `network-info.ts` | `checkInternetReachability` 改成**首个成功即答**：`finished(reachable)` —— 成功立即 resolve(true)，全部失败才 resolve(false)；落败那条**不取消**（下次调用仍走热路径），语义仍是「任一 registry 2xx ⇒ 可达」 |
| `environment-check.test.ts` | +4 例：无 socket 时按墙钟放弃且 destroy 被调用；跳转链共用一条预算（第二跳不答 ⇒ 报超时而不是「跳转过多」）；正常应答返回实测毫秒；非 2xx 报失败 |
| `network-info.test.ts` | +1 例：第一条永不落定、第二条答 12 ms ⇒ 仍 resolve(true) |

## 五 门禁（全部实跑）

| 环 | 读数 |
| --- | --- |
| `src/main/settings` + `src/main/net` + `network-ipc.test.ts` | **105 files / 1,594 passed**（3 skipped），exit 0 |
| 双 typecheck（`--composite false`，node 侧 `NODE_OPTIONS=…8192`） | node 0；web 0 |
| `eslint --no-cache`（4 个改动文件） | 0 error / 0 warning |
| 全仓 `eslint --no-cache .` | **0 error / 94 warning**（与基线同值） |
| 变异自证（两次，均已还原） | ① 墙钟退回 `request.setTimeout` ⇒ 两条预算用例当场红；② `checkInternetReachability` 退回 `Promise.all` ⇒「首个成功即答」当场红（60 s 后失败），合计 3 failed / 40 passed |

## 六 边界（不许读成更强）

- **不是装机读数**：本机三条 registry 现在都通（第三节），我量到的是「首个成功 vs 全部落定」的差距，
  不是那 13 行越过预算的行会不会消失。装机判据：新版本之后 `network:check-connectivity` 的
  **> 5 s 行数应为 0**（基线 13/122），且中位数向「首个成功」那一侧靠。
- **没有改判定语义**：仍然是「任一 registry 2xx ⇒ 可达」「全部失败 ⇒ 不可达」；`runEnvironmentCheck`
  里两个 registry 的**延迟比较**照旧（成功路径的 `Date.now() - startedAt` 未变）。
- **落败的探针不取消**：它会跑完自己那条（最多 5 s），这是有意的——取消它会让下一次调用重新冷启动。
- **没有覆盖「主进程整体卡住」**：如果主进程的事件循环停了，定时器同样不会跑；那种情况属于停滞判定，
  不是这条探针的预算问题。
