import { desktopCapturer, screen } from "electron";

export interface CapturedImage {
  data: string;
  mediaType: "image/png";
}

export async function captureScreenshotBase64(): Promise<CapturedImage | null> {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });
    const primary = sources[0];
    if (!primary || primary.thumbnail.isEmpty()) return null;

    return { data: primary.thumbnail.toPNG().toString("base64"), mediaType: "image/png" };
  } catch (err) {
    console.error("Screen capture failed:", err);
    return null;
  }
}
