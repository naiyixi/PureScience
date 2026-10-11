# WAL 在生产上的真机读数（P0-10③ 第一步，2026-10-12）

> 取数方式：把常驻 dev 实例重启到含本改动的代码（`launchctl kickstart -k gui/<uid>/com.totota.purescience`），
> 让**应用自己的代码路径**去设置 PRAGMA；再用**另一条连接**（`sqlite3` CLI）回读。

## 读数一：机制在生产上生效

```
$ ls -la ~/.purescience-project/purescience.db*
purescience.db        87,851,008  Oct 12 03:45
purescience.db-shm        32,768  Oct 12 03:45
purescience.db-wal             0  Oct 12 03:45

$ sqlite3 ~/.purescience-project/purescience.db "PRAGMA journal_mode;"
wal
```

- 库在重启前是 `delete`；重启（pid 1845 → 68679，44100 恢复 LISTEN）后**由应用自己**切成 `wal`，
  并生成 `-wal` / `-shm` 伴随文件 ⇒ **第一步的机制在生产上成立**。
- 单测里验过的东西（PRAGMA 落点、伴随文件出现）在真库上同样成立。

## 读数二：设计里那条 PRAGMA 语义被生产实证

```
$ sqlite3 ~/.purescience-project/purescience.db "PRAGMA busy_timeout;"
0
```

CLI 是**另一条连接**，它读到 0；应用自己那条连接是 5000。这**正是**设计里写的那条区分：
`journal_mode` 是**文件级**（持久 ⇒ 新连接也读到 `wal`），`busy_timeout` 是**连接级**（新连接读不到）。
⇒ 设计的第一步之所以不需要读池就能上，依据就在这里。

## 读数三：同一次启动里，我这一批的存储读数在真数据根上跑出来

```
[storage] package cache redundancy {
  redundantBytes: 2818211369, redundantFiles: 74393,
  soleLinkBytes: 1544122744, soleLinkFiles: 11683, maxLinkCount: 5
}
```

- 这是 `f7a23c2c` 接进启动维护块的那套读数，**在生产上真的跑了**：2.82 GB / 74,393 个文件是可证冗余，
  1.54 GB / 11,683 个文件是"最后一条链"（永不删），最大链接数 5。
- 与更早一次 `find -links` 的读数（2.73 GB / 95,817 + 2.75 GB / 23,030）**不同** —— 树在被改动（期间有环境的建/删），
  两次读数各自的采集时刻不同 ⇒ 引用时必须带时刻，不能把其中一个当成"当前值"。

## 一条被纠正的假设（重要）

我第一次回读的是 `~/.purescience/purescience.db`（117 MB，仍是 `delete`）—— **那是打包版应用的库**。
常驻 **dev** 实例的库在 **`~/.purescience-project/`**（87.85 MB，就是 config 根本身，即统一数据根）。
⇒ 本仓三套根必须先定根再断言：配置/DB 根 `~/.purescience-project` ≠ 打包 `~/.purescience`（≠ 已退役的 dev `~/PureScience-DEV`）。
**打包版的库要等下一次发版运行新代码后才会切 WAL** —— 这是发版后应复核的一项。

## 未取（具名）

**延迟改善（`dbCanaryMs` p50/p90 改前改后对照）仍未取**：`dbCanaryMs` 只出现在**慢路径**日志
（`artifact version resolve was slow`）里，需要流量与时间才会出样本 —— 一次短探必然 0 样本。
取法已明确：让实例跑一段有真实使用的时段，再比较该 warn 的**出现率**（改前 9 天 273 次）。
