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
