# 决策日志（DECISIONS）

> 用途：跨对话保存「为什么这么做」和「踩过的坑」，让新开的对话页能快速对齐。
> 写法约定：只记结论、原因、日期，不记过程；最新在最上；速览必须控制在 15 行内。
> 维护：条目超过约 40 条时，把已失效的移到 `DECISIONS-archive.md`。

## 速览（当前状态）

| 项 | 现状 |
| --- | --- |
| 转写 | GPU（RTX 5070 Ti）+ `large-v3-turbo`；60 秒素材约 3.7 秒 |
| 运行形态 | WSL2 内 systemd 服务：`bilinote-backend`(8483)、`bilinote-frontend`(3015) |
| 服务开关 | `active` 但 `disabled`（不开机自启），重启用 `sudo systemctl restart bilinote-backend` |
| Python | 后端用项目内 `backend/myvenv`（3.12），不碰系统环境 |
| 前端 | React 19 + Vite + **Tailwind v4**；移动端断点 767px，走 JS 分支 |
| 模型权重 | `backend/models/whisper/`：turbo / medium / small / tiny（tiny 与 medium 不完整） |

---

## 2026-09-18 知识资产与记忆管理

**结论**：跨对话的记忆载体是仓库里的书面文件，不是模型记忆。

- Codex 每个新对话只会自动加载 `AGENTS.md`（仓库根 + 从工作目录往上到根的所有同名文件），其余文件都要主动去读。
- 因此 `AGENTS.md` 保持精简（只放约定、命令、坑），细节放本文件，并在 `AGENTS.md` 顶部留一行指针。
- 长对话会被自动压缩，高层结论能保住，细节会糊。重要结论要当场落盘。

## 2026-09-18 GPU 加速转写落地

**背景**：CPU 模式转写慢，60 秒素材要 16.5 秒。

**结论**：只需把 NVIDIA 加速库装进**项目自己的 venv**，不需要装显卡驱动、不动 Windows 系统。

- 补三个包（NVIDIA 发布在 PyPI 的组件，走国内镜像）：`nvidia-cudnn-cu12==9.26.0.51`、`nvidia-cublas-cu12==12.9.2.10`、`nvidia-cuda-nvrtc-cu12==12.9.86`；约 1.4GB 下载 / 2.2GB 磁盘。
- 新增 `backend/app/utils/nvidia_libs.py`：用 `ctypes.CDLL(..., RTLD_GLOBAL)` 预加载，任何一步失败即返回 False → 自动回落 CPU，保证不会因显卡问题导致笔记生成失败。
- `backend/app/transcriber/whisper.py` 的 `is_cuda()` 改为不依赖 torch，直接判断加速库是否就绪。
- 模型权重 `whisper-large-v3-turbo`（1.6GB）来自 ModelScope 的 `pengzhendong/faster-whisper-large-v3-turbo`。

**实测**（340 秒中文音频）：

| 配置 | 耗时 |
| --- | --- |
| CPU + small（原方案） | 122 秒 |
| GPU + small | 16–18 秒（首次 23.5 秒） |
| GPU + large-v3-turbo | **10.8 秒** |

60 秒素材：CPU 约 12 秒 → GPU turbo 3.7 秒；端到端（上传→转写→总结→保存）18 秒。

**验收方式**：`curl http://127.0.0.1:8483/api/deploy_status`，应返回 `cuda.available=true`、`whisper.model_size=large-v3-turbo`、`device=cuda`。

**怎么撤销**：删掉 `myvenv` 里那两个库目录 + 去掉路径注入，立刻回到 CPU 模式，随时可退。

## 2026-09-18 移动端响应式方案（重要，别改错方向）

**结论**：本项目移动端**不是纯 CSS 响应式**，而是 JS 媒体查询 + 两套 JSX 分支。

- 断点 `(max-width: 767px)`，定义在 `src/hooks/useIsMobile.ts`（初值同步读 `matchMedia`，避免首帧跳变）。
- 之所以不用 CSS 隐藏，是因为那样会导致两套布局同时挂载。
- 全局兜底在 `src/index.css` 的 `@media (max-width: 767px)`：把 `html/body/#root` 从 `height:100% + overflow:hidden` 改为 `height:auto + overflow-y:auto`，并用 `!important` 关掉 Radix ScrollArea 的内部滚动。
- 桌面靠内部滚动、移动靠文档滚动——这是有意区分的模型切换。
- 挂载策略：`NoteForm` 用 `hidden` 保留挂载（不丢已填内容）；思维导图按需挂载（隐藏时尺寸为 0 会画错，必须真实尺寸）。
- **技术栈修正**：前端已是 **Tailwind v4**（`@import 'tailwindcss'` + `@tailwindcss/vite`）；根目录 `tailwind.config.cjs`（v3 写法）实际不生效，是遗留死文件。
- 未处理项：无 `dvh`、无 `env(safe-area-inset-*)`；Tauri 默认窗口 1600×1000 且无 `minWidth`。

## 2026-09-18 用户内容同步功能

**结论**：用纯 user id 绑定实现多设备笔记同步，绑定时整理上传并合并，不绑定则保持原状。

- 后端 `app/routers/sync.py` + `app/db/models/user_notes.py`；前端 `store/syncStore/`、`services/sync.ts`、`pages/HomePage/components/SyncPanel.tsx`。
- 入口在生成历史菜单旁；绑定后每次自动同步。
- 待办：弹窗示例文案要脱敏（不要出现真实 id，用 `test1` 这类占位）。

---

## 本机环境踩坑清单

- `backend/myvenv/bin/pip` 的 shebang 指向已失效的 `/mnt/d/Code/project/...`，**必须**用 `myvenv/bin/python -m pip`。
- `app/routers/config.py`、`app/services/note.py`、`app/transcriber/transcriber_provider.py` 是 **CRLF** 行尾，`apply_patch` 上下文匹配会失败；先删文件再以 LF 重建。
- PowerShell → WSL 传参有引号陷阱：管道（如 `| tail`）要放在 `bash -lc '...'` 的引号内；`$var` 有时不展开，优先直接写死路径。
- 全仓递归查找很慢（`BillNote_frontend` 4.6 万文件 / `backend` 3.7 万文件），一律限定 path 并跳过 `node_modules/ .git/ __pycache__/ dist/ build/`。
- 硬约束：不修改系统全局环境（如 `/etc/environment`）；高风险操作先停下确认。
