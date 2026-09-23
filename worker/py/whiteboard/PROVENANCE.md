# 来源

这个目录是手绘图解的落墨程序(把一张手绘风格的图,按分区一笔一笔"画"出来的视频)。

- 拷自 [renmengwen/MuseDock](https://github.com/renmengwen/MuseDock) `server/resources/whiteboard/`
  (2026-09-17 提交 65030fb),Apache-2.0,许可证原文见 `LICENSE-MuseDock`。
- MuseDock 自己又是从 `srt-whiteboard-animation` 抽出来的,逐文件的来源和哈希见 `sources.json`。
- 改动:`media.py` 里 `canvas-formats.json` 的路径改成同目录;`drawing-hand.png` 笔杆上原作者的署名「@moveR」抹掉了(成片会发到平台上,不能带别人的署名)。其余原样,入口是上一级的 `draw.py`。
