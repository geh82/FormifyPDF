import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertConfinedPath,
  assertValidTenantId,
  isRegularNonSymlinkFile,
  validatePdfBufferSignature,
} from "../../server/formforge-storage.ts";
function isValidDocumentId(id: unknown): id is string { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }

export interface StorageScopeOptions {
  tenantId?: string;
}

export interface SignedPdfMetadata {
  sha256: string;
  byteSize: number;
  uploadedAt: string;
}

export interface StorageHealthResult {
  ok: boolean;
  provider: string;
  details?: string;
}

export interface RetentionCleanupResult {
  deletedGenerated: number;
  deletedSigned: number;
}

export interface StorageProvider {
  readonly providerName: string;
  healthCheck(): Promise<StorageHealthResult>;
  saveGeneratedPdf(
    id: string,
    pdfBuffer: Buffer,
    options?: StorageScopeOptions
  ): Promise<void>;
  existsGeneratedPdf(id: string, options?: StorageScopeOptions): Promise<boolean>;
  readGeneratedPdf(id: string, options?: StorageScopeOptions): Promise<Buffer | null>;
  saveSignedPdf(
    id: string,
    pdfBuffer: Buffer,
    metadata: SignedPdfMetadata,
    options?: StorageScopeOptions
  ): Promise<void>;
  existsSignedPdf(id: string, options?: StorageScopeOptions): Promise<boolean>;
  readSignedPdf(id: string, options?: StorageScopeOptions): Promise<Buffer | null>;
  readSignedMetadata?(
    id: string,
    options?: StorageScopeOptions
  ): Promise<SignedPdfMetadata | null>;
  deleteExpired(retentionHours: number): Promise<RetentionCleanupResult>;
}

export interface LocalStorageOptions {
  generatedDir?: string;
  signedDir?: string;
}

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}

function assertValidDocumentId(id: string): string {
  if (!isValidDocumentId(id)) {
    throw new Error("Invalid document identifier");
  }
  return id;
}

function assertValidPdfPayload(pdfBuffer: Buffer): void {
  const check = validatePdfBufferSignature(pdfBuffer);
  if (!check.valid) {
    throw new Error(check.reason || "Invalid PDF payload");
  }
}

function resolveTenantSegments(options?: StorageScopeOptions): string[] {
  if (!options?.tenantId) return [];
  return ["tenants", assertValidTenantId(options.tenantId)];
}

export class LocalStorageProvider implements StorageProvider {
  public readonly providerName = "local";
  private readonly generatedDir: string;
  private readonly signedDir: string;

  constructor(options: LocalStorageOptions = {}) {
    this.generatedDir = path.resolve(
      options.generatedDir ||
        process.env.GENERATED_PDF_DIR ||
        path.join(process.cwd(), "public", "generated")
    );
    this.signedDir = path.resolve(
      options.signedDir ||
        process.env.SIGNED_PDF_DIR ||
        path.join(process.cwd(), "public", "signed")
    );
    if (this.generatedDir === this.signedDir) {
      throw new Error("Generated and signed PDF directories must be separate");
    }
    this.ensureDirectoriesSync();
  }

  private ensureDirectoriesSync(): void {
    fs.mkdirSync(this.generatedDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.signedDir, { recursive: true, mode: 0o700 });
  }

  private async ensureDirectories(): Promise<void> {
    await fsp.mkdir(this.generatedDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.signedDir, { recursive: true, mode: 0o700 });
  }

  private getGeneratedPath(id: string, options?: StorageScopeOptions): string {
    const safeId = assertValidDocumentId(id);
    const tenantSegs = resolveTenantSegments(options);
    return assertConfinedPath(this.generatedDir, ...tenantSegs, `${safeId}.pdf`);
  }

  private getSignedPath(id: string, options?: StorageScopeOptions): string {
    const safeId = assertValidDocumentId(id);
    const tenantSegs = resolveTenantSegments(options);
    return assertConfinedPath(this.signedDir, ...tenantSegs, `${safeId}_signed.pdf`);
  }

  private getSignedMetadataPath(id: string, options?: StorageScopeOptions): string {
    const safeId = assertValidDocumentId(id);
    const tenantSegs = resolveTenantSegments(options);
    return assertConfinedPath(this.signedDir, ...tenantSegs, `${safeId}_meta.json`);
  }

