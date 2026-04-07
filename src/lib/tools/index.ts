import { readFileTool, executeReadFile } from "./read-file";
import { writeFileTool, executeWriteFile } from "./write-file";
import { runCommandTool, executeRunCommand } from "./run-command";

export const tools = [readFileTool, writeFileTool, runCommandTool];

export async function executeTool(name: string, input: unknown): Promise<string> {
  switch (name) {
    case "read_file":
      return executeReadFile(input);
    case "write_file":
      return executeWriteFile(input);
    case "run_command":
      return executeRunCommand(input);
    default:
      return `Error: 알 수 없는 툴 - ${name}`;
  }
}
