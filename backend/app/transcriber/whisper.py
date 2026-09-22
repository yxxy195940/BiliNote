from faster_whisper import WhisperModel

from app.decorators.timeit import timeit
from app.models.transcriber_model import TranscriptSegment, TranscriptResult
from app.transcriber.base import Transcriber
from app.utils.logger import get_logger
from app.utils.nvidia_libs import is_gpu_acceleration_ready
from app.utils.path_helper import get_model_dir

from events import transcription_finished
from pathlib import Path
import os
from tqdm import tqdm
from modelscope import snapshot_download


'''
 Size of the model to use (tiny, tiny.en, base, base.en, small, small.en, distil-small.en, medium, medium.en, distil-medium.en, large-v1, large-v2, large-v3, large, distil-large-v2, distil-large-v3, large-v3-turbo, or turbo
'''
logger=get_logger(__name__)

MODEL_MAP={
    "tiny": "pengzhendong/faster-whisper-tiny",
    'base':'pengzhendong/faster-whisper-base',
    'small':'pengzhendong/faster-whisper-small',
    'medium':'pengzhendong/faster-whisper-medium',
    'large-v1':'pengzhendong/faster-whisper-large-v1',
    'large-v2':'pengzhendong/faster-whisper-large-v2',
    'large-v3':'pengzhendong/faster-whisper-large-v3',
    'large-v3-turbo':'pengzhendong/faster-whisper-large-v3-turbo',
}

class WhisperTranscriber(Transcriber):
    # TODO:修改为可配置
    def __init__(
            self,
            model_size: str = "base",
            device: str = 'cpu',
            compute_type: str = None,
            cpu_threads: int = 1,
    ):
        if device == 'cpu' or device is None:
            self.device = 'cpu'
        else:
            self.device = "cuda" if self.is_cuda() else "cpu"
            if device == 'cuda' and self.device == 'cpu':
                print('没有 cuda 使用 cpu进行计算')

        self.compute_type = compute_type or ("float16" if self.device == "cuda" else "int8")

        model_dir = get_model_dir("whisper")
        model_path = os.path.join(model_dir, f"whisper-{model_size}")
        if not Path(model_path).exists():
            logger.info(f"模型 whisper-{model_size} 不存在，开始下载...")
            repo_id = MODEL_MAP[model_size]
            model_path = snapshot_download(
                repo_id,

                local_dir=model_path,
            )
            logger.info("模型下载完成")

        try:
            self.model = WhisperModel(
                model_size_or_path=model_path,
                device=self.device,
                compute_type=self.compute_type,
                download_root=model_dir
            )
        except Exception as exc:
            # 显卡环境不完整（缺 cuDNN、显存不足、驱动不匹配等）时不能让整个笔记生成失败，
            # 直接降级到 CPU + int8 继续跑。
            if self.device != "cuda":
                raise
            logger.warning(f"GPU 转写初始化失败，自动回退到 CPU：{exc}")
            self.device = "cpu"
            self.compute_type = "int8"
            self.model = WhisperModel(
                model_size_or_path=model_path,
                device=self.device,
                compute_type=self.compute_type,
                download_root=model_dir
            )
    @staticmethod
    def is_cuda() -> bool:
        """能否真正用 GPU 跑转写。

        这里不看 torch（项目没装），而是直接检查 CTranslate2 + NVIDIA 加速库：
        库加载失败、检测不到显卡、显存不可用时都返回 False，由调用方退回 CPU。
        """
        try:
            if is_gpu_acceleration_ready():
                print(" CUDA 可用，使用 GPU")
                return True
            print(" 未检测到可用的 CUDA 加速环境，使用 CPU")
            return False
        except Exception as exc:
            print(f" CUDA 检测异常，使用 CPU：{exc}")
            return False

    @timeit
    def transcript(self, file_path: str) -> TranscriptResult:
        try:

            segments_raw, info = self.model.transcribe(file_path)

            segments = []
            full_text = ""

            for seg in segments_raw:
                text = seg.text.strip()
                full_text += text + " "
                segments.append(TranscriptSegment(
                    start=seg.start,
                    end=seg.end,
                    text=text
                ))

            result= TranscriptResult(
                language=info.language,
                full_text=full_text.strip(),
                segments=segments,
                raw=info
            )
            # self.on_finish(file_path, result)
            return result
        except Exception as e:
            print(f"转写失败：{e}")


    def on_finish(self,video_path:str,result: TranscriptResult)->None:
        print("转写完成")
        transcription_finished.send({
            "file_path": video_path,
        })
