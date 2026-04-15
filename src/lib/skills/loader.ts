import type { ToolDef } from "../llm/types";
import { tools as generatedTools, executors as generatedExecutors } from "./registry.generated";

export function getSkillTools(): readonly ToolDef[] {
  return generatedTools;
}

export async function executeSkill(name: string, args: unknown): Promise<string> {
  const fn = generatedExecutors[name];
  if (!fn) throw new Error(`Unknown skill: ${name}`);
  return fn(args);
}