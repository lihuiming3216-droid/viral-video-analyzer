import type { Metadata } from "next";
import HandcardApp from "./HandcardApp";

export const metadata: Metadata = { title: "补录手卡 · 表格配置", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function Page() { return <HandcardApp />; }
