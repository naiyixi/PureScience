# 「会话体积可见」的真机读数（P0-10③，2026-10-12）

> 取数方式：**不经过界面**，直接对常驻实例的 Web RPC 面调 `storage:get-info`
> （`POST http://127.0.0.1:44100/rpc/storage:get-info`，`Authorization: Bearer <token>`，body `{"protocolVersion":1,"args":[]}`）。

## 读数（真实数据根，一次调用）

```
http=200  bytes=9244
usage keys: categories / projects / sharedBytes / sharedFiles / totalBytes

categories:
  artifacts   141,475,300
  uploads           2,801
  runtime   5,662,629,164
  notebooks 1,640,912,468
  workspaces    2,567,977
totalBytes  7,447,587,710

projects: 55 条，**55/55 都带 name**，按体积降序：
  cmskfamdk0000wfnav39jojhh  分子动力学                                    561,498,015
  cmtv1eh3c0003wft07lbd51t6  细胞暗物质 —— 从单细胞图谱到合成致死细胞疗法的零先验发现   433,968,742
  cmtmyny9k0000jtq8ljbxca1b  极限压力测试题                                 176,508,850
  cmttjc48c0000jtvn420z4ddj  罕见病（SHANK2 突变）的多组学机制裁决与药物重定位        143,824,845
  cmuh0axy50000jt29bqjmk9gm  马尔可夫态模型（MSM）与动力学采样收敛…              119,322,126
```

## 这条读数证明了什么

1. **`StorageUsage.projects` 在真数据根上真的带数据**：55 条真项目、真名称（中文项目名原样透传 —— 这正是"项目名是
   *值* 不是 *文案*、所以不进字典"的设计在真机上的表现）、真字节数，且**按体积降序**（排序在真机上生效）。
2. **载荷层面的闭环**：主进程真实走查（7.45 GB 总量）→ 载荷 → 面板那一节（面板侧已有渲染用例钉住名字+数值成对）。
   至此本单元"看得见谁占了多少"的三层里，**契约（单测）+ 载荷（本条真机读数）+ 渲染（渲染用例）** 都有证据。
3. 顺带给了 `runtime` 5.66 GB / `notebooks` 1.64 GB 这类**当前真实分布**，与更早的 `du` 读数可对照（树在变，引用需带时刻）。

## 仍未取（具名）

**打包态界面截图**：设置面板不在 Web 面上（"Remote Control only"，无设置通道），要拍它必须驱动**打包/带窗的 Electron 窗口**
（CDP）—— 那是另一条取证路径，且需要为该版本重建产物。本条的"渲染"证据目前是 jsdom 渲染用例（断言名字+数值成对，
`/Mpro docking\s*1\.1 GB/`），**不是截图**。
