# 跨机重放演练里被重跑的那段分析。
#
# 要求：同一份输入在任何平台都必须给出**逐字节相同**的输出 —— 定长小数、键名排序、行尾固定 \n、
# 不用平台相关的换行或本地化格式。任何「差不多一致」都会让 4.1 的判据变成一句空话。
import csv
import json
import pathlib

here = pathlib.Path(__file__).parent
rows = list(csv.DictReader((here / "measurements.csv").open(encoding="utf-8", newline="")))

columns = [name for name in rows[0].keys() if name != "sample"]
means = {}
for column in columns:
    values = [float(row[column]) for row in rows]
    means[column] = round(sum(values) / len(values), 6)

with (here / "summary.csv").open("w", encoding="utf-8", newline="\n") as handle:
    handle.write("column,mean\n")
    for column in columns:
        handle.write(f"{column},{means[column]:.6f}\n")

with (here / "counts.json").open("w", encoding="utf-8", newline="\n") as handle:
    json.dump({"rows": len(rows), "columns": columns}, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
