import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as fs from "node:fs";
import { readBlob, resolveRef } from "isomorphic-git";
import { PERSONAS, type PersonaName } from "./registry.generated";
import { createLogger } from "../log";

const log = createLogger("agent");

const PERSONA_SET: ReadonlySet<string> = new Set(PERSONAS);
const REF_RE = /^[a-zA-Z0-9_.\-/]{1,64}$/;

export interface SoulRequest {
  persona?: string;
  personaRef?: string;
}

export interface LoadedSoul {
  systemPrompt: string;
  resolvedPersona: PersonaName;
  resolvedRef: string;
}

export class PersonaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaValidationError";
  }
}

export class PersonaRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaRefError";
  }
}

export function validatePersona(raw?: string): PersonaName {
  const p = raw ?? "default";
  if (!PERSONA_SET.has(p)) {
    throw new PersonaValidationError(`Unknown persona: ${p}`);
  }
  return p as PersonaName;
}

function validateRef(raw: string): string {
  if (!REF_RE.test(raw)) {
    throw new PersonaRefError(`Invalid persona_ref: ${raw}`);
  }
  return raw;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\s*\n+/, "");
}

async function readSoulFromHead(persona: PersonaName): Promise<string> {
  const path = join(process.cwd(), "souls", persona, "SOUL.md");
  return readFile(path, "utf-8");
}

async function readSoulFromRef(persona: PersonaName, ref: string): Promise<string> {
  const repoDir = process.cwd();
  let oid: string;
  try {
    oid = await resolveRef({ fs, dir: repoDir, ref });
  } catch (e) {
    throw new PersonaRefError(`Cannot resolve persona_ref "${ref}": ${(e as Error).message}`);
  }
  try {
    const { blob } = await readBlob({
      fs,
      dir: repoDir,
      oid,
      filepath: `souls/${persona}/SOUL.md`,
    });
    return new TextDecoder().decode(blob);
  } catch (e) {
    throw new PersonaRefError(
      `Cannot read souls/${persona}/SOUL.md at ref "${ref}": ${(e as Error).message}`,
    );
  }
}

export async function loadSoul(req: SoulRequest = {}): Promise<LoadedSoul> {
  const persona = validatePersona(req.persona);
  const ref = req.personaRef ? validateRef(req.personaRef) : undefined;

  let content: string;
  if (ref) {
    content = await readSoulFromRef(persona, ref);
  } else {
    try {
      content = await readSoulFromHead(persona);
    } catch (e) {
      if (persona === "default") throw e;
      log.warn(
        { event: "persona_fallback", persona, err_message: (e as Error).message },
        "fallback to default — failed to read SOUL.md",
      );
      content = await readSoulFromHead("default" as PersonaName);
      return {
        systemPrompt: stripFrontmatter(content),
        resolvedPersona: "default" as PersonaName,
        resolvedRef: "HEAD",
      };
    }
  }

  return {
    systemPrompt: stripFrontmatter(content),
    resolvedPersona: persona,
    resolvedRef: ref ?? "HEAD",
  };
}
