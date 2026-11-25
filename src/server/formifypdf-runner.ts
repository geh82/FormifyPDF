import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFormifyNodeEngine } from "./formifypdf-node-engine.ts";

export type EngineCommand =
  | "inspect"
  | "analyze"
  | "generate-acroform"
  | "render-pdf"
  | "validate-acroform";

export function detectPythonExecutable(): string {
  const configured = (process.env.PYTHON_EXECUTABLE || "").trim();
  if (configured) return configured;
  return process.platform === "win32" ? "python" : "python3";
}

function isMissingPythonDepsError(msg: string): boolean {
  return (
    msg.includes("ModuleNotFoundError") ||
    msg.includes("No module named") ||
    msg.includes("ENOENT")
  );
}

let cachedPythonBin: string | null = null;
let cachedPythonDepsAvailable: boolean | null = null;

export function resetPythonAvailabilityCache(): void {
  cachedPythonBin = null;
  cachedPythonDepsAvailable = null;
}

async function hasPythonPdfDependencies(pythonBin: string): Promise<boolean> {
  if (cachedPythonBin === pythonBin && cachedPythonDepsAvailable !== null) {
    return cachedPythonDepsAvailable;
  }

  const available = await new Promise<boolean>((resolve) => {
    const child = spawn(
      pythonBin,
      ["-c", "import fitz, pypdf, pdfplumber, cv2, pytesseract"],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
      }
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(false);
    }, 3000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

  cachedPythonBin = pythonBin;
  cachedPythonDepsAvailable = available;
  return available;
}

export async function runFormifyPythonEngine<T = unknown>(
  command: EngineCommand,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; scriptPath?: string; pythonExecutable?: string } = {}
): Promise<T> {
  const scriptPath =
    options.scriptPath ||
    path.resolve(process.cwd(), "python", "formifypdf_engine.py");
  const pythonBin = options.pythonExecutable || detectPythonExecutable();
  const timeoutMs =
    options.timeoutMs ?? Number(process.env.PYTHON_TIMEOUT_MS || "60000");

  // Fast path: when using default Python + script and Python PDF libraries are absent,
  // route directly to the built-in Node engine without paying process spawn overhead.
  if (!options.scriptPath && !options.pythonExecutable) {
    if (!fs.existsSync(scriptPath) || !(await hasPythonPdfDependencies(pythonBin))) {
      return await runFormifyNodeEngine<T>(command, payload);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-py-"));
  const id = crypto.randomBytes(6).toString("hex");
  const inputJsonPath = path.join(tempDir, `in_${id}.json`);
  const outputJsonPath = path.join(tempDir, `out_${id}.json`);

  try {
    fs.writeFileSync(inputJsonPath, JSON.stringify(payload), {
      encoding: "utf-8",
      mode: 0o600,
    });

    const { exitCode, stderr } = await new Promise<{
      exitCode: number | null;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        pythonBin,
        [scriptPath, command, inputJsonPath, outputJsonPath],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
          },
        }
      );

      let stderrText = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill(process.platform === "win32" ? undefined : "SIGKILL");
        } catch {
          // ignore kill error if process already exited
        }
      }, timeoutMs);

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrText.length < 8192) {
          stderrText += chunk.toString("utf-8");
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`PYTHON_TIMEOUT: Engine timed out after ${timeoutMs}ms`));
          return;
        }
        resolve({ exitCode: code, stderr: stderrText });
      });
    });

    if (fs.existsSync(outputJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(outputJsonPath, "utf-8")) as {
        ok: boolean;
        result?: T;
        code?: string;
        error?: string;
      };
      if (!parsed.ok) {
        const err = new Error(parsed.error || stderr || "Python engine failed");
        (err as Error & { code?: string }).code = parsed.code || "ENGINE_ERROR";
        throw err;
      }
      return parsed.result as T;
    }

    if (exitCode !== 0) {
      if (
        !options.scriptPath &&
        !options.pythonExecutable &&
        isMissingPythonDepsError(stderr)
      ) {
        cachedPythonBin = pythonBin;
        cachedPythonDepsAvailable = false;
        return await runFormifyNodeEngine<T>(command, payload);
      }
      throw new Error(stderr || `Python engine exited with code ${exitCode}`);
    }

    throw new Error("Python engine produced no output manifest");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !options.scriptPath &&
      !options.pythonExecutable &&
      isMissingPythonDepsError(msg)
    ) {
      cachedPythonBin = pythonBin;
      cachedPythonDepsAvailable = false;
      return await runFormifyNodeEngine<T>(command, payload);
    }
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
