// 浏览器端上传素材:返回一句要给她看的话(失败原因 / 跳过了哪些),全成功返回 null。
// 以前两个上传入口都不看返回值,盘满、格式不对、断网都是静默失败。
export async function uploadFiles(url: string, files: FileList): Promise<string | null> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  try {
    const r = await fetch(url, { method: "POST", body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return `上传失败:${d.error ?? `服务器返回 ${r.status}`}`;
    if (Array.isArray(d.skipped) && d.skipped.length) return `这些不是视频或图片,没收:${d.skipped.join("、")}`;
    return null;
  } catch {
    return "上传失败:网络断了,或者文件太大传到一半断开";
  }
}
