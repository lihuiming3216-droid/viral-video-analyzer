import type { Metadata } from "next";
import ViralAnalyzerApp from "./ViralAnalyzerApp";

export const metadata: Metadata = {
  title: "爆片分析",
  description: "TikTok 带货视频多模态拆解与产品爆片档案库",
};

export default function Home() {
  return <ViralAnalyzerApp />;
}
