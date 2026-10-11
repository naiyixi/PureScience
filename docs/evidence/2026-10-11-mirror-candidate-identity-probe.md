# 候选镜像对的「内容同一性」实测（P0-8 后半，2026-10-11）

> 目的：P0-8 后半要求"科研来源镜像回退"，但**换源必须先能证明拿到的是同一个东西**（硬判据见
> `docs/plan-2026-10-10-v2-line-schedule.md` 的 P0-8 行）。本文件用**本机真实网络**（中国）取一次读数，
> 结果**推翻了我先前写下的三条设计判断** —— 记在这里，免得下一轮照旧表开工。

## 取数方式（可复跑）

```bash
# 每对：原始端点与候选各取一次，比 HTTP 状态 / 字节数 / sha256
curl -sS --max-time 25 -o /tmp/a -w '%{http_code}' <ORIGIN_URL>
curl -sS --max-time 25 -o /tmp/b -w '%{http_code}' <CANDIDATE_URL>
shasum -a 256 /tmp/a /tmp/b
```

## 读数

| 对 | 原始端点 | 候选端点 | 判决 |
|---|---|---|---|
| **RCSB 结构** | `files.rcsb.org/download/1CRN.pdb` → **200 / 49,491 B** / sha `42199a30…` | `ftp.wwpdb.org/pub/pdb/data/structures/all/pdb/pdb1crn.ent.gz` → **HTTP 000，`curl: (6) Could not resolve host: ftp.wwpdb.org`** | **候选在本机不可用**（DNS 直接解析不了）⇒ **不构成回退** |
| **HuggingFace 文件** | `huggingface.co/bert-base-uncased/resolve/main/config.json` → **HTTP 000，`(28) Connection timed out after 25006 ms`** | `hf-mirror.com/...` → **200 / 570 B** / sha `7160e155…` | **回退有效**：原始超时、镜像拿到数据 |
| **GitHub raw** | `raw.githubusercontent.com/naiyixi/PureScience/main/package.json` → **HTTP 000，超时 25 s** | `cdn.jsdelivr.net/gh/naiyixi/PureScience@main/package.json` → **200 / 6,318 B** / sha `1133f4a8…` | **回退有效且可证同一性**：镜像 sha 与本机工作副本 **逐字符相同**（`1133f4a8…`） |
| **NCBI** | `eutils.ncbi.nlm.nih.gov/.../efetch.fcgi?db=pubmed&id=31452104` → **200 / 6,081 B** | `ftp.ncbi.nlm.nih.gov/pubmed/` → **200**（目录可访问） | **不构成内容等价回退**：一侧是 API 返回的 XML、一侧是文件目录，**服务不同** |

## 由此推翻的三条设计判断

1. ❌ 「`files.rcsb.org` ↔ `ftp.wwpdb.org` 同属 wwPDB 体系，可放心回退」——
   在本机 `ftp.wwpdb.org` **连 DNS 都不解析**，回退等于把一次失败换成另一次失败（还多一次超时）。
   它仍可能对别处的网络有用，但**不能作为本机默认回退**。
2. ❌ 「`ftp.ncbi.nlm.nih.gov` ↔ `eutils.ncbi.nlm.nih.gov` 是 NCBI 自己的两条路」——
   两者**服务不同内容**（API XML vs 文件目录），不满足"内容同一性"这道门 ⇒ 不属于可回退对。
3. ✅ 真正在本机成立、且**能拿出同一性证据**的回退只有两条：
   - **HF：`huggingface.co` → `hf-mirror.com`**（原始超时 / 镜像 200）；
   - **GitHub raw：`raw.githubusercontent.com` → `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`**
     —— 后者能与**仓内已知内容**逐字节对上（本仓 `package.json` sha 相同），这正是"同一性证明"的样子。

## 对设计的直接后果

- 镜像表不能靠"组织归属"推理，**每一行都要有实测**（本文件即第一版实测）。
- `via` 标记（`origin` / `mirror:<host>`）必须**带同一性证据**才允许标成"已回退"：
  有校验和（HF 文件级 sha256、jsDelivr 对仓内已知文件）→ 标；拿不出 → **按具名失败报错**。
- `api.anthropic.com` / `api.deepseek.com` 永不回退（认证与计费端点）——本轮读数未触及，维持原判。
