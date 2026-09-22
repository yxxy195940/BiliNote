import json
import logging
import tempfile
from pathlib import Path
from typing import Optional, Dict

logger = logging.getLogger(__name__)


def write_netscape_cookie_file(cookie: Optional[str], domain: str, platform: str = "") -> Optional[str]:
    """
    把浏览器里复制的 Cookie 字符串写成 yt-dlp 可用的 Netscape 格式临时文件。

    :param cookie: 形如 "a=1; b=2" 的 Cookie 字符串
    :param domain: Cookie 生效域名，如 .bilibili.com / .youtube.com
    :param platform: 仅用于日志
    :return: 临时文件路径；未配置 Cookie 时返回 None
    """
    if not cookie:
        return None

    lines = ["# Netscape HTTP Cookie File\n"]
    # 支持带/不带空格的分号分隔，并进行 strip
    for pair in cookie.split(";"):
        pair = pair.strip()
        if "=" in pair:
            key, value = pair.split("=", 1)
            lines.append(f"{domain}\tTRUE\t/\tFALSE\t0\t{key}\t{value}\n")

    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8")
    tmp.writelines(lines)
    tmp.close()
    logger.info("已生成 %s Netscape Cookie 文件: %s (条目: %d)", platform or domain, tmp.name, len(lines) - 1)
    return tmp.name


class CookieConfigManager:
    def __init__(self, filepath: str = "config/downloader.json"):
        self.path = Path(filepath)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write({})

    def _read(self) -> Dict[str, Dict[str, str]]:
        try:
            with self.path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _write(self, data: Dict[str, Dict[str, str]]):
        with self.path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get(self, platform: str) -> Optional[str]:
        data = self._read()
        return data.get(platform, {}).get("cookie")

    def set(self, platform: str, cookie: str):
        data = self._read()
        data[platform] = {"cookie": cookie}
        self._write(data)

    def delete(self, platform: str):
        data = self._read()
        if platform in data:
            del data[platform]
            self._write(data)

    def list_all(self) -> Dict[str, str]:
        data = self._read()
        return {k: v.get("cookie", "") for k, v in data.items()}

    def exists(self, platform: str) -> bool:
        return self.get(platform) is not None