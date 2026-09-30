// Keeps transpiled data-URL stacks out of terminal logs without hiding failures.
export default async function* report(events) {
  for await (const event of events) {
    if (event.type === "test:fail") {
      const error = event.data.details?.error?.cause || event.data.details?.error;
      yield JSON.stringify({ type: "fail", file: event.data.file?.split("/").at(-1), name: event.data.name,
        reason: String(error?.message || "").replace(/data:text[^\s]+/g, "[compiled fixture]").slice(0, 1200) }) + "\n";
    }
    if (event.type === "test:summary") yield JSON.stringify({ type: "summary", ...event.data }) + "\n";
  }
}
