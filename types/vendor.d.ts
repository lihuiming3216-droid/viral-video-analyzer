declare module "ffprobe-static" {
  const value: { path: string; version?: string };
  export default value;
}

declare module "@ffmpeg-installer/ffmpeg" {
  const value: { path: string; version: string; url: string };
  export default value;
}
