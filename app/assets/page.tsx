import { listAssets } from "@/lib/media";
import { AssetLibrary } from "@/components/AssetLibrary";

export const dynamic = "force-dynamic";

export default function AssetsPage() {
  const assets = listAssets("_global");
  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">素材库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            全局共享,所有项目的素材阶段都会挑着用。真素材永远优先于字卡。
          </p>
        </div>
      </div>
      <AssetLibrary assets={assets} />
    </div>
  );
}
