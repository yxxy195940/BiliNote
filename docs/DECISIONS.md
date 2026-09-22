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
| Agent 环境 | Windows 原生 agent + 项目在 WSL2；经实测**无需**切换到 WSL agent |

---

## 2026-09-19 Agent 运行环境：保持 Windows 原生，项目留在 WSL2

**结论**：Codex agent 继续跑 Windows 原生（PowerShell），项目文件继续留在 WSL2 文件系统，两者都不迁移。

- 官方 WSL 指南里会促使人切换的两个警告，在本机**均不成立**：WSL 是 **version 2**（不是已停止支持的 WSL1）；Windows git（`D:\Code\Git\cmd\git.exe`）能正常识别 UNC 仓库（`git -C \\wsl.localhost\... rev-parse --git-dir` 返回 `.git`）。
- 审查面板（Review）在 UNC 仓库上可正常显示改动，已实测确认。
- `wsl.exe` 调用开销实测约 **0.08 秒/次**，可忽略；真正的瓶颈是目录层数（每层一次 RTT），与文件大小无关。
- **反面警告（重要）**：不要照搬指南里「项目放 Windows 盘、WSL 通过 `/mnt/<drive>/...` 访问」的建议。本项目**在 WSL 内运行**（systemd 单元 + `backend/myvenv` + GPU 加速库 + `node_modules`），路径迁移会连锁破坏 systemd 配置与 GPU 环境，且 `/mnt/*` 跨文件系统 I/O 对 venv 和 node_modules 极慢。
- 保持现状的已知小代价：PowerShell → WSL 传参需转义。heredoc（`<<'EOF'`）会被拆开（改用临时消息文件）；`$var` 有时不展开；管道须放进 `bash -lc '...'` 引号内；路径中的 `[OI]` 会被当通配符。
- 若将来确实被上述摩擦困扰：Settings 里把 agent 切到 WSL + 重启应用即可，可逆；但无论选哪边都**不迁移项目路径**。

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

## 2026-09-19 移动端 ⓘ 提示按钮 & 笔记格式默认值

**背景**：移动端首页所有「感叹号」说明按钮点击无反应，PC 端鼠标悬停却正常。

**根因**：Radix Tooltip 只在 `onPointerMove` 里判断，遇到触摸指针直接 return；说明图标本身是裸 `<svg>`，也不在键盘 Tab 序列里。移动端没有任何触发路径。

**结论**：新增 `BillNote_frontend/src/components/InfoTip.tsx` —— 受控 `Tooltip` + 真正的 `<button>` 触发元素：触摸点按自行 toggle、鼠标端仍是悬停展开、键盘聚焦可开。`NoteForm.tsx` 的 `SectionHeader` 统一改用它（首页的 ⓘ 都出自这里）。

- 顺带：`NoteForm.tsx` 的 `format` 初值从 `[]` 改为 `['toc', 'link', 'summary']`，即「目录 / 原片跳转 / AI 总结」默认勾选。
- 注意 `MarkdownHeader.tsx` / `NoteHistory.tsx` 里还有 Radix Tooltip，但它们绑定的都是可点击的 `<Button>`（悬停只是补充说明），不属于「点了没反应」，未改动。

## 2026-09-19 笔记生成失败时展示「卡在哪一环」

**结论**：后端在状态文件里记录阶段，前端失败页展示「阶段 + 原始报错」。

- `app/services/note.py` 新增 `self._current_phase`，`_update_status` 时写入 `phase` / `phase_desc`，失败分支把阶段一并落盘。**坑**：失败会被写两次（`_handle_exception` 和 `generate` 的 `except`），只有 `SUCCESS` 才允许清空阶段，否则第二次写会把 `phase` 冲成 `null`。
- `app/routers/note.py` 的 `/task_status` 失败分支保持 `code=500`（不破坏旧契约），`data` 补 `{status, phase, phase_desc, task_id}`。
- 前端：`utils/request.ts` 加 `skipErrorToast` 让轮询静默；`useTaskPolling.ts` 把 `message/phase/phase_desc` 写回任务，并把 `code === -1`（纯网络抖动）当作 `continue`，不再误判任务失败；`store/taskStore` 补 `taskPhaseLabels` / `taskFailureText`；`MarkdownViewer.tsx` 失败页渲染「笔记生成失败（下载中）」+ 可滚动报错原文。
- 实测：提交一个必然失败的 YouTube 任务，接口返回 `code=500`、`phase=DOWNLOADING`、`phase_desc=下载中`。

## 2026-09-19 YouTube 下载器接入 Cookie

**背景**：YouTube 报 `Sign in to confirm you're not a bot`。

**结论**：`YoutubeDownloader` 读 `config/downloader.json` 的 `youtube.cookie`，用共享的 `write_netscape_cookie_file()`（`app/services/cookie_manager.py`，由 B 站私有实现提取而来）生成 Netscape 临时文件，注入 `ydl_opts['cookiefile']`；`YouTubeSubtitleFetcher(cookie=...)` 给 InnerTube session 设 Cookie 头，`download_subtitles` 一并传入。未配置 cookie 时只记 warning，不影响其他平台。

- 离线校验（无网也能验）：yt-dlp 能从生成的 cookiefile 解析出 23 条 cookie，含 `SID` / `HSID` / `SSID` / `APISID` / `SAPISID` / `__Secure-1PSID` / `LOGIN_INFO`；字幕 fetcher 有 cookie 时发出 `Cookie` 头、无 cookie 时不发。
- **cookie 只解机器人校验，解不了网络层问题**。本机 YouTube 失败的真实原因见下方踩坑清单。

## 2026-09-19 WSL 代理打通 YouTube 下载（网络层已解决）

