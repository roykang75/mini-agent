import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const InputSchema = z.object({ path: z.string(), content: z.string() });
type FsWriteInput = z.infer<typeof InputSchema>;

export async function execute(args: FsWriteInput): Promise<string> {
  const { path, content } = InputSchema.parse(args);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return `파일을 성공적으로 작성했습니다: ${path} (${content.length} bytes)`;
  } catch (e) {
    return `Error: 파일을 쓸 수 없습니다 - ${path} (${(e as Error).message})`;
  }
}
