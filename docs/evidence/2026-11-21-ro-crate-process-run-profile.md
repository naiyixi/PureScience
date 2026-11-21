# 导出包对 Process Run Crate 0.5 的 REQUIRED 检查归零（2026-11-21）

上一轮（`docs/evidence/2026-11-20-process-run-crate-2-1.md`）把这条红的形状定死在一个六变体的矩阵里，
结论是「能落地的形状只有 `both-described`」，但当时**只停在结论**：产品写出器一个字节没改，
所以官方验证器对真包的读数一直是 `process-run-crate-0.5` **REQUIRED 2 条**（都是 `2.1`）。
这一篇是落地后的读数：同一份种子、同一份输入，改前（`/tmp/ps-aff-crate`，2026-11-20 由旧代码写出）
与改后（`/tmp/ps-crate-after`，本轮 HEAD+改动由同一个写出器写出）逐项对照。

## 一 仪器与样本

| 项       | 读数                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 验证器   | `rocrate-validator` **0.4.2**，venv `/tmp/ps-val-venv`（Python 3.9.6），`abort_on_first=False`                          |
| 第二读者 | `rocrate` **0.16.0** + `pyld` **3.3.0**，venv `/tmp/ps-rocrate-venv`（Python 3.13.3），脚本 `docs/evidence/2026-11-18-ro-crate-third-party-read.py` |
| 被测对象 | 产品自己的写出器 `writeRoCrateExport`（`src/main/ro-crate/export.ts`），不是手搓 JSON                                   |
| 种子     | `/tmp/ps-aff-seed`：`artifacts/project-1/session-1/.provenance/artifact-1/versions/version-1/`，一条已发布 Version，sha256 `492d5ea4…` |
| 输入     | 作者 `Abel Wang`、机构 `zerolink Bio`（含 URL）、文本许可 `CC BY 4.0`、app `PureScience 2.31.1`、`generatedAt` 固定 |

改前与改后的包**只差本轮那几处**：把两份 `ro-crate-metadata.json` 逐行 `diff`，命中项全部落在
`conformsTo`、`mentions`、`CreateAction.description`/`endTime`、以及末尾两条 profile 实体上（见第三节）。

## 二 读数（现取）

| 判决                                            | 改前（旧代码写出的真包） | 改后（本轮写出的真包） |
| ----------------------------------------------- | ------------------------ | ---------------------- |
| `process-run-crate-0.5` **REQUIRED**            | **2 条**（都是 `2.1`）   | **0 条**               |
| `process-run-crate-0.5` **RECOMMENDED**         | 12 条                    | **7 条**               |
| `ro-crate-1.1` **REQUIRED**                     | 0 条                     | 0 条                   |
| `ro-crate-1.1` **RECOMMENDED**                  | 3 条                     | 3 条（同三条，未变）   |
| CLI `rocrate-validator validate`（按包自报的 1.1） | —                        | `[OK] RO-Crate is a valid ro-crate-1.1` |

`REQUIRED` 归零的两条正是 `2.1` 自己：`class` 未满足与 `pattern` 未满足各一条，来源是同一个属性形状
（`sh:class` 与 `sh:qualifiedValueShape` 挂在同一条 property shape 上）。

## 三 改了什么（都在 `src/shared/ro-crate.ts`）

1. **根实体的 `conformsTo` 变成列表**：`[{@id: https://w3id.org/ro/crate/1.1}, {@id: https://w3id.org/ro/wfrun/process/0.5}]`。
   **只在包真的记录了运行时**才写两条 —— 判据是图里有没有 `CreateAction`（每个文件一条），
   没有 run 的包仍写单条 base 声明，不替它宣称「这是一个过程记录」。
2. **两条 permalink 各写一条 `CreativeWork` 实体**：`sh:class` 是逐值判的，列表里任何一个 `@id`
   没有实体，`2.1` 就留着红（上一轮用 `root-only` 与 `list-one-entity` 两个变体各证了一半）。
