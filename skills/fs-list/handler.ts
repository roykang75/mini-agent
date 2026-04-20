import { readdir } from "node:fs/promises";
import { z } from "zod";

const InputSchema = z.object({ path: z.string() });
type FsListInput = z.infer<typeof InputSchema>;

export async function execute(args: FsListInput): Promise<string> {
  const { path } = InputSchema.parse(args);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length === 0) return "(empty directory)";
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .join("\n");
  } catch (e) {
    return `Error: 디렉토리를 읽을 수 없습니다 - ${path} (${(e as Error).message})`;
  }
}
