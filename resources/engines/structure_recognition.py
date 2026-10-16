#!/usr/bin/env python3
"""Structure recognition (image -> SMILES) for the app's illustration pipeline.

Two modes, both speaking JSON on stdout so the caller never parses prose:

  rasterize  --pdf P --page N --bbox x,y,w,h --dpi D --out OUT.png
             Render the figure's box from the PDF at an explicit DPI. Deterministic: the same
             PDF + page + box + dpi produce byte-identical output, which is what makes the
             caller's input fingerprint recomputable outside the app.

  recognize  --engine decimer|molscribe --image IN.png --weights DIR
             Read one structure image with ONE engine and report the engine's own version. Engines
             are loaded lazily: a missing engine fails ONLY for its own call, by name, with the
             exception text -- never silently, and never by falling back to another engine.

  engines    --weights DIR
             Report which engines this interpreter can actually load, with versions. The caller
             uses this to decide whether it can demand two independent readings at all.

Nothing here decides whether a result is trustworthy: agreement between engines is the caller's
rule, and this script only reports what each engine said.
"""

import argparse
import importlib
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path


def _link_product_weights(weights):
    """把**产品已经下载并校验过**的权重链接到引擎期望的位置（硬链接优先），返回用到的路径。

    没给路径就不动 —— 那就按引擎自己的行为走（它会去下自己的那份，慢，但由调用方决定）。

    这一步**每次调用都要先做**：DECIMER 的模型加载在 import 时发生，而它解包完会把 zip 删掉，下次 import
    发现 zip 不在就会**重新下载 285 MB**（真机读数：一次 150 秒）。硬链接是即时的，符合「产品那份已校验的
    字节是唯一来源」。
    """
    if not weights:
        return None
    source = Path(weights)
    if source.is_dir():
        candidate = source / "weights.bin"
        source = candidate if candidate.is_file() else source
    if not source.is_file():
        return None
    # DECIMER 用 pystow 解析模型位置：<PYSTOW_HOME or ~/.data>/DECIMER-V2/models.zip。
    # **zip 不在就链接**：真机读数显示 DECIMER 每次 import 都要求这个 zip 在位（它解包完会把它删掉），
    # 缺了就去网上重下 285 MB —— 所以这里按「zip 是否存在且字节数一致」判断，而不是按「是否已解包」。
    home = Path(os.environ.get("PYSTOW_HOME", str(Path.home() / ".data")))
    target = home / "DECIMER-V2" / "models.zip"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.stat().st_size != source.stat().st_size:
            if target.exists():
                target.unlink()
            try:
                os.link(source, target)
            except OSError:
                shutil.copy2(source, target)
        os.environ["PYSTOW_HOME"] = str(target.parent.parent)
        return {"path": str(target), "bytes": target.stat().st_size}
    except OSError:
        return None


def _version(module_name):
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 - the message is the point
        return None, f"{type(exc).__name__}: {exc}"
    version = getattr(module, "__version__", None)
    if version is None:
        try:
            from importlib.metadata import version as meta_version

            version = meta_version(module_name)
        except Exception:  # noqa: BLE001
            version = "unknown"
    return version, None


def _fail(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)  # a named failure is a result, not a crash: the caller reads it from stdout


