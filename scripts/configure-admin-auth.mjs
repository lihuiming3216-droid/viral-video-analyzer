// Run interactively on the intended server/container. No default password and no plaintext output.
import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

if (!process.stdin.isTTY) throw new Error("请在交互终端运行，不接受命令行明文密码参数");
const ui = readline.createInterface({ input: process.stdin, output: process.stdout });
const username = (await ui.question("后台账号: ")).trim();
ui.close();
if (!/^[A-Za-z0-9_-]{1,64}$/.test(username)) throw new Error("账号格式无效");

async function password(label) {
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = "";
      const onData = buffer => {
        for (const char of buffer.toString("utf8")) {
          if (char === "\u0003") { finish(); reject(new Error("已取消")); return; }
          if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
      };
      const finish = () => { process.stdin.off("data", onData); process.stdout.write("\n"); };
      process.stdin.on("data", onData);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); }
}
const secret = await password("密码（不显示）: ");
if (secret.length < 6 || secret.length > 1024 || secret !== await password("再次输入密码（不显示）: ")) throw new Error("密码不一致或长度不合要求");
const salt = randomBytes(16).toString("hex");
const target = path.join(process.cwd(), ".data", "admin-auth.json");
await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
const temporary = target + "." + randomBytes(8).toString("hex") + ".tmp";
const file = await open(temporary, "wx", 0o600);
try {
  await file.writeFile(JSON.stringify({ username, salt, passwordHash: scryptSync(secret, salt, 64).toString("hex") }));
  await file.sync();
} finally { await file.close(); }
await rename(temporary, target);
console.log("后台账号已保存，仅存密码哈希；请通过HTTPS登录。");
