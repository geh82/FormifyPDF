import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PythonRunOptions {
  pythonExecutable?: string;
  scriptPath?: string;
  templatePath?: string;
  fieldMapPath?: string;
  timeoutMs?: number;
}

export interface PythonRunResult {
  pdfBuffer: Buffer;
  stdout: string;
}

export class PythonEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PythonEngineError";
    this.code = code;
  }
}

export function resolvePythonExecutable(override?: string): string {
  const configured = (override ?? process.env.PYTHON_EXECUTABLE ?? "").trim();
  if (configured.length > 0) {
    return configured;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export async function runAlvPythonEngine(
  payload: Record<string, unknown>,
  options: PythonRunOptions = {}
): Promise<PythonRunResult> {
  const pythonBin = resolvePythonExecutable(options.pythonExecutable);
  const scriptPath = path.resolve(
    options.scriptPath || path.join(process.cwd(), "src", "lib", "alv", "fill_alv.py")
  );
  const templatePath = path.resolve(
    options.templatePath || path.join(process.cwd(), "src", "lib", "alv", "ALV_blank.pdf")
  );
  const fieldMapPath = path.resolve(
    options.fieldMapPath || path.join(process.cwd(), "src", "lib", "alv", "field_map.json")
  );
  const timeoutMs =
    options.timeoutMs ??
    Math.max(1000, Number(process.env.PYTHON_TIMEOUT_MS || "15000"));

  // Pre-flight existence checks
  for (const [label, filePath, code] of [
    ["Python PDF engine script", scriptPath, "SCRIPT_NOT_FOUND"],
    ["Official blank ALV PDF template", templatePath, "TEMPLATE_NOT_FOUND"],
    ["ALV field map", fieldMapPath, "FIELD_MAP_NOT_FOUND"],
  ] as const) {
    try {
      await fs.access(filePath);
    } catch {
      throw new PythonEngineError(code, `${label} could not be found`);
    }
  }

  const runToken = crypto.randomBytes(12).toString("hex");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `alv-${runToken}-`));
  const tempJsonPath = path.join(tempDir, "input.json");
  const tempPdfPath = path.join(tempDir, "output.pdf");

  try {
    await fs.writeFile(tempJsonPath, JSON.stringify(payload), {
      encoding: "utf-8",
      mode: 0o600,
    });

    const args = [
      scriptPath,
      "--in",
      tempJsonPath,
      "--out",
      tempPdfPath,
      "--template",
      templatePath,
      "--map",
      fieldMapPath,
    ];

    const { stdout, stderr, exitCode } = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;
      const MAX_STDIO = 64 * 1024;

      const child = spawn(pythonBin, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore kill error
          }
          reject(
            new PythonEngineError(
              "PYTHON_TIMEOUT",
              `PDF generation timed out after ${timeoutMs}ms`
            )
          );
        }
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBuf.length < MAX_STDIO) {
          stdoutBuf += chunk.toString("utf-8");
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBuf.length < MAX_STDIO) {
          stderrBuf += chunk.toString("utf-8");
        }
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (err.code === "ENOENT") {
          reject(
            new PythonEngineError(
              "PYTHON_NOT_FOUND",
              `Python executable '${pythonBin}' was not found`
            )
          );
        } else {
          reject(
            new PythonEngineError(
              "PYTHON_SPAWN_ERROR",
              `Failed to start Python PDF engine: ${err.message}`
            )
          );
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code });
      });
    });

    if (exitCode !== 0) {
      const msg = stderr.trim() || `Python PDF engine exited with code ${exitCode}`;
      if (msg.includes("No module named 'fitz'") || msg.includes("ModuleNotFoundError")) {
        throw new PythonEngineError(
          "PYMUPDF_MISSING",
          "PyMuPDF (fitz) dependency is not installed in the Python environment"
        );
      }
      throw new PythonEngineError("PYTHON_PROCESSING_FAILED", msg);
    }

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await fs.readFile(tempPdfPath);
    } catch {
      throw new PythonEngineError(
        "OUTPUT_PDF_MISSING",
        "Python engine exited cleanly but did not produce an output PDF"
      );
    }

    if (pdfBuffer.length < 100 || pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new PythonEngineError(
        "OUTPUT_PDF_INVALID",
        "Generated output failed PDF signature validation"
      );
    }

    return { pdfBuffer, stdout };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
