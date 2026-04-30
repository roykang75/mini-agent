import {
  listPublicProfiles,
  getDefaultProfileName,
  getPreferredLocalProfileName,
} from "@/lib/llm/profiles";

export async function GET() {
  try {
    const profiles = listPublicProfiles();
    const defaultName = getDefaultProfileName();
    const preferredLocal = getPreferredLocalProfileName();
    return Response.json({ default: defaultName, preferredLocal, profiles });
  } catch (e) {
    return Response.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
