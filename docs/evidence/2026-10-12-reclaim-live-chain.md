# 按需回收的真机读数：读数 → 动作 → 磁盘 三者逐字节吻合（P0-10，2026-10-12）

> 取数方式：在常驻 dev 实例上直调产品自己的动作 `storage:sweep-duplicate-content`（Web RPC，不经界面）。

## 一、动作的返回与日志（真数据根上跑出来）

```
POST /rpc/storage:sweep-duplicate-content → http=200
result: {
  ok: true, scanned: 1325, linked: 0, bytes: 0, distinct: 1325, alreadyShared: 1359,
  unreadable: 0, unlinked: 0, elapsedMs: 10683,
  cacheFreedBytes: 2818211369,      ← 释放 2.82 GB
  cacheFreedFiles: 74393,
  cacheLeftAloneBytes: 1544122744   ← 保留 1.54 GB（最后一条链，一个字节没碰）
}
```

日志行 `[storage:ipc] content duplicates reclaimed on request` 带全套字段，含载荷里没有的那三个：

```
cacheLeftAloneFiles: 11683, cacheSkippedFiles: 0, cacheElapsedMs: 9817
```

## 二、磁盘核对（第三次读数，独立于前两者）

```
dataRoot（接口自己报的）= /Users/totota/PureScience-DEV
$ du -sh -x /Users/totota/PureScience-DEV/runtime/pkgs
1.5G
```

`1.5 GB ≈ 1,544,122,744 字节 = 1.54 GB` = 动作**声称保留**的那部分 ⇒ **剩下的正是"最后一条链"**。

## 三、三者吻合（这才算证据）

| 来源 | 可证冗余 | 最后一条链 |
|---|---|---|
| 启动时的读数（`f7a23c2c` 接进维护块） | 2,818,211,369 B / 74,393 | 1,544,122,744 B / 11,683 |
| 动作自身的回报（本次） | 2,818,211,369 B / 74,393 | 1,544,122,744 B |
| 磁盘现状（`du`） | （已消失） | **1.5 GB 仍在** |

**逐字节一致**：读数预测了什么会被释放、什么会被拒绝，动作的回报与磁盘现状都对得上。
`cacheSkippedFiles: 0` + `SQLITE_BUSY=0` 说明本次没有被跳过的文件、也没有锁错误。

## 四、又一次「先定根」的实证（我本轮第二次踩）

- 配置/DB 根：`~/.purescience-project`（**库在这里**：`purescience.db` + `-wal`/`-shm`）
- **dev 存储根**：`~/PureScience-DEV`（`runtime/pkgs`、`notebooks` 等在这里；接口自报 `dataRoot` 也是它）
- 打包版根：`~/.purescience`（5.7 GB 的 `runtime/pkgs` 还在那里，属打包版）
- 已退役：旧品牌时代留下的一个根（名字含旧品牌，按仓规**不写在跟踪文件里**；其 `runtime/pkgs` 仍占着空间）

⇒ **同一个"数据根"这个词在三个地方各指一个目录**。任何"删了多少 / 还剩多少 / 库是什么模式"的结论
**必须先打印接口自报的 `dataRoot`（或先指明用哪个根）**，否则读到的是另一个应用的另一个目录 —— 本轮我两次读过别的根。

## 未取（具名）

打包态界面截图（设置面板不在 Web 面上）；慢解析出现率的前后对照（需真实使用时段，读法已固定）。
