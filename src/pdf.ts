const PDF_TEXT_TIMEOUT_MS = 30_000;

/**
 * Read the first PDF page with poppler's `pdftotext`. This is optional: when the
 * binary is missing or the PDF cannot be read, joint-author resolution keeps
 * the conservative defaults instead of guessing.
 */
export async function extractPdfFirstPageText(
  pdfPath: string
): Promise<string | null> {
  if (!Bun.which("pdftotext")) return null;

  try {
    const child = Bun.spawn(
      ["pdftotext", "-layout", "-f", "1", "-l", "1", pdfPath, "-"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(PDF_TEXT_TIMEOUT_MS)
      }
    );

    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);

    return exitCode === 0 ? stdout : null;
  } catch {
    return null;
  }
}
