---
name: bionexus-spatial-transcriptomics
description: 空间转录组学分析（squidpy）：组织图像、邻域富集、共定位与空间模式检测。
---

# Spatial transcriptomics gold chain (squidpy)

Default path is **squidpy**, not the legacy fused-graph / NNLS helpers.

```bash
python scripts/doctor.py   # need ready.spatial_ready
python skills/spatial-transcriptomics/scripts/spatial_inspect.py visium.h5ad
python skills/spatial-transcriptomics/scripts/spatial_pipeline.py visium.h5ad -o spatial_out.h5ad
python skills/spatial-transcriptomics/scripts/spatial_plot.py spatial_out.h5ad -o figures/ --color leiden
# SpatialData with several tables:
python skills/spatial-transcriptomics/scripts/spatial_inspect.py data.zarr --table table_name
```

Accepts SpatialData `.zarr` (requires `spatialdata`) or `.h5ad` with `obsm['spatial']`. Multiple tables **refuse** unless `--table` is set.

| Step | Script | Backend |
|---|---|---|
| inspect | `spatial_inspect.py` | AnnData / SpatialData I/O |
| pipeline | `spatial_pipeline.py` | `spatial_neighbors_knn` + Moran |
| plot | `spatial_plot.py` | `squidpy.pl.spatial_scatter` → `spatial_{color}.png` |

**Refuses** if squidpy is missing. No silent local-Moran substitute on this path.

Legacy grade-C scripts stay in-tree. They are not Cell2location / BayesSpace / COMMOT.
