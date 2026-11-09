"use client";

import { Download, Ellipsis, Layers, RotateCw, Trash2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { deleteAssetAction, retryProcessingAction } from "@/server/actions/org";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { MenuList } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { useUploader } from "./uploader";

export function AssetActions({
  orgSlug,
  projectId,
  asset,
  versionId,
  can,
}: {
  orgSlug: string;
  projectId: string;
  asset: { id: string; name: string; kind: string; folderId: string | null };
  versionId: string | null;
  can: { download: boolean; version: boolean; delete: boolean };
}) {
  const { enqueue } = useUploader();
  const input = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <div className="flex items-center gap-2">
      {can.version && (
        <>
          <Button size="sm" onClick={() => input.current?.click()}>
            <Layers size={13} /> Upload new version
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            data-testid="version-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) enqueue([f], { orgSlug, projectId, folderId: asset.folderId, assetId: asset.id, label: `new version of ${asset.name}` });
              e.target.value = "";
            }}
          />
        </>
      )}
      {can.download && versionId && (
        <a href={`/api/v1/orgs/${orgSlug}/versions/${versionId}/download`} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-hover">
          <Download size={13} /> Download
        </a>
      )}
      {can.delete && (
        <>
          <IconButton ref={more} label="More actions" onClick={() => setMenu((m) => !m)}>
            <Ellipsis size={15} />
          </IconButton>
          {menu && (
            <MenuList
              anchor={more}
              onClose={() => setMenu(false)}
              items={[{ label: "Delete asset", icon: <Trash2 size={13} />, danger: true, onSelect: () => setConfirm(true) }]}
            />
          )}
          <Dialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title={`Delete “${asset.name}”?`}
            description="All versions of this asset will be removed from the project."
            footer={
              <>
                <Button onClick={() => setConfirm(false)}>Cancel</Button>
                <Button
                  variant="danger"
                  loading={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await deleteAssetAction(orgSlug, projectId, asset.id);
                      if (res && !res.ok) toast(res.error.message, "error");
                    })
                  }
                >
                  Delete
                </Button>
              </>
            }
          />
        </>
      )}
    </div>
  );
}

export function RetryButton({ orgSlug, versionId }: { orgSlug: string; versionId: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <Button
      size="sm"
      className="mt-2"
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await retryProcessingAction(orgSlug, versionId);
          toast(res.ok ? "Processing queued again" : res.error.message, res.ok ? "success" : "error");
        })
      }
    >
      <RotateCw size={13} /> Retry processing
    </Button>
  );
}
