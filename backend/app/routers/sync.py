"""用户笔记同步接口。

设计要点：
- 一条笔记 = 「用户 + 平台 + 视频ID」，同一条视频反复生成出来的多个版本统一放在
  user_notes.versions（JSON 数组，含正文/风格/模型/转写/素材信息）里，所以任何设备
  绑定同一个用户 ID 之后都能拿到完整内容。
- 生成流程写出的 note_results/<task_id>.json 继续保留（AI 问答、向量索引依赖它），
  同步时发现文件缺失会用版本内容自动补写。
- 写接口都是幂等的：重复上传只做合并，不会产生重复条目。
- 删除是「真的删」：数据库记录 + 结果文件 + 音频/视频素材 + 截图一起清掉。
"""
import datetime
import glob
import hashlib
import json
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from app.db.engine import SessionLocal
from app.db.models.user_notes import UserNote
from app.db.models.video_tasks import VideoTask
from app.utils.logger import get_logger
from app.utils.response import ResponseWrapper as R

router = APIRouter()
logger = get_logger(__name__)

NOTE_OUTPUT_DIR = os.getenv("NOTE_OUTPUT_DIR", "note_results")
SCREENSHOT_DIR = os.path.join("static", "screenshots")
COVER_DIR = os.path.join("static", "cover")


# ------------------------------------------------------------------ 请求模型

class VersionIn(BaseModel):
    ver_id: Optional[str] = None
    task_id: str
    created_at: Optional[str] = ""
    style: Optional[str] = ""
    model_name: Optional[str] = ""
    content: Optional[str] = None
    transcript: Optional[Dict[str, Any]] = None
    audio_meta: Optional[Dict[str, Any]] = None


class EntryIn(BaseModel):
    platform: str
    video_id: str
    title: Optional[str] = None
    created_at: Optional[str] = None
    publish_date: Optional[int] = None
    versions: List[VersionIn] = Field(default_factory=list)


class UploadRequest(BaseModel):
    user_id: str
    entries: List[EntryIn] = Field(default_factory=list)


class PullRequest(BaseModel):
    user_id: str
    # 客户端已经有的版本 id，服务器只回传缺的部分，避免每次全量传输
    have: List[str] = Field(default_factory=list)


class DeleteRequest(BaseModel):
    user_id: str
    platform: str
    video_id: str
    # 客户端本地这条笔记的全部版本 id，兜底清理数据库里没登记到的产物
    task_ids: List[str] = Field(default_factory=list)


# ------------------------------------------------------------------ 文件工具

def _result_path(task_id: str) -> str:
    return os.path.join(NOTE_OUTPUT_DIR, f"{task_id}.json")


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _iso_from_mtime(task_id: str) -> str:
    """结果文件的写入时间≈这条笔记的完成时间，作为排序兜底。"""
    try:
        ts = os.path.getmtime(_result_path(task_id))
    except OSError:
        return ""
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def _within(path: str, root: str) -> bool:
    real_path = os.path.realpath(path)
    real_root = os.path.realpath(root)
    return real_path == real_root or real_path.startswith(real_root + os.sep)


def _remove_file(path: str) -> int:
    try:
        if os.path.isfile(path):
            os.remove(path)
            return 1
    except Exception as e:
        logger.warning(f"删除文件失败 {path}: {e}")
    return 0


# ------------------------------------------------------------------ 版本记录

def _load_versions(raw: Optional[str]) -> List[dict]:
    try:
        data = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [v for v in data if isinstance(v, dict)]


def _version_key(version: dict) -> str:
    return str(version.get("ver_id") or version.get("task_id") or "")


def _normalize(version: VersionIn, entry: EntryIn, fallback: dict) -> dict:
    """把客户端上传的版本整理成入库格式，缺的字段用条目级信息兜底。"""
    task_id = version.task_id
    stored = {
        "ver_id": version.ver_id or task_id,
        "task_id": task_id,
        "created_at": version.created_at or fallback.get("created_at") or "",
        "style": version.style or "",
        "model_name": version.model_name or "",
        "content": version.content or "",
        "transcript": version.transcript or fallback.get("transcript"),
        "audio_meta": version.audio_meta or fallback.get("audio_meta"),
    }
    return stored


def _merge_versions(stored: List[dict], incoming: List[dict]) -> List[dict]:
    """按 ver_id 去重合并，同一条记录里非空的新值优先。"""
    merged: Dict[str, dict] = {}
    for version in stored:
        key = _version_key(version)
        if key:
            merged[key] = version
    for version in incoming:
        key = _version_key(version)
        if not key:
            continue
        previous = merged.get(key)
        if previous is None:
            merged[key] = version
            continue
        updated = dict(previous)
        for field, value in version.items():
            if value not in (None, "", [], {}):
                updated[field] = value
        merged[key] = updated

    result = list(merged.values())
    result.sort(key=lambda v: v.get("created_at") or "", reverse=True)
    return _dedupe_by_content(result)


