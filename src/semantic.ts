export interface SemanticAnnotation {
  M: boolean | null;
  T: string | null;
}

/** Load `doi -> {M, T}` annotations. A missing file means no annotations yet. */
export async function loadSemanticAnnotations(
  path: string
): Promise<Map<string, SemanticAnnotation>> {
  const annotations = new Map<string, SemanticAnnotation>();
  if (!(await Bun.file(path).exists())) return annotations;

  const value: unknown = await Bun.file(path).json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Semantic annotations must be an object keyed by DOI: ${path}`);
  }

  for (const [doi, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    annotations.set(semanticKey(doi), {
      M: typeof record.M === "boolean" ? record.M : null,
      T: typeof record.T === "string" ? record.T : null
    });
  }
  return annotations;
}

export function semanticKey(doi: string): string {
  return String(doi ?? "").trim().toLowerCase();
}
