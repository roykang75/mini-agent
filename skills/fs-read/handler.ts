import { readFile } from "node:fs/promises";
import { z } from "zod";

const InputSchema = z.object({ path: z.string() });
type FsReadInput = z.infer<typeof InputSchema>;

export async function execute(args: FsReadInput): Promise<string> {
  const { path } = InputSchema.parse(args);
  try {
    return await readFile(path, "utf-8");
  } catch (e) {
    return `Error: 파일을 읽을 수 없습니다 - ${path} (${(e as Error).message})`;
  }
}
