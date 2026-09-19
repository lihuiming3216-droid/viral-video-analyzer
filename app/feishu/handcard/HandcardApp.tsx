"use client";

import { useEffect, useState } from "react";
import styles from "./handcard.module.css";

type Field = { field_id: string; field_name: string; type: number };
type Key = "pid" | "productName" | "productDocument" | "productCardStatus";
type Table = { table_id: string; name: string };
type Loaded = { appToken: string; tableId: string; tableName: string; fields: Field[]; selectedFields: Record<Key, string>; revision: string };
const choices: { key: Key; label: string; hint: string; required?: boolean }[] = [
  { key: "pid", label: "PID", hint: "必选文本列。请勿用数字列存储商品长编号。", required: true },
  { key: "productName", label: "产品名称", hint: "可选。名称为空时按 PID 获取，优先复用缓存。" },
  { key: "productDocument", label: "产品手卡", hint: "必选文本列，用于回填文档链接。", required: true },
  { key: "productCardStatus", label: "手卡状态", hint: "可选文本列，用于显示进度和失败原因。" },
];

async function api(action: string, data: Record<string, unknown> = {}) {
  const response = await fetch("/feishu/handcard/api", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "暂时无法完成，请重新登录后再试。");
  return result;
}

export default function HandcardApp() {
  const [name, setName] = useState("");
  const [checking, setChecking] = useState(true);
  const [link, setLink] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [tableId, setTableId] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Record<Key, string>>({ pid: "", productName: "", productDocument: "", productCardStatus: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/feishu/handcard/api", { cache: "no-store" }).then(async response => {
      const body = await response.json();
      if (!active) return;
      if (response.ok) setName(body.name);
      else if (response.status !== 401) setError(body.error || "服务暂不可用。");
      if (new URLSearchParams(window.location.search).has("loginError")) setError("飞书登录未完成。请确认应用已发布、你在可用范围内，再重新登录。");
    }).catch(() => { if (active) setError("连接失败，请刷新页面。"); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(""); setSaved(false);
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function discover() {
    setLoaded(null); setTables([]); setTableId("");
    const result = await api("discover", { link });
    setTables(result.tables);
    setTableId(result.tables.some((table: Table) => table.table_id === result.suggestedTableId)
      ? result.suggestedTableId : result.tables.length === 1 ? result.tables[0].table_id : "");
  }
  async function load() {
    setLoaded(null);
    const result = await api("load", { link, tableId }) as Loaded;
    setLoaded(result); setSelected(result.selectedFields);
  }
  async function save() {
    if (!loaded) return;
    await api("save", { link, tableId: loaded.tableId, fields: selected, revision: loaded.revision });
    // Invalidate the old revision locally; another save requires a fresh read.
    setSaved(true);
  }

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><span className={styles.badge}>公司内部应用</span><h1>补录手卡</h1><p>配置一次表格，之后在行内点击按钮即可。</p></div>
      {name && <div className={styles.account}><span>{name}</span><button disabled={busy} onClick={() => run(async () => {
        const response = await fetch("/feishu/handcard/api", { method: "DELETE" });
        if (!response.ok) throw new Error("退出失败，请重试。");
        setName(""); setTables([]); setLoaded(null); setLink("");
      })}>退出</button></div>}
    </header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {checking ? <section className={styles.card}>正在检查登录状态…</section> : !name ? <section className={styles.card}>
      <h2>使用飞书身份登录</h2><p>公司同事均可使用，仅能配置自己有编辑权限的表格。无需服务器账号或应用密钥。</p>
      <a className={styles.primary} href="/feishu/handcard/auth/login">使用飞书登录</a>
    </section> : <>
      <section className={styles.card}>
        <h2><span>1</span> 选择多维表格</h2>
        <label htmlFor="table-link">表格链接</label>
        <div className={styles.row}><input id="table-link" type="url" placeholder="粘贴飞书多维表格或知识库链接" value={link} disabled={busy}
          onChange={event => { setLink(event.target.value); setTables([]); setLoaded(null); setSaved(false); }} />
          <button className={styles.primary} disabled={busy || !link.trim()} onClick={() => run(discover)}>读取表格</button></div>
        <p className={styles.hint}>支持知识库里的多维表格；不支持普通电子表格。读取和保存均不会创建手卡。</p>
        {tables.length > 0 && <div className={styles.row}>
          <select aria-label="选择数据表" value={tableId} disabled={busy} onChange={event => { setTableId(event.target.value); setLoaded(null); setSaved(false); }}>
            <option value="">请选择其中一张数据表</option>{tables.map(table => <option key={table.table_id} value={table.table_id}>{table.name}</option>)}
          </select><button disabled={!tableId || busy} onClick={() => run(load)}>读取字段</button>
        </div>}
      </section>
      {loaded && <section className={styles.card}>
        <h2><span>2</span> 对应字段 · {loaded.tableName}</h2>
        <div className={styles.grid}>{choices.map(choice => <div key={choice.key}>
          <label htmlFor={`field-${choice.key}`}>{choice.label}{choice.required && <em> *</em>}</label>
          <select id={`field-${choice.key}`} value={selected[choice.key]} disabled={busy || saved}
            onChange={event => setSelected({ ...selected, [choice.key]: event.target.value })}>
            <option value="">{choice.required ? "请选择对应列" : "不使用此列"}</option>
            {loaded.fields.filter(field => field.type === 1)
              .map(field => <option key={field.field_id} value={field.field_id}>{field.field_name}</option>)}
          </select><p className={styles.hint}>{choice.hint}</p>
        </div>)}</div>
        <p className={styles.hint}>只调整上述四项，不修改视频流程。同事同时修改时会要求重新读取，避免覆盖。</p>
        <div className={styles.row}><button className={styles.primary} disabled={busy || saved || !selected.pid || !selected.productDocument} onClick={() => run(save)}>保存配置</button>
          <button disabled={busy} onClick={() => run(load)}>重新读取</button><span aria-live="polite">{busy ? "处理中…" : ""}</span></div>
      </section>}
      {saved && loaded && <section className={`${styles.card} ${styles.success}`} role="status">
        <h2>配置已保存</h2><p>接下来由你在这张表里设置「补录手卡」按钮自动化。已有按钮可继续使用；请求中不要再传旧的字段对应关系。</p>
        <p>使用现有补录手卡接口和管理员保存的请求密钥。请求内容如下：</p>
        <pre>{JSON.stringify({ appToken: loaded.appToken, tableId: loaded.tableId, recordId: "请插入触发记录的记录ID变量" }, null, 2)}</pre>
        <p className={styles.hint}>接口路径：/api/feishu/automation。recordId 必须插入飞书的动态变量，不能把上面的提示文字原样发送。密钥不在本页面展示。</p>
        <p>点击行内按钮才开始补录；已有手卡按 PID 复用，链接只回填当前行。</p>
      </section>}
    </>}
    <footer className={styles.footer}>新应用管理配置 · 原服务生成手卡 · 不自动扫描或批量创建</footer>
  </main>;
}
