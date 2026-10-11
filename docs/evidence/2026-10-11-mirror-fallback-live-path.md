# 镜像回退路径的真机读数（P0-8 后半，2026-10-11）

> 前一份读数（`2026-10-11-mirror-candidate-identity-probe.md`）证的是**候选端点可达且内容同一**；
> 本文件证的是**回退路径本身**在真网络上跑得通、且落地字节的校验和与预期一致。

## 读数一：回退那一跳（真机跑通）

探针（临时 vitest 文件，跑完即删，未入库）：真端点原样调 `downloadWithMirrorFallback`，
只给一个**独立测得的** digest（该 digest 由前一份读数的 curl 取 `hf-mirror.com` 得到，570 字节）。

```
PROBE via=hf-mirror.com sha=7160e1553ad2ca51d8c1cb066be533db31826e12d173824c1bb0cb1a4f187d20 verified=true
✓ ... 10824ms
```

- 原端点 `huggingface.co` 在本机**没有应答**（stall 预算 8 s 内无响应）；
- 回退到 `hf-mirror.com` → **200，570 字节**；
- 落地文件的 sha256 与预期**逐字符相同** ⇒ `verified=true`；
- 返回值 `via` **正确报出镜像宿主**（这正是"来源标记"要能上屏的那件事）。

## 读数二（同一会话附带）：`raw.githubusercontent.com` 的超时是**间歇性**的

第一次以 `raw.githubusercontent.com` 为原端点跑同一路径，结果是：

```
PROBE via=origin sha=1133f4a82a5c7e1cd6ea055034d99e598b5745a46b277c7e55ef32ba2997b917 matchesLocal=true
```

即**原端点这次自己答上了**，字节与本地工作副本一致。

⇒ 结论要点：**超时不等于永久不可达**。因此回退机制的正确形态就是本单元做的样子 ——
**先试原始端点、失败才换源**（而不是"检测到中国网络就直接换源"）；
而 `hf-mirror.com` 这一行之所以能作为回退，是**实测它承载了原始端点给不出的那次服务**。
