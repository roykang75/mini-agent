import {
  loadSoul,
  validatePersona,
  PersonaValidationError,
  PersonaRefError,
} from "../src/lib/souls/loader";

type ErrCtor<E extends Error> = { new (...args: never[]): E; name: string };

async function expectThrows<E extends Error>(
  label: string,
  fn: () => Promise<unknown> | unknown,
  cls: ErrCtor<E>,
) {
  try {
    await fn();
    console.error(`[FAIL] ${label} — expected ${cls.name} but none thrown`);
    process.exit(1);
  } catch (e) {
    if (e instanceof cls) {
      console.log(`[ok]   ${label} → ${cls.name}: ${(e as Error).message}`);
    } else {
      console.error(`[FAIL] ${label} — expected ${cls.name} got ${(e as Error).constructor.name}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
}

async function main() {
  // 1. allowlist pass
  console.log("[ok]   validatePersona(undefined) →", validatePersona());
  console.log("[ok]   validatePersona('default') →", validatePersona("default"));
  console.log("[ok]   validatePersona('cia-analyst') →", validatePersona("cia-analyst"));

  // 2. allowlist reject
  await expectThrows(
    "validatePersona('../../etc/passwd')",
    () => validatePersona("../../etc/passwd"),
    PersonaValidationError,
  );
  await expectThrows(
    "validatePersona('unknown')",
    () => validatePersona("unknown"),
    PersonaValidationError,
  );

  // 3. loadSoul HEAD default
  const d = await loadSoul({});
  console.log(`[ok]   loadSoul({}) → persona=${d.resolvedPersona} ref=${d.resolvedRef} len=${d.systemPrompt.length}`);
  if (!d.systemPrompt.startsWith("당신은")) {
    console.error("[FAIL] default SOUL should start with '당신은'");
    process.exit(1);
  }
  if (d.systemPrompt.includes("---")) {
    console.error("[FAIL] frontmatter not stripped");
    process.exit(1);
  }

  // 4. loadSoul HEAD cia-analyst
  const c = await loadSoul({ persona: "cia-analyst" });
  console.log(`[ok]   loadSoul(cia-analyst) → persona=${c.resolvedPersona} ref=${c.resolvedRef}`);
  if (!c.systemPrompt.includes("Change Impact Analysis")) {
    console.error("[FAIL] cia-analyst SOUL missing expected content");
    process.exit(1);
  }

  // 5. loadSoul with explicit HEAD ref exercises isomorphic-git. On this branch souls/*
  //    files are not yet committed, so we expect PersonaRefError. This still proves the
  //    git-ref path is reachable and returns the structured error.
  await expectThrows(
    "loadSoul at HEAD before souls are committed",
    () => loadSoul({ persona: "default", personaRef: "HEAD" }),
    PersonaRefError,
  );

  // 6. invalid persona_ref syntax → rejected by validator (we call the loader directly with a bad ref)
  await expectThrows(
    "loadSoul with injection-y ref",
    () => loadSoul({ persona: "default", personaRef: "foo;rm -rf" }),
    PersonaRefError,
  );

  // 7. non-existent ref → PersonaRefError
  await expectThrows(
    "loadSoul with non-existent ref",
    () => loadSoul({ persona: "default", personaRef: "nonexistent-ref-xyz" }),
    PersonaRefError,
  );

  console.log("\nall souls smoke tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
