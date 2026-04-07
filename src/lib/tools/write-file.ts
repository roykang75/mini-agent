import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";

export const writeFileTool = {
  name: "write_file" as const,
  description: "파일에 내용을 작성합니다. 디렉토리가 없으면 자동 생성합니다.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, description: "작성할 파일의 경로" },
      content: { type: "string" as const, description: "파일에 작성할 내용" },
    },
    required: ["path", "content"],
  },
};

const InputSchema = z.object({ path: z.string(), content: z.string() });

export async function executeWriteFile(input: unknown): Promise<string> {
  const { path, content } = InputSchema.parse(input);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return `파일을 성공적으로 작성했습니다: ${path} (${content.length} bytes)`;
  } catch (e) {
    return `Error: 파일을 쓸 수 없습니다 - ${path} (${(e as Error).message})`;
  }
}
