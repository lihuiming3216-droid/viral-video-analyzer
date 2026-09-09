"use server";

import { revalidatePath } from "next/cache";
import { getVideo } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";

export async function retryVideoAction(formData: FormData) {
  const videoId = String(formData.get("videoId") || "");
  if (!videoId) return;
  const video = await getVideo(videoId, false);
  if (!video || !["failed", "stopped"].includes(video.status)) return;
  await enqueueVideos([videoId]);
  revalidatePath("/admin/tasks");
}
