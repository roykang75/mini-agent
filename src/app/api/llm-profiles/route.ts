import { listPublicProfiles, getDefaultProfileName } from "@/lib/llm/profiles";

export async function GET() {
  try {
    const profiles = listPublicProfiles();
    const defaultName = getDefaultProfileName();
    return Response.json({ default: defaultName, profiles });
  } catch (e) {
    return Response.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
