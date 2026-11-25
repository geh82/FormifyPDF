// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.tsx";
import {
  bottomLeftPdfToTopLeftPdf,
  pdfRectToViewportPx,
  topLeftPdfToBottomLeftPdf,
  viewportPxToPdfRect,
} from "../../src/lib/formifypdf/coordinate.ts";

describe("FormifyPDF Coordinate Calibration & Studio Frontend", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("performs reversible coordinate transforms across scale, rotation, and CropBox bottom-left / top-left spaces", () => {
    const pageW = 595.28;
    const pageH = 841.89;
    const orig = { x: 120.5, y: 210.25, width: 180, height: 22 };

    for (const rot of [0, 90, 180, 270] as const) {
      const px = pdfRectToViewportPx(orig, 1.4, pageW, pageH, rot);
      const back = viewportPxToPdfRect(px, 1.4, pageW, pageH, rot);
      expect(Math.abs(back.x - orig.x)).toBeLessThan(0.1);
      expect(Math.abs(back.y - orig.y)).toBeLessThan(0.1);
      expect(Math.abs(back.width - orig.width)).toBeLessThan(0.1);
      expect(Math.abs(back.height - orig.height)).toBeLessThan(0.1);
    }

    const crop = { x: 10, y: 20, width: 595.28, height: 841.89 };
    const bottomLeft = topLeftPdfToBottomLeftPdf(orig, crop);
    const backTopLeft = bottomLeftPdfToTopLeftPdf(bottomLeft, crop);
    expect(backTopLeft.x).toBeCloseTo(orig.x, 1);
    expect(backTopLeft.y).toBeCloseTo(orig.y, 1);
    expect(backTopLeft.width).toBeCloseTo(orig.width, 1);
    expect(backTopLeft.height).toBeCloseTo(orig.height, 1);
  });

  it("opens FormifyPDF Studio tab, shows First-Run Admin Claim, and renders Dashboard & Approved Template", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/status") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            bootstrapped: false,
            requiresFirstRunSetup: true,
            authenticated: false,
            user: null,
          }),
        };
      }
      if (url === "/api/v1/auth/bootstrap" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            token: "fps_testtoken",
            user: {
              id: "usr_admin",
              email: "admin@formifypdf.local",
              fullName: "Workspace Administrator",
              role: "administrator",
              tenantId: "tenant_default",
              permissions: [
                "documents:read",
                "documents:write",
                "fields:edit",
                "templates:read",
                "templates:write",
                "templates:approve",
                "render:write",
                "signed:write",
                "api_keys:manage",
                "users:manage",
                "settings:manage",
                "audit:read",
              ],
            },
          }),
        };
      }
      if (url === "/api/v1/dashboard") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            metrics: {
              totalDocumentsProcessed: 1,
              totalTemplatesCreated: 1,
              approvedTemplates: 1,
              documentsAwaitingReview: 0,
              conversionSuccessRate: 100,
              processingFailures: 0,
              totalJobs: 0,
              generatedDocumentsCount: 0,
              storageUsedBytes: 120000,
            },
            recentActivity: [],
            recentJobs: [],
          }),
        };
      }
      if (url === "/api/v1/documents") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            documents: [
              {
                id: "doc_sample_form",
                title: "Sample Official Form",
                original_filename: "sample_form.pdf",
                byte_size: 115000,
                page_count: 2,
                is_scanned: 0,
                has_existing_acroform: 0,
                status: "template_created",
                latest_field_count: 48,
                created_at: "2026-11-22T00:00:00Z",
              },
            ],
          }),
        };
      }
      if (url === "/api/v1/templates") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            templates: [
              {
                id: "tpl_sample_approved",
                document_id: "doc_sample_form",
                name: "Sample Approved Form Template",
                slug: "sample-approved-form",
                description: "Pre-calibrated approved form template.",
                category: "Government & Licensing",
                tags_json: '["FORM"]',
                status: "approved",
                output_policy: "flattened",
                current_version_number: 1,
                is_system_integration: 1,
                integration_key: "sample_official",
                field_count: 48,
                updated_at: "2026-11-22T00:00:00Z",
              },
            ],
          }),
        };
      }
      if (url === "/api/v1/jobs") {
        return { ok: true, json: async () => ({ ok: true, jobs: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
    });

    // Verify Conversion Studio tab
    const studioTab = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) =>
      b.textContent?.includes("Conversion Studio")
    ) as HTMLButtonElement;
    expect(studioTab).toBeTruthy();

    await act(async () => {
      studioTab.click();
    });

    expect(container.textContent).toContain("Claim FormifyPDF Administrator");

    // Fill passwords & claim admin
    const pwInputs = Array.from(
      container.querySelectorAll('input[type="password"]')
    ) as HTMLInputElement[];
    expect(pwInputs.length).toBe(2);

    const setVal = (el: HTMLInputElement, val: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    await act(async () => {
      setVal(pwInputs[0], "AdminPass1234!");
      setVal(pwInputs[1], "AdminPass1234!");
    });

    const submitBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Claim Admin & Open Studio")
    ) as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });

    expect(container.textContent).toContain("Platform Overview");
    expect(container.textContent).toContain("Documents Processed");

    // Navigate to Template Library inside Studio sidebar
    const tplNav = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Template Library")
    ) as HTMLButtonElement;
    await act(async () => {
      tplNav.click();
    });

    expect(container.textContent).toContain("Sample Approved Form Template");
  });

  it("runs the 3-step Upload PDF -> Convert to Fillable PDF -> Download AcroForm workflow cleanly", async () => {
    let jobPollCount = 0;
    const downloadCalls: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/status") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            bootstrapped: true,
            requiresFirstRunSetup: false,
            authenticated: true,
            user: {
              id: "usr_admin",
              email: "admin@formifypdf.local",
              fullName: "Workspace Administrator",
              role: "administrator",
              tenantId: "tenant_default",
              permissions: [
                "documents:read",
                "documents:write",
                "fields:edit",
                "templates:read",
                "templates:write",
                "templates:approve",
                "render:write",
              ],
            },
          }),
        };
      }
      if (url === "/api/v1/dashboard") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            metrics: { totalDocumentsProcessed: 0 },
            recentActivity: [],
            recentJobs: [],
          }),
        };
      }
      if (url === "/api/v1/documents") {
        return { ok: true, json: async () => ({ ok: true, documents: [] }) };
      }
      if (url === "/api/v1/templates") {
        return { ok: true, json: async () => ({ ok: true, templates: [] }) };
      }
      if (url === "/api/v1/jobs") {
        return { ok: true, json: async () => ({ ok: true, jobs: [] }) };
      }
      if (url === "/api/v1/jobs/job_conv_1") {
        jobPollCount += 1;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            job: {
              id: "job_conv_1",
              document_id: "doc_conv_1",
              job_type: "full_analysis",
              stage: "completed",
              progress_pct: 100,
              status: "completed",
              attempts: 1,
              created_at: "2026-11-24T00:00:00Z",
              completed_at: "2026-11-24T00:00:02Z",
            },
          }),
        };
      }
      if (url === "/api/v1/documents/doc_conv_1") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            document: {
              id: "doc_conv_1",
              title: "Client Application",
              original_filename: "client-application.pdf",
              page_count: 2,
              latest_field_count: 6,
            },
            latestAsset: { widget_count: 6 },
          }),
        };
      }
      if (url === "/api/v1/documents/doc_conv_1/acroform-pdf?disposition=attachment") {
        downloadCalls.push(url);
        const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF");
        return {
          ok: true,
          headers: new Headers({
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="client-application-fillable-acroform.pdf"',
          }),
          arrayBuffer: async () => bytes.buffer,
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const origXhr = globalThis.XMLHttpRequest;
    class MockXMLHttpRequest {
      upload: { onprogress: ((evt: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 201;
      responseText = "";
      open() {}
      setRequestHeader() {}
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
        this.responseText = JSON.stringify({
          ok: true,
          document: { id: "doc_conv_1", title: "Client Application", pageCount: 2 },
          jobId: "job_conv_1",
        });
        this.onload?.();
      }
    }
    globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;

    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-acroform-url");
    URL.revokeObjectURL = vi.fn();

    try {
      await act(async () => {
        root.render(<App />);
      });

      const convertNav = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.trim() === "Convert PDF"
      ) as HTMLButtonElement;
      expect(convertNav).toBeTruthy();

      await act(async () => {
        convertNav.click();
      });

      const fileInput = container.querySelector("#formifypdf-pdf-upload") as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const convertBtnBefore = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Convert to Fillable PDF")
      ) as HTMLButtonElement;
      expect(convertBtnBefore.disabled).toBe(true);

      const mockPdf = new File(["%PDF-1.7\n%%EOF"], "client-application.pdf", {
        type: "application/pdf",
      });
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [mockPdf], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const convertBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Convert to Fillable PDF")
      ) as HTMLButtonElement;
      expect(convertBtn.disabled).toBe(false);

      await act(async () => {
        convertBtn.click();
      });

      // Allow job poll timer (600ms) + async state updates to complete
      await act(async () => {
        await new Promise((r) => setTimeout(r, 750));
      });

      expect(jobPollCount).toBeGreaterThanOrEqual(1);
      expect(container.textContent).toContain("Conversion Complete");

      const dlBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Download AcroForm")
      ) as HTMLButtonElement;
      expect(dlBtn).toBeTruthy();

      await act(async () => {
        dlBtn.click();
      });

      expect(downloadCalls).toEqual([
        "/api/v1/documents/doc_conv_1/acroform-pdf?disposition=attachment",
      ]);
    } finally {
      globalThis.XMLHttpRequest = origXhr;
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
  });
});
