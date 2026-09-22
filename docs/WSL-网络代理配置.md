# WSL 环境网络代理配置参考

> **适用场景**：BiliNote 后端跑在 WSL2 里，yt-dlp 要访问 YouTube；同时 DeepSeek / DashScope / 火山等国内 API 必须直连。
> **定稿**：2026-09-19（当天实测打通，YouTube 下载的网络层问题已解决）
> **相关**：`docs/DECISIONS.md`「本机环境踩坑清单」、`docs/运维手册.md`「本机现状」

---

## 一、先记结论

- **目标**：只有外网流量走代理，国内 API / LLM 直连。
- **做法**：**不动** `.wslconfig` 的 `autoProxy`，只在 systemd 单元加 drop-in 注入代理变量，作用范围限定到后端这一个进程。
- **一句话判据**：

  | 报错 | 含义 |
  | --- | --- |
  | `[Errno 101] Network is unreachable` | 代理没注入到这个进程 |
  | `Sign in to confirm you're not a bot` | 网络已通，卡在 YouTube 反爬（另一层问题） |

---

## 二、本机拓扑（实测）

| 项 | 值 |
| --- | --- |
| Windows 侧代理 | QingyunLite（青云 Lite），mixed 端口 `7892` |
| WSL 网络模式 | `networkingMode=mirrored`（`C:\Users\<用户>\.wslconfig`）→ **WSL 内的 `127.0.0.1` 就是 Windows 本机** |
| WSL 是否继承 Windows 代理 | **否**，`.wslconfig` 里 `autoProxy=false` |
| WSL DNS | `dnsTunneling=true`，解析交给 Windows 侧 |
| 代理生效范围 | **进程级环境变量**（systemd 单元 / 你的 shell），不是 WSL 全局 |
| 服务日志 | 走 journal，Windows 侧读不到 → 排障看 `backend/note_results/*.status.json` 的 `message` |

> 关键前提：**systemd 服务不继承你 shell 里手敲的环境变量**。在终端里 `export http_proxy=...` 后 `curl` 能通，**不代表**后端起任务能通——这是本机最容易误判的一点。

---

## 三、配置步骤（改一次，永久生效）

### 1) 写入 drop-in

推荐用 `tee` 直接写文件，绕开 `systemctl edit` 编辑器里那一堆 `#` 参考行的干扰：

```bash
sudo tee /etc/systemd/system/bilinote-backend.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment=http_proxy=http://127.0.0.1:7892
Environment=https_proxy=http://127.0.0.1:7892
Environment=ALL_PROXY=http://127.0.0.1:7892
EOF
```

> **坑**：`sudo systemctl edit bilinote-backend` 打开后，每行带 `#` 的（`# [Unit]`、`# Environment=...`）是**原单元文件的参考副本**（自动注释），不是文件内容。
> 真正生效的内容必须写在 `### Anything between here ...` 与 `### Edits below this comment will be discarded` 之间，写在下面会被丢弃。

### 2) 重新加载并重启

```bash
sudo systemctl daemon-reload
sudo systemctl restart bilinote-backend
```

### 3) 校验

```bash
systemctl show bilinote-backend -p Environment | tr ' ' '\n' | grep -i proxy
```

能列出 `http_proxy= / https_proxy= / ALL_PROXY=` 三行即生效。

---

## 四、`no_proxy` 白名单（单元本体已有，别删）

```
no_proxy=localhost,127.0.0.1,*.cn-beijing.volces.com,ark.cn-beijing.volces.com,dashscope.aliyuncs.com,api.deepseek.com
```

- 含义：这些域名**绕过代理、直连**，压根不会到达 Clash。
- 作用是保住国内 LLM 调用：代理没开 / 挂了 / 换端口，都不会影响它们。
- 新增国内 API 时，**优先加到 `no_proxy`**（独立于代理状态），再在 Clash 里补一条 `DIRECT` 兜底。
- **语法差异、别互相搬**：
  - `no_proxy` 的条目是**朴素后缀匹配**（`requests` 走 `urllib.request.proxy_bypass_environment`，判定就是 `host.endswith(entry)`）。所以 `*.cn-beijing.volces.com` 这种写法**匹配不到任何东西**——这也正是单元里旁边另列了一条裸域名 `ark.cn-beijing.volces.com` 的原因。
  - **一律写裸域名**：`a6api.com` 就能覆盖 `api.a6api.com`，两种实现下都生效。
  - Clash 的 rules 不支持任何通配符写法。

