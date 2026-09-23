"""从 macOS 按需下载的字体包(.ttc)里抽出单个字体 —— Chromium 看不到这些字体,
手绘图解要用手写体,就抽成 .otf 由页面自己加载。抽出来的文件只在本机用,不进仓库。"""
import subprocess, sys
from pathlib import Path
from fontTools.ttLib import TTCollection

WANT = {"HannotateSC-W7": "Hannotate.ttc"}
out = Path(__file__).resolve().parent.parent / "fonts"
out.mkdir(exist_ok=True)
listing = subprocess.run(["fc-list", ":", "file"], capture_output=True, text=True).stdout.splitlines()
for ps, ttc in WANT.items():
    target = out / f"{ps}.otf"
    if target.exists():
        continue
    path = next((l.split(":")[0] for l in listing if l.split(":")[0].endswith("/" + ttc)), None)
    if not path:
        print(f"没找到 {ttc}(系统设置 → 字体 里下载「手札体」「翩翩体」)", file=sys.stderr)
        continue
    for font in TTCollection(path).fonts:
        if font["name"].getDebugName(6) == ps:
            font.save(str(target))
            print(f"抽出 {target.name} ({target.stat().st_size // 1024} KB)")
            break
