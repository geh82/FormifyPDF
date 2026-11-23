import { useState, type FormEvent } from "react";
import { AlertCircle, KeyRound, Lock, ShieldCheck } from "lucide-react";
import type { AuthStatusResponse, AuthUser, StudioApiClient } from "./studio-api.ts";

interface AuthGateProps {
  api: StudioApiClient;
  authStatus: AuthStatusResponse;
  onAuthenticated: (user: AuthUser, token: string) => void;
}

export function AuthGate({ api, authStatus, onAuthenticated }: AuthGateProps) {
  const [mode, setMode] = useState<"setup" | "login" | "reset">(
    authStatus.requiresFirstRunSetup ? "setup" : "login"
  );

  const [email, setEmail] = useState("admin@formforge.local");
  const [fullName, setFullName] = useState("Workspace Administrator");
  const [orgName, setOrgName] = useState("FormForge Workspace");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [resetToken, setResetToken] = useState("");
  const [issuedTokenHint, setIssuedTokenHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleBootstrap = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Administrator password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.json<{
        ok: boolean;
        token: string;
        user: AuthUser;
      }>("/api/v1/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          email,
          fullName,
          password,
          organisationName: orgName,
        }),
      });
      api.setToken(res.token);
      onAuthenticated(res.user, res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize admin");
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.json<{
        ok: boolean;
        token: string;
        user: AuthUser;
      }>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      api.setToken(res.token);
      onAuthenticated(res.user, res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRequestReset = async () => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const res = await api.json<{
        ok: boolean;
        message: string;
        resetToken?: string;
      }>("/api/v1/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setInfo(res.message);
      if (res.resetToken) {
        setIssuedTokenHint(res.resetToken);
        setResetToken(res.resetToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request password reset");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReset = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.json("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token: resetToken, newPassword: password }),
      });
      setInfo("Password updated. You may now sign in.");
      setMode("login");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset confirmation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md my-8 rounded-lg border border-slate-200 bg-white p-7">
      <div className="flex items-center gap-2.5 text-emerald-900 mb-2">
        {mode === "setup" ? (
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Lock className="h-5 w-5" aria-hidden="true" />
        )}
        <h2 className="text-lg font-semibold text-slate-900">
          {mode === "setup"
            ? "Claim FormForge AI Administrator"
            : mode === "reset"
            ? "Reset Account Password"
            : "Sign In to FormForge AI Studio"}
        </h2>
      </div>
      <p className="text-xs text-slate-600 leading-relaxed mb-5">
        {mode === "setup"
          ? "First-run setup: create the initial workspace administrator account. Once claimed, registration locks automatically and roles are managed inside User Management."
          : mode === "reset"
          ? "Request a short-lived reset token for your account email and set a new password."
          : "Access universal PDF analysis, visual field calibration, AcroForm generation, templates, and REST API keys."}
      </p>

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {info && (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <p>{info}</p>
          {issuedTokenHint && (
            <p className="mt-1 font-mono text-[11px] break-all">
              Dev reset token: {issuedTokenHint}
            </p>
          )}
        </div>
      )}

      {mode === "setup" && (
        <form onSubmit={handleBootstrap} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Organisation / Tenant Name
            </label>
            <input
              type="text"
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Administrator Full Name
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Administrator Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Password (min 8 characters)
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Confirm Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-emerald-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 min-h-[40px]"
          >
            {busy ? "Creating Administrator..." : "Claim Admin & Open Studio"}
          </button>
        </form>
      )}

      {mode === "login" && (
        <form onSubmit={handleLogin} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-emerald-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 min-h-[40px]"
          >
            {busy ? "Signing In..." : "Sign In"}
          </button>
          <div className="pt-2 flex items-center justify-between text-xs text-slate-600">
            <button
              type="button"
              onClick={() => setMode("reset")}
              className="inline-flex items-center gap-1 hover:text-slate-900 hover:underline"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Forgot password?</span>
            </button>
          </div>
        </form>
      )}

      {mode === "reset" && (
        <form onSubmit={handleConfirmReset} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Account Email
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
              />
              <button
                type="button"
                onClick={handleRequestReset}
                disabled={busy}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
              >
                Issue Token
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Reset Token
            </label>
            <input
              type="text"
              required
              value={resetToken}
              onChange={(e) => setResetToken(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              New Password (min 8 chars)
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-md bg-emerald-900 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Confirm Reset
            </button>
            <button
              type="button"
              onClick={() => setMode("login")}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