  private async writeAtomic(
    targetPath: string,
    data: Buffer | string,
    encoding?: BufferEncoding
  ): Promise<void> {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const suffix = crypto.randomBytes(6).toString("hex");
    const tmpPath = `${targetPath}.tmp-${process.pid}-${suffix}`;
    try {
      if (typeof data === "string") {
        await fsp.writeFile(tmpPath, data, { encoding: encoding || "utf8", mode: 0o600 });
      } else {
        await fsp.writeFile(tmpPath, data, { mode: 0o600 });
      }
      await fsp.rename(tmpPath, targetPath);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async healthCheck(): Promise<StorageHealthResult> {
    try {
      await this.ensureDirectories();
      await fsp.access(this.generatedDir, fs.constants.R_OK | fs.constants.W_OK);
      await fsp.access(this.signedDir, fs.constants.R_OK | fs.constants.W_OK);
      return {
        ok: true,
        provider: this.providerName,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.providerName,
        details: err instanceof Error ? err.message : "Local storage check failed",
      };
    }
  }

  async saveGeneratedPdf(
    id: string,
    pdfBuffer: Buffer,
    options?: StorageScopeOptions
  ): Promise<void> {
    assertValidPdfPayload(pdfBuffer);
    await this.ensureDirectories();
    const targetPath = this.getGeneratedPath(id, options);
    await this.writeAtomic(targetPath, pdfBuffer);
  }

  async existsGeneratedPdf(id: string, options?: StorageScopeOptions): Promise<boolean> {
    const targetPath = this.getGeneratedPath(id, options);
    return isRegularNonSymlinkFile(targetPath);
  }

  async readGeneratedPdf(id: string, options?: StorageScopeOptions): Promise<Buffer | null> {
    const targetPath = this.getGeneratedPath(id, options);
    if (!(await isRegularNonSymlinkFile(targetPath))) {
      return null;
    }
    return fsp.readFile(targetPath);
  }

  async saveSignedPdf(
    id: string,
    pdfBuffer: Buffer,
    metadata: SignedPdfMetadata,
    options?: StorageScopeOptions
  ): Promise<void> {
    assertValidPdfPayload(pdfBuffer);
    await this.ensureDirectories();
    const pdfPath = this.getSignedPath(id, options);
    const metaPath = this.getSignedMetadataPath(id, options);
    await this.writeAtomic(pdfPath, pdfBuffer);
    await this.writeAtomic(metaPath, JSON.stringify(metadata, null, 2), "utf8");
  }

  async existsSignedPdf(id: string, options?: StorageScopeOptions): Promise<boolean> {
    const targetPath = this.getSignedPath(id, options);
    return isRegularNonSymlinkFile(targetPath);
  }

  async readSignedPdf(id: string, options?: StorageScopeOptions): Promise<Buffer | null> {
    const targetPath = this.getSignedPath(id, options);
    if (!(await isRegularNonSymlinkFile(targetPath))) {
      return null;
    }
    return fsp.readFile(targetPath);
  }

  async readSignedMetadata(
    id: string,
    options?: StorageScopeOptions
  ): Promise<SignedPdfMetadata | null> {
    const metaPath = this.getSignedMetadataPath(id, options);
    if (!(await isRegularNonSymlinkFile(metaPath))) {
      return null;
    }
    try {
      return JSON.parse(await fsp.readFile(metaPath, "utf8")) as SignedPdfMetadata;
    } catch {
      return null;
    }
  }

  async deleteExpired(retentionHours: number): Promise<RetentionCleanupResult> {
    const safeHours = Math.max(1, Number.isFinite(retentionHours) ? retentionHours : 24);
    const cutoffMs = Date.now() - safeHours * 60 * 60 * 1000;

    let deletedGenerated = 0;
    let deletedSigned = 0;

    const pruneDirectory = async (
      rootDir: string,
      currentDir: string,
      isSignedDir: boolean
    ): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const candidatePath = assertConfinedPath(
          rootDir,
          path.relative(rootDir, path.join(currentDir, entry.name))
        );
        try {
          const stat = await fsp.lstat(candidatePath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            await pruneDirectory(rootDir, candidatePath, isSignedDir);
            continue;
          }
          if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;

          if (!isSignedDir && entry.name.endsWith(".pdf")) {
            await fsp.unlink(candidatePath);
            deletedGenerated += 1;
          } else if (isSignedDir && entry.name.endsWith("_signed.pdf")) {
            await fsp.unlink(candidatePath);
            deletedSigned += 1;
            const idPrefix = entry.name.slice(0, -"_signed.pdf".length);
            if (isValidDocumentId(idPrefix)) {
              const metaSibling = assertConfinedPath(
                rootDir,
                path.relative(rootDir, path.join(currentDir, `${idPrefix}_meta.json`))
              );
              await fsp.unlink(metaSibling).catch(() => undefined);
            }
          } else if (entry.name.includes(".tmp-")) {
            await fsp.unlink(candidatePath).catch(() => undefined);
          }
        } catch {
          // Ignore individual entry race failures
        }
      }
    };

    await pruneDirectory(this.generatedDir, this.generatedDir, false);
    await pruneDirectory(this.signedDir, this.signedDir, true);

    return { deletedGenerated, deletedSigned };
  }
}

export class S3StorageProvider implements StorageProvider {
  public readonly providerName = "s3";
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;

  constructor(options: S3StorageOptions) {
    if (!options.bucket || !options.bucket.trim()) {
      throw new Error("S3_BUCKET is required when STORAGE_PROVIDER=s3");
    }
    this.bucket = options.bucket.trim();
    this.prefix = (options.prefix || "formforge").replace(/^\/+|\/+$/g, "");

    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: options.region || process.env.S3_REGION || "us-east-1",
      forcePathStyle: Boolean(options.forcePathStyle),
    };

