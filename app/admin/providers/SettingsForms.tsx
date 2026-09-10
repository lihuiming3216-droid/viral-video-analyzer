"use client";
import { useActionState, useState } from "react";
import { AI_LABELS, type AiSettings } from "@/lib/ai/types";
import type { ProviderSetting } from "@/lib/types";
import { saveAiPurposeAction, saveProviderAction, type ProviderTestResult } from "./actions";
import { TestConnectionButton } from "./TestConnectionButton";

function Result({ state }: { state: ProviderTestResult | null }) {
  return state && <p role="status" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.ok ? state.message : state.error}</p>;
}

export function PurposeForm({ config, hasCustomKey, saved }: { config: AiSettings; hasCustomKey: boolean; saved: boolean }) {
  const [state, action, pending] = useActionState(saveAiPurposeAction, null);
  const [provider, setProvider] = useState(config.provider);
  const [source, setSource] = useState(config.credentialSource);
  const [model, setModel] = useState(config.model);
  const [audioConfirmed, setAudioConfirmed] = useState(config.videoAudioConfirmed);
  const options = config.purpose === "product" ? ["qwen3.7-plus"] : config.purpose === "video" ? ["qwen3.5-omni-plus", "qwen3.5-omni-flash", "qwen3-omni-flash"] : ["qwen-plus", "qwen-turbo"];
  return <form action={action} className="admin-card provider-form">
    <input type="hidden" name="purpose" value={config.purpose} />
    <h2>{AI_LABELS[config.purpose]}</h2>
    <p>{saved ? "已保存独立用途设置，优先于旧环境变量与旧模型设置。" : "当前沿用初始或原有模型；保存后以本卡设置为准。"}</p>
    <div className="provider-grid">
      <label>服务商<select name="provider" value={provider} onChange={e => { const next = e.target.value as AiSettings["provider"]; setProvider(next); setModel(""); setAudioConfirmed(false); if (next === "compatible") setSource("custom"); }}>
        <option value="qwen">Qwen / 百炼</option>
        {config.purpose !== "video" && <option value="openai">OpenAI</option>}
        <option value="compatible">自定义兼容接口</option>
      </select></label>
      <label>模型名称<input name="model" required value={model} onChange={e => { setModel(e.target.value); setAudioConfirmed(false); }} list={"models-" + config.purpose} autoComplete="off" />
        <datalist id={"models-" + config.purpose}>{options.map(model => <option key={model} value={model} />)}</datalist>
      </label>
      <label>接口与密钥来源<select name="credentialSource" value={source} onChange={e => { setSource(e.target.value as AiSettings["credentialSource"]); setAudioConfirmed(false); }}>
        <option value="shared" disabled={provider === "compatible"}>沿用对应服务商共享配置</option><option value="custom">本用途单独填写</option>
      </select></label>
      <label>失败后额外重试<select name="retries" defaultValue={config.retries}>
        <option value="0">0次（最多请求1次）</option><option value="1">1次（最多请求2次，可能重复计费）</option>
      </select></label>
    </div>
    {source === "custom" && <div className="provider-grid">
      <label>HTTPS接口根地址<input name="baseUrl" required type="url" defaultValue={config.baseUrl} onChange={() => setAudioConfirmed(false)} placeholder="https://example.com/v1" /></label>
      <label>独立API Key{hasCustomKey ? "（已配置，留空不修改）" : "（未配置）"}<input name="apiKey" type="password" autoComplete="new-password" /></label>
      <label className="provider-check"><input name="clearKey" type="checkbox" />明确清除已存独立密钥</label>
    </div>}
    {config.purpose === "video" && <label className="provider-check"><input name="videoAudioConfirmed" type="checkbox" checked={audioConfirmed} onChange={e => setAudioConfirmed(e.target.checked)} />确认该接口与模型支持完整MP4画面及原音轨；仅支持图片、抽帧或文字的模型不能使用。</label>}
    <p>商品/翻译各次超时分别为120秒/60秒；视频单次600秒。其他模型需实际验证，名称能保存不代表能力已验证。</p>
    {config.purpose === "product" && <p>商品仅对网络、限流和服务故障按设置重试。返回格式有误先保存响应供排查，不为格式问题自动再收费。</p>}
    <button disabled={pending}>{pending ? "保存中…" : "保存本用途"}</button><Result state={state} />
  </form>;
}

export function SharedProviderForm({ setting, environmentKeyAvailable = false }: { setting: ProviderSetting; environmentKeyAvailable?: boolean }) {
  const [state, action, pending] = useActionState(saveProviderAction, null);
  return <section className="admin-card provider-form"><form action={action}>
    <h2>{setting.provider === "qwen" ? "Qwen共享配置" : setting.provider === "openai" ? "OpenAI共享配置（可选）" : "TokScript"}</h2>
    <input type="hidden" name="provider" value={setting.provider} />
    <input type="hidden" name="model" value={setting.model} />
    <div className="provider-grid">
      <label>接口根地址<input name="baseUrl" type="url" required defaultValue={setting.baseUrl} /></label>
      <label>API Key{setting.hasKey ? "（已配置，留空不修改）" : environmentKeyAvailable ? "（可沿用服务器配置）" : "（未配置）"}<input name="apiKey" type="password" autoComplete="new-password" /></label>
      <label className="provider-check"><input name="enabled" type="checkbox" defaultChecked={setting.enabled} />启用共享配置</label>
      <label className="provider-check"><input name="clearKey" type="checkbox" />明确清除已存密钥</label>
    </div>
    {environmentKeyAvailable && <p>服务器另有旧OpenAI密钥，仅可发送到官方地址。清除按钮只清除后台保存的密钥；要停止共享调用，请取消启用。</p>}
    <button disabled={pending}>{pending ? "保存中…" : "保存共享配置"}</button><Result state={state} />
  </form>{setting.provider !== "openai" && <TestConnectionButton provider={setting.provider} />}</section>;
}
