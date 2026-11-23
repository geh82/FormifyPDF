import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type FormForgeStorageClass =
  | "originals"
  | "acroforms"
  | "renders"
  | "signed"
  | "supporting"
  | "thumbnails";

export function getFormForgeStorageRoot(overrideRoot?: string): string {
  return path.resolve(
    overrideRoot ||
      process.env.FORMFORGE_STORAGE_DIR ||
      path.join(process.cwd(), "storage", "formforge")
  );
}

export function ensureStorageDirs(rootDir?: string): string {
  const root = getFormForgeStorageRoot(rootDir);
  const subdirs: FormForgeStorageClass[] = [
    "originals",
    "acroforms",
    "renders",
    "signed",
    "supporting",
    "thumbnails",
  ];
  for (const dir of subdirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
  }
  return root;
}

export function resolveSafeStoragePath(
  storageKey: string,
  rootDir?: string
): string {
  if (!storageKey || storageKey.includes("\0") || path.isAbsolute(storageKey)) {
    throw new Error("Invalid storage key");
  }
  const normalized = storageKey.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some((s) => s === "." || s === "..")) {
    throw new Error("Path traversal blocked in storage key");
  }
  const allowedBuckets = new Set<string>([
    "originals",
    "acroforms",
    "renders",
    "signed",
    "supporting",
    "thumbnails",
  ]);
  if (!allowedBuckets.has(segments[0])) {
    throw new Error("Unsupported storage bucket");
  }

  const root = ensureStorageDirs(rootDir);
  const resolved = path.resolve(root, ...segments);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("Resolved storage path escaped storage root");
  }
  return resolved;
}

export function validatePdfBufferSignature(buffer: Buffer): {
  valid: boolean;
  reason?: string;
} {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    return { valid: false, reason: "File is empty or too small to be a valid PDF." };
  }
  const head = buffer.subarray(0, 1024).toString("latin1");
  const headerIdx = head.indexOf("%PDF-");
  if (headerIdx === -1 || headerIdx > 64) {
    return { valid: false, reason: "File failed %PDF- magic header verification." };
  }
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    return { valid: false, reason: "PDF file appears truncated (missing %%EOF trailer)." };
  }
  return { valid: true };
}

export function validateSupportingFileSignature(
  buffer: Buffer,
  filename: string,
  declaredMime?: string
): { valid: boolean; mimeType?: string; reason?: string } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valid: false, reason: "Supporting file is empty." };
  }
  const ext = path.extname(filename || "").toLowerCase();
  const mime = (declaredMime || "").toLowerCase().split(";")[0].trim();

  if (ext === ".pdf") {
    if (mime && mime !== "application/pdf" && mime !== "application/octet-stream") {
      return { valid: false, reason: "PDF file has an unexpected MIME type." };
    }
    const sig = validatePdfBufferSignature(buffer);
    return sig.valid
      ? { valid: true, mimeType: "application/pdf" }
      : { valid: false, reason: sig.reason };
  }

  if (ext === ".png") {
    if (mime && mime !== "image/png" && mime !== "application/octet-stream") {
      return { valid: false, reason: "PNG file has an unexpected MIME type." };
    }
    const isPng =
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;
    return isPng
      ? { valid: true, mimeType: "image/png" }
      : { valid: false, reason: "File failed PNG magic-byte verification." };
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    if (
      mime &&
      mime !== "image/jpeg" &&
      mime !== "image/jpg" &&
      mime !== "application/octet-stream"
    ) {
      return { valid: false, reason: "JPEG file has an unexpected MIME type." };
    }
    const isJpeg =
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;
    return isJpeg
      ? { valid: true, mimeType: "image/jpeg" }
      : { valid: false, reason: "File failed JPEG magic-byte verification." };
  }

  if (ext === ".webp") {
    if (mime && mime !== "image/webp" && mime !== "application/octet-stream") {
      return { valid: false, reason: "WebP file has an unexpected MIME type." };
    }
    const isWebp =
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
    return isWebp
      ? { valid: true, mimeType: "image/webp" }
      : { valid: false, reason: "File failed WebP magic-byte verification." };
  }

  return {
    valid: false,
    reason: "Unsupported supporting file type. Allowed formats: .pdf, .png, .jpg, .jpeg, .webp.",
  };
}

export function saveStorageBuffer(
  classification: FormForgeStorageClass,
  filename: string,
  buffer: Buffer,
  rootDir?: string
): { storageKey: string; absolutePath: string; sha256: string; byteSize: number } {
  const safeExt = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".pdf";
  const key = `${classification}/${crypto.randomBytes(16).toString("hex")}${safeExt}`;
  const absolutePath = resolveSafeStoragePath(key, rootDir);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolutePath, buffer, { mode: 0o600 });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    storageKey: key,
    absolutePath,
    sha256,
    byteSize: buffer.length,
  };
}

export function readStorageBuffer(storageKey: string, rootDir?: string): Buffer | null {
  const abs = resolveSafeStoragePath(storageKey, rootDir);
  if (!fs.existsSync(abs)) return null;
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  return fs.readFileSync(abs);
}

export function deleteStorageObject(storageKey: string, rootDir?: string): boolean {
  try {
    const abs = resolveSafeStoragePath(storageKey, rootDir);
    if (!fs.existsSync(abs)) return false;
    fs.rmSync(abs, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function computeDirectoryBytes(rootDir?: string): number {
  const root = ensureStorageDirs(rootDir);
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(root);
  return total;
}