    if (options.endpoint) {
      clientConfig.endpoint = options.endpoint;
    }
    if (options.accessKeyId && options.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      };
    }

    this.client = new S3Client(clientConfig);
  }

  private tenantSegment(options?: StorageScopeOptions): string {
    const segs = resolveTenantSegments(options);
    return segs.length > 0 ? `${segs.join("/")}/` : "";
  }

  private generatedKey(id: string, options?: StorageScopeOptions): string {
    return `${this.prefix}/${this.tenantSegment(options)}generated/${assertValidDocumentId(id)}.pdf`;
  }

  private signedKey(id: string, options?: StorageScopeOptions): string {
    return `${this.prefix}/${this.tenantSegment(options)}signed/${assertValidDocumentId(id)}_signed.pdf`;
  }

  private signedMetaKey(id: string, options?: StorageScopeOptions): string {
    return `${this.prefix}/${this.tenantSegment(options)}signed/${assertValidDocumentId(id)}_meta.json`;
  }

  async healthCheck(): Promise<StorageHealthResult> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, provider: this.providerName };
    } catch (err) {
      return {
        ok: false,
        provider: this.providerName,
        details: err instanceof Error ? err.message : "S3 bucket check failed",
      };
    }
  }

  async saveGeneratedPdf(
    id: string,
    pdfBuffer: Buffer,
    options?: StorageScopeOptions
  ): Promise<void> {
    assertValidPdfPayload(pdfBuffer);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.generatedKey(id, options),
        Body: pdfBuffer,
        ContentType: "application/pdf",
        ServerSideEncryption: "AES256",
      })
    );
  }

  async existsGeneratedPdf(id: string, options?: StorageScopeOptions): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.generatedKey(id, options),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async readGeneratedPdf(id: string, options?: StorageScopeOptions): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.generatedKey(id, options),
        })
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch {
      return null;
    }
  }

  async saveSignedPdf(
    id: string,
    pdfBuffer: Buffer,
    metadata: SignedPdfMetadata,
    options?: StorageScopeOptions
  ): Promise<void> {
    assertValidPdfPayload(pdfBuffer);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.signedKey(id, options),
        Body: pdfBuffer,
        ContentType: "application/pdf",
        ServerSideEncryption: "AES256",
        Metadata: {
          sha256: metadata.sha256,
          uploaded_at: metadata.uploadedAt,
        },
      })
    );

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.signedMetaKey(id, options),
        Body: JSON.stringify(metadata, null, 2),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      })
    );
  }

  async existsSignedPdf(id: string, options?: StorageScopeOptions): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.signedKey(id, options),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async readSignedPdf(id: string, options?: StorageScopeOptions): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.signedKey(id, options),
        })
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch {
      return null;
    }
  }

  async readSignedMetadata(
    id: string,
    options?: StorageScopeOptions
  ): Promise<SignedPdfMetadata | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.signedMetaKey(id, options),
        })
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as SignedPdfMetadata;
    } catch {
      return null;
    }
  }

  async deleteExpired(retentionHours: number): Promise<RetentionCleanupResult> {
    const safeHours = Math.max(1, Number.isFinite(retentionHours) ? retentionHours : 24);
    const cutoff = new Date(Date.now() - safeHours * 60 * 60 * 1000);
    let deletedGenerated = 0;
    let deletedSigned = 0;

    const purgeBucketTree = async () => {
      let continuationToken: string | undefined;
      do {
        const listed = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${this.prefix}/`,
            ContinuationToken: continuationToken,
          })
        );
        for (const obj of listed.Contents || []) {
          if (!obj.Key || !obj.LastModified) continue;
          if (obj.LastModified < cutoff) {
            await this.client.send(
              new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: obj.Key,
              })
            );
            if (obj.Key.includes("/signed/") && obj.Key.endsWith("_signed.pdf")) {
              deletedSigned += 1;
            } else if (obj.Key.includes("/generated/") && obj.Key.endsWith(".pdf")) {
              deletedGenerated += 1;
            }
          }
        }
        continuationToken = listed.IsTruncated
          ? listed.NextContinuationToken
          : undefined;
      } while (continuationToken);
    };

    await purgeBucketTree();

    return { deletedGenerated, deletedSigned };
  }
}

let cachedProvider: StorageProvider | null = null;

export function resetStorageProviderCache(): void {
  cachedProvider = null;
}

export function getStorageProvider(): StorageProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const mode = (process.env.STORAGE_PROVIDER || "local").trim().toLowerCase();
  if (mode === "s3") {
    const bucket = process.env.S3_BUCKET || "";
    if (!bucket.trim()) {
      throw new Error(
        "S3_BUCKET environment variable is required when STORAGE_PROVIDER=s3"
      );
    }
    cachedProvider = new S3StorageProvider({
      bucket,
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
      prefix: process.env.S3_PREFIX || undefined,
    });
    return cachedProvider;
  }

  cachedProvider = new LocalStorageProvider({
    generatedDir: process.env.GENERATED_PDF_DIR || undefined,
    signedDir: process.env.SIGNED_PDF_DIR || undefined,
  });
  return cachedProvider;
}
