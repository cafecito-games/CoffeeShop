import { readFile } from "node:fs/promises";
import { validateProjectProfile, type ProjectProfile } from "@coffee-shop/protocol";

export type ProjectProfileLoadFailureKind = "not-found" | "invalid";

export interface ProjectProfileLoadResult {
  ok: true;
  profiles: ProjectProfile[];
}

export interface ProjectProfileLoadFailure {
  ok: false;
  kind: ProjectProfileLoadFailureKind;
  error: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function loadProjectProfilesFromFile(
  path: string
): Promise<ProjectProfileLoadResult | ProjectProfileLoadFailure> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, kind: "not-found", error: `project profile file not found: ${path}` };
    }
    return { ok: false, kind: "invalid", error: `project profile file could not be read: ${path}: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return { ok: false, kind: "invalid", error: `project profile file is not valid JSON: ${(error as Error).message}` };
  }

  if (!isRecord(parsed) || !Object.keys(parsed).every((key) => key === "profiles") || !Array.isArray(parsed.profiles)) {
    return { ok: false, kind: "invalid", error: "project profile file must be an object with a single profiles array" };
  }

  const profiles: ProjectProfile[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of (parsed.profiles as unknown[]).entries()) {
    const validated = validateProjectProfile(entry);
    if (!validated.ok) {
      return { ok: false, kind: "invalid", error: `project profile at index ${index} is invalid: ${validated.reason}` };
    }
    if (seenIds.has(validated.value.id)) {
      return { ok: false, kind: "invalid", error: `duplicate project profile id: ${validated.value.id}` };
    }
    seenIds.add(validated.value.id);
    profiles.push(validated.value);
  }

  return { ok: true, profiles };
}

/** Immutable lookup over profiles loaded from a hub-authoritative file; callers derive fingerprints on demand. */
export class ProjectProfileRegistry {
  private readonly profilesById: ReadonlyMap<string, ProjectProfile>;

  constructor(profiles: readonly ProjectProfile[]) {
    this.profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  get(projectId: string): ProjectProfile | undefined {
    return this.profilesById.get(projectId);
  }

  has(projectId: string): boolean {
    return this.profilesById.has(projectId);
  }

  list(): readonly ProjectProfile[] {
    return [...this.profilesById.values()];
  }
}
