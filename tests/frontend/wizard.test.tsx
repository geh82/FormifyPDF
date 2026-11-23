// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.tsx";

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickButtonByText(container: HTMLElement, text: string) {
  const buttons = Array.from(container.querySelectorAll("button"));
  const target = buttons.find((b) => b.textContent?.includes(text));
  if (!target) {
    throw new Error(`Button containing "${text}" not found`);
  }
  target.click();
}

describe("ALV Form Online Frontend Wizard", () => {
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

  it("validates steps, navigates forward and backward, reviews, generates PDF, and completes signed upload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        id: "abcdef0123456789abcdef01",
        downloadUrl: "/api/download?id=abcdef0123456789abcdef01&type=generated&disposition=attachment",
        inlineUrl: "/api/download?id=abcdef0123456789abcdef01&type=generated&disposition=inline",
        filename: "ALV_generated.pdf",
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
    });

    // Step 1: Attempt Continue with empty form -> validation error shown
    await act(async () => {
      clickButtonByText(container, "Continue");
    });
    expect(container.textContent).toContain("Identification number is required");

    // Fill Step 1 Owner details
    await act(async () => {
      setInputValue(
        container.querySelector('input[id="owner.identificationNumber"]')!,
        "8506155012089"
      );
      setInputValue(
        container.querySelector('input[id="owner.surnameOrOrganisation"]')!,
        "VAN DER MERWE"
      );
      setInputValue(container.querySelector('input[id="owner.initials"]')!, "JP");
      setInputValue(
        container.querySelector('input[id="owner.firstNames"]')!,
        "JOHANNES PETRUS"
      );
      setInputValue(
        container.querySelector('input[id="owner.cellphone"]')!,
        "0825551234"
      );
    });

    await act(async () => {
      clickButtonByText(container, "Continue");
    });

    // Step 2: Addresses
    expect(container.textContent).toContain("2. Postal & Street Address Details");
    await act(async () => {
      setInputValue(
        container.querySelector('input[id="postalAddress.line1"]')!,
        "PO BOX 1420"
      );
      setInputValue(
        container.querySelector('input[id="postalAddress.suburb"]')!,
        "SANDTON"
      );
      setInputValue(
        container.querySelector('input[id="postalAddress.city"]')!,
        "JOHANNESBURG"
      );
      setInputValue(
        container.querySelector('input[id="postalAddress.postalCode"]')!,
        "2146"
      );
      const sameCheckbox = Array.from(
        container.querySelectorAll('input[type="checkbox"]')
      )[0] as HTMLInputElement;
      sameCheckbox.click();
    });

    await act(async () => {
      clickButtonByText(container, "Continue");
    });

    // Step 3: Organisation Proxy & Rep (individual owner skips cleanly)
    expect(container.textContent).toContain("3. Organisation's Proxy & Representative");
    await act(async () => {
      clickButtonByText(container, "Continue");
    });

    // Step 4: Vehicle Details + test Previous Step button
    expect(container.textContent).toContain("4. Identification of Motor Vehicle");
    await act(async () => {
      clickButtonByText(container, "Previous Step");
    });
    expect(container.textContent).toContain("3. Organisation's Proxy & Representative");
    await act(async () => {
      clickButtonByText(container, "Continue");
    });

    await act(async () => {
      setInputValue(
        container.querySelector('input[id="vehicle.licenceNumber"]')!,
        "GP442198"
      );
      setInputValue(
        container.querySelector('input[id="vehicle.chassisVin"]')!,
        "WBA3A5C50CF256981"
      );
      setInputValue(container.querySelector('input[id="vehicle.make"]')!, "BMW");
      setInputValue(
        container.querySelector('input[id="vehicle.seriesName"]')!,
        "320I SEDAN"
      );
      setInputValue(
        container.querySelector('input[id="vehicle.odometerReading"]')!,
        "124500"
      );
    });

    await act(async () => {
      clickButtonByText(container, "Continue");
    });

    // Step 5: Declaration & Review
    expect(container.textContent).toContain("5. Declaration & Review");
    expect(container.textContent).toContain("Application Review Summary");

    await act(async () => {
      setInputValue(
        container.querySelector('input[id="declaration.signatoryName"]')!,
        "Johannes Petrus van der Merwe"
      );
      setInputValue(
        container.querySelector('input[id="declaration.place"]')!,
        "JOHANNESBURG"
      );
    });

    await act(async () => {
      clickButtonByText(container, "Generate Official ALV PDF");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Official ALV PDF Generated");
    expect(container.textContent).toContain("ALV-ABCDEF01");

    // Verify Download link and Open & Print button work
    const dlAnchor = container.querySelector('a[download="ALV_generated.pdf"]') as HTMLAnchorElement;
    expect(dlAnchor).toBeTruthy();
    expect(dlAnchor.getAttribute("href")).toContain("disposition=attachment");

    await act(async () => {
      clickButtonByText(container, "Open & Print");
    });
    const iframe = container.querySelector('iframe[title="Generated Official ALV PDF"]') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute("src")).toContain("disposition=inline");

    // Test upload failure state first (server rejects invalid PDF)
    class FailingXHR {
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 400;
      responseText = "";
      open() {}
      send() {
        this.responseText = JSON.stringify({
          ok: false,
          error: "Uploaded file failed PDF signature verification",
        });
        this.onload?.();
      }
    }
    globalThis.XMLHttpRequest = FailingXHR as unknown as typeof XMLHttpRequest;

    const fileInput = container.querySelector('#signed-pdf-input') as HTMLInputElement;
    const pdfFile = new File(["%PDF-1.4\n...%%EOF"], "signed_alv.pdf", {
      type: "application/pdf",
    });
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [pdfFile], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("signed_alv.pdf");

    await act(async () => {
      clickButtonByText(container, "Upload Signed PDF");
    });
    expect(container.textContent).toContain("Signed PDF upload failed");
    expect(container.textContent).toContain("Uploaded file failed PDF signature verification");

    // Verify Signed Upload success via XMLHttpRequest mock
    class MockXHR {
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 200;
      responseText = "";
      open() {}
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
        this.responseText = JSON.stringify({
          ok: true,
          documentId: "abcdef0123456789abcdef01",
          reference: "ALV-ABCDEF01",
          byteSize: 115883,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          uploadedAt: "2026-11-22T12:00:00.000Z",
        });
        this.onload?.();
      }
    }
    globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;

    await act(async () => {
      clickButtonByText(container, "Upload Signed PDF");
    });

    expect(container.textContent).toContain("Signed ALV Document Uploaded Successfully");
    expect(container.textContent).toContain("ALV-ABCDEF01");
  });
});
