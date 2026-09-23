"""手绘图解的落墨渲染入口:stdin 收一个 JSON,渲出一段 mp4。

{ "image": 手绘风格底图 png(纯白纸面), "output": 输出 mp4, "ffmpeg": ffmpeg 路径,
  "fps": 30, "durationMs": 这一拍的时长, "showHand": true,
  "annotation": { "canvas": {"width","height"}, "rendering": {...}, "elements": [
      { "id", "region": {x,y,width,height}, "reveal": {"startMs","durationMs","direction","protectedRegions":[]} } ] } }

落墨逻辑全在 whiteboard/(拷自 MuseDock,见 PROVENANCE.md);这里只负责按我们的参数把它跑起来,
并在最后报告有多少笔迹没被任何分区盖住(那部分画不出来)。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent / "whiteboard"
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
import stream_primitives as sr  # noqa: E402
import handwritten_media as hm  # noqa: E402
import ffmpeg_frame_sink  # noqa: E402


def main():
    data = json.load(sys.stdin)
    image = sr._imread_any(data["image"])
    if image is None:
        raise ValueError("底图读不出来")
    ann = data["annotation"]
    width, height = ann["canvas"]["width"], ann["canvas"]["height"]
    if image.shape[:2] != (height, width):
        raise ValueError(f"底图是 {image.shape[1]}x{image.shape[0]},画幅是 {width}x{height},不能拉伸")
    fps = int(data.get("fps", 30))
    show_hand = bool(data.get("showHand", True))
    renderer = hm.HandwrittenRegionRenderer(
        image, ann, sr.Config(fps=fps), HERE / "drawing-hand.png" if show_hand else None, not show_hand,
        output_size=(width, height),
    )
    # 覆盖率:分区之外的笔迹永远画不出来,报出来写进决定清单
    covered = np.zeros(renderer.ink_pixels.shape, dtype=bool)
    for mask in renderer.element_masks.values():
        covered |= mask
    ink = int(renderer.ink_pixels.sum())
    coverage = float((renderer.ink_pixels & covered).sum()) / ink if ink else 1.0

    def sink(path, **kw):
        return ffmpeg_frame_sink.FFmpegFrameSink(path, ffmpeg_executable=data["ffmpeg"], preset="fast", encoder_threads=4, **kw)

    frames = int(data["frameCount"])
    renderer.render_to(Path(data["output"]), int(data["durationMs"]), target_frame_count=frames,
                       scene_start_ms=0, scene_start_frame=0, sink_factory=sink)
    print(json.dumps({"ok": True, "frames": frames, "coverage": round(coverage, 4)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 让 node 那边拿到一句人话
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:400]}, ensure_ascii=False))
        sys.exit(1)
