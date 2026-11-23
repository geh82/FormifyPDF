import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export const ZIP_ID_REGEX = /^[a-f0-9]{24}$/;

export const DEFAULT_MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB compressed archive
export const DEFAULT_MAX_ZIP_ENTRIES = 1000;
export const DEFAULT_MAX_ENTRY_UNCOMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB total

export interface ZipStoredFileEntry {
  path: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export interface ZipArchiveManifest {
  id: string;
  originalFilename: string;
  uploadedAt: string;
  archiveSize: number;
  fileCount: number;
  totalUncompressedBytes: number;
  files: ZipStoredFileEntry[];
}

export interface ZipStorageLimits {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalUncompressedBytes?: number;
}

export class ZipSecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ZipSecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function getUploadedZipsRoot(overrideRoot?: string): string {
  return path.resolve(
    overrideRoot || process.env.UPLOADED_ZIPS_DIR || path.join(process.cwd(), "uploaded-zips")
  );
}

export function isValidZipId(id: unknown): id is string {
  return typeof id === "string" && ZIP_ID_REGEX.test(id);
}

/**
 * Verify ZIP PK magic header:
 * - PK\x03\x04 (standard local file header)
 * - PK\x05\x06 (empty zip EOCD)
 * - PK\x07\x08 (spanned archive)
 */
export function hasValidZipMagicBytes(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return (
    (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

/**
 * Strictly sanitize a relative archive path to defeat ZIP-slip and control-byte tricks.
 */
export function sanitizeRelativeZipPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ZipSecurityError("INVALID_PATH", "Archive entry path cannot be empty");
  }
  if (rawPath.includes("\0") || /[\u0000-\u001F\u007F]/.test(rawPath)) {
    throw new ZipSecurityError("INVALID_PATH", "Archive entry path contains illegal control characters");
  }

  const normalizedSlashes = rawPath.replace(/\\/g, "/");
  if (normalizedSlashes.startsWith("/") || /^[A-Za-z]:/.test(normalizedSlashes)) {
    throw new ZipSecurityError("PATH_TRAVERSAL", "Absolute paths inside ZIP archives are forbidden");
  }

  const parts = normalizedSlashes.split("/").filter((seg, idx, arr) => {
    // Allow trailing slash only if caller stripped directory entries; reject empty middle segments
    if (seg === "" && idx === arr.length - 1) return false;
    return true;
  });

  if (parts.length === 0) {
    throw new ZipSecurityError("INVALID_PATH", "Archive entry path resolves to empty");
  }

  for (const seg of parts) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ZipSecurityError(
        "PATH_TRAVERSAL",
        `Unsafe path traversal segment '${seg}' blocked`
      );
    }
  }

  return parts.join("/");
}

export function resolveSafeArchiveDir(rootDir: string, id: string): string {
  if (!isValidZipId(id)) {
    throw new ZipSecurityError("INVALID_ID", "Invalid archive identifier format");
  }
  const base = path.resolve(rootDir);
  const archiveDir = path.resolve(base, id);
  if (!archiveDir.startsWith(base + path.sep)) {
    throw new ZipSecurityError("PATH_TRAVERSAL", "Archive directory escaped storage root");
  }
  return archiveDir;
}

export function resolveSafeEntryDiskPath(
  rootDir: string,
  id: string,
  relativeEntryPath: string
): { safeRelPath: string; diskPath: string; filesDir: string } {
  const archiveDir = resolveSafeArchiveDir(rootDir, id);
  const filesDir = path.resolve(archiveDir, "files");
  const safeRelPath = sanitizeRelativeZipPath(relativeEntryPath);
  const diskPath = path.resolve(filesDir, ...safeRelPath.split("/"));

  if (!diskPath.startsWith(filesDir + path.sep)) {
    throw new ZipSecurityError(
      "PATH_TRAVERSAL",
      "Resolved entry path escaped uploaded-zips/<id>/files/ boundary"
    );
  }
  return { safeRelPath, diskPath, filesDir };
}

export function inferSafeMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
    case ".ts":
    case ".tsx":
    case ".jsx":
    case ".md":
    case ".txt":
    case ".xml":
    case ".yml":
    case ".yaml":
    case ".html":
    case ".htm":
      // Force text/plain for code & HTML so direct browser reads never execute active scripts
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export function sanitizeDisplayFilename(name: string): string {
  const base = path.basename(name || "archive.zip").replace(/[^A-Za-z0-9._-]/g, "_");
  return base.slice(0, 120) || "archive.zip";
}

