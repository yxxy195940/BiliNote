"""NVIDIA 加速库（cuDNN / cuBLAS / NVRTC）的加载与自检。

faster-whisper 底层的 CTranslate2 在 GPU 模式下会按名字加载 `libcudnn*.so.9`、
`libcublas.so.12` 等库。这些库通过 PyPI 的 `nvidia-cudnn-cu12` / `nvidia-cublas-cu12`
包安装进项目自己的 venv，不在系统动态链接器搜索路径里，所以需要手动预加载。

这里不修改系统环境，也不依赖 torch：只要能加载成功就启用 GPU，任何环节失败都
返回 CPU，保证转写不会因为显卡环境问题而报错。
"""

from __future__ import annotations

import ctypes
import importlib.util
import os
from typing import List, Optional, Tuple

from app.utils.logger import get_logger

logger = get_logger(__name__)

# 预加载顺序有依赖：cuBLAS / NVRTC 在前，cuDNN 主体按 主库 -> 子库 排列。
# (包名, 相对 lib 目录, 库文件名)
_LIBRARIES: Tuple[Tuple[str, str, str], ...] = (
    ("nvidia.cublas", "lib", "libcublasLt.so.12"),
    ("nvidia.cublas", "lib", "libcublas.so.12"),
    ("nvidia.cuda_nvrtc", "lib", "libnvrtc.so.12"),
    ("nvidia.cudnn", "lib", "libcudnn.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_graph.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_ops.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_adv.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_cnn.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_heuristic.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_engines_precompiled.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_engines_runtime_compiled.so.9"),
    ("nvidia.cudnn", "lib", "libcudnn_ext.so.9"),
)

_preload_attempted = False
_loaded_libraries: List[str] = []
_load_error: Optional[str] = None


def _package_lib_dir(package: str, lib_subdir: str) -> Optional[str]:
    """返回 nvidia 子包里 lib 目录的绝对路径，找不到返回 None。"""
    try:
        spec = importlib.util.find_spec(package)
    except (ImportError, ValueError):
        return None
    if spec is None or not spec.submodule_search_locations:
        return None
    base = list(spec.submodule_search_locations)[0]
    path = os.path.join(base, *lib_subdir.split("/"))
    return path if os.path.isdir(path) else None


def preload_nvidia_libraries() -> bool:
    """把 venv 里的 NVIDIA 库以 RTLD_GLOBAL 方式预加载。

    返回 True 表示所有已知库都加载成功；False 表示有缺失或加载失败。
    该函数可重复调用，只有第一次会真正执行加载。
    """
    global _preload_attempted, _load_error
    if _preload_attempted:
        return not _load_error

    _preload_attempted = True
    missing: List[str] = []

    for package, lib_subdir, filename in _LIBRARIES:
        lib_dir = _package_lib_dir(package, lib_subdir)
        if not lib_dir:
            missing.append(f"{package}:{filename}")
            continue
        path = os.path.join(lib_dir, filename)
        if not os.path.exists(path):
            missing.append(filename)
            continue
        try:
            ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
            _loaded_libraries.append(filename)
        except OSError as exc:
            missing.append(f"{filename}({exc})")

    if missing:
        _load_error = ", ".join(missing)
        logger.warning("NVIDIA 加速库加载不完整，将使用 CPU：%s", _load_error)
        return False

    logger.info("NVIDIA 加速库已加载：%s", ", ".join(_loaded_libraries))
    return True


def is_gpu_acceleration_ready() -> bool:
    """判断当前环境能否用 GPU 转写。

    依次检查：库能被加载 -> CTranslate2 能看到 CUDA 设备 -> 设备上能建立
    float16 推理。任何一步失败都返回 False（调用方回退 CPU）。
    """
    if not preload_nvidia_libraries():
        return False

    try:
        import ctranslate2
    except ImportError as exc:
        logger.warning("CTranslate2 不可用，使用 CPU：%s", exc)
        return False

    try:
        if ctranslate2.get_cuda_device_count() < 1:
            logger.info("未检测到可用的 CUDA 设备，使用 CPU")
            return False
    except Exception as exc:
        logger.warning("CUDA 设备检测失败，使用 CPU：%s", exc)
        return False

    try:
        supported = ctranslate2.get_supported_compute_types("cuda")
    except Exception as exc:
        logger.warning("CUDA 计算类型查询失败，使用 CPU：%s", exc)
        return False

    if "float16" not in supported:
        logger.warning("CUDA 不支持 float16（%s），使用 CPU", sorted(supported))
        return False

    return True


def get_acceleration_status() -> dict:
    """给监控页面用的只读状态，不抛异常。"""
    ready = is_gpu_acceleration_ready()
    return {
        "acceleration_ready": ready,
        "loaded_libraries": list(_loaded_libraries),
        "load_error": _load_error,
    }