def rasterize(args):
    try:
        import pypdfium2 as pdfium
    except Exception as exc:  # noqa: BLE001
        _fail({"ok": False, "reason": "rasterizer-unavailable", "detail": f"{type(exc).__name__}: {exc}"})
        return

    try:
        pdf = pdfium.PdfDocument(args.pdf)
    except Exception as exc:  # noqa: BLE001
        _fail({"ok": False, "reason": "pdf-unreadable", "detail": f"{type(exc).__name__}: {exc}"})
        return

    if args.page < 1 or args.page > len(pdf):
        _fail({"ok": False, "reason": "page-out-of-range", "detail": f"page {args.page} of {len(pdf)}"})
        return

    try:
        x, y, width, height = (float(part) for part in args.bbox.split(","))
    except Exception as exc:  # noqa: BLE001
        _fail({"ok": False, "reason": "bbox-unreadable", "detail": f"{type(exc).__name__}: {exc}"})
        return

    page = pdf[args.page - 1]
    page_width, page_height = page.get_size()
    # 裁在**像素**层面做，不在 PDFium 的 crop 参数上做：那个参数是位图级的，原点与顺序都容易读错，
    # 而这里的换算必须能被读者在应用之外复算：
    #   应用给的框是 PDF 用户空间（原点左下）；Pillow 的原点左上 ⇒ 先翻 y，再按 scale 乘。
    tolerance = 1.0  # 浮点噪声的容差（点）
    outside = (
        x < -tolerance
        or y < -tolerance
        or x + width > page_width + tolerance
        or y + height > page_height + tolerance
    )
    if outside:
        # 框超出页面 ⇒ **具名拒绝**，不静默裁窄：裁窄之后渲染出来的可能是**另一张图**，而它照样会被拿去识别，
        # 结果就是「照着错的像素给了一个很像那么回事的结构式」。
        _fail(
            {
                "ok": False,
                "reason": "bbox-outside-page",
                "detail": f"box {x},{y},{width},{height} is not inside the page ({page_width}x{page_height})",
            }
        )
        return

    left = max(0.0, x)
    top = max(0.0, page_height - (y + height))
    right = min(page_width, x + width)
    bottom = min(page_height, page_height - y)
    if right <= left or bottom <= top:
        _fail({"ok": False, "reason": "bbox-outside-page", "detail": f"{left},{top},{right},{bottom} in {page_width}x{page_height}"})
        return

    scale = args.dpi / 72.0
    try:
        full = page.render(scale=scale).to_pil()
        box = (
            int(round(left * scale)),
            int(round(top * scale)),
            int(round(right * scale)),
            int(round(bottom * scale)),
        )
        image = full.crop(box)
        image.save(args.out, format="PNG")
    except Exception as exc:  # noqa: BLE001
        _fail({"ok": False, "reason": "render-failed", "detail": f"{type(exc).__name__}: {exc}"})
        return

    print(
        json.dumps(
            {
                "ok": True,
                "path": args.out,
                "dpi": args.dpi,
                "pixels": {"width": image.width, "height": image.height},
                "pageSize": {"width": page_width, "height": page_height},
            },
            ensure_ascii=False,
        )
    )


def recognize(args):
    engine = args.engine
    if engine == "decimer":
        # DECIMER 的模型就是产品自己那份资产：包的源码里模型 URL 是
        # https://zenodo.org/record/8300489/files/models.zip，而产品清单里那条
        # `structure-recognition-primary`（revision zenodo-10.5281/zenodo.8300489、kind structure-recognition、
        # 298,662,033 字节）**就是同一份字节**。所以这里**不让它自己去下**：把产品已经下载并校验过的那份
        # 链接到 DECIMER 期望的位置（硬链接优先：同一份字节，不占第二份磁盘），模型版本因此就是产品的那条 revision。
        linked = _link_product_weights(args.weights)
        # 「字节不可用」与「引擎装不上」是**两件事**，不能共用一个名字：先给权重做体检（真机测试里，
        # 半截下载的 zip 会让 DECIMER 自己去重下 285 MB —— 这正是要拦住的情形）。
        if linked is not None and not zipfile.is_zipfile(linked["path"]):
            _fail(
                {
                    "ok": False,
                    "engine": engine,
                    "reason": "weights-unreadable",
                    "detail": f"{linked['path']} ({linked['bytes']} bytes) is not a readable archive",
                }
            )
            return
        version, error = _version("DECIMER")
        if version is None:
            _fail({"ok": False, "engine": engine, "reason": "engine-unavailable", "detail": error})
            return
        try:
            from DECIMER import predict_SMILES

            smiles = predict_SMILES(args.image)
        except Exception as exc:  # noqa: BLE001
            _fail({"ok": False, "engine": engine, "reason": "recognition-failed", "detail": f"{type(exc).__name__}: {exc}"})
            return
        print(
            json.dumps(
                {
                    "ok": True,
                    "engine": engine,
                    "revision": f"DECIMER {version}",
                    "smiles": smiles,
                    **({} if linked is None else {"weights": linked}),
                },
                ensure_ascii=False,
            )
        )
        return

    if engine == "molscribe":
        if args.weights and not zipfile.is_zipfile(args.weights):
            # 同上：半截的 checkpoint 会报出 torch 的内部错误，名字不指向真正的原因。
            _fail(
                {
                    "ok": False,
                    "engine": engine,
                    "reason": "weights-unreadable",
                    "detail": f"{args.weights} is not a readable archive (a truncated checkpoint looks like this)",
                }
            )
            return
        version, error = _version("molscribe")
        if version is None:
            _fail({"ok": False, "engine": engine, "reason": "engine-unavailable", "detail": error})
            return
        try:
            from molscribe import MolScribe

            model = MolScribe(args.weights, device="cpu")
            result = model.predict_image_file(args.image)
        except Exception as exc:  # noqa: BLE001
            _fail({"ok": False, "engine": engine, "reason": "recognition-failed", "detail": f"{type(exc).__name__}: {exc}"})
            return
        print(
            json.dumps(
                {"ok": True, "engine": engine, "revision": f"MolScribe {version}", "smiles": result.get("smiles", "")},
                ensure_ascii=False,
            )
        )
        return

    _fail({"ok": False, "engine": engine, "reason": "engine-unknown", "detail": "known engines: decimer, molscribe"})


