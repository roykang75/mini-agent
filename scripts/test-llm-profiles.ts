import {
  __resetProfilesForTest,
  getPreferredLocalProfileName,
  listPublicProfiles,
  resolveProfile,
} from "../src/lib/llm/profiles";

function expect(name: string, ok: boolean, detail: Record<string, unknown>) {
  console.log(JSON.stringify({ case: name, ok, ...detail }));
  if (!ok) process.exitCode = 1;
}

function findProfile(name: string) {
  const found = listPublicProfiles().find((p) => p.name === name);
  if (!found) throw new Error(`profile not found in public list: ${name}`);
  return found;
}

function resetEnv() {
  delete process.env.ALLOW_EXPERIMENTAL_LOCAL;
  __resetProfilesForTest();
}

async function main() {
  resetEnv();

  const preferredLocal = getPreferredLocalProfileName();
  expect("preferred local stays on 26b", preferredLocal === "gemma-4-26b-a4b-it-mlx", {
    preferredLocal,
  });

  const stableLocal = findProfile("gemma-4-26b-a4b-it-mlx");
  expect(
    "26b is recommended local-main",
    stableLocal.recommended === true &&
      stableLocal.stability === "stable" &&
      stableLocal.selectable === true,
    {
      recommended: stableLocal.recommended,
      stability: stableLocal.stability,
      selectable: stableLocal.selectable,
    },
  );

  const experimentalLocal = findProfile("gemma-4-31b-it");
  expect(
    "31b is blocked by default",
    experimentalLocal.stability === "experimental" &&
      experimentalLocal.selectable === false &&
      typeof experimentalLocal.blockedReason === "string" &&
      experimentalLocal.blockedReason.includes("ALLOW_EXPERIMENTAL_LOCAL=1"),
    {
      stability: experimentalLocal.stability,
      selectable: experimentalLocal.selectable,
      blockedReason: experimentalLocal.blockedReason,
    },
  );

  let blocked = false;
  try {
    resolveProfile("gemma-4-31b-it");
  } catch (e) {
    blocked = (e as Error).message.includes("ALLOW_EXPERIMENTAL_LOCAL=1");
  }
  expect("resolveProfile blocks experimental local by default", blocked, { blocked });

  process.env.ALLOW_EXPERIMENTAL_LOCAL = "1";
  __resetProfilesForTest();

  const experimentalAllowed = findProfile("gemma-4-31b-it");
  expect(
    "31b becomes selectable with override",
    experimentalAllowed.selectable === true && experimentalAllowed.blockedReason === undefined,
    {
      selectable: experimentalAllowed.selectable,
      blockedReason: experimentalAllowed.blockedReason,
    },
  );

  const resolved = resolveProfile("gemma-4-31b-it");
  expect("resolveProfile allows experimental local with override", resolved.name === "gemma-4-31b-it", {
    resolved: resolved.name,
  });

  resetEnv();
  console.log(JSON.stringify({ ok: process.exitCode !== 1 }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