**背景**：YouTube 任务在 `DOWNLOADING` 阶段失败，报 `[youtube] Unable to download API page: [Errno 101] Network is unreachable`。

**结论**：systemd 单元 `bilinote-backend` 只配了 `no_proxy`，**没有** `http_proxy` / `https_proxy` / `ALL_PROXY`；而 **systemd 服务不继承 shell 里的环境变量**，所以 yt-dlp 在直连被墙的 YouTube。补 drop-in 注入 `http://127.0.0.1:7892` 后网络层打通——报错变为 `Sign in to confirm you're not a bot`（反爬，属另一层问题）。

- **改法**：`/etc/systemd/system/bilinote-backend.service.d/override.conf` 加三个 `Environment=`（http_proxy / https_proxy / ALL_PROXY），再 `daemon-reload` + `restart`。
- **不做 `autoProxy=true`**：会把 WSL 的出网绑到 Windows 系统代理开关上，还可能污染回环、让本机服务报 502；粒度也做不到「只让 YouTube 走代理」。
- **完整方案、Clash 规则写法、排障清单**：见 [`docs/WSL-网络代理配置.md`](./WSL-网络代理配置.md)。

**后续（同日解决）**：网络层通了之后暴露出的 `Sign in to confirm you're not a bot` 属 cookie 问题——用浏览器扩展 **Get cookies.txt LOCALLY** 重新导出 YouTube cookie 粘贴到「设置 → 下载器」，即刻恢复，实测任务 `29407d60` 全链路通过。**结论：YouTube 报 bot check = cookie 票据过期，重新导出粘贴即可，别动代码。** 细节与遗留观察（`cookie_manager` 强行覆盖 cookie 域）见 [`docs/WSL-网络代理配置.md`](./WSL-网络代理配置.md) 第九节。

---

## 本机环境踩坑清单

- **前端服务跑的是 `vite preview`（生产 `dist/`），不是 dev server**。改完 `src/` 必须 `pnpm build`（要 `NODE_OPTIONS=--max-old-space-size=6144`，否则 OOM）再 `sudo systemctl restart bilinote-frontend`，否则用户看到的一直是旧包 ——「改了没生效」多半是这个。判断是否已部署：比对 `dist/index.html` 的 mtime 与源文件 mtime。
- 后端 `WorkingDirectory` 是 `backend/`，所以 `CookieConfigManager` 的默认路径 `config/downloader.json` 实际指向 `backend/config/downloader.json`；根目录那个 `config/downloader.json` 是空文件，别看错。
- `app/services/note.py` 曾在服务运行期间被手工编辑，`markdown_cache_file.stem.split("_")[0]` 那行丢过缩进导致 `IndentationError`。改完先跑 `myvenv/bin/python -m compileall app` 再重启。
- `eth5`（Windows 侧 `QingyunLite Tunnel`）**会整个消失**：2026-09-19 05:30 时 `ip -br addr` 只剩 `eth2`（192.168.2.x 直连 LAN）。此时 bilibili / baidu 正常（200），但 YouTube / Google 完全不通（curl 超时；DNS 把 `www.youtube.com` 解成 `2001::1` 这种无效 IPv6）。排查方法：先 `ip -br addr` 看有没有 `eth5`，没有就别怀疑代码。WSL 是镜像网络模式（WSL 里的 `127.0.0.1` 就是 Windows 本机）。**注**：「Windows 侧没有任何代理在监听」是 05:30 那个时点的观测；此后 QingyunLite 恢复监听 7892，代理方案见 [`docs/WSL-网络代理配置.md`](./WSL-网络代理配置.md)。
- 既有问题（未处理）：`app/downloaders/douyin_downloader.py:117` 有裸 `print(self.headers_config)`，每次都会把**抖音 cookie 完整打进 stdout 日志**，属于敏感信息泄漏 + 日志噪音。

- `backend/myvenv/bin/` 下脚本的 shebang 曾指向已失效的 `/mnt/d/Code/project/...`，2026-09-19 已修为项目真实路径，`myvenv/bin/pip` 可直接用（保险起见也可写 `myvenv/bin/python -m pip`）。
- `app/routers/config.py`、`app/services/note.py`、`app/transcriber/transcriber_provider.py` 是 **CRLF** 行尾，`apply_patch` 上下文匹配会失败；先删文件再以 LF 重建。
- PowerShell → WSL 传参有引号陷阱：管道（如 `| tail`）要放在 `bash -lc '...'` 的引号内；`$var` 有时不展开，优先直接写死路径。
- 全仓递归查找很慢（`BillNote_frontend` 4.6 万文件 / `backend` 3.7 万文件），一律限定 path 并跳过 `node_modules/ .git/ __pycache__/ dist/ build/`。
- 硬约束：不修改系统全局环境（如 `/etc/environment`）；高风险操作先停下确认。
- WSL 出网走 `eth5`（对应 Windows 侧 `QingyunLite Tunnel`），HTTPS 会**间歇性**卡死（同一域名可能一个 0.4 秒通、下一个 20 秒超时）。a6api 需在代理里加**直连/绕过规则**；排查时先隔几分钟重试再下结论。
- ~~别加 `HTTPS_PROXY` 指向 `127.0.0.1:7892`（实测反而失败）~~ → **此结论已被 2026-09-19 的实测推翻，作废**。当时失败的前置条件是 QingyunLite 没在跑（Windows 侧 7892 无监听），与代理变量本身无关。现在 `127.0.0.1:7892` 在 WSL 内可达，后端已通过 systemd drop-in 注入代理并打通 YouTube 下载的网络层。方案与判据见 [`docs/WSL-网络代理配置.md`](./WSL-网络代理配置.md)。
