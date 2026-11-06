export type ArtifactKey =
  | "repositories"
  | "zenodo"
  | "figshare"
  | "dryad"
  | "osf"
  | "software_heritage"
  | "code_ocean"
  | "packages"
  | "datasets"
  | "models"
  | "containers"
  | "other";

export const ARTIFACT_KEYS: ArtifactKey[] = [
  "repositories",
  "zenodo",
  "figshare",
  "dryad",
  "osf",
  "software_heritage",
  "code_ocean",
  "packages",
  "datasets",
  "models",
  "containers",
  "other"
];

export const METRIC_NAMES = [
  "Y",
  "A_first",
  "A_senior",
  "A_lead",
  "A_total",
  "L_lead",
  "C_lead",
  "R",
  "h_lead",
  "M",
  "T",
  "S",
  "C",
  "I_open",
  "I_closed"
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * The parts of a paper record needed to rebuild `papers.csv`. The scraper's
 * full `PaperRecord` is structurally compatible with this.
 */
export interface CsvRecord {
  paper_name: string;
  authors: string[];
  joint_first: string[];
  joint_senior: string[];
  lead_affiliations: string[] | null;
  openalex_senior_authors: unknown[];
  metrics: Partial<Record<MetricName, unknown>>;
  doi: string;
  article_url: string;
  link_to_pdf: string;
  artifacts: Record<ArtifactKey, string[]>;
  files: {
    html: string | null;
    pdf: string | null;
    figures: Array<{ path: string | null }>;
  };
}

export function metricCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

export function toCsv(rows: CsvRecord[]): string {
  const columns = [
    "paper_name",
    "authors",
    "joint_first",
    "joint_senior",
    "lead_affiliations",
    "openalex_senior_authors",
    ...METRIC_NAMES,
    "doi",
    "article_url",
    "link_to_pdf",
    ...ARTIFACT_KEYS,
    "local_html",
    "local_pdf",
    "local_figures"
  ];

  const quote = (value: unknown) => {
    const s = String(value ?? "");
    return `"${s.replaceAll('"', '""')}"`;
  };

  const valuesFor = (row: CsvRecord): Record<string, string> => ({
    paper_name: row.paper_name,
    authors: JSON.stringify(row.authors),
    joint_first: JSON.stringify(row.joint_first),
    joint_senior: JSON.stringify(row.joint_senior),
    lead_affiliations: metricCell(row.lead_affiliations),
    openalex_senior_authors: JSON.stringify(row.openalex_senior_authors),
    ...Object.fromEntries(
      METRIC_NAMES.map((name) => [name, metricCell(row.metrics?.[name])])
    ),
    doi: row.doi,
    article_url: row.article_url,
    link_to_pdf: row.link_to_pdf,
    repositories: JSON.stringify(row.artifacts.repositories),
    zenodo: JSON.stringify(row.artifacts.zenodo),
    figshare: JSON.stringify(row.artifacts.figshare),
    dryad: JSON.stringify(row.artifacts.dryad),
    osf: JSON.stringify(row.artifacts.osf),
    software_heritage: JSON.stringify(row.artifacts.software_heritage),
    code_ocean: JSON.stringify(row.artifacts.code_ocean),
    packages: JSON.stringify(row.artifacts.packages),
    datasets: JSON.stringify(row.artifacts.datasets),
    models: JSON.stringify(row.artifacts.models),
    containers: JSON.stringify(row.artifacts.containers),
    other: JSON.stringify(row.artifacts.other),
    local_html: row.files.html || "",
    local_pdf: row.files.pdf || "",
    local_figures: JSON.stringify(row.files.figures.map((f) => f.path).filter(Boolean))
  });

  return [
    columns.join(","),
    ...rows.map((row) => {
      const flat = valuesFor(row);
      return columns.map((column) => quote(flat[column] || "")).join(",");
    })
  ].join("\n") + "\n";
}