### 关闭 Clash 会怎样（重要）

`no_proxy` 之外的目标**全部走代理**，因此「关掉代理软件」≠「后端网络全废」，而是**部分能力失效**：

| 目标 | 关掉 Clash 后 | 原因 |
| --- | --- | --- |
| `api.deepseek.com` / `dashscope.aliyuncs.com` / `*.cn-beijing.volces.com` | ✅ 正常 | 在 `no_proxy` 里，直连 |
| `127.0.0.1`（Ollama `11434`、后端自身、前端） | ✅ 正常 | 在 `no_proxy` 里 |
| YouTube / Google 等外网 | ❌ 本来就依赖代理 | 设计如此 |
| **`api.a6api.com`（正在用的 provider）**、Groq、其他不在白名单的域名 | ❌ 失败 | 走代理 → 端口无监听 → `ProxyError` |

- **失败特征**：报 `ProxyError` / `Connection refused 127.0.0.1:7892`（**不是超时**）。看到这个就先确认代理软件是否在跑。
- **没有自动回退**：`requests` / `httpx`（OpenAI SDK 底层）在代理连不上时直接抛错，不会退回直连。
- **想让国内 API 免于代理开关影响**：把它加进 `no_proxy`。例如 a6api：

  ```bash
  sudo systemctl edit bilinote-backend   # 在 drop-in 里补一行
  # Environment=no_proxy=localhost,127.0.0.1,a6api.com,api.deepseek.com,dashscope.aliyuncs.com,*.cn-beijing.volces.com,ark.cn-beijing.volces.com
  sudo systemctl daemon-reload && sudo systemctl restart bilinote-backend
  ```

  ⚠️ 注意 drop-in 里重复声明 `no_proxy` 会**整行覆盖**单元本体那一行，必须把原有条目一并写上，否则会丢白名单。
  ⚠️ **不要把 YouTube 加进 `no_proxy`**——那样它会直连，直接撞墙。

---

## 五、为什么不打开 `autoProxy`（`.wslconfig`）

`.wslconfig` 里 `autoProxy=false` 是**有意为之**，四条理由：

1. **会把 WSL 的命脉绑到 Windows 系统代理开关上**——Clash 一关、端口一改、或被别的软件抢走系统代理设置，WSL 全部流量当场断，而报错长得像普通网络故障，极难定位。
2. **可能污染回环**：autoProxy 是全量注入，WSL 内的 `127.0.0.1` 请求也可能被塞进代理，本机服务（8483 / 3015 / 11434）会开始报 502。
3. **粒度不可控**：全有全无，做不到「只让 YouTube 走代理、国内直连」。现在的方案只给后端一个进程开代理。
4. **改完必须 `wsl --shutdown`** 才生效，调试成本高。

**结论：保持 `autoProxy=false` + 服务级 drop-in。** 真要开，先把 `no_proxy` 补齐，否则本机服务会先炸。

---

## 六、分流发生在哪一层

| 路径 | DNS 是否参与 | 谁做分流决策 |
| --- | --- | --- |
| 走 HTTP 代理（当前方式） | **不参与**，域名明文交给 Clash | Clash 的 **rules**（按域名） |
| 走 TUN / 透明代理 | 参与（fake-ip、`nameservers` / `nameserver-policy`） | 先 DNS 接管，再 rules |

- 走 HTTP 代理时客户端发的是 `CONNECT www.youtube.com:443`，**本地不做解析**，所以 Clash 手上只有域名 → 只能按域名规则匹配，**DNS 规则根本不会被触发**。
- 实测本机 TUN（Windows 侧 `QingyunLite Tunnel`）**没有接管 WSL 出口**（否则直连就不会报 `Errno 101`）。所以 DNS 附加规则目前基本不参与。
- **两层不要混**：

  | 层 | 位置 | 决定什么 |
  | --- | --- | --- |
  | `no_proxy` | systemd drop-in / 环境变量 | 要不要**交给**代理 |
  | Clash `rules` | Clash 配置 | 交给之后**走哪条线** |

---

## 七、Clash 规则写法速查

一条规则固定三段：**匹配类型, 匹配值, 动作**。

| 写法 | 命中范围 |
| --- | --- |
| `DOMAIN,a6api.com,DIRECT` | **只**匹配 `a6api.com` 本身，子域不匹配 |
| `DOMAIN,api.a6api.com,DIRECT` | 只匹配这一个精确域名 |
| `DOMAIN-SUFFIX,a6api.com,DIRECT` | `a6api.com` + **所有子域**（含 `api.a6api.com`）← 最常用 |
| `GEOIP,CN,DIRECT` | 按 IP 归属地，标准收尾之一 |
| `MATCH,节点选择` | 兜底，**必须放最后** |

