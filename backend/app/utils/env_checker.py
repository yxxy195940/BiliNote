import subprocess
from typing import Optional

# WSL 里的 nvidia-smi 通常在 /usr/lib/wsl/lib 下，而 systemd 服务的 PATH 里没有这个目录，
# 所以这里把候选路径都列出来，逐个尝试。
_NVIDIA_SMI_CANDIDATES = (
    "nvidia-smi",
    "/usr/lib/wsl/lib/nvidia-smi",
    "/usr/bin/nvidia-smi",
    "/usr/local/bin/nvidia-smi",
)


def _run_nvidia_smi(*args: str) -> Optional[str]:
    """执行 nvidia-smi 并返回 stdout，任何失败都返回 None（绝不抛异常）。"""
    for exe in _NVIDIA_SMI_CANDIDATES:
        try:
            result = subprocess.run(
                [exe, *args],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except FileNotFoundError:
            continue
        except Exception:
            return None
        output = (result.stdout or "").strip()
        if result.returncode == 0 and output:
            return output
    return None


def is_cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


def is_torch_installed() -> bool:
    try:
        import torch
        return True
    except ImportError:
        return False


def get_gpu_name() -> Optional[str]:
    """不依赖 torch 获取显卡型号，取不到返回 None。"""
    output = _run_nvidia_smi("--query-gpu=name", "--format=csv,noheader")
    if not output:
        return None
    names = [line.strip() for line in output.splitlines() if line.strip()]
    return names[0] if names else None


def get_cuda_version() -> Optional[str]:
    """从 nvidia-smi 的输出里解析驱动支持的 CUDA 版本，取不到返回 None。

    不同平台输出格式不一样：Linux 上通常是 `CUDA Version: 12.4`，
    Windows / WSL 上则是 `CUDA UMD Version: 13.4`，两种都要兼容。
    """
    output = _run_nvidia_smi()
    if not output:
        return None
    for marker in ("CUDA UMD Version:", "CUDA Version:"):
        for line in output.splitlines():
            if marker in line:
                value = line.split(marker, 1)[1].strip().split()[0]
                if value:
                    return value
    return None
