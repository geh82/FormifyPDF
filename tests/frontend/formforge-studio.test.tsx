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
} from "../../src/lib/formforge/coordinate.ts";

describe("FormForge AI Coordinate Calibration & Studio Frontend", () => {
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

  it("opens FormForge AI Studio tab, shows First-Run Admin Claim, and renders Dashboard & ALV Integration Template", async () => {
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
            token: "ffs_testtoken",
            user: {
              id: "usr_admin",
              email: "admin@formforge.local",
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
                id: "doc_alv_official",
                title: "Official ALV(9)(2011/07) Form",
                original_filename: "ALV_blank.pdf",
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
                id: "tpl_alv_official",
                document_id: "doc_alv_official",
                name: "Official ALV(9)(2011/07) — Motor Vehicle Licensing",
                slug: "alv-official-9-2011-07",
                description: "Pre-calibrated ALV integration template.",
                category: "Government & Licensing",
                tags_json: '["ALV"]',
                status: "approved",
                output_policy: "flattened",
                current_version_number: 1,
                is_system_integration: 1,
                integration_key: "alv_official",
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

    // Switch to FormForge AI Studio tab
    const studioTab = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) =>
      b.textContent?.includes("FormForge AI Studio")
    ) as HTMLButtonElement;
    expect(studioTab).toBeTruthy();

    await act(async () => {
      studioTab.click();
    });

    expect(container.textContent).toContain("Claim FormForge AI Administrator");

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

    expect(container.textContent).toContain("Official ALV(9)(2011/07)");
  });
});
