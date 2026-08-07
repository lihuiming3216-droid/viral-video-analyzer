import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dataRoot = path.join(process.cwd(), ".data");
const keyPath = path.join(dataRoot, "secret.key");

function getMasterKey() {
  mkdirSync(dataRoot, { recursive: true });
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("本机密钥文件无效，请恢复备份或重新配置 API Key");
  return key;
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(value: string | null | undefined) {
  if (!value) return "";
  const [version, ivText, tagText, payload] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !payload) throw new Error("API Key 加密数据无效");
  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]).toString("utf8");
}
