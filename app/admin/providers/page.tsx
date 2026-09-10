import { listProviderSettings } from "@/lib/database";
import { listAiSettings } from "@/lib/ai/settings";
import { requireAdmin } from "@/lib/require-admin";
import { AdminTopbar } from "../AdminTopbar";
import { PurposeForm, SharedProviderForm } from "./SettingsForms";

export const dynamic = "force-dynamic";

export default async function AdminProvidersPage() {
  await requireAdmin();
  const [settings, purposes] = await Promise.all([listProviderSettings(), listAiSettings()]);
  return <>
    <AdminTopbar title="模型与接口设置" />
    <div className="provider-settings">
      <div className="admin-card provider-note">
        <h2>按用途配置，互不替代</h2>
        <p>商品资料读取出海匠的已存图文；手卡视频发送完整MP4和原音轨；中文翻译独立处理口播。任务安排表不增加视频分析。</p>
        <p>保存设置不会请求模型、出海匠，也不会重跑旧资料。选定接口出错会报错，不自动换模型。已有商品仍复用缓存。</p>
      </div>
      {purposes.map(setting => <PurposeForm key={JSON.stringify(setting)} {...setting} />)}
      <h2>共享接口与密钥</h2>
      <p>三种用途可沿用下面的共享配置，也可在各自卡片内填写独立接口和密钥。密钥加密保存，只显示是否已配置。</p>
      {settings.map(setting => <SharedProviderForm key={setting.provider + setting.updatedAt} setting={setting}
        environmentKeyAvailable={setting.provider === "openai" && setting.baseUrl === "https://api.openai.com/v1" && Boolean(process.env.OPENAI_API_KEY?.trim())} />)}
    </div>
  </>;
}
