import { readFile } from "fs/promises";
import { z } from "zod";

export const readFileTool = {
  name: "read_file" as const,
  description: "파일의 내용을 읽어서 반환합니다.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, description: "읽을 파일의 경로" },
    },
    required: ["path"],
  },
};

const InputSchema = z.object({ path: z.string() });

export async function executeReadFile(input: unknown): Promise<string> {
  const { path } = InputSchema.parse(input);
  try {
    return await readFile(path, "utf-8");
  } catch (e) {
    return `Error: 파일을 읽을 수 없습니다 - ${path} (${(e as Error).message})`;
  }
}
