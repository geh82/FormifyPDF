import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFormForgeNodeEngine } from "./formforge-node-engine.ts";

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

export async function runFormForgePythonEngine<T = unknown>(
  command: EngineCommand,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; scriptPath?: string; pythonExecutable?: string } = {}
): Promise<T> {
  const scriptPath =
    options.scriptPath ||
    path.resolve(process.cwd(), "python", "formforge_engine.py");
  const pythonBin = options.pythonExecutable || detectPythonExecutable();
  const timeoutMs =
    options.timeoutMs ?? Number(process.env.PYTHON_TIMEOUT_MS || "60000");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-py-"));
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
          },
        }
      );

      let stderrText = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
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
        return await runFormForgeNodeEngine<T>(command, payload);
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
      return await runFormForgeNodeEngine<T>(command, payload);
    }
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
