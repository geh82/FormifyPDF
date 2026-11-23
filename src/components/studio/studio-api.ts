import type {
  AcroFormValidationReport,
  DetectedFormField,
  DocumentPageInfo,
  FieldManifest,
  RoleName,
} from "../../lib/formforge/types.ts";

export interface AuthUser {
  id: string | null;
  email: string;
  fullName: string;
  role: RoleName;
  tenantId: string;
  permissions: string[];
}

export interface AuthStatusResponse {
  ok: boolean;
  bootstrapped: boolean;
  requiresFirstRunSetup: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

export interface DocumentRecord {
  id: string;
  title: string;
  original_filename: string;
  byte_size: number;
  page_count: number;
  is_scanned: number;
  has_existing_acroform: number;
  status: string;
  latest_job_id?: string | null;
  latest_job_status?: string | null;
  latest_field_count?: number | null;
  latest_acroform_asset_id?: string | null;
  created_at: string;
}

export interface JobRecord {
  id: string;
  document_id: string;
  document_title?: string;
  original_filename?: string;
  job_type: string;
  stage: string;
  progress_pct: number;
  status: string;
  error_code?: string | null;
  error_message?: string | null;
  attempts: number;
  created_at: string;
  completed_at?: string | null;
}

export interface TemplateRecord {
  id: string;
  document_id: string | null;
  name: string;
  slug: string;
  description: string;
  category: string;
  tags_json: string;
  status: string;
  output_policy: "flattened" | "fillable" | "both";
  current_version_number: number;
  is_system_integration: number;
  integration_key: string | null;
  latest_version_id?: string;
  latest_is_approved?: number;
  field_count?: number;
  updated_at: string;
}

export class StudioApiClient {
  private bearerToken: string | null = null;

  setToken(token: string | null) {
    this.bearerToken = token;
  }

  getToken(): string | null {
    return this.bearerToken;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra || {}) };
    if (this.bearerToken) {
      h.Authorization = `Bearer ${this.bearerToken}`;
    }
    return h;
  }

  async json<T = Record<string, unknown>>(
    url: string,
    init: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: this.headers({
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...((init.headers as Record<string, string>) || {}),
      }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Invalid server response" }));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data as T;
  }

  async fetchPdfBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Failed to load PDF (${res.status})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  uploadPdfWithProgress(
    file: File,
    options: { title: string; enableOcr: boolean; forceOcr: boolean; ocrLanguage: string },
    onProgress: (pct: number) => void
  ): Promise<{
    ok: boolean;
    document: DocumentRecord & { pageCount: number };
    jobId: string | null;
  }> {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);
      form.append("title", options.title);
      form.append("enableOcr", String(options.enableOcr));
      form.append("forceOcr", String(options.forceOcr));
      form.append("ocrLanguage", options.ocrLanguage);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/v1/documents");
      if (this.bearerToken) {
        xhr.setRequestHeader("Authorization", `Bearer ${this.bearerToken}`);
      }
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          onProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
            resolve(data);
          } else {
            reject(new Error(data.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error("Invalid upload response"));
        }
      };
      xhr.onerror = () => reject(new Error("Network error during PDF upload"));
      xhr.send(form);
    });
  }

  async renderTestPdf(
    documentId: string,
    values: Record<string, unknown>,
    flatten: boolean
  ): Promise<Uint8Array> {
    const res = await fetch(`/api/v1/documents/${documentId}/test-fill`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ values, flatten }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Sample fill failed" }));
      throw new Error(err.error || "Sample fill failed");
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

export type {
  AcroFormValidationReport,
  DetectedFormField,
  DocumentPageInfo,
  FieldManifest,
};
