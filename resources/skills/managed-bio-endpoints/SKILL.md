---
name: managed-bio-endpoints
description: 把生物模型（ESM-2 嵌入、ESMFold2/ColabFold 结构预测、scGPT 单细胞、Evo2 基因组等）封装为本地推理服务并注册为 PureScience 的 managed endpoint。覆盖通用托管模式（FastAPI/llama.cpp 风格包装 + 幂等启停 + 就绪路由 + 缓存挂载），附 fair-esm2 轻量示例与 esmfold2 GPU 示例。用于把模型留在本机、离线推理、或复用 NIM 式本地部署。
license: Apache-2.0
category: local-models
requirements: []
metadata:
  display-name: 生物模型本地托管
  third_party:
    - kind: weights
      name: ESM-2 / ESMFold2 / scGPT / Evo2（示例模型）
      provider: Meta AI / Biohub / 学术团队
      license: 各模型 MIT/Apache-2.0（详见对应 skill 的 third_party 声明）
      terms_url: https://github.com/facebookresearch/esm
---

# 生物模型本地托管（managed endpoint runbook）

把生物模型包成 OpenAI 风格（或自定义）的本地 HTTP 服务，注册为 managed
endpoint：注册一次，生命周期（启动 → 就绪探测 → 放行 → 停止）全部交给
PureScience 守护进程。**通用模式**适用于任何模型——按 §1 包装，按 §2 注册，
按 §3 调用。

## 1. 通用托管模式

任何生物模型 → 本地服务的三步包装：

```bash
# 1) 模型装进端点专属目录（SERVICE_DIR 由守护注入）
#    - 权重缓存挂这里（幂等：已存在不重复下载）
#    - 例：ESM-2 → 2.5GB 权重；ESMFold2 → 1.36GB；scGPT → ~1GB
ln -sf ~/models/esm2_t33_650M_UR50D.pt "${SERVICE_DIR}/weights.pt"
```

```python
# 2) 服务脚本（FastAPI 例：POST /v1/embed 返回嵌入；GET /health/ready 探活）
#    存为 ${SERVICE_DIR}/serve.py —— start 脚本里 python serve.py 拉起
from fastapi import FastAPI
from pydantic import BaseModel
import torch, esm

app = FastAPI()
model, alphabet = esm.pretrained.esm2_t33_650M_UR50D()
model.eval()
if torch.cuda.is_available():
    model = model.cuda()

class Req(BaseModel):
    sequences: list[str]

@app.get("/health/ready")
async def ready():
    return {"ok": True}

@app.post("/v1/embed")
async def embed(req: Req):
    batch = [(s, None) for s in req.sequences]
    _, _, tokens = alphabet.get_batch_converter()(batch)
    with torch.no_grad():
        out = model(tokens, repr_layers=[33], return_contacts=False)
    return {"embeddings": out["representations"][33].tolist()}
```

```bash
# 3) start 脚本（幂等：已就绪直接退出 0）
if curl -sf "http://127.0.0.1:${HOST_PORT}/health/ready" >/dev/null 2>&1; then
  exit 0
fi
nohup "${SERVICE_DIR}/venv/bin/python" "${SERVICE_DIR}/serve.py" \
  --port "${HOST_PORT}" > "${SERVICE_DIR}/serve.log" 2>&1 &
echo $! > "${SERVICE_DIR}/serve.pid"
exit 0
```

```bash
# stop 脚本（等端口释放，超时非零让守护记失败）
[ -f "${SERVICE_DIR}/serve.pid" ] && kill "$(cat "${SERVICE_DIR}/serve.pid")" 2>/dev/null
for i in 1 2 3 4 5; do
  curl -sf "http://127.0.0.1:${HOST_PORT}/health/ready" >/dev/null 2>&1 || exit 0
  sleep 1
done
exit 1
```

## 2. 注册（agent 侧，endpoint_* 工具）

```
1. port = endpoint_free_port()
2. endpoint_register(
     name="esm2-embed",
     url="http://127.0.0.1:20001",      # 必须字面量 127.0.0.1
     skill_name="managed-bio-endpoints",
     start=<§1 start 脚本>, stop=<§1 stop 脚本>, live="/health/ready")
3. endpoint_start(name="esm2-embed")    # 守护轮询就绪，120s 超时
4. 调用推理（§3）
```

首次注册需用户在设置 → 本地模型面板批准脚本（sha256 白名单）。

## 3. 调用

```python
import requests
r = requests.post("http://127.0.0.1:20001/v1/embed",
                  json={"sequences": ["MKTAYIAKQRQISFVKSHFSRQDILDLWII"]})
emb = r.json()["embeddings"][0]   # 650M 模型 → 1280 维
```

## 4. worked example：ESMFold2（GPU 工作站）

ESMFold2 是重型扩散共折叠模型（H100/A100 级）。**有 GPU 工作站**时按
esmfold2 skill 的安装配方建 venv（Python 3.12、`set_kernel_backend('fused')`），
把 ColabFold/本地推理脚本包成上面的 FastAPI 服务，注册 endpoint 托管。
**没有本地 GPU** 时不要托管——直接用 esmfold2 skill 的远程 compute
（Modal）提交，效果相同且不占本地资源。

## 5. 注意事项

- **依赖装进 SERVICE_DIR 的 venv**，不要装进系统 python（幂等重建容易）。
- **权重用软链**指向共享缓存目录（多端点复用，避免重复下载）。
- **批大小/并行**按 GPU 显存调：ESM-2 650M 约 2.5GB 权重 + 激活；ESMFold2 需 ~40GB 显存。
- **凭据**：NIM 风格网关要密钥时在 start 脚本读 `CREDENTIAL_VALUE`，别写死。
- 模型权重许可各不相同：ESM-2/ESMFold2 MIT，scGPT 学术许可，Evo2 Apache-2.0——发布前查对应 skill 的 third_party 声明。
