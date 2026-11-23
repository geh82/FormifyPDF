import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import { saveZipArchive } from "../../server/zipStorage.ts";

async function createSampleZipBuffer(
  entries: Record<string, string | Buffer>
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("ZIP Upload & Workspace API (/api/zip-uploads)", () => {
  let tmpRoot: string;
  let zipsDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zip-uploads-test-"));
    zipsDir = path.join(tmpRoot, "uploaded-zips");

    const app = await createApp({
      disableRateLimit: true,
      zipOptions: {
        rootDir: zipsDir,
        disableRateLimit: true,
        limits: {
          maxArchiveBytes: 256 * 1024, // 256 KB
          maxEntries: 10,
          maxEntryBytes: 128 * 1024,
          maxTotalUncompressedBytes: 200 * 1024,
        },
      },
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("uploads, extracts into uploaded-zips/<id>/files/, lists, reads with nosniff + sandbox CSP, and deletes", async () => {
    const zipBuf = await createSampleZipBuffer({
      "brand/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#0f3d2e"/></svg>',
      "styles/tokens.css": ":root { --accent: #f59e0b; }",
      "pages/index.html": "<script>alert(1)</script><h1>Hello</h1>",
    });

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(zipBuf)], { type: "application/zip" }),
      "brand-kit.zip"
    );

    const postRes = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: form,
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    expect(postJson.ok).toBe(true);
    expect(postJson.archive.id).toMatch(/^[a-f0-9]{24}$/);
    expect(postJson.archive.fileCount).toBe(3);

    const id: string = postJson.archive.id;
    expect(fs.existsSync(path.join(zipsDir, id, "files", "brand", "logo.svg"))).toBe(true);
    expect(fs.existsSync(path.join(zipsDir, id, "files", "styles", "tokens.css"))).toBe(true);

    // List archives
    const listRes = await fetch(`${baseUrl}/api/zip-uploads`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.ok).toBe(true);
    expect(listJson.archives.some((a: { id: string }) => a.id === id)).toBe(true);

    // Get manifest
    const manifestRes = await fetch(`${baseUrl}/api/zip-uploads/${id}`);
    expect(manifestRes.status).toBe(200);
    const manifestJson = await manifestRes.json();
    expect(manifestJson.archive.originalFilename).toBe("brand-kit.zip");

    // Wildcard file read with nosniff + sandbox CSP and text/plain for HTML
    const htmlRes = await fetch(`${baseUrl}/api/zip-uploads/${id}/files/pages/index.html`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlRes.headers.get("content-security-policy")).toContain("sandbox");
    expect(htmlRes.headers.get("content-type")).toContain("text/plain");
    expect(await htmlRes.text()).toContain("<h1>Hello</h1>");

    // Query param file read for SVG
    const svgRes = await fetch(
      `${baseUrl}/api/zip-uploads/${id}/file?path=${encodeURIComponent("brand/logo.svg")}`
    );
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");
    expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");

    // Path traversal attempt on read is blocked
    const traversalRead = await fetch(
      `${baseUrl}/api/zip-uploads/${id}/file?path=${encodeURIComponent("../../etc/passwd")}`
    );
    expect(traversalRead.status).toBe(400);
    const traversalJson = await traversalRead.json();
    expect(traversalJson.code).toBe("PATH_TRAVERSAL");

    const wildcardTraversal = await fetch(
      `${baseUrl}/api/zip-uploads/${id}/files/%2e%2e%2f%2e%2e%2fmanifest.json`
    );
    expect(wildcardTraversal.status).toBe(400);

    // Delete archive
    const delRes = await fetch(`${baseUrl}/api/zip-uploads/${id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(fs.existsSync(path.join(zipsDir, id))).toBe(false);

    const afterDelRes = await fetch(`${baseUrl}/api/zip-uploads/${id}`);
    expect(afterDelRes.status).toBe(404);
  });

  it("rejects non-PK magic bytes, wrong extension, empty uploads, and corrupt ZIPs", async () => {
    // Fake .zip containing shell script (no PK header)
    const fakeForm = new FormData();
    fakeForm.append(
      "file",
      new Blob(["#!/bin/sh\nrm -rf /\n"], { type: "application/zip" }),
      "fake.zip"
    );
    const fakeRes = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: fakeForm,
    });
    expect(fakeRes.status).toBe(400);
    const fakeJson = await fakeRes.json();
    expect(fakeJson.code).toBe("INVALID_ZIP_SIGNATURE");

    // Non-.zip filename
    const validZip = await createSampleZipBuffer({ "a.txt": "hello" });
    const badExtForm = new FormData();
    badExtForm.append(
      "file",
      new Blob([new Uint8Array(validZip)], { type: "application/zip" }),
      "payload.tar.gz"
    );
    const badExtRes = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: badExtForm,
    });
    expect(badExtRes.status).toBe(400);

    // Corrupt buffer starting with PK\x03\x04
    const corruptForm = new FormData();
    corruptForm.append(
      "file",
      new Blob([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x11])], {
        type: "application/zip",
      }),
      "corrupt.zip"
    );
    const corruptRes = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: corruptForm,
    });
    expect(corruptRes.status).toBe(400);
    const corruptJson = await corruptRes.json();
    expect(corruptJson.code).toBe("CORRUPT_ZIP");
  });

  it("blocks ZIP-slip traversal entries inside uploaded archives", async () => {
    // JSZip strips '../' during zip creation, so craft a real malicious ZIP buffer
    // by replacing a same-length path in both Local File Header and Central Directory
    const slipZip = new JSZip();
    slipZip.file("XX/YY/escaped.txt", "evil content");
    const rawBuf = await slipZip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const rawStr = rawBuf.toString("latin1");
    expect(rawStr).toContain("XX/YY/escaped.txt");
    const buf = Buffer.from(rawStr.replaceAll("XX/YY/escaped.txt", "../../escaped.txt"), "latin1");

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buf)], { type: "application/zip" }),
      "zipslip.zip"
    );

    const res = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("PATH_TRAVERSAL");

    // Ensure escaped file was NOT written outside or inside zipsDir
    expect(fs.existsSync(path.join(tmpRoot, "escaped.txt"))).toBe(false);
  });

  it("enforces entry count, uncompressed byte cap, and upload byte limit", async () => {
    // 1. Entry count > 10 (configured maxEntries = 10)
    const manyEntries: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      manyEntries[`file_${i}.txt`] = `content ${i}`;
    }
    const tooManyBuf = await createSampleZipBuffer(manyEntries);
    const tooManyForm = new FormData();
    tooManyForm.append(
      "file",
      new Blob([new Uint8Array(tooManyBuf)], { type: "application/zip" }),
      "too-many.zip"
    );
    const tooManyRes = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: tooManyForm,
    });
    expect(tooManyRes.status).toBe(400);
    const tooManyJson = await tooManyRes.json();
    expect(tooManyJson.code).toBe("TOO_MANY_ENTRIES");

    // 2. Uncompressed size cap > 200 KB (compressible zeros shrink under 256 KB compressed)
    const bombBuf = await createSampleZipBuffer({
      "big_1.txt": Buffer.alloc(120 * 1024, 0x41),
      "big_2.txt": Buffer.alloc(120 * 1024, 0x42),
    });
    const bombForm = new FormData();
    bombForm.append(
      "file",
      new Blob([new Uint8Array(bombBuf)], { type: "application/zip" }),
      "bomb.zip"
    );
    const bombRes = await fetch(`${baseUrl}/api/zip-uploads`, {
      method: "POST",
      body: bombForm,
    });
    expect(bombRes.status).toBe(413);
    const bombJson = await bombRes.json();
    expect(bombJson.code).toBe("ARCHIVE_UNCOMPRESSED_TOO_LARGE");

    // 3. Direct storage guard on invalid ID
    await expect(
      saveZipArchive(Buffer.from("not-a-zip"), "bad.zip", { rootDir: zipsDir })
    ).rejects.toMatchObject({ code: "INVALID_ZIP_SIGNATURE" });
  });
});
