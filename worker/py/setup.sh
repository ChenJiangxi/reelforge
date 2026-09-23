#!/bin/bash
# 手绘图解和音效要的本机资源(都不进仓库):Python 环境、从系统字体包抽出的手写体、Mixkit 音效。
# 在 worker 所在的机器上跑一次就行;跑过的部分会跳过。
set -e
cd "$(dirname "$0")/../.."
PY=${PYTHON:-/opt/homebrew/bin/python3.12}
[ -x worker/py/.venv/bin/python ] || "$PY" -m venv worker/py/.venv
worker/py/.venv/bin/pip install -q --disable-pip-version-check numpy==2.2.6 opencv-python-headless==4.12.0.88 Pillow==11.3.0 fonttools
worker/py/.venv/bin/python worker/py/extract_fonts.py
node worker/sfx/fetch.mjs
echo "手绘 + 音效 就绪"