def _content_key(version: dict) -> str:
    content = (version.get("content") or "").strip()
    return hashlib.md5(content.encode("utf-8")).hexdigest() if content else ""


def _richness(version: dict) -> int:
    return sum(1 for f in ("style", "model_name", "transcript", "audio_meta") if version.get(f))


def _dedupe_by_content(versions: List[dict]) -> List[dict]:
    """不同设备用不同 ver_id 上报的同一份内容只保留一条，避免同步后出现重复版本。"""
    seen: Dict[str, int] = {}
    result: List[dict] = []
    for version in versions:
        key = _content_key(version)
        if not key:
            result.append(version)
            continue
        index = seen.get(key)
        if index is None:
            seen[key] = len(result)
            result.append(version)
            continue
        # 同内容时保留信息更全的那一条（ver_id 仍以先出现的为准，便于客户端去重）
        if _richness(version) > _richness(result[index]):
            merged = dict(version)
            merged["ver_id"] = result[index].get("ver_id") or version.get("ver_id")
            result[index] = merged
    return result


def _ensure_result_files(entry: EntryIn, versions: List[dict]) -> None:
    """给还没有结果文件的版本补一份，保证 AI 问答/向量索引仍能按 task_id 读到内容。"""
    for version in versions:
        task_id = version.get("task_id")
        content = version.get("content")
        if not task_id or not content or os.path.exists(_result_path(task_id)):
            continue
        _write_json(
            _result_path(task_id),
            {
                "markdown": content,
                "transcript": version.get("transcript")
                or {"language": "", "full_text": "", "segments": [], "raw": None},
                "audio_meta": version.get("audio_meta")
                or {
                    "cover_url": "",
                    "duration": 0,
                    "file_path": "",
                    "platform": entry.platform,
                    "raw_info": None,
                    "title": entry.title or "",
                    "video_id": entry.video_id,
                    "publish_date": entry.publish_date,
                },
            },
        )


# ------------------------------------------------------------------ 数据读写

def _entry_summary(row: UserNote) -> dict:
    versions = _load_versions(row.versions)
    return {
        "platform": row.platform,
        "video_id": row.video_id,
        "title": row.title or "",
        "created_at": row.created_at or "",
        "publish_date": row.publish_date,
        "task_ids": [v.get("task_id") for v in versions if v.get("task_id")],
    }


def _entry_with_versions(row: UserNote, known: set) -> dict:
    data = _entry_summary(row)
    data["versions"] = [
        v for v in _load_versions(row.versions) if _version_key(v) not in known
    ]
    return data


def _sorted_summaries(db, user_id: str) -> List[dict]:
    rows = db.execute(select(UserNote).where(UserNote.user_id == user_id)).scalars().all()
    entries = [_entry_summary(r) for r in rows]
    entries.sort(key=lambda e: e.get("created_at") or "", reverse=True)
    return entries


def _ensure_video_task(db, platform: str, video_id: str, task_id: str, publish_date: Optional[int]) -> None:
    """登记表里已有同 task_id 就跳过，保证 /delete_task 等既有链路依旧能找到它。"""
    exists = db.execute(select(VideoTask).where(VideoTask.task_id == task_id)).scalars().first()
    if exists:
        return
    db.add(VideoTask(video_id=video_id, platform=platform, task_id=task_id, publish_date=publish_date))


def _upsert_entry(db, user_id: str, entry: EntryIn) -> None:
    fallback = {
        "created_at": entry.created_at,
        "transcript": None,
        "audio_meta": None,
    }
    incoming = [_normalize(v, entry, fallback) for v in entry.versions if v.task_id]

    row = db.execute(
        select(UserNote).where(
            UserNote.user_id == user_id,
            UserNote.platform == entry.platform,
            UserNote.video_id == entry.video_id,
        )
    ).scalars().first()
    if row is None:
        row = UserNote(user_id=user_id, platform=entry.platform, video_id=entry.video_id)
        db.add(row)

    merged = _merge_versions(_load_versions(row.versions), incoming)
    for version in merged:
        task_id = version.get("task_id")
        if not task_id:
            continue
        if not version.get("created_at"):
            version["created_at"] = _iso_from_mtime(task_id)
        if not version.get("content"):
            result = _read_json(_result_path(task_id)) or {}
            version["content"] = result.get("markdown") or ""
            version["transcript"] = version.get("transcript") or result.get("transcript")
            version["audio_meta"] = version.get("audio_meta") or result.get("audio_meta")
    merged.sort(key=lambda v: v.get("created_at") or "", reverse=True)

    newest = merged[0] if merged else {}
    audio_meta = newest.get("audio_meta") or {}

    row.versions = json.dumps(merged, ensure_ascii=False)
    row.task_ids = json.dumps(
        [v.get("task_id") for v in merged if v.get("task_id")], ensure_ascii=False
    )
    row.title = entry.title or audio_meta.get("title") or row.title or ""
    row.created_at = newest.get("created_at") or entry.created_at or row.created_at or ""
    if entry.publish_date is not None:
        row.publish_date = entry.publish_date
    elif audio_meta.get("publish_date"):
        row.publish_date = audio_meta.get("publish_date")

    for version in incoming:
        _ensure_video_task(db, entry.platform, entry.video_id, version["task_id"], row.publish_date)

    _ensure_result_files(entry, merged)


