#!/usr/bin/env python3
"""Stdlib-only tests for the omics preview kernel (run: python3 test_kernel.py)."""

from __future__ import annotations

import gzip
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kernel import (  # noqa: E402
    DEFAULT_MAX_VARIANTS,
    SCHEMA_VERSION,
    build_manifest,
    detect_format,
    main,
)

VCF_BODY = """##fileformat=VCFv4.2
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
chr1\t100\t.\tA\tG\t.\t.\t.
chr1\t200\t.\tC\tT\t.\t.\t.
chr1\t300\t.\tG\tA\t.\t.\t.
chr2\t50\t.\tT\tC\t.\t.\t.
chr2\t90\t.\tA\tT\t.\t.\t.
"""


class FormatDetectionTest(unittest.TestCase):
    def test_extensions(self) -> None:
        self.assertEqual(detect_format("pbmc.h5ad"), "h5ad")
        self.assertEqual(detect_format("cohort.vcf"), "vcf")
        self.assertEqual(detect_format("cohort.vcf.gz"), "vcf-gz")
        self.assertEqual(detect_format("cohort.vcf.bgz"), "vcf-gz")
        self.assertEqual(detect_format("notes.txt"), "unknown")


class VcfPreviewTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.plain = os.path.join(self.tmp.name, "cohort.vcf")
        self.gzipped = os.path.join(self.tmp.name, "cohort.vcf.gz")
        with open(self.plain, "w", encoding="utf-8") as handle:
            handle.write(VCF_BODY)
        with gzip.open(self.gzipped, "wt", encoding="utf-8") as handle:
            handle.write(VCF_BODY)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_full_scan_counts_every_variant_and_is_not_a_subset(self) -> None:
        manifest = build_manifest(self.plain, full_scan=True)
        self.assertEqual(manifest["variantCount"], 5)
        self.assertFalse(manifest["subset"]["applied"])
        self.assertFalse(manifest["fullRunRequired"])
        self.assertEqual(manifest["schemaVersion"], SCHEMA_VERSION)

    def test_bounded_scan_is_labelled_as_a_lower_bound_subset(self) -> None:
        manifest = build_manifest(self.plain, max_variants=2)
        self.assertEqual(manifest["variantCount"], 2)
        self.assertTrue(manifest["subset"]["applied"])
        self.assertTrue(manifest["fullRunRequired"])
        self.assertTrue(any("lower bound" in note for note in manifest["notes"]))

    def test_gzip_variants_are_read_without_third_party_deps(self) -> None:
        manifest = build_manifest(self.gzipped, full_scan=True)
        self.assertEqual(manifest["format"], "vcf-gz")
        self.assertEqual(manifest["variantCount"], 5)

    def test_default_max_variants_leaves_small_files_untruncated(self) -> None:
        manifest = build_manifest(self.plain)
        self.assertEqual(manifest["variantCount"], 5)
        self.assertFalse(manifest["subset"]["applied"])
        self.assertGreater(DEFAULT_MAX_VARIANTS, 5)


class UnknownAndH5adTest(unittest.TestCase):
    def test_unknown_format_reports_no_structure_and_requires_full_run(self) -> None:
        manifest = build_manifest("mystery.bin")
        self.assertEqual(manifest["format"], "unknown")
        self.assertTrue(manifest["fullRunRequired"])
        self.assertTrue(any("unrecognized" in note for note in manifest["notes"]))

    def test_h5ad_without_optional_deps_is_honest_about_structure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pbmc.h5ad")
            with open(path, "wb") as handle:
                handle.write(b"not-really-hdf5")
            manifest = build_manifest(path, subset_cells=2000)
        self.assertEqual(manifest["format"], "h5ad")
        self.assertTrue(manifest["fullRunRequired"])
        # Either anndata/h5py parsed nothing (dependency note) or it failed to parse: never a guessed count.
        self.assertNotIn("nObs", manifest)
        self.assertTrue(manifest["notes"])


class CliTest(unittest.TestCase):
    def test_cli_writes_manifest_and_reports_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "cohort.vcf")
            target = os.path.join(tmp, "preview.json")
            with open(source, "w", encoding="utf-8") as handle:
                handle.write(VCF_BODY)
            self.assertEqual(main(["--input", source, "--full-scan", "--out", target]), 0)
            with open(target, encoding="utf-8") as handle:
                manifest = json.load(handle)
            self.assertEqual(manifest["variantCount"], 5)
            self.assertEqual(main(["--input", os.path.join(tmp, "missing.vcf")]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
