from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, func

from app.db.engine import Base


class UserNote(Base):
    """用户笔记：一个视频（平台 + 视频ID）在某批用户名下的全部版本。

    笔记正文/转写仍然放在 note_results/<task_id>.json（沿用现有生成流程的文件），
    这里只保存「归属 + 排序」需要的轻量元信息，避免把大段正文塞进数据库。
    """

    __tablename__ = "user_notes"
    __table_args__ = (
        UniqueConstraint("user_id", "platform", "video_id", name="uq_user_note_identity"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, nullable=False, index=True)
    platform = Column(String, nullable=False)
    video_id = Column(String, nullable=False)
    title = Column(String, nullable=True)
    # JSON 数组字符串：该笔记所有版本的 task_id，按生成时间倒序
    task_ids = Column(Text, nullable=False, default="[]")
    # JSON 数组字符串：每个版本的完整内容（正文/风格/模型/转写/素材信息），同样倒序
    versions = Column(Text, nullable=False, default="[]")
    # 最新版本的生成时间（ISO 字符串，直接给前端展示/排序用）
    created_at = Column(String, nullable=True)
    publish_date = Column(Integer, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