要点：

- **匹配值写完整后缀、含顶级域**，多级后缀也合法（`DOMAIN-SUFFIX,cn-beijing.volces.com`）。
- **不要带协议、端口、路径**（`https://api.a6api.com/v3` 直接失效）。
- **不支持 `*` 通配符**，`DOMAIN-SUFFIX` 自带子域覆盖。
- **自上而下、首条命中即停**：细规则写在前，宽规则/`MATCH` 在后，否则被吃掉。
- **动作只有三类**：`DIRECT`（直连）、`REJECT`（拦截）、节点名或策略组名。
- **验证**：Clash Verge 的「连接」页看每条连接命中的**规则名 + 策略**，别猜。

---

## 八、排障清单

| 现象 | 判断与动作 |
| --- | --- |
| `[Errno 101] Network is unreachable` | 代理没生效 → `systemctl show bilinote-backend -p Environment` 查；改完记得 `daemon-reload` |
| `Sign in to confirm you're not a bot` | 网络层已通，卡反爬 → 见下一节 |
| 本机服务（8483/3015/11434）报 502 | 代理把 `127.0.0.1` 截走了（沙箱代理的经典症状）→ 请求加 `--noproxy '*'` 或补 `no_proxy` |
| YouTube / Google 完全不通，且 `ip -br addr` 里**没有 `eth5`** | TUN 隧道消失（Windows 侧 `QingyunLite Tunnel` 掉了），先看网卡，别怀疑代码 |
| 同一域名时而 0.4 秒通、时而超时 | 隧道本身间歇性卡死，隔几分钟重试再下结论 |

---

## 九、YouTube 反爬（2026-09-19 已解决）

**症状**：网络层通了之后，yt-dlp 报 `Sign in to confirm you're not a bot`。

**结论**：用浏览器扩展 **Get cookies.txt LOCALLY** 在 YouTube 页面导出当前会话 cookie，粘贴到「设置 → 下载器 → YouTube Cookie」，立即恢复正常——实测任务 `29407d60` 全链路通过（下载 → 字幕 → DeepSeek 总结 → 笔记）。

**机制**：YouTube 对「匿名 + 数据中心 IP」的请求做风控，走代理的出口 IP 几乎必被拦；带上**已登录账号的完整 cookie**，请求以账号身份发出，直接放行。所以是「匿名必挂、登录能过」。

**关键认知**：

- **cookie 不是「配了就行」，必须是新鲜的。** `__Secure-*PSID` / `*PSIDTS` 这类是滚动票据，有寿命；过期后 YouTube 视同匿名，于是同样报 bot check。
- **判据**：任务报 `Sign in to confirm you're not a bot` = cookie 过期，**重新导出粘贴一次即可，不要怀疑代码或代理**。
- 导出走扩展而不是手工复制：能拿到当前会话的完整票据集（`__Secure-1PSID` / `__Secure-3PSID` / `__Secure-1PAPISID` / `__Secure-3PAPISID` / `LOGIN_INFO` 等），手工复制容易漏字段。

**遗留观察**（暂不影响功能）：`app/services/cookie_manager.py:28` 的 `write_netscape_cookie_file()` 会把**所有** cookie 的域强行写成传入的 `domain`（如 `.youtube.com`），但 `SID` / `HSID` / `SSID` / `APISID` / `SAPISID` 实际属于 `.google.com` 域。实测 yt-dlp 最终吃到的临时文件里这几条被丢掉了（24 条 → 14 条），真正起作用的是 `.youtube.com` 域的滚动票据。若日后 cookie 覆盖面再出问题，这里是第一个该看的地方。

**更稳的备选方案**（本次未采用）：定期刷新 cookie，或加 `extractor_args={'youtube': {'player_client': ['tv', 'web_safari']}}` 换客户端降低校验概率。

---

## 十、变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-09-19 | 首版。定位到 systemd 单元缺代理变量，drop-in 注入 `127.0.0.1:7892`；网络层打通，卡点转移到 YouTube 反爬 |
| 2026-09-19 | 反爬解决：改用浏览器扩展重新导出 YouTube cookie 粘贴到项目，实测全链路通过；补充 cookie 有效期判据与 `cookie_manager` 的域覆盖观察 |
