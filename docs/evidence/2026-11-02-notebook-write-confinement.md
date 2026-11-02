# Notebook 写入限制：内核只能在授权目录内写（真 seatbelt 策略，本机实测）

> 2026-11-02。对标产品把「notebook / shell 只能在你授权的目录里执行」做成默认开；我们此前只有
> 「受管运行时只读」这一层（`protectManagedRuntimeWrites` 只把 runtimeRoot 拒写，其余全放行）。

## 一 做了什么

`src/main/notebook/managed-runtime-guard.ts` 新增 `confineKernelWrites(invocation, { allowedRoots, readOnlyRoots })`，
生成 macOS seatbelt 策略并交给 `/usr/bin/sandbox-exec` 启动内核：

```
(version 1)
(allow default)
(deny file-write*)                                   ← 默认拒写
(allow file-write* (literal "/dev/null"))            ← 三个设备节点
(allow file-write* (subpath "<会话工作目录>"))          ← 授权根
(allow file-write* (subpath "<figures 目录>"))
(allow file-write* (subpath "/private/tmp"))          ← Python / BLAS / matplotlib 要写这里
(allow file-write* (subpath "/private/var/folders"))
(deny file-write* (subpath "<受管运行时根>"))           ← 最后一条，last-match-wins
```

* **读不受限**：读不了自己库的 kernel 不是更安全，只是坏掉；
* **运行时仍只读**：deny 放在 allow 之后，seatbelt 是 last-match-wins，所以即使运行时目录落在授权根内部也拒写；
* **`PURESCIENCE_NOTEBOOK_CONFINE_WRITES=0`** 可以关掉（不需要改代码）—— 一个从设置里关不掉的护栏，
  用户的工作方式就是绕开这个应用；
* 只对 **darwin** 生效：Linux/Windows 上这个构建没有经过验证的写保护，返回原始调用而**不假装**保护过。

## 二 本机实测（真 seatbelt，非模拟）

用 `confineKernelWrites` 生成的调用跑 Python，让它依次尝试写三个位置：

```
["WROTE  /var/folders/…/confine-…/inside/a.txt",
 "DENIED /Users/totota/__guard_outside.txt  PermissionError",
 "DENIED /var/folders/…/confine-…/runtime/b.txt PermissionError"]
```

三件事同时成立：授权目录内可写、授权目录外被拒（`PermissionError`）、受管运行时（虽然坐落在
`/var/folders` 这个放行的临时树里）仍被拒 —— 最后一条正是「deny 放在 allow 之后」的证据。

离线用例 4 条（`managed-runtime-guard.test.ts`）：默认拒写 + 授权根放回、临时树放行、运行时的 deny 在 allow 之后、
非 darwin 原样返回、没有授权根时原样返回。该文件 130 条全过；`kernel-executor.test.ts` 56 passed / 6 skipped。

## 三 边界（写在这里，不含糊）

1. **这是进程级护栏，不是 OS 账户隔离**：它约束的是这套内核进程树能写哪里，不是「用户本人不能写」。
2. **shell / 后台作业面没有覆盖**：本轮只做 notebook 内核（Python 与 R 都走同一条 spawn 路径，因此都覆盖）。
3. **没有设置项 UI**：开关目前是环境变量；设置面板里的「授权目录」编辑是下一步。
4. **Linux/Windows 未覆盖**（未验证就不声称）。
