"use server";

import { revalidatePath } from "next/cache";
import { getVideo } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";
import { requireAdmin } from "@/lib/require-admin";

export async function retryVideoAction(formData: FormData) {
  await requireAdmin();
  const videoId = String(formData.get("videoId") || "");
  if (!videoId) return;
  const video = await getVideo(videoId, false);
  if (!video || !["failed", "stopped"].includes(video.status)) return;
  await enqueueVideos([videoId], { restart: true });
  revalidatePath("/admin/tasks");
}
