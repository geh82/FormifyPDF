// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.tsx";
import {
  auditWorkspaceFiles,
  classifyZipFile,
  isMacOsClutter,
  sanitizeClientZipPath,
} from "../../src/lib/brandAudit.ts";

function clickButtonByText(container: HTMLElement, text: string) {
  const buttons = Array.from(container.querySelectorAll("button"));
  const target = buttons.find((b) => b.textContent?.includes(text));
  if (!target) {
    throw new Error(`Button containing "${text}" not found`);
  }
  target.click();
}

describe("brandAudit utilities", () => {
  it("audits zero-byte files, macOS clutter, and normalized hex colour tokens", () => {
    const encoder = new TextEncoder();
    const report = auditWorkspaceFiles([
      {
        path: "styles/brand.css",
        size: 64,
        bytes: encoder.encode(":root { --primary: #0f3d2e; --white: #fff; --alpha: #0f3d2ecc; }"),
        ...classifyZipFile("styles/brand.css"),
      },
      {
        path: "__MACOSX/styles/._brand.css",
        size: 120,
        bytes: new Uint8Array(120),
        ...classifyZipFile("__MACOSX/styles/._brand.css"),
      },
      {
        path: ".DS_Store",
        size: 40,
        bytes: new Uint8Array(40),
        ...classifyZipFile(".DS_Store"),
      },
      {
        path: "assets/empty.svg",
        size: 0,
        bytes: new Uint8Array(0),
        ...classifyZipFile("assets/empty.svg"),
      },
    ]);

    expect(report.totalFiles).toBe(4);
    expect(report.zeroByteFiles).toEqual(["assets/empty.svg"]);
    expect(report.macOsClutterFiles).toEqual(["__MACOSX/styles/._brand.css", ".DS_Store"]);
    expect(report.colorTokens.map((t) => t.normalizedHex)).toEqual(["#0F3D2E", "#FFFFFF"]);
    expect(report.colorTokens[0].count).toBe(2);
    expect(isMacOsClutter("folder/._icon.png")).toBe(true);
    expect(sanitizeClientZipPath("../../etc/passwd")).toBeNull();
    expect(sanitizeClientZipPath("/assets/logo.svg")).toBe("assets/logo.svg");
  });
});

describe("ZipInspectorSection UI workflow", () => {
  let container: HTMLDivElement;
  let root: Root;
  const origCreateObjectUrl = URL.createObjectURL;
  const origRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    URL.createObjectURL = origCreateObjectUrl;
    URL.revokeObjectURL = origRevokeObjectUrl;
    vi.restoreAllMocks();
  });

  it("switches to ZIP Inspector, unpacks .zip, audits tokens/clutter, strips macOS clutter, edits CSS, and repackages", async () => {
    const zip = new JSZip();
    zip.file("styles/theme.css", "body { color: #0f3d2e; background: #ffffff; }");
    zip.file("assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#d97706"/></svg>');
    zip.file("__MACOSX/._logo.svg", "appledouble");
    zip.file("notes/empty.txt", "");
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/zip-uploads" && (!init || init.method !== "POST")) {
        return {
          ok: true,
          json: async () => ({ ok: true, archives: [] }),
        } as Response;
      }
      if (url === "/api/zip-uploads" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            archive: {
              id: "abcdef0123456789abcdef01",
              originalFilename: "brand-pack.zip",
              uploadedAt: "2026-11-22T13:00:00.000Z",
              archiveSize: zipBytes.length,
              fileCount: 4,
              totalUncompressedBytes: 256,
              files: [],
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<App />);
    });

    // Switch to ZIP Workspace & Auditor tab
    await act(async () => {
      clickButtonByText(container, "ZIP Workspace & Auditor");
    });

    expect(container.textContent).toContain("ZIP Workspace Inspector, Brand Auditor & Repackager");

    // Upload .zip through #zip-archive-upload-input
    const fileInput = container.querySelector("#zip-archive-upload-input") as HTMLInputElement;
    const zipFile = new File([new Uint8Array(zipBytes)], "brand-pack.zip", {
      type: "application/zip",
    });
    Object.defineProperty(zipFile, "arrayBuffer", {
      value: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
    });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [zipFile], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Wait for async JSZip unpacking & POST /api/zip-uploads
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("styles/theme.css");
    expect(container.textContent).toContain("assets/logo.svg");
    expect(container.textContent).toContain("#0F3D2E");
    expect(container.textContent).toContain("#D97706");
    expect(container.textContent).toContain("Strip macOS (1)");

    // Strip macOS clutter
    await act(async () => {
      clickButtonByText(container, "Strip macOS (1)");
    });
    expect(container.textContent).not.toContain("__MACOSX/._logo.svg");

    // Select styles/theme.css and edit it
    await act(async () => {
      clickButtonByText(container, "styles/theme.css");
    });
    const editor = container.querySelector('textarea[aria-label="Edit styles/theme.css"]') as HTMLTextAreaElement;
    expect(editor).toBeTruthy();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(editor, "body { color: #123456; }");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      clickButtonByText(container, "Save Edit");
    });
    expect(container.textContent).toContain("#123456");

    // Download repackaged .zip
    await act(async () => {
      clickButtonByText(container, "Download Repackaged .zip");
      for (let i = 0; i < 40; i++) {
        if (container.textContent?.includes("Downloaded brand-pack-repackaged.zip")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    expect(container.textContent).toContain("Downloaded brand-pack-repackaged.zip");
  });
});
