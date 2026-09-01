---
name: llamacpp-local-server
description: 用 llama.cpp 的 llama-server 在本地托管一个 OpenAI 兼容的推理端点，并通过 managed endpoints（endpoint_register/start/status）把它的生命周期交给 PureScience 守护。用于本地运行 GGUF 模型（如 Qwen、Llama、DeepSeek 蒸馏、ESM 类小模型）、离线推理、或需要把模型留在本机的隐私场景。
license: MIT
category: local-models
requirements: []
metadata:
  display-name: llama.cpp 本地模型服务
  third_party:
    - kind: software
      name: llama.cpp
      provider: ggml-org
      license: MIT
      terms_url: https://github.com/ggml-org/llama.cpp/blob/master/LICENSE
---

# llama.cpp 本地模型服务（managed endpoint runbook）

本 runbook 教你把一个本地 llama-server 注册为 PureScience 的 **managed endpoint**：
注册一次，之后所有调用都自动经过「启动 → 就绪探测 → 放行」生命周期，无需手动管理进程。

## 1. 准备工作

- 安装 llama.cpp（任一方式，二选一）：
  - Homebrew：`brew install llama.cpp`
  - 源码：`git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && make -j8`
- 下载一个 GGUF 模型（HuggingFace，如 `Qwen/Qwen2.5-7B-Instruct-GGUF` 的 `q4_k_m` 量化）：
  `huggingface-cli download Qwen/Qwen2.5-7B-Instruct-GGUF --include "*q4_k_m*" --local-dir ~/models/qwen25-7b`
- 验证 `llama-server --version` 可运行。

## 2. 注册端点（agent 侧）

用 endpoint_* 工具注册。先分配端口，再注册：

```
1. port = endpoint_free_port()            → 例如 20001
2. endpoint_register(
     name="llama-qwen25",
     url="http://127.0.0.1:20001",
     skill_name="llamacpp-local-server",
     start=<下方 start 脚本>,
     stop=<下方 stop 脚本>,
     live="/v1/models"
   )
3. endpoint_start(name="llama-qwen25")    → 轮询就绪后 state=live
4. 调用推理（OpenAI 兼容格式，见 §4）
```

首次注册会要求用户批准脚本（设置 → 本地模型 → 批准）。批准后字节相同的重新注册静默通过。

### start 脚本（幂等）

```bash
#!/bin/bash
# 幂等：已在跑就直接返回 0；否则后台拉起 llama-server。
if curl -sf "http://127.0.0.1:${HOST_PORT}/v1/models" >/dev/null 2>&1; then
  exit 0
fi
nohup llama-server \
  -m "${SERVICE_DIR}/model.gguf" \
  --host 127.0.0.1 --port "${HOST_PORT}" \
  -c 8192 --parallel 1 \
  > "${SERVICE_DIR}/llama-server.log" 2>&1 &
# 记录 PID 以便 stop 脚本定位
echo $! > "${SERVICE_DIR}/llama-server.pid"
exit 0
```

> 提示：`SERVICE_DIR` 是端点专属目录（数据根目录下 `.endpoints/<name>/`），模型软链或缓存放这里：
> `ln -sf ~/models/qwen25-7b/qwen2.5-7b-instruct-q4_k_m.gguf "${SERVICE_DIR}/model.gguf"`

### stop 脚本

```bash
#!/bin/bash
if [ -f "${SERVICE_DIR}/llama-server.pid" ]; then
  kill "$(cat "${SERVICE_DIR}/llama-server.pid")" 2>/dev/null
  rm -f "${SERVICE_DIR}/llama-server.pid"
fi
# 确保端口释放
for i in 1 2 3 4 5; do
  if ! curl -sf "http://127.0.0.1:${HOST_PORT}/v1/models" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
exit 1  # 5 秒内没停干净 → 非零退出（manager 会记录失败）
```

## 3. 生命周期语义

| 状态 | 含义 | 触发 |
|---|---|---|
| stopped | 未运行 | 注册后 / stop 后 |
| starting | start 脚本已跑，探测中 | start |
| live | 就绪路由（/v1/models）返回 200 | 探测成功 |
| failed | start 失败或 120 秒内未就绪 | 失败；stop 脚本会被跑一遍清理 |

- `endpoint_start` 对 live 端点幂等（no-op）。
- 连跑失败的端点进入 failed，读 `last_error` 修正后再 start。
- 端点全局共享：任何会话的 agent 都能 `endpoint_status` 查看、`endpoint_start` 启动。

## 4. 调用推理（OpenAI 兼容）

端点就绪后，直接对 URL 发 OpenAI 格式请求（本地端点无需 auth header）：

```bash
curl http://127.0.0.1:20001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "解释一下 CRISPR-Cas9 的工作原理"}],
    "temperature": 0.2
  }'
```

Python 侧（notebook / agent 脚本）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20001/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="local",
    messages=[{"role": "user", "content": "..."}],
)
print(resp.choices[0].message.content)
```

## 5. 注意事项

- **端口**：必须用 `endpoint_free_port()` 分配（20000-29999 托管区间），不要手写。
- **URL**：必须是字面量 `127.0.0.1`；`localhost` 会被拒绝（rootless 容器场景会解析成 ::1）。
- **模型文件**：GGUF 体积大，用软链放 `SERVICE_DIR`，避免 start 脚本里下载。
- **凭据**：若模型服务需要密钥（如某些网关），在 start 脚本里读 `CREDENTIAL_VALUE` 环境变量（由设置里已保存的凭据注入），永远不要写死在脚本里。
- **GPU**：`llama-server` 默认用 Metal/CUDA（若编译时启用）；CPU 也能跑，慢一些。
