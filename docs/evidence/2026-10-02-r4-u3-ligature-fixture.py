#!/usr/bin/env python3
"""Build the two fixtures the R4-U3 unit still needs: a PDF whose *ToUnicode CMap* maps real glyph
codes to U+FB01 (Latin ligature fi) / U+FB00 (ff) and to U+00AD (SOFT HYPHEN).

Why hand-written instead of reportlab: reportlab's TTF subsetting rewrites ToUnicode so the reader
gets "fi" and drops the soft hyphen, i.e. the writer never emits the code points at all (recorded in
docs/evidence/r4-u3-rotation-investigation.md §4). This builder writes the CMap itself, so the reader
is handed the exact code points the unit is about. Any document produced by a real typesetter with
"map ligature glyphs to the ligature code points" behaves like this file.

Output: /tmp/ps-q2/ligature-tounicode.pdf  (3 columns x 3 rows, so 3 rows / 3 columns is the truth)
"""
import os

OUT = "/tmp/ps-q2/ligature-tounicode.pdf"
os.makedirs("/tmp/ps-q2", exist_ok=True)

# Code points we deliberately steer through ToUnicode. Codes 0x81/0x82 are undefined in WinAnsi,
# so the reader can only learn their meaning from the CMap below -- exactly the situation under test.
FB01, FB00, SHY = 0xFB01, 0xFB00, 0x00AD
CODE_FI, CODE_FF, CODE_SHY = 0x81, 0x82, 0x83

ROWS = [
    ["Protein", "Function", "Note"],
    ["Con%crmation" % CODE_FI, "af%cnity" % CODE_FI, "ef%cciency" % CODE_FI],
    ["Di%cusion" % CODE_FF, "p.Val%c600%cGlu" % (CODE_SHY, CODE_SHY), "in%cword" % CODE_SHY],
]
COLS = [80, 230, 400]
Y0 = 700
LEADING = 18


def content_stream() -> bytes:
    out = [b"BT /F1 11 Tf 1 0 0 1 0 0 Tm"]
    for index, row in enumerate(ROWS):
        y = Y0 - index * LEADING
        for col, cell in zip(COLS, row):
            out.append(b"1 0 0 1 %d %d Tm (%s) Tj" % (col, y, cell.encode("latin-1")))
    out.append(b"ET")
    return b"\n".join(out)


def to_unicode() -> bytes:
    pairs = [(CODE_FI, FB01), (CODE_FF, FB00), (CODE_SHY, SHY)]
    bfchar = "\n".join(
        "<%02X> <%04X>" % (code, uni) for code, uni in pairs
    )
    return (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
        "%d beginbfchar\n%s\nendbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
        % (len(pairs), bfchar)
    ).encode("latin-1")


def build_pdf(path: str) -> None:
    stream = content_stream()
    cmap = to_unicode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding "
        b"/ToUnicode 6 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(cmap), cmap),
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref_at = len(pdf)
    pdf += b"xref\n0 %d\n" % (len(objects) + 1)
    pdf += b"0000000000 65535 f \n"
    for offset in offsets:
        pdf += b"%010d 00000 n \n" % offset
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref_at,
    )
    with open(path, "wb") as handle:
        handle.write(bytes(pdf))
    print("wrote", path, len(pdf), "bytes")


if __name__ == "__main__":
    build_pdf(OUT)
