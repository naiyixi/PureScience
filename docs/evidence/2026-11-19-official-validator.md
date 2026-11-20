# 官方 RO-Crate 验证器读我们的导出包（2026-11-19）

4.2/4.3 的读数一直来自两个**读取**实现（`rocrate` 0.16.0、`pyld` 3.3.0）——它们说明「字段能被读出来」，
不说明「这个包合规」。这份档是第三条腿：拿 RO-Crate 社区自己的验证器（`roc-validator`，crs4）跑真包。

## 仪器

| 项       | 读数                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验证器   | `roc-validator` **0.4.2**（PyPI 最新；`rocrate-validator` CLI + `rocrate_validator.services`）                                                                        |
| profile  | `ro-crate-1.1`（包自己声明的那个）                                                                                                                                    |
| 严重级别 | `REQUIRED`（`abort_on_first=False`，一次跑完不早停）                                                                                                                  |
| 解释器   | `/tmp/ps-val-venv`，Python **3.9.6**（venv 报 LibreSSL 警告，与验证结论无关）                                                                                         |
| 被测对象 | 由**产品自己的写入器** `writeRoCrateExport` 生成，非手写 JSON：临时 harness 建隔离存储根、写两条 durable Artifact Version，再导出到 `/tmp/ps-validate-{raw,url,none}` |

三种配置，覆盖用户可能填的每一类值：

| 代号   | 署名                                            | 许可                                  | 用意                       |
| ------ | ----------------------------------------------- | ------------------------------------- | -------------------------- |
| `raw`  | `#author` / Person / `Li Wei, Fudan University` | 自由文本 `CC BY 4.0`                  | 最可能被手打进来的形态     |
| `url`  | 同上                                            | `https://spdx.org/licenses/CC-BY-4.0` | 界面占位符推荐的另一种形态 |
| `none` | 没填                                            | 没填                                  | 「没设过就两个键都不写」   |

## 修前读数：三种配置全部不合规

`valid=false`，报的都是一等 REQUIRED 检查：

| 配置   | 失败检查                                | 验证器的话（原文节选）                                                                   |
| ------ | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `raw`  | `ro-crate-1.1.8.3`                      | The Root Data Entity MUST have a `license` property … MAY be a textual description       |
| `raw`  | `ro-crate-1.1.8.4`                      | …`datePublished`… with a valid ISO 8601 date and the precision of at least the day level |
| `url`  | `ro-crate-1.1.8.4`                      | 同上                                                                                     |
| `none` | `ro-crate-1.1.8.3` + `ro-crate-1.1.8.4` | 同上两条                                                                                 |

两条根因，都在**我们的写入器**，不在读者：

1. **`datePublished` 写成 `…T00:00:00.000Z`**。profile 的 SHACL 形状是
   `^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2})?$` —— `Z` 偏移不在其中。
   `Z` 是合法 ISO 8601，但这个形状不认，而**过不了 REQUIRED 形状就不是可用的 RO-Crate**。
2. **自由文本许可被写成 `{"@id": "CC BY 4.0"}`**。带空格的 `@id` 既不是 URI 也不是字面量：
   `sh:or` 的三条（ContextualEntity / `xsd:anyURI` / `xsd:string`）一条都落不进去。规范允许
   「文本描述」，那就该写成文本，而不是伪造成一个实体引用。
3. 另有 `none` 配置：连 `license` 属性都没有。规范里它是 **MUST**，不是 MAY。

## 修后读数：三种配置全部合规

同一台机器、同一份验证器、同一个 profile：

```json
{
  "raw": { "valid": true, "issues": [] },
  "url": { "valid": true, "issues": [] },
  "none": { "valid": true, "issues": [] }
}
```

CLI 也逐包复核了一遍（`rocrate-validator validate <path>`，读结论行）：

```
raw  => RO-Crate is a valid ro-crate-1.1
url  => RO-Crate is a valid ro-crate-1.1
none => RO-Crate is a valid ro-crate-1.1
```

## 代码里改了什么

| 位置                                              | 改动                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/ro-crate.ts` `normalizeDatePublished` | 写入侧统一成形状认得的形态：`Z` → `+00:00`；已经合规的原样保留；放不进该形状的值退到**日精度**（profile 明说这是最低要求），不写一个注定被拒的时间戳                                                                     |
| `src/shared/ro-crate.ts` 根实体 `license`         | 有 scheme 的值 → 实体引用 + `CreativeWork` 实体（原行为，合规）；自由文本 → **字面量**（规范允许的「文本描述」）；完全没填 → `No licence declared by the exporter`（一句话说明「没人声明」，不主张任何权利，也不猜许可） |
| `src/shared/ro-crate.ts` 校验侧                   | 新增 `root-license-declared`（**spec-must**）：`license` 缺失即失败。此前只有一条 `root-license-described`（spec-should），而 SHOULD 挡不住这次的事                                                                      |

**校验侧故意比视图更宽**：`datePublished` 的 In-app 判据仍是通用 ISO 8601（接受 `Z`、接受负偏移），
因为规范允许这些写法、而参考形状更窄；我们把**自己写出去的**做成过窄形状也接受，别人写的按规范判。
判据应该能分辨「不合规」和「不合某个实现的口味」。

## 边界

- 只跑了 **base profile 1.1** 的 REQUIRED 级别；RECOMMENDED / OPTIONAL 未纳入（那会把「可选建议」读成缺陷）。
- 只有**一个**验证器实现。上一轮两个读者是「读得出」，这一轮一个验证器是「合规」，两者互补，都不等于
  多实现交叉验证。
- 没填许可时写的那句话是**描述**，不是许可主张；它让包在结构上合规，同时明确说清「导出方没声明」。
  若将来产品支持「明确选择无许可」，文案要跟着改。
- `datePublished` 只归一化根实体；文件实体的时间戳沿用原值（规范对 `File` 没有同样的 MUST）。
