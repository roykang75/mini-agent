import { exec } from "node:child_process";
import { z } from "zod";

const InputSchema = z.object({ command: z.string() });
type ShellRunInput = z.infer<typeof InputSchema>;

const TIMEOUT_MS = 30_000;

export async function execute(args: ShellRunInput): Promise<string> {
  const { command } = InputSchema.parse(args);
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