# ------------------------------------------------------------------ 接口

@router.get("/sync/notes")
def sync_notes(user_id: str):
    """列出某个用户名下的全部笔记（只有元信息，不含正文）。"""
    user_id = (user_id or "").strip()
    if not user_id:
        return R.error(msg="缺少 user_id")
    db = SessionLocal()
    try:
        return R.success(data={"entries": _sorted_summaries(db, user_id)})
    finally:
        db.close()


@router.post("/sync/pull")
def sync_pull(req: PullRequest):
    """拉取该用户的笔记；客户端已有的版本只回元信息，缺的版本连正文一起回。"""
    user_id = (req.user_id or "").strip()
    if not user_id:
        return R.error(msg="缺少 user_id")
    known = {str(i) for i in (req.have or []) if i}
    db = SessionLocal()
    try:
        rows = db.execute(select(UserNote).where(UserNote.user_id == user_id)).scalars().all()
        entries = [_entry_with_versions(r, known) for r in rows]
        entries.sort(key=lambda e: e.get("created_at") or "", reverse=True)
        return R.success(data={"entries": entries})
    except Exception as e:
        logger.error(f"拉取笔记失败: {e}")
        return R.error(msg=str(e))
    finally:
        db.close()


@router.post("/sync/upload")
def sync_upload(req: UploadRequest):
    """把本机的笔记合并到服务器，返回合并后的完整清单（不含正文）。"""
    user_id = (req.user_id or "").strip()
    if not user_id:
        return R.error(msg="缺少 user_id")
    db = SessionLocal()
    try:
        for entry in req.entries:
            if not entry.platform or not entry.video_id:
                continue
            _upsert_entry(db, user_id, entry)
        db.commit()
        return R.success(data={"entries": _sorted_summaries(db, user_id)})
    except Exception as e:
        db.rollback()
        logger.error(f"上传合并失败: {e}")
        return R.error(msg=str(e))
    finally:
        db.close()


def _delete_task_assets(task_id: str) -> int:
    """删掉一条任务的全部产物：结果/状态文件、音频素材、截图。"""
    removed = 0
    for suffix in (
        ".json",
        ".status.json",
        "_audio.json",
        "_transcript.json",
        "_markdown.md",
        "_markdown.status.json",
    ):
        removed += _remove_file(os.path.join(NOTE_OUTPUT_DIR, f"{task_id}{suffix}"))

    result = _read_json(_result_path(task_id))
    if result:
        audio_meta = result.get("audio_meta") or {}
        for key in ("file_path", "video_path"):
            path = audio_meta.get(key)
            if isinstance(path, str) and path and _within(path, "."):
                removed += _remove_file(path)

    for directory in (SCREENSHOT_DIR, COVER_DIR):
        for path in glob.glob(os.path.join(directory, f"*{task_id}*")):
            if _within(path, "."):
                removed += _remove_file(path)
    return removed


@router.post("/sync/delete")
def sync_delete(req: DeleteRequest):
    """删除一条笔记：服务器上所有版本 + 素材一起清掉（不可恢复）。"""
    user_id = (req.user_id or "").strip()
    if not user_id:
        return R.error(msg="缺少 user_id")

    db = SessionLocal()
    try:
        row = db.execute(
            select(UserNote).where(
                UserNote.user_id == user_id,
                UserNote.platform == req.platform,
                UserNote.video_id == req.video_id,
            )
        ).scalars().first()

        task_ids: List[str] = []
        if row is not None:
            for version in _load_versions(row.versions):
                task_id = version.get("task_id")
                if task_id:
                    task_ids.append(task_id)
            task_ids += [t for t in json.loads(row.task_ids or "[]") if t]
        task_ids += [t for t in (req.task_ids or []) if t]
        task_ids = list(dict.fromkeys(task_ids))

        removed = 0
        for task_id in task_ids:
            removed += _delete_task_assets(task_id)
            db.execute(delete(VideoTask).where(VideoTask.task_id == task_id))

        if row is not None:
            db.delete(row)
        db.commit()
        logger.info(
            f"删除笔记 user={user_id} platform={req.platform} video={req.video_id} "
            f"任务数={len(task_ids)} 文件数={removed}"
        )
        return R.success(data={"task_ids": task_ids, "deleted_files": removed})
    except Exception as e:
        db.rollback()
        logger.error(f"删除笔记失败: {e}")
        return R.error(msg=str(e))
    finally:
        db.close()
