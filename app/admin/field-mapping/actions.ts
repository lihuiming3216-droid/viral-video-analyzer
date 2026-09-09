"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteFeishuFieldMapping, getFeishuFieldMapping, saveFeishuFieldMapping } from "@/lib/database";
import { defaultFeishuAutomationFieldMap, parseFeishuBaseUrl, type FeishuAutomationFieldMap } from "@/lib/feishu/automation";

const FIELD_KEYS = Object.keys(defaultFeishuAutomationFieldMap) as Array<keyof FeishuAutomationFieldMap>;

/** Step 1: turn a pasted Base URL into a scope key and jump into the editor. */
export async function startFieldMappingFromUrlAction(formData: FormData) {
  const pastedUrl = String(formData.get("pastedUrl") || "").trim();
  const parsed = pastedUrl ? parseFeishuBaseUrl(pastedUrl) : null;
  if (!parsed) {
    redirect(`/admin/field-mapping?new=1&urlError=1`);
  }
  redirect(`/admin/field-mapping?scope=${encodeURIComponent(`${parsed.appToken}:${parsed.tableId}`)}&edit=1`);
}

/**
 * Step 2: save the per-real-column selections. The edit form lists every
 * real column Feishu reports for this table (colname_<fieldId>) next to a
 * dropdown of which system field should be written there (select_<fieldId>,
 * empty = unused). Because that list is now the table's actual schema, a
 * system field nobody assigned defaults to "" (skip) rather than falling
 * back to a maybe-wrong code default — see setMappedField in automation.ts.
 */
export async function saveFieldMappingAction(formData: FormData) {
  const scopeKey = String(formData.get("scopeKey") || "").trim();
  const label = String(formData.get("label") || "").trim();
  if (!scopeKey) return;

  const fieldMap: Record<string, string> = Object.fromEntries(FIELD_KEYS.map((key) => [key, ""]));
  for (const [name, rawValue] of formData.entries()) {
    if (!name.startsWith("select_") || !rawValue) continue;
    const fieldId = name.slice("select_".length);
    const systemKey = String(rawValue);
    const columnName = String(formData.get(`colname_${fieldId}`) || "").trim();
    if (!columnName || !(systemKey in fieldMap)) continue;
    // If a mistake assigns the same system field to two columns, the last
    // one submitted wins — forgiving over a hard validation error, since the
    // fix is just picking again, not losing the whole in-progress form.
    fieldMap[systemKey] = columnName;
  }

  // The old text-input UI also let someone attach extra recognized aliases
  // per field; that config still lives on scopes nobody has re-saved here.
  // Preserve it rather than silently wiping it out just because this newer
  // column-driven form has no alias input of its own.
  const existing = await getFeishuFieldMapping(scopeKey);
  await saveFeishuFieldMapping({ scopeKey, label: label || scopeKey, fieldMap, aliases: existing?.aliases || {} });
  revalidatePath("/admin/field-mapping");
  redirect(`/admin/field-mapping?scope=${encodeURIComponent(scopeKey)}`);
}

export async function deleteFieldMappingAction(formData: FormData) {
  const scopeKey = String(formData.get("scopeKey") || "").trim();
  if (!scopeKey) return;
  await deleteFeishuFieldMapping(scopeKey);
  revalidatePath("/admin/field-mapping");
}
