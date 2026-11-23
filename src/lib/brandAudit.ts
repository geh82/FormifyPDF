export type ZipFileCategory =
  | "image"
  | "svg"
  | "css"
  | "json"
  | "code"
  | "pdf"
  | "other";

export interface WorkspaceZipEntry {
  path: string;
  size: number;
  bytes: Uint8Array;
  category: ZipFileCategory;
  isTextEditable: boolean;
}

export interface ColorTokenAudit {
  normalizedHex: string;
  rawVariants: string[];
  count: number;
  files: string[];
}

export interface BrandAuditIssue {
  id: string;
  severity: "warning" | "info";
  title: string;
  description: string;
  paths: string[];
}

export interface BrandAuditReport {
  totalFiles: number;
  totalBytes: number;
  zeroByteFiles: string[];
  macOsClutterFiles: string[];
  cleanablePaths: string[];
  colorTokens: ColorTokenAudit[];
  categoryCounts: Record<ZipFileCategory, number>;
  issues: BrandAuditIssue[];
}

export function getFileExtension(filePath: string): string {
  const base = filePath.split("/").pop() || "";
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return "";
  return base.slice(idx).toLowerCase();
}

export function classifyZipFile(filePath: string): {
  category: ZipFileCategory;
  isTextEditable: boolean;
} {
  const ext = getFileExtension(filePath);
  if (ext === ".svg") {
    return { category: "svg", isTextEditable: true };
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"].includes(ext)) {
    return { category: "image", isTextEditable: false };
  }
  if ([".css", ".scss", ".sass", ".less"].includes(ext)) {
    return { category: "css", isTextEditable: true };
  }
  if (ext === ".json") {
    return { category: "json", isTextEditable: true };
  }
  if (ext === ".pdf") {
    return { category: "pdf", isTextEditable: false };
  }
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".html",
      ".htm",
      ".xml",
      ".txt",
      ".md",
      ".yml",
      ".yaml",
      ".env",
      ".py",
      ".csv",
    ].includes(ext)
  ) {
    return { category: "code", isTextEditable: true };
  }
  return { category: "other", isTextEditable: false };
}

export function isMacOsClutter(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const base = segments[segments.length - 1] || "";
  if (segments.includes("__MACOSX")) return true;
  if (base === ".DS_Store") return true;
  if (base.startsWith("._")) return true;
  return false;
}

export function sanitizeClientZipPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

export function normalizeHexColor(rawHex: string): string {
  const clean = rawHex.trim().toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(clean)) {
    return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  if (/^#[0-9A-F]{4}$/.test(clean)) {
    return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  if (/^#[0-9A-F]{8}$/.test(clean)) {
    return clean.slice(0, 7);
  }
  return clean;
}

const HEX_COLOR_REGEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

export function extractHexColorsFromText(text: string): string[] {
  const matches = text.match(HEX_COLOR_REGEX);
  return matches ? matches : [];
}

export function auditWorkspaceFiles(entries: WorkspaceZipEntry[]): BrandAuditReport {
  const categoryCounts: Record<ZipFileCategory, number> = {
    image: 0,
    svg: 0,
    css: 0,
    json: 0,
    code: 0,
    pdf: 0,
    other: 0,
  };

  let totalBytes = 0;
  const zeroByteFiles: string[] = [];
  const macOsClutterFiles: string[] = [];
  const colorMap = new Map<
    string,
    { rawVariants: Set<string>; count: number; files: Set<string> }
  >();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (const entry of entries) {
    categoryCounts[entry.category]++;
    totalBytes += entry.size;

    if (entry.size === 0) {
      zeroByteFiles.push(entry.path);
    }

    if (isMacOsClutter(entry.path)) {
      macOsClutterFiles.push(entry.path);
    }

    if (entry.isTextEditable && entry.size > 0 && entry.size <= 2 * 1024 * 1024) {
      const text = decoder.decode(entry.bytes);
      const matches = extractHexColorsFromText(text);
      for (const raw of matches) {
        const normalized = normalizeHexColor(raw);
        let bucket = colorMap.get(normalized);
        if (!bucket) {
          bucket = { rawVariants: new Set(), count: 0, files: new Set() };
          colorMap.set(normalized, bucket);
        }
        bucket.rawVariants.add(raw.toUpperCase());
        bucket.count += 1;
        bucket.files.add(entry.path);
      }
    }
  }

  const colorTokens: ColorTokenAudit[] = Array.from(colorMap.entries())
    .map(([normalizedHex, info]) => ({
      normalizedHex,
      rawVariants: Array.from(info.rawVariants).sort(),
      count: info.count,
      files: Array.from(info.files).sort(),
    }))
    .sort((a, b) => b.count - a.count || a.normalizedHex.localeCompare(b.normalizedHex));

  const issues: BrandAuditIssue[] = [];
  if (macOsClutterFiles.length > 0) {
    issues.push({
      id: "macos-clutter",
      severity: "warning",
      title: `${macOsClutterFiles.length} macOS metadata/resource file(s) detected`,
      description:
        "Files inside __MACOSX/, .DS_Store, or ._ AppleDouble forks bloat packages and should be stripped before distribution.",
      paths: macOsClutterFiles,
    });
  }
  if (zeroByteFiles.length > 0) {
    issues.push({
      id: "zero-byte",
      severity: "warning",
      title: `${zeroByteFiles.length} zero-byte empty file(s) found`,
      description:
        "Empty 0 B placeholder or corrupt files may break asset pipelines or document packaging.",
      paths: zeroByteFiles,
    });
  }
  if (colorTokens.length > 0) {
    issues.push({
      id: "color-tokens",
      severity: "info",
      title: `${colorTokens.length} unique colour hex token(s) extracted`,
      description:
        "Audited from CSS, SVG, JSON, and code files inside the workspace archive.",
      paths: Array.from(new Set(colorTokens.flatMap((t) => t.files))),
    });
  }

  const cleanablePaths = Array.from(
    new Set([...macOsClutterFiles, ...zeroByteFiles])
  ).sort();

  return {
    totalFiles: entries.length,
    totalBytes,
    zeroByteFiles,
    macOsClutterFiles,
    cleanablePaths,
    colorTokens,
    categoryCounts,
    issues,
  };
}

export function formatArchiveBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
