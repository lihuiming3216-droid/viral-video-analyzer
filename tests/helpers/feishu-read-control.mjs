import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../../lib/feishu/read-control.ts", import.meta.url), "utf8");
export const readControlUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
