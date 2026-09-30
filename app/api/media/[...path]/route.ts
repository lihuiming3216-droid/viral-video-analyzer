import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { contentTypeForMedia, resolveMediaPath } from "@/lib/video-processing";
import { parseMediaRange } from "@/lib/media-range";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path: parts } = await context.params;
    const relative = parts.join("/");
    const absolute = resolveMediaPath(relative);
    const stat = statSync(absolute);
    if (!stat.isFile()) return new Response("Not found", { status: 404 });
    const range = request.headers.get("range");
    if (range) {
      const parsed = parseMediaRange(range, stat.size);
      if (!parsed) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
      const { start, end } = parsed;
      const stream = Readable.toWeb(createReadStream(absolute, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          "Content-Type": contentTypeForMedia(relative),
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
    const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": contentTypeForMedia(relative),
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
