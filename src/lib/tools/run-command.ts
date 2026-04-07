import { exec } from "child_process";
import { z } from "zod";

export const runCommandTool = {
  name: "run_command" as const,
  description: "쉘 명령을 실행하고 결과를 반환합니다.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: { type: "string" as const, description: "실행할 쉘 명령" },
    },
    required: ["command"],
  },
};

const InputSchema = z.object({ command: z.string() });

const TIMEOUT_MS = 30_000;

export async function executeRunCommand(input: unknown): Promise<string> {
  const { command } = InputSchema.parse(input);

  return new Promise((resolve) => {
    exec(command, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Error (exit ${error.code ?? "?"}): ${stderr || error.message}\n${stdout}`.trim());
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve(output || "(no output)");
    });
  });
}