export async function saveZipArchive(
  zipBuffer: Buffer,
  originalFilename: string,
  options: { rootDir?: string; limits?: ZipStorageLimits } = {}
): Promise<ZipArchiveManifest> {
  const rootDir = getUploadedZipsRoot(options.rootDir);
  const maxArchiveBytes = options.limits?.maxArchiveBytes ?? DEFAULT_MAX_ZIP_BYTES;
  const maxEntries = options.limits?.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const maxEntryBytes =
    options.limits?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_UNCOMPRESSED_BYTES;
  const maxTotalUncompressed =
    options.limits?.maxTotalUncompressedBytes ?? DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES;

  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    throw new ZipSecurityError("EMPTY_UPLOAD", "Uploaded ZIP file is empty");
  }
  if (zipBuffer.length > maxArchiveBytes) {
    throw new ZipSecurityError(
      "ARCHIVE_TOO_LARGE",
      `ZIP archive exceeds maximum allowed size of ${Math.round(maxArchiveBytes / (1024 * 1024))} MB`,
      413
    );
  }
  if (!hasValidZipMagicBytes(zipBuffer)) {
    throw new ZipSecurityError(
      "INVALID_ZIP_SIGNATURE",
      "File failed PK magic-byte verification and is not a valid ZIP archive"
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: true });
  } catch (err) {
    throw new ZipSecurityError(
      "CORRUPT_ZIP",
      `Unable to parse ZIP archive: ${err instanceof Error ? err.message : "corrupt archive"}`
    );
  }

  const allEntries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (allEntries.length === 0) {
    throw new ZipSecurityError("EMPTY_ARCHIVE", "ZIP archive contains no files");
  }
  if (allEntries.length > maxEntries) {
    throw new ZipSecurityError(
      "TOO_MANY_ENTRIES",
      `ZIP archive contains ${allEntries.length} files, exceeding the safety limit of ${maxEntries}`
    );
  }

  const id = crypto.randomBytes(12).toString("hex");
  const archiveDir = resolveSafeArchiveDir(rootDir, id);
  const filesDir = path.resolve(archiveDir, "files");

  const storedFiles: ZipStoredFileEntry[] = [];
  let totalUncompressedBytes = 0;

  try {
    await fs.mkdir(filesDir, { recursive: true });

    for (const entry of allEntries) {
      const rawEntryName =
        (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ||
        entry.name;
      const { safeRelPath, diskPath } = resolveSafeEntryDiskPath(
        rootDir,
        id,
        rawEntryName
      );

      // Extract entry with streaming byte cap guard
      const content = await entry.async("nodebuffer");
      if (content.length > maxEntryBytes) {
        throw new ZipSecurityError(
          "ENTRY_TOO_LARGE",
          `Entry '${safeRelPath}' exceeds maximum per-file size limit`,
          413
        );
      }

      totalUncompressedBytes += content.length;
      if (totalUncompressedBytes > maxTotalUncompressed) {
        throw new ZipSecurityError(
          "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
          "Total uncompressed ZIP size exceeds safety limit",
          413
        );
      }

      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      await fs.writeFile(diskPath, content, { mode: 0o600 });

      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      storedFiles.push({
        path: safeRelPath,
        size: content.length,
        sha256,
        mimeType: inferSafeMimeType(safeRelPath),
      });
    }

    storedFiles.sort((a, b) => a.path.localeCompare(b.path));

    const manifest: ZipArchiveManifest = {
      id,
      originalFilename: sanitizeDisplayFilename(originalFilename),
      uploadedAt: new Date().toISOString(),
      archiveSize: zipBuffer.length,
      fileCount: storedFiles.length,
      totalUncompressedBytes,
      files: storedFiles,
    };

    await fs.writeFile(
      path.join(archiveDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );

    return manifest;
  } catch (err) {
    // Clean up partial extraction on any failure
    await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function getZipManifest(
  id: string,
  rootDirOverride?: string
): Promise<ZipArchiveManifest | null> {
  const rootDir = getUploadedZipsRoot(rootDirOverride);
  const archiveDir = resolveSafeArchiveDir(rootDir, id);
  const manifestPath = path.join(archiveDir, "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as ZipArchiveManifest;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function listZipArchives(
  rootDirOverride?: string
): Promise<ZipArchiveManifest[]> {
  const rootDir = getUploadedZipsRoot(rootDirOverride);
  let dirNames: string[] = [];
  try {
    dirNames = await fs.readdir(rootDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const manifests: ZipArchiveManifest[] = [];
  for (const name of dirNames) {
    if (!isValidZipId(name)) continue;
    const manifest = await getZipManifest(name, rootDirOverride);
    if (manifest) manifests.push(manifest);
  }

  manifests.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return manifests;
}

export async function readZipEntry(
  id: string,
  relativeEntryPath: string,
  rootDirOverride?: string
): Promise<{ buffer: Buffer; mimeType: string; safeRelPath: string } | null> {
  const rootDir = getUploadedZipsRoot(rootDirOverride);
  const { safeRelPath, diskPath } = resolveSafeEntryDiskPath(
    rootDir,
    id,
    relativeEntryPath
  );

  try {
    const stat = await fs.lstat(diskPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    const buffer = await fs.readFile(diskPath);
    return {
      buffer,
      mimeType: inferSafeMimeType(safeRelPath),
      safeRelPath,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function deleteZipArchive(
  id: string,
  rootDirOverride?: string
): Promise<boolean> {
  const rootDir = getUploadedZipsRoot(rootDirOverride);
  const archiveDir = resolveSafeArchiveDir(rootDir, id);
  try {
    await fs.access(archiveDir);
  } catch {
    return false;
  }
  await fs.rm(archiveDir, { recursive: true, force: true });
  return true;
}
