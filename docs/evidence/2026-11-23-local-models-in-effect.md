# 本地模型到底在起作用吗（2026-11-23 实机读数）

问题来自一张截图：本地解析模型列表里 `structure-recognition` 下载失败，报 `fetch failed: not cached,
and temporary files have been cleared`。要回答的是「它现在起作用吗」，不是「它有没有代码」。

## 结论

**起作用，但只有一票。** 本机 DECIMER 一路是活的：权重在、解释器能加载、栅格化与化学规范化都在。
第二路 MolScribe 不活 —— 环境装好了、包也在，**缺 checkpoint**。而这两个引擎的意义恰恰是互相独立地读同一张图，
「两票一致」才是可信度的判据；只有一票时不能说「结构式识别可用」，只能说「读了一次」。

## 读数（可原样重跑）

内存里有环境根 `~/.purescience`，产品自己的解释器在 `runtime/envs/<name>/bin/python`。

```bash
# 1) 权重：298,662,033 B（285 MB），2026-10-17 落地
ls -la ~/.purescience/engine-weights/structure-recognition-primary
#   -rw-r--r--@ 1 totota staff 298662033 Oct 17 02:32 weights.bin

# 2) 用 DECIMER 那个环境问引擎能力
~/.purescience/runtime/envs/structure-recognition/bin/python \
  resources/engines/structure_recognition.py engines \
  --weights ~/.purescience/engine-weights/structure-recognition-primary
#   {"ok": true, "engines": {
#      "decimer":     {"available": true,  "version": "2.7.2"},
#      "molscribe":   {"available": false, "detail": "ModuleNotFoundError: No module named 'molscribe'"},
#      "rasterizer":  {"available": true,  "version": "5.14.0"},
#      "canonicalizer":{"available": true, "version": "2026.09.1"}}}

# 3) 上一条里 molscribe 的 not-found 不代表环境缺包 —— 它自己的环境是另一套：
~/.purescience/runtime/envs/structure-recognition-molscribe/bin/python -c "import molscribe, torch; print(torch.__version__)"
#   molscribe ok 1.13.1      # 包里在，torch 也是它要的 1.x

# 4) 缺的是 checkpoint：engine-weights 下只有 primary 一个目录
ls -la ~/.purescience/engine-weights/
#   structure-recognition-primary/     # 只有 DECIMER 的资产
```

`structure-recognition.ts:43-47` 的取舍规则正是这样：权重文件在 → 那一路上；checkpoint 在 → 另一路上。
文件不在就是不在，不会拿「包能 import」冒充「模型可用」。

## 为什么截图里写着失败

权重是**从远端下载校验**的（`model-weight-cache.ts`，带 sha256 与镜像回退）；那天首跳不通，就把
`fetch failed` 原样端上来了。今天的构建里，这一类失败会被换成分得清的说法（不可达 / 被拒 / 超时 / 证书 /
被重置），并且会在 origin 失败后按已测量过的镜像回退 —— 但**下载终究要能到字节**，镜像里也得有这份资产。

## 待办（下一版，不假装已做）

1. MolScribe checkpoint 进清单并发布到自家镜像（`purescience.work/download/…`），让第二票能投出来。
2. 界面上把「一路可用 / 两路可用」说清楚，而不是把「装上了」等同于「识别可信」。
3. 下载失败时给出**下一步**（换镜像重试 / 稍后再试），而不是只报原因。
