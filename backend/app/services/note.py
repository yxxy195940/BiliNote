import json
import logging
import os
import re
from dataclasses import asdict
from pathlib import Path
from typing import List, Optional, Tuple, Union, Any

from fastapi import HTTPException
from pydantic import HttpUrl
from dotenv import load_dotenv

from app.downloaders.base import Downloader
from app.downloaders.bilibili_downloader import BilibiliDownloader
from app.downloaders.douyin_downloader import DouyinDownloader
from app.downloaders.local_downloader import LocalDownloader
from app.downloaders.youtube_downloader import YoutubeDownloader
from app.db.video_task_dao import delete_task_by_video, insert_video_task
from app.enmus.exception import NoteErrorEnum, ProviderErrorEnum
from app.enmus.task_status_enums import TaskStatus
from app.enmus.note_enums import DownloadQuality
from app.exceptions.note import NoteError
from app.exceptions.provider import ProviderError
from app.gpt.base import GPT
from app.gpt.gpt_factory import GPTFactory
from app.models.audio_model import AudioDownloadResult
from app.models.gpt_model import GPTSource
from app.models.model_config import ModelConfig
from app.models.notes_model import AudioDownloadResult, NoteResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services.constant import SUPPORT_PLATFORM_MAP
from app.services.provider import ProviderService
from app.transcriber.base import Transcriber
from app.transcriber.transcriber_provider import get_transcriber, _transcribers
from app.utils.note_helper import replace_content_markers, prepend_source_link
from app.utils.screenshot_marker import extract_screenshot_timestamps
from app.utils.status_code import StatusCode
from app.utils.video_helper import generate_screenshot

# ------------------ 环境变量与全局配置 ------------------

# 从 .env 文件中加载环境变量
load_dotenv()

# 后端 API 地址与端口（若有需要可以在代码其他部分使用 BACKEND_BASE_URL）
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost")
BACKEND_PORT = os.getenv("BACKEND_PORT", "8483")
BACKEND_BASE_URL = f"{API_BASE_URL}:{BACKEND_PORT}"

# 输出目录（用于缓存音频、转写、Markdown 文件，以及存储截图）
NOTE_OUTPUT_DIR = Path(os.getenv("NOTE_OUTPUT_DIR", "note_results"))
NOTE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_OUTPUT_DIR = os.getenv("OUT_DIR", "./static/screenshots")
# 图片基础 URL（用于生成 Markdown 中的图片链接，需前端静态目录对应）
IMAGE_BASE_URL = os.getenv("IMAGE_BASE_URL", "/static/screenshots")

# 日志配置
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


