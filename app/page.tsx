import { redirect } from "next/navigation";

/** The web analysis workspace was retired on 2026-10-31; work happens in Feishu and the admin console. */
export default function Home() {
  redirect("/admin");
}