3. **`CreateAction` 总有 `description`**：有记录配方时仍是 `Recorded recipe: …`；没有时写
   `Recorded run in <app> that produced <file>[ from N recorded input(s)].` —— 只复述记录里已有的三件事。
4. **`endTime` 的 `Z` 换成 `+00:00`**：profile 的 `endTime` 形状与 `datePublished` 用的是同一条
   `^(…)(T…[+-]\d{2}:\d{2})?$`，两者都是合法 ISO 8601，只有带偏移的那种过形状。复用 `normalizeDatePublished`。
5. **根实体的 `mentions` 收进它自己的 `CreateAction`**：「这个包提到它自己包含的 run」由包内图自证，
   不是对外主张。
6. **自有验证器加一条 `root-named-profiles-described`**：`conformsTo` 里凡是 base 规格之外的 permalink，
   都必须在本图里有实体（base 自己那条不判，否则一个普通的 1.1 包会被误判）。断言总数 32 → 33。

## 四 第二读者（换形状有没有把别人弄瞎）

`conformsTo` 从对象变列表是**读者可见**的变化，所以除了写侧还要读侧：

```
rocrate 0.16.0 : entities 11 / files 1 / files_missing_on_disk 0 / files_with_sha_mismatch 0 / dangling_hasPart 0
pyld 3.3.0     : nodes 11 / root_conformsTo ["https://w3id.org/ro/crate/1.1", "https://w3id.org/ro/wfrun/process/0.5"]
                 unexpanded_terms [] / dangling_hasPart 0
VERDICT PASS（退出码 0）
```

两份与我们的代码不共享任何一行的读取实现都读得出来，且 pyld 把两条 permalink 都解析成了 absolute IRI。

## 五 边界（这一篇不宣称的东西）

- **不宣称「符合 Process Run Crate 0.5」**：RECOMMENDED 还剩 **7 条**，逐条如下，其中 4 条是这一层拿不出的真内容：

| 检查 | 它要什么 | 为什么这一轮不做 |
| --- | --- | --- |
| `…0.5.3.2` | Application 有 `url` | 缺的是 `#environment-python` 的 URL，记录里没有运行时来源地址；编一个就是造假 |
| `…0.5.4.1` | SoftwareApplication 有 `version` | 同一条目：只有记录里带 `runtimeVersion` 时才写得出（有则已写） |
| `…0.5.5.1` | 软件实体的 `@id` 是绝对 URI | `#environment-python` 是包内相对 id；改成绝对 URI 需要我们自己造一个不解引用的命名空间 |
| `…0.5.8.6` | Action 有 `agent`（Person/Organization） | 记录里没有执行者身份；导出作者 ≠ 执行者，用他当 `agent` 是一次推断 |
| `ro-crate-1.1.22.1` ×2 | `license` 指向上下文实体 | 用户填的是自由文本（`CC BY 4.0`），把它拧成一个我们编的 URI 等于替用户改许可 |
| `ro-crate-1.1.22.3` | `publisher` 是 Organization | 既定决定：不替用户声明发布者 |

- 仍**没有**与第二台引擎逐条对拍这些 RECOMMENDED 判定（只对拍了 REQUIRED 与三个读者的读法）。
- 记录模型仍不带完整日期这一点与本单元无关（那在引用样式那条线上）。

## 六 复算

```bash
# 1. 用产品自己的写出器生成包（探针不入库：src/main/ro-crate/crate-readout.local.test.ts 跑完即删）
VITEST_LOCAL=1 npx vitest run src/main/ro-crate/crate-readout.local.test.ts
# 2. 官方验证器，逐 profile 逐严重级别
/tmp/ps-val-venv/bin/python -c 'from rocrate_validator import services, models; \
  s=services.ValidationSettings(data_path="/tmp/ps-crate-after", profile_identifier="process-run-crate-0.5", \
  requirement_severity=models.Severity.REQUIRED, abort_on_first=False); r=services.validate(s); \
  print(len(r.get_issues()))'
# 3. 第二读者
/tmp/ps-rocrate-venv/bin/python docs/evidence/2026-11-18-ro-crate-third-party-read.py /tmp/ps-crate-after
```