class NoteGenerator:
    """
    NoteGenerator 用于执行视频/音频下载、转写、GPT 生成笔记、插入截图/链接、
    以及将任务信息写入状态文件与数据库等功能。
    """

    def __init__(self):
        from app.services.transcriber_config_manager import TranscriberConfigManager
        config_manager = TranscriberConfigManager()
        self.model_size: str = config_manager.get_whisper_model_size()
        self.device: Optional[str] = None
        self.transcriber_type: str = config_manager.get_transcriber_type()
        self.transcriber: Transcriber = self._init_transcriber()
        self.video_path: Optional[Path] = None
        self.video_img_urls=[]
        # 最近一次进入的处理阶段，失败时用来定位卡在哪一环
        self._current_phase: Optional[TaskStatus] = None
        logger.info("NoteGenerator 初始化完成")


    # ---------------- 公有方法 ----------------

    def generate(
        self,
        video_url: Union[str, HttpUrl],
        platform: str,
        quality: DownloadQuality = DownloadQuality.medium,
        task_id: Optional[str] = None,
        model_name: Optional[str] = None,
        provider_id: Optional[str] = None,
        link: bool = False,
        screenshot: bool = False,
        _format: Optional[List[str]] = None,
        style: Optional[str] = None,
        extras: Optional[str] = None,
        output_path: Optional[str] = None,
        video_understanding: bool = False,
        video_interval: int = 0,
        grid_size: Optional[List[int]] = None,
        transcript_only: bool = False,
    ) -> NoteResult | None:
        """
        主流程：按步骤依次下载、转写、GPT 总结、截图/链接处理、存库、返回 NoteResult。

        :param video_url: 视频或音频链接
        :param platform: 平台名称，对应 SUPPORT_PLATFORM_MAP 中的键
        :param quality: 下载音频的质量枚举
        :param task_id: 用于标识本次任务的唯一 ID，亦用于状态文件和缓存文件命名
        :param model_name: GPT 模型名称
        :param provider_id: 模型供应商 ID
        :param link: 是否在笔记中插入视频片段链接
        :param screenshot: 是否在笔记中替换 Screenshot 标记为图片
        :param _format: 包含 'link' 或 'screenshot' 等字符串的列表，决定后续处理
        :param style: GPT 生成笔记的风格
        :param extras: 额外参数，传递给 GPT
        :param output_path: 下载输出目录（可选）
        :param video_understanding: 是否需要视频拼图理解（生成缩略图）
        :param video_interval: 视频帧截取间隔（秒），仅在 video_understanding 为 True 时生效
        :param grid_size: 生成缩略图时的网格大小，如 [3, 3]
        :return: NoteResult 对象，包含 markdown 文本、转写结果和音频元信息
        """
        if grid_size is None:
            grid_size = []

        try:
            logger.info(f"开始生成笔记 (task_id={task_id})")
            self._update_status(task_id, TaskStatus.PARSING)

            # 获取下载器与 GPT 实例

            downloader = self._get_downloader(platform)
            # 仅提取原文时不需要 LLM
            gpt = None if transcript_only else self._get_gpt(model_name, provider_id)

            # 缓存文件路径
            audio_cache_file = NOTE_OUTPUT_DIR / f"{task_id}_audio.json"
            transcript_cache_file = NOTE_OUTPUT_DIR / f"{task_id}_transcript.json"
            markdown_cache_file = NOTE_OUTPUT_DIR / f"{task_id}_markdown.md"
            # 1. 获取字幕/转写：优先缓存 → 平台字幕 → 音频转写
            transcript = None

            # 尝试读取缓存
            if transcript_cache_file.exists():
                logger.info(f"检测到转写缓存 ({transcript_cache_file})，尝试读取")
                try:
                    data = json.loads(transcript_cache_file.read_text(encoding="utf-8"))
                    segments = [TranscriptSegment(**seg) for seg in data.get("segments", [])]
                    transcript = TranscriptResult(
                        language=data.get("language"),
                        full_text=data["full_text"],
                        segments=segments,
                    )
                    logger.info(f"已从缓存加载转写结果，共 {len(segments)} 段")
                except Exception as e:
                    logger.warning(f"加载转写缓存失败: {e}")

            # 缓存没有，尝试获取平台字幕
            if transcript is None:
                logger.info("尝试获取平台字幕（优先于音频下载）...")
                try:
                    transcript = downloader.download_subtitles(video_url)
                    if transcript and transcript.segments:
                        logger.info(f"成功获取平台字幕，共 {len(transcript.segments)} 段")
                        transcript_cache_file.write_text(
                            json.dumps(asdict(transcript), ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
                    else:
                        transcript = None
                        logger.info("平台无可用字幕，将下载音频后转写")
                except Exception as e:
                    logger.warning(f"获取平台字幕失败: {e}，将下载音频后转写")
                    transcript = None

            # 2. 下载音频/视频
            # 有字幕时只提取元信息，不下载音视频文件（除非需要截图）
            # 注：video_understanding（抽帧拼图喂 VLM）已废弃，参数保留仅为兼容旧请求，
            #     截图改为「模型标注时间点 → ffmpeg 按点截帧」，见 _insert_screenshots
            # 截图开关有两个来源：显式 screenshot 布尔，或 format 列表里含 'screenshot'
            # （前端只传 format 数组，所以必须把两者合并判断，否则永远不下视频）
            want_screenshot = bool(screenshot) or "screenshot" in (_format or [])
            has_transcript = transcript is not None
            need_full_download = not has_transcript or want_screenshot
            audio_meta = self._download_media(
                downloader=downloader,
                video_url=video_url,
                quality=quality,
                audio_cache_file=audio_cache_file,
                status_phase=TaskStatus.DOWNLOADING,
                platform=platform,
                output_path=output_path,
                screenshot=want_screenshot,
                video_understanding=video_understanding,
                video_interval=video_interval,
                grid_size=grid_size,
                skip_download=not need_full_download,
            )

            # 3. 如果前面没拿到字幕，走转写流程
            if transcript is None:
                transcript = self._get_transcript(
                    downloader=downloader,
                    video_url=video_url,
                    audio_file=audio_meta.file_path,
                    transcript_cache_file=transcript_cache_file,
                    status_phase=TaskStatus.TRANSCRIBING,
                    task_id=task_id,
                )

            # 3. 生成 Markdown：transcript_only 时跳过 LLM，直接用转写原文
            if transcript_only:
                markdown = self._format_transcript_as_markdown(transcript, audio_meta)
                markdown_cache_file.write_text(markdown, encoding="utf-8")
                logger.info(f"仅提取原文模式，跳过 LLM 总结 ({markdown_cache_file})")
            else:
                # GPT 总结
                markdown = self._summarize_text(
                    audio_meta=audio_meta,
                    transcript=transcript,
                    gpt=gpt,
                    markdown_cache_file=markdown_cache_file,
                    link=link,
                    screenshot=screenshot,
                    formats=_format or [],
                    style=style,
                    extras=extras,
                    video_img_urls=self.video_img_urls,
                )

                # 4. 截图 & 链接替换
                if _format:
                    markdown = self._post_process_markdown(
                        markdown=markdown,
                        video_path=self.video_path,
                        formats=_format,
                        audio_meta=audio_meta,
                        platform=platform,
                    )

            markdown = prepend_source_link(markdown, str(video_url))

            # 5. 保存记录到数据库
            self._update_status(task_id, TaskStatus.SAVING)
            self._save_metadata(video_id=audio_meta.video_id, platform=platform, task_id=task_id, publish_date=audio_meta.publish_date)

            # 6. 完成
            self._update_status(task_id, TaskStatus.SUCCESS)
            logger.info(f"笔记生成成功 (task_id={task_id})")
            return NoteResult(markdown=markdown, transcript=transcript, audio_meta=audio_meta)

        except Exception as exc:
            logger.error(f"生成笔记流程异常 (task_id={task_id})：{exc}", exc_info=True)
            self._update_status(task_id, TaskStatus.FAILED, message=str(exc))
            return None

    def generate_text_note(
        self,
        text_content: str,
        task_id: Optional[str] = None,
        model_name: Optional[str] = None,
        provider_id: Optional[str] = None,
        title: Optional[str] = None,
        style: Optional[str] = None,
        extras: Optional[str] = None,
        transcript_only: bool = False,
    ) -> NoteResult | None:
        """
        文本整理：跳过下载/转写，直接把用户上传的文本交给 LLM 生成结构化笔记。

        复用现有 _get_gpt / _summarize_text / _save_metadata 等能力，
        仅在历史列表中标记为文本整理（platform='text'）。
        """
        try:
            logger.info(f"开始文本整理 (task_id={task_id})")
            self._update_status(task_id, TaskStatus.PARSING)

            gpt = None if transcript_only else self._get_gpt(model_name, provider_id)

            # 把整段文本作为单个 segment，复用现有 LLM 总结与分块逻辑
            text = (text_content or "").strip()
            if not text:
                raise ValueError("文本内容为空")
            segments = [TranscriptSegment(start=0, end=0, text=text)]
            transcript = TranscriptResult(language="zh", full_text=text, segments=segments)

            # 合成音频元信息，保证下游 / 历史列表能拿到标题与平台标识
            lines = [ln for ln in text.splitlines() if ln.strip()]
            resolved_title = (title or "").strip() or (lines[0][:30] if lines else "文本整理")
            audio_meta = AudioDownloadResult(
                file_path="",
                title=resolved_title,
                duration=0,
                cover_url=None,
                platform="text",
                video_id=task_id,
                raw_info={},
            )

            markdown_cache_file = NOTE_OUTPUT_DIR / f"{task_id}_markdown.md"

            if transcript_only:
                markdown = self._format_transcript_as_markdown(transcript, audio_meta)
                markdown_cache_file.write_text(markdown, encoding="utf-8")
                logger.info(f"仅提取原文（文本）模式，跳过 LLM 总结 ({markdown_cache_file})")
            else:
                markdown = self._summarize_text(
                    audio_meta=audio_meta,
                    transcript=transcript,
                    gpt=gpt,
                    markdown_cache_file=markdown_cache_file,
                    link=False,
                    screenshot=False,
                    formats=[],
                    style=style,
                    extras=extras,
                    video_img_urls=[],
                )

            # 保存记录到数据库
            self._update_status(task_id, TaskStatus.SAVING)
            self._save_metadata(video_id=task_id, platform="text", task_id=task_id)

            self._update_status(task_id, TaskStatus.SUCCESS)
            logger.info(f"文本整理成功 (task_id={task_id})")
            return NoteResult(markdown=markdown, transcript=transcript, audio_meta=audio_meta)

        except Exception as exc:
            logger.error(f"文本整理流程异常 (task_id={task_id})：{exc}", exc_info=True)
            self._update_status(task_id, TaskStatus.FAILED, message=str(exc))
            return None

    @staticmethod
    def delete_note(video_id: str, platform: str) -> int:
        """
        删除数据库中对应 video_id 与 platform 的任务记录

        :param video_id: 视频 ID
        :param platform: 平台标识
        :return: 删除的记录数
        """
        logger.info(f"删除笔记记录 (video_id={video_id}, platform={platform})")
        return delete_task_by_video(video_id, platform)

    # ---------------- 私有方法 ----------------

    def _init_transcriber(self) -> Transcriber:
        """
        根据环境变量 TRANSCRIBER_TYPE 动态获取并实例化转写器
        """
        if self.transcriber_type not in _transcribers:
            logger.error(f"未找到支持的转写器：{self.transcriber_type}")
            raise Exception(f"不支持的转写器：{self.transcriber_type}")

        logger.info(f"使用转写器：{self.transcriber_type}")
        return get_transcriber(transcriber_type=self.transcriber_type, model_size=self.model_size)

    def _get_gpt(self, model_name: Optional[str], provider_id: Optional[str]) -> GPT:
        """
        根据 provider_id 获取对应的 GPT 实例
        :param model_name: GPT 模型名称
        :param provider_id: 供应商 ID
        :return: GPT 实例
        """
        provider = ProviderService.get_provider_by_id(provider_id)
        if not provider:
            logger.error(f"[get_gpt] 未找到模型供应商: provider_id={provider_id}")
            raise ProviderError(code=ProviderErrorEnum.NOT_FOUND,message=ProviderErrorEnum.NOT_FOUND.message)
        logger.info(f"创建 GPT 实例 {provider_id}")
        config = ModelConfig(
            api_key=provider["api_key"],
            base_url=provider["base_url"],
            model_name=model_name,
            provider=provider["type"],
            name=provider["name"],
        )
        return GPTFactory().from_config(config)

    def _get_downloader(self, platform: str) -> Downloader:
        """
        根据平台名称获取对应的下载器实例

        :param platform: 平台标识，需在 SUPPORT_PLATFORM_MAP 中
        :return: 对应的 Downloader 子类实例
        """
        downloader_cls = SUPPORT_PLATFORM_MAP.get(platform)
        logger.debug(f"实例化下载器 -  {platform}")
        instance = None
        if not downloader_cls:
            logger.error(f"不支持的平台：{platform}")
            raise NoteError(code=NoteErrorEnum.PLATFORM_NOT_SUPPORTED.code,
                            message=NoteErrorEnum.PLATFORM_NOT_SUPPORTED.message)
        try:
            instance = downloader_cls
        except Exception as e:
            logger.error(f"实例化下载器失败：{e}")


        logger.info(f"使用下载器：{downloader_cls.__class__}")
        return instance

    def _update_status(self, task_id: Optional[str], status: Union[str, TaskStatus], message: Optional[str] = None):
        """
        创建或更新 {task_id}.status.json，记录当前任务状态

        :param task_id: 任务唯一 ID
        :param status: TaskStatus 枚举或自定义状态字符串
        :param message: 可选消息，用于记录失败原因等
        """
        if not task_id:
            return

        NOTE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        status_file = NOTE_OUTPUT_DIR / f"{task_id}.status.json"
        print(f"写入状态文件: {status_file} 当前状态: {status}")

        # 记录/消费当前阶段：失败时把出错阶段一并落盘，前端据此提示卡在哪一环
        phase = self._current_phase
        if isinstance(status, TaskStatus):
            if status is TaskStatus.SUCCESS:
                self._current_phase = None
            elif status is TaskStatus.FAILED:
                # 失败可能被写多次（_handle_exception + generate 的 except），
                # 这里保留阶段，避免后一次写入把出错阶段冲成空
                pass
            else:
                self._current_phase = status
                phase = status
        else:
            phase = None

        data = {"status": status.value if isinstance(status, TaskStatus) else status}
        if message:
            data["message"] = message
        if isinstance(status, TaskStatus) and status is TaskStatus.FAILED and phase is not None:
            data["phase"] = phase.value
            data["phase_desc"] = TaskStatus.description(phase)

        try:
            # First create a temporary file
            temp_file = status_file.with_suffix('.tmp')

            # Write to temporary file
            with temp_file.open('w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            # Atomic rename operation
            temp_file.replace(status_file)

            print(f"状态文件写入成功: {status_file}")
        except Exception as e:
            logger.error(f"写入状态文件失败 (task_id={task_id})：{e}")
            # Try to write error to file directly as fallback
            try:
                with status_file.open('w', encoding='utf-8') as f:
                    f.write(f"Error writing status: {str(e)}")
            except:
                logger.error(f"写入错误  {e}")

    def _handle_exception(self, task_id, exc):
        logger.error(f"任务异常 (task_id={task_id})", exc_info=True)
        error_message = getattr(exc, 'detail', str(exc))
        if isinstance(error_message, dict):
            try:
                error_message = json.dumps(error_message, ensure_ascii=False)
            except:
                error_message = str(error_message)
        self._update_status(task_id, TaskStatus.FAILED, message=error_message)

    def _download_media(
        self,
        downloader: Downloader,
        video_url: Union[str, HttpUrl],
        quality: DownloadQuality,
        audio_cache_file: Path,
        status_phase: TaskStatus,
        platform: str,
        output_path: Optional[str],
        screenshot: bool,
        video_understanding: bool,
        video_interval: int,
        grid_size: List[int],
        skip_download: bool = False,
    ) -> AudioDownloadResult | None:
        """
        1. 检查音频缓存；若不存在，则根据需要下载音频或视频（需要截图时下视频）。
        2. 返回 AudioDownloadResult

        :param downloader: Downloader 实例
        :param video_url: 视频/音频链接
        :param quality: 音频下载质量
        :param audio_cache_file: 本地缓存 JSON 文件路径
        :param status_phase: 对应的状态枚举，如 TaskStatus.DOWNLOADING
        :param platform: 平台标识
        :param output_path: 下载输出目录（可为 None）
        :param screenshot: 是否需要在笔记中插入截图
        :param video_understanding: 已废弃，仅为兼容旧请求保留（不再抽帧拼图）
        :param video_interval: 已废弃，仅为兼容旧请求保留
        :param grid_size: 已废弃，仅为兼容旧请求保留
        :return: AudioDownloadResult 对象
        """
        task_id = audio_cache_file.stem.split("_")[0]
        self._update_status(task_id, status_phase)

        # 已有缓存，尝试加载
        # 注意：需要截图时必须先确保原片视频可用，所以这里不能直接 return，
        # 否则重试/重跑同一个任务会跳过视频下载，截图整段失效
        if audio_cache_file.exists():
            try:
                data = json.loads(audio_cache_file.read_text(encoding="utf-8"))
                if not screenshot:
                    logger.info(f"检测到音频缓存 ({audio_cache_file})，直接读取")
                    return AudioDownloadResult(**data)
                logger.info("检测到音频缓存，但本次需要截图，继续确保原片视频可用")
            except Exception as e:
                logger.warning(f"读取音频缓存失败，将重新下载：{e}")

        # 有字幕且不需要截图/视频理解时，只提取元信息不下载文件
        if skip_download:
            logger.info("已有字幕，仅提取视频元信息（不下载音视频）")
            try:
                audio = downloader.download(
                    video_url=video_url,
                    quality=quality,
                    output_dir=output_path,
                    need_video=False,
                    skip_download=True,
                )
                audio_cache_file.write_text(
                    json.dumps(asdict(audio), ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                logger.info(f"元信息提取完成 ({audio_cache_file})")
                return audio
            except Exception as exc:
                logger.warning(f"元信息提取失败，将尝试完整下载: {exc}")

        # 判断是否需要下载视频（截图需要原片；音频在后面单独下载）
        need_video = screenshot
        if need_video:
            try:
                logger.info("开始下载视频")
                video_path_str = downloader.download_video(video_url)
                self.video_path = Path(video_path_str)
                logger.info(f"视频下载完成：{self.video_path}")
            except Exception as exc:
                logger.error(f"视频下载失败：{exc}")
                self._handle_exception(task_id, exc)
                raise

            # 视频已就位，若音频有缓存就直接复用，避免同一资源下载两次
            if audio_cache_file.exists():
                try:
                    cached_audio = AudioDownloadResult(
                        **json.loads(audio_cache_file.read_text(encoding="utf-8"))
                    )
                    logger.info("原片已下载，音频沿用缓存")
                    return cached_audio
                except Exception as e:
                    logger.warning(f"音频缓存不可用，将重新下载：{e}")

        # 下载音频
        try:
            logger.info("开始下载音频")
            audio = downloader.download(
                video_url=video_url,
                quality=quality,
                output_dir=output_path,
                need_video=need_video,
            )
            audio_cache_file.write_text(json.dumps(asdict(audio), ensure_ascii=False, indent=2), encoding="utf-8")
            logger.info(f"音频下载并缓存成功 ({audio_cache_file})")
            return audio
        except Exception as exc:
            logger.error(f"音频下载失败：{exc}")
            self._handle_exception(task_id, exc)
            raise


    def _get_transcript(
        self,
        downloader: Downloader,
        video_url: str,
        audio_file: str,
        transcript_cache_file: Path,
        status_phase: TaskStatus,
        task_id: Optional[str] = None,
    ) -> TranscriptResult | None:
        """
        优先获取平台字幕，没有则 fallback 到音频转写

        :param downloader: 下载器实例
        :param video_url: 视频链接
        :param audio_file: 音频文件路径（用于 fallback 转写）
        :param transcript_cache_file: 缓存文件路径
        :param status_phase: 状态枚举
        :param task_id: 任务 ID
        :return: TranscriptResult 对象
        """
        self._update_status(task_id, status_phase)

        # 已有缓存，直接返回
        if transcript_cache_file.exists():
            logger.info(f"检测到转写缓存 ({transcript_cache_file})，尝试读取")
            try:
                data = json.loads(transcript_cache_file.read_text(encoding="utf-8"))
                segments = [TranscriptSegment(**seg) for seg in data.get("segments", [])]
                return TranscriptResult(language=data.get("language"), full_text=data["full_text"], segments=segments)
            except Exception as e:
                logger.warning(f"加载转写缓存失败，将重新获取：{e}")

        # 1. 先尝试获取平台字幕
        logger.info("尝试获取平台字幕...")
        try:
            transcript = downloader.download_subtitles(video_url)
            if transcript and transcript.segments:
                logger.info(f"成功获取平台字幕，共 {len(transcript.segments)} 段")
                # 缓存结果
                transcript_cache_file.write_text(
                    json.dumps(asdict(transcript), ensure_ascii=False, indent=2),
                    encoding="utf-8"
                )
                return transcript
            else:
                logger.info("平台无可用字幕，将使用音频转写")
        except Exception as e:
            logger.warning(f"获取平台字幕失败: {e}，将使用音频转写")

        # 2. Fallback 到音频转写
        return self._transcribe_audio(
            audio_file=audio_file,
            transcript_cache_file=transcript_cache_file,
            status_phase=status_phase,
        )

    def _transcribe_audio(
        self,
        audio_file: str,
        transcript_cache_file: Path,
        status_phase: TaskStatus,
    ) -> TranscriptResult | None:
        """
        1. 检查转写缓存；若存在则尝试加载，否则调用转写器生成并缓存。
        2. 返回 TranscriptResult 对象

        :param audio_file: 音频文件本地路径
        :param transcript_cache_file: 转写结果缓存路径
        :param status_phase: 对应的状态枚举，如 TaskStatus.TRANSCRIBING
        :return: TranscriptResult 对象
        """
        task_id = transcript_cache_file.stem.split("_")[0]
        self._update_status(task_id, status_phase)

        # 已有缓存，尝试加载
        if transcript_cache_file.exists():
            logger.info(f"检测到转写缓存 ({transcript_cache_file})，尝试读取")
            try:
                data = json.loads(transcript_cache_file.read_text(encoding="utf-8"))
                segments = [TranscriptSegment(**seg) for seg in data.get("segments", [])]
                return TranscriptResult(language=data["language"], full_text=data["full_text"], segments=segments)
            except Exception as e:
                logger.warning(f"加载转写缓存失败，将重新转写：{e}")

        # 调用转写器
        try:
            logger.info("开始转写音频")
            transcript = self.transcriber.transcript(file_path=audio_file)
            transcript_cache_file.write_text(json.dumps(asdict(transcript), ensure_ascii=False, indent=2), encoding="utf-8")
            logger.info(f"转写并缓存成功 ({transcript_cache_file})")
            return transcript
        except Exception as exc:
            logger.error(f"音频转写失败：{exc}")
            self._handle_exception(task_id, exc)
            raise

    def _format_transcript_as_markdown(
        self,
        transcript: TranscriptResult,
        audio_meta: AudioDownloadResult,
    ) -> str:
        """
        将转写结果格式化为 Markdown 原文：仅提取原文模式下使用，跳过 LLM 总结。

        :param transcript: TranscriptResult 转写结果
        :param audio_meta: AudioDownloadResult 元信息（用于标题）
        :return: 仅包含原文的 Markdown 字符串
        """
        title = getattr(audio_meta, "title", None) or "视频原文"
        lines = [f"# {title}", "", "## 原文", ""]

        segments = transcript.segments or []
        if segments:
            for seg in segments:
                start = self._format_timestamp(seg.start)
                lines.append(f"{start} {seg.text.strip()}")
        else:
            text = (transcript.full_text or "").strip()
            if text:
                lines.append(text)

        return "\n".join(lines)

    @staticmethod
    def _format_timestamp(seconds: float) -> str:
        """把秒数格式化为 [HH:MM:SS] 形式的时间戳"""
        try:
            total = int(float(seconds))
        except (TypeError, ValueError):
            total = 0
        hours, remainder = divmod(total, 3600)
        minutes, secs = divmod(remainder, 60)
        return f"[{hours:02d}:{minutes:02d}:{secs:02d}]"

    def _summarize_text(
        self,
        audio_meta: AudioDownloadResult,
        transcript: TranscriptResult,
        gpt: GPT,
        markdown_cache_file: Path,
        link: bool,
        screenshot: bool,
        formats: List[str],
        style: Optional[str],
        extras: Optional[str],
            video_img_urls: List[str],
    ) -> str | None:
        """
        调用 GPT 对转写结果进行总结，生成 Markdown 文本并缓存。

        :param audio_meta: AudioDownloadResult 元信息
        :param transcript: TranscriptResult 转写结果
        :param gpt: GPT 实例
        :param markdown_cache_file: Markdown 缓存路径
        :param link: 是否在笔记中插入链接
        :param screenshot: 是否在笔记中生成截图占位
        :param formats: 包含 'link' 或 'screenshot' 的列表
        :param style: GPT 输出风格
        :param extras: GPT 额外参数
        :return: 生成的 Markdown 字符串
        """
        # markdown_cache_file 形如 {task_id}_markdown.md，直接取 stem 会得到带后缀的 id（{task_id}_markdown），
        # 前端只读 {task_id}.status.json，总结阶段的状态/失败原因就会丢失，必须截掉后缀
        task_id = markdown_cache_file.stem.split("_")[0]
        self._update_status(task_id, TaskStatus.SUMMARIZING)

        source = GPTSource(
            title=audio_meta.title,
            segment=transcript.segments,
            tags=audio_meta.raw_info.get("tags", []),
            screenshot=screenshot,
            video_img_urls=video_img_urls,
            link=link,
            _format=formats,
            style=style,
            extras=extras,
            checkpoint_key=task_id,
        )

        try:
            markdown = gpt.summarize(source)
            markdown_cache_file.write_text(markdown, encoding="utf-8")
            logger.info(f"GPT 总结并缓存成功 ({markdown_cache_file})")
            return markdown
        except Exception as exc:
            logger.error(f"GPT 总结失败：{exc}")
            self._handle_exception(task_id, exc)
            raise

    def _post_process_markdown(
        self,
        markdown: str,
        video_path: Optional[Path],
        formats: List[str],
        audio_meta: AudioDownloadResult,
        platform: str,
    ) -> str:
        """
        对生成的 Markdown 做后期处理：插入截图和/或插入链接。

        :param markdown: 原始 Markdown 字符串
        :param video_path: 本地视频路径（可为 None）
        :param formats: 包含 'link' 或 'screenshot' 的列表
        :param audio_meta: AudioDownloadResult 元信息，用于链接替换
        :param platform: 平台标识，用于链接替换
        :return: 处理后的 Markdown 字符串
        """
        if "screenshot" in formats and video_path:
            try:
                markdown = self._insert_screenshots(markdown, video_path)
            except Exception as exc:
                logger.warning("截图插入失败，跳过该步骤")

        if "link" in formats:
            try:
                markdown = replace_content_markers(markdown, video_id=audio_meta.video_id, platform=platform)
            except Exception as e:
                logger.warning(f"链接插入失败，跳过该步骤：{e}")

        return markdown

    def _insert_screenshots(self, markdown: str, video_path: Path) -> str:
        """
        扫描 Markdown 中的 Screenshot 标记，按时间点截取原片画面并替换为图片链接。

        模型只负责挑时间点，截图阶段由本方法做质量把关：跳过片头、限制相邻间隔、
        限制总量、丢弃无效画面（黑屏/纯色帧的 jpg 体积会异常小）。
        每张图片下方会补一行带时间戳的说明（形如 `*03:12 · 三层封装结构剖面*`），
        时间戳同时写进图片 alt，图片加载失败时也能看出这是哪一刻的画面。

        :param markdown: 含有 *Screenshot-mm:ss 或 Screenshot-[mm:ss] 标记的 Markdown 文本
        :param video_path: 本地视频文件路径
        :return: 替换后的 Markdown 字符串
        """
        # 结尾的 \*? 用来一起吃掉标记外的斜体星号，否则清空标记后会残留一个孤立的 *
        # 末尾 ([^\n]*) 捕获标记后同一行的说明文字，供落选时决定是否一并清除
        pattern = re.compile(r"(\*?Screenshot-(?:\[(\d{2}):(\d{2})\]|(\d{2}):(\d{2})))\*?([^\n]*)")
        matches = list(pattern.finditer(markdown))
        if not matches:
            return markdown

        min_ts = int(os.getenv("SCREENSHOT_MIN_TIMESTAMP", "8"))
        min_gap = int(os.getenv("SCREENSHOT_MIN_GAP_SECONDS", "20"))
        max_count = int(os.getenv("SCREENSHOT_MAX_COUNT", "20"))
        min_bytes = int(os.getenv("SCREENSHOT_MIN_BYTES", "10240"))

        # 第一遍：决定哪些时间点值得截图
        keep_starts: set = set()
        last_ts: Optional[int] = None
        for match in matches:
            ts = int(match.group(2) or match.group(4)) * 60 + int(match.group(3) or match.group(5))
            if ts < min_ts:
                logger.info(f"跳过片头截图标记 (timestamp={ts})")
                continue
            if len(keep_starts) >= max_count:
                logger.info(f"截图数量已达上限 {max_count}，丢弃后续标记")
                continue
            if last_ts is not None and ts - last_ts < min_gap:
                logger.info(f"跳过与上一张间隔过近的截图 (timestamp={ts})")
                continue
            keep_starts.add(match.start())
            last_ts = ts

        # 第二遍：逐条替换；落选的标记原地清空，避免残留 *Screenshot-xx* 文本
        idx = 0

        def _format_ts(total_seconds: int) -> str:
            return f"{total_seconds // 60:02d}:{total_seconds % 60:02d}"

        def _cleanup(match: "re.Match", trailing: str) -> str:
            """标记没能换成图片时怎么收场：独占一行就连说明一起清掉，否则只删标记。"""
            line_start = markdown.rfind("\n", 0, match.start()) + 1
            is_line_head = markdown[line_start:match.start()].strip() == ""
            return "" if is_line_head else trailing

        def _replace(match: "re.Match") -> str:
            nonlocal idx
            trailing = match.group(6) or ""
            if match.start() not in keep_starts:
                return _cleanup(match, trailing)
            ts = int(match.group(2) or match.group(4)) * 60 + int(match.group(3) or match.group(5))
            try:
                img_path = generate_screenshot(str(video_path), str(IMAGE_OUTPUT_DIR), ts, idx)
                path_obj = Path(img_path)
                size = path_obj.stat().st_size if path_obj.exists() else 0
                if size < min_bytes:
                    logger.info(f"画面为空或纯色，跳过截图 (timestamp={ts}, size={size})")
                    # 同一次调用里生成的废图顺手删掉，别在 static 目录里堆垃圾
                    path_obj.unlink(missing_ok=True)
                    return _cleanup(match, trailing)
                idx += 1
                # 构建前端可访问的 URL，例如 /static/screenshots/{filename}
                img_url = f"{IMAGE_BASE_URL.rstrip('/')}/{path_obj.name}"
                ts_text = _format_ts(ts)
                # 去掉说明里可能自带的分隔符前置字符（模型偶尔会写 "- 03:12 说明"）；
                # strip('*') 用于吃掉模型自己加的斜体/加粗星号，否则会和下文的斜体嵌套成
                # `*00:47 · *说明**` 这种坏 markdown
                caption = trailing.strip().lstrip("-—:：·").strip().strip("*").strip()
                # 时间戳写进 alt，图片加载失败时也能看出是哪一刻；下方再补一行带时间戳的说明
                caption_line = f"*{ts_text} · {caption}*" if caption else f"*{ts_text}*"
                return f"![{ts_text}]({img_url})\n{caption_line}"
            except Exception as exc:
                logger.error(f"生成截图失败 (timestamp={ts})：{exc}")
                return _cleanup(match, trailing)

        # 清掉因删除整行留下的多余空行
        return re.sub(r"\n{3,}", "\n\n", pattern.sub(_replace, markdown))

    @staticmethod
    def _extract_screenshot_timestamps(markdown: str) -> List[Tuple[str, int]]:
        """
        从 Markdown 文本中提取所有 '*Screenshot-mm:ss' 或 'Screenshot-[mm:ss]' 标记，
        返回 [(原始标记文本, 时间戳秒数), ...] 列表。

        :param markdown: 原始 Markdown 文本
        :return: 标记与对应时间戳秒数的列表
        """
        return extract_screenshot_timestamps(markdown)

    def _save_metadata(self, video_id: str, platform: str, task_id: str, publish_date: int = None) -> None:
        """
        将生成的笔记任务记录插入数据库

        :param video_id: 视频 ID
        :param platform: platform 标识
        :param task_id: 任务 ID
        :param publish_date: 发布时间
        """
        try:
            insert_video_task(video_id=video_id, platform=platform, task_id=task_id, publish_date=publish_date)
            logger.info(f"已保存任务记录到数据库 (video_id={video_id}, platform={platform}, task_id={task_id}, publish_date={publish_date})")
        except Exception as e:
            logger.error(f"保存任务记录失败：{e}")