def report_engines(args):
    payload = {"ok": True, "engines": {}}
    for name, module_name in (("decimer", "DECIMER"), ("molscribe", "molscribe")):
        version, error = _version(module_name)
        payload["engines"][name] = {"available": version is not None, "version": version, "detail": error}
    version, error = _version("pypdfium2")
    payload["rasterizer"] = {"available": version is not None, "version": version, "detail": error}
    version, error = _version("rdkit")
    payload["canonicalizer"] = {"available": version is not None, "version": version, "detail": error}
    print(json.dumps(payload, ensure_ascii=False))


def canonicalize(args):
    """Canonical SMILES, so two engines' spellings can be compared as chemistry, not as strings."""
    version, error = _version("rdkit")
    if version is None:
        _fail({"ok": False, "reason": "canonicalizer-unavailable", "detail": error})
        return
    try:
        from rdkit import Chem

        molecule = Chem.MolFromSmiles(args.smiles)
        if molecule is None:
            _fail({"ok": False, "reason": "unparsable-smiles", "detail": args.smiles})
            return
        canonical = Chem.MolToSmiles(molecule)
        # 分子式是**额外**信息：它取不到也绝不能把规范化本身弄失败（缺它只是少一行注解）。
        formula = None
        try:
            from rdkit.Chem import rdMolDescriptors

            formula = rdMolDescriptors.CalcMolFormula(molecule)
        except Exception:  # noqa: BLE001
            formula = None
    except Exception as exc:  # noqa: BLE001
        _fail({"ok": False, "reason": "canonicalize-failed", "detail": f"{type(exc).__name__}: {exc}"})
        return
    print(
        json.dumps(
            {"ok": True, "canonical": canonical, **({} if formula is None else {"formula": formula})},
            ensure_ascii=False,
        )
    )


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)

    p_raster = sub.add_parser("rasterize")
    p_raster.add_argument("--pdf", required=True)
    p_raster.add_argument("--page", type=int, required=True)
    p_raster.add_argument("--bbox", required=True)
    p_raster.add_argument("--dpi", type=int, required=True)
    p_raster.add_argument("--out", required=True)

    p_rec = sub.add_parser("recognize")
    p_rec.add_argument("--engine", required=True)
    p_rec.add_argument("--image", required=True)
    p_rec.add_argument("--weights", default="")

    p_eng = sub.add_parser("engines")
    p_eng.add_argument("--weights", default="")

    p_can = sub.add_parser("canonicalize")
    p_can.add_argument("--smiles", required=True)

    args = parser.parse_args()
    # **任何会导入引擎的模式都要先建链接**：DECIMER 的模型下载发生在 **import 时**（真机踩到过：脚本第一步的
    # `engines` 自报就把它招来了，于是绕过链接又去下 285 MB）。这一步幂等且极廉价。
    if args.mode in ("recognize", "engines"):
        _link_product_weights(getattr(args, "weights", ""))
    if args.mode == "rasterize":
        rasterize(args)
    elif args.mode == "recognize":
        recognize(args)
    elif args.mode == "engines":
        report_engines(args)
    else:
        canonicalize(args)


if __name__ == "__main__":
    main()
