// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.tsx";
import { matchPricingTierForPages } from "../../src/components/studio/studio-api.ts";

function findButtonByExactText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  );
}

describe("Public Landing Conversion Experience (/)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.pushState({}, "", "/");
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

  it("renders clean public landing on /, hides /admin and AuthGate, and omits Normal Upload/Download labels", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/public/config") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            toggles: {
              normalUpload: true,
              normalDownload: true,
              topTierZipUpload: true,
              topTierZipDownload: true,
            },
            pricingTiers: [
              {
                id: "tier_15_299",
                name: "Up to 15 pages",
                max_pages: 15,
                price_cents: 299,
                description: "Up to 15 pages",
                is_active: 1,
              },
              {
                id: "tier_30_599",
                name: "Up to 30 pages",
                max_pages: 30,
                price_cents: 599,
                description: "Up to 30 pages",
                is_active: 1,
              },
              {
                id: "tier_45_749",
                name: "Up to 45 pages",
                max_pages: 45,
                price_cents: 749,
                description: "Up to 45 pages",
                is_active: 1,
              },
              {
                id: "tier_60_999",
                name: "Up to 60 pages",
                max_pages: 60,
                price_cents: 999,
                description: "Up to 60 pages",
                is_active: 1,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
    });

    const text = container.textContent || "";
    expect(text).toContain("Turn Static PDFs & Form Bundles Into Fillable AcroForms");
    expect(text).toContain("Up to 15 pages");
    expect(text).toContain("$2.99");
    expect(text).toContain("Up to 30 pages");
    expect(text).toContain("$5.99");
    expect(text).toContain("Up to 45 pages");
    expect(text).toContain("$7.49");
    expect(text).toContain("Up to 60 pages");
    expect(text).toContain("$9.99");
    expect(text).toContain("Above 60 Pages");
    expect(text).toContain("Custom Price");
    expect(text).toContain("Bulk, Business & Recurring Conversions");

    // Required upload controls with exact labels
    expect(findButtonByExactText(container, "Upload")).toBeTruthy();
    expect(findButtonByExactText(container, "ZIP Upload")).toBeTruthy();

    // Commercial footer, formifypdf.com domain, and social media links
    const footer = container.querySelector("footer");
    expect(footer).toBeTruthy();
    expect(footer?.textContent).toContain("formifypdf.com");
    expect(footer?.textContent).toContain("support@formifypdf.com");
    expect(footer?.querySelector('a[aria-label="FormifyPDF on X"]')).toBeTruthy();
    expect(footer?.querySelector('a[aria-label="FormifyPDF on LinkedIn"]')).toBeTruthy();
    expect(footer?.querySelector('a[aria-label="FormifyPDF on GitHub"]')).toBeTruthy();
    expect(footer?.querySelector('a[aria-label="FormifyPDF on YouTube"]')).toBeTruthy();

    // Verify policy modal opens from footer link
    const privacyBtn = findButtonByExactText(container, "Privacy Policy");
    expect(privacyBtn).toBeTruthy();
    await act(async () => {
      privacyBtn?.click();
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Privacy Policy");
    const closeModalBtn = findButtonByExactText(container, "Close");
    await act(async () => {
      closeModalBtn?.click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // Forbidden strings and hidden /admin checks
    expect(text).not.toContain("Normal Upload");
    expect(text).not.toContain("Normal Download");
    expect(text).not.toContain("Claim FormifyPDF Administrator");
    expect(text).not.toContain("Sign In to FormifyPDF Studio");
    expect(text).not.toContain("Conversion Studio");
    expect(container.querySelector('a[href="/admin"]')).toBeNull();
    const adminBtn = Array.from(container.querySelectorAll("button, a")).find(
      (el) => el.textContent?.trim() === "Admin"
    );
    expect(adminBtn).toBeUndefined();
  });

  it("uploads PDF, converts, previews on screen, matches active pricing tier, locks downloads until checkout, then unlocks", async () => {
    let paidState = false;
    const downloadCalls: string[] = [];

    const tiers = [
      {
        id: "tier_15_299",
        name: "Up to 15 pages",
        max_pages: 15,
        price_cents: 299,
        description: "Up to 15 pages",
        is_active: 1,
      },
      {
        id: "tier_30_599",
        name: "Up to 30 pages",
        max_pages: 30,
        price_cents: 599,
        description: "Up to 30 pages",
        is_active: 1,
      },
      {
        id: "tier_45_749",
        name: "Up to 45 pages",
        max_pages: 45,
        price_cents: 749,
        description: "Up to 45 pages",
        is_active: 1,
      },
      {
        id: "tier_60_999",
        name: "Up to 60 pages",
        max_pages: 60,
        price_cents: 999,
        description: "Up to 60 pages",
        is_active: 1,
      },
    ];
    expect(matchPricingTierForPages(20, tiers)?.id).toBe("tier_30_599");
    expect(matchPricingTierForPages(40, tiers)?.id).toBe("tier_45_749");
    expect(matchPricingTierForPages(55, tiers)?.id).toBe("tier_60_999");
    expect(matchPricingTierForPages(65, tiers)).toBeNull();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/public/config") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            toggles: {
              normalUpload: true,
              normalDownload: true,
              topTierZipUpload: true,
              topTierZipDownload: true,
            },
            pricingTiers: tiers,
          }),
        };
      }
      if (url === "/api/v1/public/conversions/conv_20p") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            conversion: {
              id: "conv_20p",
              documentId: "doc_20p",
              jobId: "job_20p",
              sourceType: "pdf",
              archiveFilename: null,
              originalFilename: "application-20p.pdf",
              title: "Application 20p",
              pageCount: 20,
              fieldCount: 14,
              widgetCount: 14,
              acroformByteSize: 98304,
              paid: paidState,
              paidTierId: paidState ? "tier_30_599" : null,
              paidTierName: paidState ? "Up to 30 pages" : null,
              paidAmountCents: paidState ? 599 : null,
              job: {
                id: "job_20p",
                stage: "completed",
                progress_pct: 100,
                status: "completed",
              },
            },
            matchedTier: tiers[1],
            pricingTiers: tiers,
            toggles: {
              normalUpload: true,
              normalDownload: true,
              topTierZipUpload: true,
              topTierZipDownload: true,
            },
          }),
        };
      }
      if (url === "/api/v1/public/conversions/conv_20p/preview") {
        const bytes = new TextEncoder().encode("%PDF-1.7");
        return {
          ok: true,
          arrayBuffer: async () => bytes.buffer,
        };
      }
      if (url === "/api/v1/public/conversions/conv_20p/checkout" && init?.method === "POST") {
        paidState = true;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            paid: true,
            tier: tiers[1],
          }),
        };
      }
      if (url === "/api/v1/public/conversions/conv_20p/download") {
        downloadCalls.push(url);
        const bytes = new TextEncoder().encode("%PDF-1.7");
        return {
          ok: true,
          headers: new Headers({
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename='application-20p-fillable-acroform.pdf'",
          }),
          arrayBuffer: async () => bytes.buffer,
        };
      }
      if (url === "/api/v1/public/conversions/conv_20p/zip-download") {
        downloadCalls.push(url);
        const bytes = new TextEncoder().encode("PK");
        return {
          ok: true,
          headers: new Headers({
            "content-type": "application/zip",
            "content-disposition": "attachment; filename='application-20p-fillable-bundle.zip'",
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
          conversionId: "conv_20p",
          accessToken: "tok_abc",
          jobId: "job_20p",
        });
        this.onload?.();
      }
    }
    globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;

    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-download");
    URL.revokeObjectURL = vi.fn();

    try {
      await act(async () => {
        root.render(<App />);
      });

      const fileInput = container.querySelector("#public-pdf-upload") as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const mockPdf = new File(["%PDF-1.7"], "application-20p.pdf", { type: "application/pdf" });
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [mockPdf], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const convertBtn = findButtonByExactText(container, "Convert to Fillable PDF");
      expect(convertBtn).toBeTruthy();
      expect(convertBtn?.disabled).toBe(false);

      await act(async () => {
        convertBtn?.click();
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 600));
      });

      // Verify on-screen presentation, summary, matched pricing tier, and locked downloads
      expect(container.textContent).toContain("Converted Fillable PDF Preview");
      expect(container.textContent).toContain("application-20p.pdf");
      expect(container.textContent).toContain("20 pages");
      expect(container.textContent).toContain("14 fields · 14 widgets");
      expect(container.textContent).toContain("Up to 30 pages");
      expect(container.textContent).toContain("$5.99");

      const dlBtnLocked = findButtonByExactText(container, "Download");
      const zipDlBtnLocked = findButtonByExactText(container, "ZIP Download");
      expect(dlBtnLocked?.disabled).toBe(true);
      expect(zipDlBtnLocked?.disabled).toBe(true);

      // Click pay-to-unlock CTA
      const payBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Pay $5.99 to Unlock Downloads")
      );
      expect(payBtn).toBeTruthy();

      await act(async () => {
        payBtn?.click();
      });

      // Downloads are now unlocked and clickable
      const dlBtnUnlocked = findButtonByExactText(container, "Download");
      const zipDlBtnUnlocked = findButtonByExactText(container, "ZIP Download");
      expect(dlBtnUnlocked?.disabled).toBe(false);
      expect(zipDlBtnUnlocked?.disabled).toBe(false);

      await act(async () => {
        dlBtnUnlocked?.click();
      });
      await act(async () => {
        zipDlBtnUnlocked?.click();
      });

      expect(downloadCalls).toEqual([
        "/api/v1/public/conversions/conv_20p/download",
        "/api/v1/public/conversions/conv_20p/zip-download",
      ]);
    } finally {
      globalThis.XMLHttpRequest = origXhr;
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
  });
});
