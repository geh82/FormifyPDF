import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  FileCode2,
  FileText,
  FolderKanban,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PencilRuler,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import type {
  DetectedFormField,
  DocumentPageInfo,
  FieldManifest,
  RoleName,
} from "../../lib/formforge/types.ts";
import { AuthGate } from "./AuthGate.tsx";
import { DocumentPreviewAndValidation } from "./DocumentPreviewAndValidation.tsx";
import { PdfFieldEditor } from "./PdfFieldEditor.tsx";
import {
  StudioApiClient,
  type AuthStatusResponse,
  type AuthUser,
  type DocumentRecord,
  type JobRecord,
  type TemplateRecord,
} from "./studio-api.ts";

export type StudioNavSection =
  | "dashboard"
  | "convert"
  | "analysis"
  | "editor"
  | "templates"
  | "preview"
  | "validation"
  | "generation"
  | "api"
  | "history"
  | "settings"
  | "users";



function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FormForgeStudio() {
  const apiRef = useRef<StudioApiClient>(new StudioApiClient());
  const api = apiRef.current;

  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeNav, setActiveNav] = useState<StudioNavSection>("dashboard");

  // Shared loaded lists
  const [dashboardData, setDashboardData] = useState<{
    metrics: Record<string, number | null>;
    recentActivity: Array<Record<string, unknown>>;
    recentJobs: JobRecord[];
  } | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);

  // Active document & template selections
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // Convert PDF upload & job polling
  const [uploadTitle, setUploadTitle] = useState("");
  const [enableOcr, setEnableOcr] = useState(true);
  const [forceOcr, setForceOcr] = useState(false);
  const [ocrLanguage, setOcrLanguage] = useState("eng");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [activeJob, setActiveJob] = useState<JobRecord | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Document Analysis detail state
  const [docDetail, setDocDetail] = useState<{
    document: Record<string, unknown>;
    pages: Array<Record<string, unknown>>;
    manifest?: FieldManifest | null;
  } | null>(null);

  // Template Library filters & version detail
  const [tplSearch, setTplSearch] = useState("");
  const [tplStatusFilter, setTplStatusFilter] = useState("");
  const [tplDetail, setTplDetail] = useState<{
    template: TemplateRecord;
    versions: Array<{
      id: string;
      version_number: number;
      field_count: number;
      manifest_json: string;
      widget_count: number | null;
      is_approved: number;
      is_locked: number;
      changelog: string;
      created_at: string;
    }>;
    approvals: Array<Record<string, unknown>>;
  } | null>(null);

  // Engine B state
  const [genTemplateId, setGenTemplateId] = useState<string>("");
  const [genManifest, setGenManifest] = useState<FieldManifest | null>(null);
  const [genValues, setGenValues] = useState<Record<string, unknown>>({});
  const [genOutputMode, setGenOutputMode] = useState<"flattened" | "fillable">("flattened");
  const [renderedHistory, setRenderedHistory] = useState<Array<Record<string, unknown>>>([]);
  const [latestRendered, setLatestRendered] = useState<{
    generatedDocumentId: string;
    reference: string;
    outputMode: string;
    populatedWidgets: number;
    byteSize: number;
  } | null>(null);
  const [renderedPreviewUrl, setRenderedPreviewUrl] = useState<string | null>(null);
  const [signedUploadMsg, setSignedUploadMsg] = useState<string | null>(null);
  const [supportingDocs, setSupportingDocs] = useState<
    Array<{
      id: string;
      original_filename: string;
      mime_type: string;
      byte_size: number;
      category: string;
      created_at: string;
    }>
  >([]);
  const [supportingBusy, setSupportingBusy] = useState(false);

  // API & Integrations state
  const [apiKeys, setApiKeys] = useState<Array<Record<string, unknown>>>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>([
    "documents:read",
    "documents:write",
    "templates:read",
    "render:write",
  ]);
  const [createdKeySecret, setCreatedKeySecret] = useState<string | null>(null);
  const [openApiSpec, setOpenApiSpec] = useState<Record<string, unknown> | null>(null);

  // Settings & Users state
  const [settingsData, setSettingsData] = useState<{
    name: string;
    retentionDays: number;
    storageBytes: number;
  } | null>(null);
  const [usersList, setUsersList] = useState<Array<Record<string, unknown>>>([]);
  const [rolesList, setRolesList] = useState<
    Array<{ name: RoleName; label: string; description: string; permissions: string[] }>
  >([]);
  const [sessionsList, setSessionsList] = useState<Array<Record<string, unknown>>>([]);
  const [auditEvents, setAuditEvents] = useState<Array<Record<string, unknown>>>([]);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserRole, setNewUserRole] = useState<RoleName>("editor");
  const [newUserPassword, setNewUserPassword] = useState("");

  const [notice, setNotice] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);

  const hasPermission = useCallback(
    (perm: string) => Boolean(user?.permissions?.includes(perm)),
    [user]
  );

  // Initial auth status check
  const checkAuthStatus = useCallback(async () => {
    try {
      const status = await api.json<AuthStatusResponse>("/api/v1/auth/status");
      setAuthStatus(status);
      if (status.authenticated && status.user) {
        setUser(status.user);
      }
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Failed to connect to FormForge API");
    }
  }, [api]);

  useEffect(() => {
    void checkAuthStatus();
  }, [checkAuthStatus]);

  const refreshCoreLists = useCallback(async () => {
    if (!user) return;
    try {
      const [dash, docs, tpls, jobsRes] = await Promise.all([
        api.json<typeof dashboardData & { ok: boolean }>("/api/v1/dashboard"),
        api.json<{ ok: boolean; documents: DocumentRecord[] }>("/api/v1/documents"),
        api.json<{ ok: boolean; templates: TemplateRecord[] }>("/api/v1/templates"),
        api.json<{ ok: boolean; jobs: JobRecord[] }>("/api/v1/jobs"),
      ]);
      setDashboardData({
        metrics: dash.metrics,
        recentActivity: dash.recentActivity,
        recentJobs: dash.recentJobs,
      });
      setDocuments(docs.documents);
      setTemplates(tpls.templates);
      setJobs(jobsRes.jobs);
      if (!selectedDocId && docs.documents.length > 0) {
        setSelectedDocId(docs.documents[0].id);
      }
      if (!selectedTemplateId && tpls.templates.length > 0) {
        setSelectedTemplateId(tpls.templates[0].id);
      }
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Failed to load workspace data");
    }
  }, [api, user, selectedDocId, selectedTemplateId]);

  useEffect(() => {
    if (user) {
      void refreshCoreLists();
    }
  }, [user, refreshCoreLists]);

  // Poll active analysis job
  useEffect(() => {
    if (!activeJob || activeJob.status === "completed" || activeJob.status === "failed") {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const res = await api.json<{ ok: boolean; job: JobRecord }>(
          `/api/v1/jobs/${activeJob.id}`
        );
        setActiveJob(res.job);
        if (res.job.status === "completed" || res.job.status === "failed") {
          void refreshCoreLists();
        }
      } catch {
        // ignore transient poll failure
      }
    }, 900);
    return () => clearInterval(timer);
  }, [activeJob, api, refreshCoreLists]);

  // Load section-specific details on tab switch
  useEffect(() => {
    if (!user) return;
    if (activeNav === "analysis" && selectedDocId) {
      void (async () => {
        try {
          const detail = await api.json<{
            ok: boolean;
            document: Record<string, unknown>;
            pages: Array<Record<string, unknown>>;
          }>(`/api/v1/documents/${selectedDocId}`);
          let manifest: FieldManifest | null = null;
          try {
            const man = await api.json<{ ok: boolean; manifest: FieldManifest }>(
              `/api/v1/documents/${selectedDocId}/manifest`
            );
            manifest = man.manifest;
          } catch {
            manifest = null;
          }
          setDocDetail({ document: detail.document, pages: detail.pages, manifest });
        } catch (err) {
          setStudioError(err instanceof Error ? err.message : "Failed to load analysis");
        }
      })();
    }

    if (activeNav === "templates" && selectedTemplateId) {
      void (async () => {
        try {
          const detail = await api.json<{
            ok: boolean;
            template: TemplateRecord;
            versions: NonNullable<typeof tplDetail>["versions"];
            approvals: Array<Record<string, unknown>>;
          }>(`/api/v1/templates/${selectedTemplateId}`);
          if (detail.template) {
            setTplDetail({
              template: detail.template,
              versions: detail.versions || [],
              approvals: detail.approvals || [],
            });
          }
        } catch {
          // ignore
        }
      })();
    }

    if (activeNav === "generation") {
      void (async () => {
        try {
          const [renderedRes] = await Promise.all([
            api.json<{ ok: boolean; generatedDocuments: Array<Record<string, unknown>> }>(
              "/api/v1/rendered"
            ),
          ]);
          setRenderedHistory(renderedRes.generatedDocuments);
        } catch {
          // ignore
        }
      })();
    }

    if (activeNav === "api") {
      void (async () => {
        try {
          const spec = await api.json<Record<string, unknown>>("/api/v1/openapi.json");
          setOpenApiSpec(spec);
          if (hasPermission("api_keys:manage")) {
            const keysRes = await api.json<{ ok: boolean; apiKeys: Array<Record<string, unknown>> }>(
              "/api/v1/api-keys"
            );
            setApiKeys(keysRes.apiKeys);
          }
        } catch {
          // ignore
        }
      })();
    }

    if (activeNav === "settings" && hasPermission("settings:manage")) {
      void (async () => {
        try {
          const res = await api.json<{
            ok: boolean;
            tenant: { name: string; retention_days: number };
            storageBytes: number;
          }>("/api/v1/settings");
          setSettingsData({
            name: res.tenant.name,
            retentionDays: res.tenant.retention_days,
            storageBytes: res.storageBytes,
          });
        } catch {
          // ignore
        }
      })();
    }

    if (activeNav === "users") {
      void (async () => {
        try {
          const rolesRes = await api.json<{ ok: boolean; roles: typeof rolesList }>("/api/v1/roles");
          setRolesList(rolesRes.roles);
          if (hasPermission("users:manage")) {
            const [uRes, sRes] = await Promise.all([
              api.json<{ ok: boolean; users: Array<Record<string, unknown>> }>("/api/v1/users"),
              api.json<{ ok: boolean; sessions: Array<Record<string, unknown>> }>(
                "/api/v1/auth/sessions"
              ),
            ]);
            setUsersList(uRes.users);
            setSessionsList(sRes.sessions);
          }
          if (hasPermission("audit:read")) {
            const aRes = await api.json<{ ok: boolean; events: Array<Record<string, unknown>> }>(
              "/api/v1/audit-events"
            );
            setAuditEvents(aRes.events);
          }
        } catch {
          // ignore
        }
      })();
    }
  }, [activeNav, api, hasPermission, selectedDocId, selectedTemplateId, user]);

  // Load Engine B manifest when chosen approved template changes
  useEffect(() => {
    if (!user || activeNav !== "generation" || !genTemplateId) return;
    void (async () => {
      try {
        const res = await api.json<{
          ok: boolean;
          manifest: FieldManifest;
          outputPolicy: "flattened" | "fillable" | "both";
        }>(`/api/v1/templates/${genTemplateId}/manifest`);
        setGenManifest(res.manifest);
        const init: Record<string, unknown> = {};
        for (const f of res.manifest.fields) {
          init[f.name] = f.defaultValue || (f.type === "checkbox" ? false : "");
        }
        setGenValues(init);
        setGenOutputMode(res.outputPolicy === "fillable" ? "fillable" : "flattened");
      } catch {
        setGenManifest(null);
      }
    })();
  }, [activeNav, api, genTemplateId, user]);

  // Clean up Blob preview URL
  useEffect(() => {
    return () => {
      if (renderedPreviewUrl) URL.revokeObjectURL(renderedPreviewUrl);
    };
  }, [renderedPreviewUrl]);

  const handleUploadPdf = async (file: File) => {
    setUploadError(null);
    setNotice(null);
    setUploadProgress(0);
    try {
      const res = await api.uploadPdfWithProgress(
        file,
        {
          title: uploadTitle.trim() || file.name.replace(/\.pdf$/i, ""),
          enableOcr,
          forceOcr,
          ocrLanguage,
        },
        (pct) => setUploadProgress(pct)
      );
      setSelectedDocId(res.document.id);
      if (res.jobId) {
        setActiveJob({
          id: res.jobId,
          document_id: res.document.id,
          job_type: "full_analysis",
          stage: "queued",
          progress_pct: 5,
          status: "queued",
          attempts: 1,
          created_at: new Date().toISOString(),
        });
      }
      setNotice(`Uploaded ${res.document.title} (${res.document.pageCount} pages). Analysis started.`);
      await refreshCoreLists();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadProgress(null);
    }
  };

  const selectedDoc = useMemo(
    () => documents.find((d) => d.id === selectedDocId) || null,
    [documents, selectedDocId]
  );

  const selectedTpl = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId]
  );

  const filteredTemplates = useMemo(
    () =>
      templates.filter((t) => {
        if (tplStatusFilter && t.status !== tplStatusFilter) return false;
        if (tplSearch.trim()) {
          const hay = `${t.name} ${t.description} ${t.category} ${t.tags_json}`.toLowerCase();
          if (!hay.includes(tplSearch.trim().toLowerCase())) return false;
        }
        return true;
      }),
    [templates, tplSearch, tplStatusFilter]
  );

  const approvedTemplates = useMemo(
    () => templates.filter((t) => t.status === "approved"),
    [templates]
  );

  // Version Diff calculation between latest and previous template version
  const versionDiff = useMemo(() => {
    if (!tplDetail?.versions || tplDetail.versions.length < 2) return null;
    const latest = JSON.parse(tplDetail.versions[0].manifest_json) as FieldManifest;
    const prev = JSON.parse(tplDetail.versions[1].manifest_json) as FieldManifest;
    const prevMap = new Map(prev.fields.map((f) => [f.name, f]));
    const latestMap = new Map(latest.fields.map((f) => [f.name, f]));

    const added = latest.fields.filter((f) => !prevMap.has(f.name)).map((f) => f.name);
    const removed = prev.fields.filter((f) => !latestMap.has(f.name)).map((f) => f.name);
    const modified = latest.fields
      .filter((f) => {
        const pf = prevMap.get(f.name);
        if (!pf) return false;
        return (
          pf.type !== f.type ||
          pf.rect.x !== f.rect.x ||
          pf.rect.y !== f.rect.y ||
          pf.rect.width !== f.rect.width ||
          pf.rect.height !== f.rect.height ||
          pf.required !== f.required
        );
      })
      .map((f) => f.name);
    return {
      fromVersion: tplDetail.versions[1].version_number,
      toVersion: tplDetail.versions[0].version_number,
      added,
      removed,
      modified,
    };
  }, [tplDetail]);

  const handleEngineBRender = async (e: FormEvent) => {
    e.preventDefault();
    setStudioError(null);
    setNotice(null);
    setSignedUploadMsg(null);
    try {
      const res = await api.json<{
        ok: boolean;
        generatedDocumentId: string;
        reference: string;
        outputMode: string;
        populatedWidgets: number;
        byteSize: number;
      }>(`/api/v1/render/${genTemplateId}`, {
        method: "POST",
        body: JSON.stringify({
          outputMode: genOutputMode,
          values: genValues,
        }),
      });
      setLatestRendered(res);
      setNotice(`Document rendered (${res.reference}, ${res.outputMode}).`);

      // Fetch inline blob preview cleanly using bearer header
      const pdfBytes = await api.fetchPdfBytes(
        `/api/v1/rendered/${res.generatedDocumentId}/download?disposition=inline`
      );
      const blobUrl = URL.createObjectURL(
        new Blob([pdfBytes.slice()], { type: "application/pdf" })
      );
      setRenderedPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return blobUrl;
      });
      const renderedRes = await api.json<{
        ok: boolean;
        generatedDocuments: Array<Record<string, unknown>>;
      }>("/api/v1/rendered");
      setRenderedHistory(renderedRes.generatedDocuments);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Document render failed");
    }
  };

  const handleDownloadProtectedBlob = async (
    url: string,
    filename: string,
    mimeType = "application/pdf"
  ) => {
    try {
      const bytes = await api.fetchPdfBytes(url);
      const blobUrl = URL.createObjectURL(
        new Blob([bytes.slice()], { type: mimeType })
      );
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Download failed");
    }
  };

  const refreshSupportingDocs = useCallback(
    async (generatedDocumentId: string) => {
      try {
        const res = await api.json<{
          ok: boolean;
          supportingDocuments: typeof supportingDocs;
        }>(`/api/v1/supporting-documents?generatedDocumentId=${encodeURIComponent(generatedDocumentId)}`);
        setSupportingDocs(res.supportingDocuments || []);
      } catch {
        setSupportingDocs([]);
      }
    },
    [api]
  );

  useEffect(() => {
    if (activeNav === "generation" && latestRendered?.generatedDocumentId) {
      void refreshSupportingDocs(latestRendered.generatedDocumentId);
    } else {
      setSupportingDocs([]);
    }
  }, [activeNav, latestRendered?.generatedDocumentId, refreshSupportingDocs]);

  const handleUploadSupportingFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !latestRendered) return;
    setStudioError(null);
    setSupportingBusy(true);
    try {
      const form = new FormData();
      form.append("generatedDocumentId", latestRendered.generatedDocumentId);
      form.append("category", "supporting");
      for (const f of Array.from(files)) {
        form.append("files", f);
      }
      await api.json("/api/v1/supporting-documents", {
        method: "POST",
        body: form,
      });
      await refreshSupportingDocs(latestRendered.generatedDocumentId);
      setNotice(`Attached ${files.length} supporting document(s).`);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Supporting upload failed");
    } finally {
      setSupportingBusy(false);
    }
  };

  const handleReplaceSupportingFile = async (supId: string, file: File) => {
    if (!latestRendered) return;
    setStudioError(null);
    setSupportingBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api.json(`/api/v1/supporting-documents/${supId}`, {
        method: "PUT",
        body: form,
      });
      await refreshSupportingDocs(latestRendered.generatedDocumentId);
      setNotice(`Replaced supporting attachment with ${file.name}.`);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Replacement upload failed");
    } finally {
      setSupportingBusy(false);
    }
  };

  const handleDeleteSupportingFile = async (supId: string) => {
    if (!latestRendered) return;
    setStudioError(null);
    setSupportingBusy(true);
    try {
      await api.json(`/api/v1/supporting-documents/${supId}`, {
        method: "DELETE",
      });
      await refreshSupportingDocs(latestRendered.generatedDocumentId);
      setNotice("Supporting document deleted.");
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Failed to delete supporting document");
    } finally {
      setSupportingBusy(false);
    }
  };

  const handleUploadSignedRendered = async (file: File) => {
    if (!latestRendered) return;
    setStudioError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await api.json<{ ok: boolean; reference: string; sha256: string }>(
        `/api/v1/rendered/${latestRendered.generatedDocumentId}/upload-signed`,
        { method: "POST", body: form }
      );
      setSignedUploadMsg(`Signed PDF uploaded (${res.reference}). SHA-256: ${res.sha256.slice(0, 16)}...`);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : "Signed PDF upload failed");
    }
  };

  if (!authStatus) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        Connecting to FormForge AI Studio...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthGate
        api={api}
        authStatus={authStatus}
        onAuthenticated={(loggedUser) => {
          setUser(loggedUser);
          setStudioError(null);
        }}
      />
    );
  }

  const navItems: Array<{ id: StudioNavSection; label: string; icon: typeof LayoutDashboard }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "convert", label: "Convert PDF", icon: Upload },
    { id: "analysis", label: "Document Analysis", icon: FileText },
    { id: "editor", label: "Field Editor", icon: PencilRuler },
    { id: "templates", label: "Template Library", icon: FolderKanban },
    { id: "preview", label: "PDF Preview", icon: Activity },
    { id: "validation", label: "Test & Validation", icon: ShieldCheck },
    { id: "generation", label: "Document Generation", icon: Play },
    { id: "api", label: "API & Integrations", icon: Code2 },
    { id: "history", label: "Processing History", icon: History },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "users", label: "User Management", icon: Users },
  ];

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Studio Sub-Header Bar */}
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span className="font-semibold text-slate-900">FormForge AI Studio</span>
          <span>·</span>
          <span>{user.fullName}</span>
          <span>·</span>
          <span className="font-mono text-emerald-900 font-medium">{user.role}</span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={async () => {
              await api.json("/api/v1/auth/logout", { method: "POST" }).catch(() => null);
              api.setToken(null);
              setUser(null);
              void checkAuthStatus();
            }}
            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 whitespace-nowrap"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>

      {/* 240px Sidebar + Workspace Content */}
      <div className="flex flex-col md:flex-row min-h-[720px]">
        <aside className="w-full md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-slate-200 bg-slate-50/60 p-3">
          <nav aria-label="FormForge Studio Navigation" className="space-y-0.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setStudioError(null);
                    setNotice(null);
                    setActiveNav(item.id);
                  }}
                  className={`w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-xs font-medium text-left transition-colors ${
                    isActive
                      ? "bg-emerald-900 text-white"
                      : "text-slate-700 hover:bg-slate-200/70 hover:text-slate-900"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex-1 p-5 sm:p-6 min-w-0 space-y-6 bg-white">
          {notice && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-900">
              {notice}
            </div>
          )}
          {studioError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-800"
            >
              {studioError}
            </div>
          )}

          {/* 1. DASHBOARD */}
          {activeNav === "dashboard" && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    Platform Overview
                  </h2>
                  <p className="text-xs text-slate-500">
                    Real-time counts from workspace storage and processing queues.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveNav("convert")}
                    className="rounded-md bg-emerald-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800 whitespace-nowrap"
                  >
                    Convert PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveNav("templates")}
                    className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                  >
                    Browse Templates
                  </button>
                </div>
              </div>

              {/* KPI Strip (max 4 per row, clean tabular numerals) */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Documents Processed</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                    {dashboardData?.metrics.totalDocumentsProcessed ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Approved Templates</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                    {dashboardData?.metrics.approvedTemplates ?? 0} /{" "}
                    {dashboardData?.metrics.totalTemplatesCreated ?? 0}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Conversion Success Rate</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                    {dashboardData?.metrics.conversionSuccessRate !== null &&
                    dashboardData?.metrics.conversionSuccessRate !== undefined
                      ? `${dashboardData.metrics.conversionSuccessRate}%`
                      : "N/A"}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Storage Used</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                    {formatBytes(Number(dashboardData?.metrics.storageUsedBytes || 0))}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-slate-900">Recent Processing Jobs</h3>
                    <span className="text-[11px] text-slate-500 tabular-nums">
                      {dashboardData?.metrics.documentsAwaitingReview ?? 0} awaiting review
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100 text-xs">
                    {(dashboardData?.recentJobs || []).map((j) => (
                      <div key={j.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">
                            {j.document_title || j.document_id}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {j.stage} · {j.progress_pct}%
                          </p>
                        </div>
                        <span
                          className={`text-[11px] font-medium ${
                            j.status === "completed"
                              ? "text-emerald-700"
                              : j.status === "failed"
                              ? "text-rose-700"
                              : "text-amber-700"
                          }`}
                        >
                          {j.status}
                        </span>
                      </div>
                    ))}
                    {(!dashboardData?.recentJobs || dashboardData.recentJobs.length === 0) && (
                      <p className="p-4 text-slate-500">
                        No PDF conversion jobs run yet. Upload a PDF under Convert PDF.
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
                    <h3 className="text-xs font-semibold text-slate-900">Recent Audit Activity</h3>
                  </div>
                  <div className="divide-y divide-slate-100 text-xs max-h-72 overflow-y-auto">
                    {(dashboardData?.recentActivity || []).map((ev, i) => (
                      <div key={String(ev.id || i)} className="px-4 py-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-[11px] text-slate-900 truncate">
                            {String(ev.action)}
                          </p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {String(ev.actor_email || "system")} · {String(ev.resource_type)}
                          </p>
                        </div>
                        <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                          {String(ev.created_at || "").slice(11, 19)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. CONVERT PDF */}
          {activeNav === "convert" && (
            <div className="max-w-3xl space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Convert Any PDF to Interactive AcroForm
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Supports native digital PDFs, scanned image-only forms (OpenCV + Tesseract OCR), and mixed vector/tabular documents of any paper size.
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Document Title (Optional)
                    </label>
                    <input
                      type="text"
                      value={uploadTitle}
                      onChange={(e) => setUploadTitle(e.target.value)}
                      placeholder="e.g. Municipal Clearance Application"
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      OCR Language Pack
                    </label>
                    <input
                      type="text"
                      value={ocrLanguage}
                      onChange={(e) => setOcrLanguage(e.target.value)}
                      placeholder="eng"
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-6 text-xs text-slate-700">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={enableOcr}
                      onChange={(e) => setEnableOcr(e.target.checked)}
                    />
                    <span>Enable OCR Fallback for scanned / low-text pages</span>
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={forceOcr}
                      onChange={(e) => setForceOcr(e.target.checked)}
                    />
                    <span>Force OCR on all pages</span>
                  </label>
                </div>

                <label
                  htmlFor="formforge-pdf-upload"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f) void handleUploadPdf(f);
                  }}
                  className="block cursor-pointer rounded-lg border-2 border-dashed border-slate-300 bg-slate-50/70 hover:border-emerald-800 hover:bg-emerald-50/30 p-8 text-center transition-colors"
                >
                  <Upload className="mx-auto h-7 w-7 text-emerald-900 mb-2" />
                  <p className="text-sm font-medium text-slate-900">
                    Drop a PDF here or click to browse
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Up to 35 MB · Automatically inspects pages, detects fields, builds FieldManifest, and generates AcroForm widgets
                  </p>
                  <input
                    id="formforge-pdf-upload"
                    type="file"
                    accept="application/pdf,.pdf"
                    disabled={!hasPermission("documents:write")}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleUploadPdf(f);
                    }}
                    className="sr-only"
                  />
                </label>

                {uploadProgress !== null && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-600 tabular-nums">
                      <span>Uploading PDF...</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full bg-emerald-900 transition-all"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {uploadError && (
                  <div
                    role="alert"
                    className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
                  >
                    {uploadError}
                  </div>
                )}

                {activeJob && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-900">
                        Analysis Pipeline Status: {activeJob.stage}
                      </span>
                      <span className="font-mono tabular-nums text-slate-700">
                        {activeJob.progress_pct}% ({activeJob.status})
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          activeJob.status === "failed" ? "bg-rose-600" : "bg-emerald-800"
                        }`}
                        style={{ width: `${activeJob.progress_pct}%` }}
                      />
                    </div>
                    {activeJob.error_message && (
                      <p className="text-xs text-rose-700">{activeJob.error_message}</p>
                    )}
                    {activeJob.status === "completed" && (
                      <div className="pt-1 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDocId(activeJob.document_id);
                            setActiveNav("editor");
                          }}
                          className="rounded-md bg-emerald-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                        >
                          Open Visual Field Editor
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDocId(activeJob.document_id);
                            setActiveNav("analysis");
                          }}
                          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
                        >
                          Inspect Page Geometry
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. DOCUMENT ANALYSIS */}
          {activeNav === "analysis" && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    Document Analysis & Page Geometry
                  </h2>
                  <p className="text-xs text-slate-500">
                    Inspect MediaBox/CropBox coordinates, OCR telemetry, text spans, and confidence tiers.
                  </p>
                </div>
                <select
                  aria-label="Select document"
                  value={selectedDocId || ""}
                  onChange={(e) => setSelectedDocId(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                >
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} ({d.page_count}p · {d.status})
                    </option>
                  ))}
                </select>
              </div>

              {docDetail && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-3 text-slate-700">
                      <span className="font-semibold text-slate-900">
                        {String(docDetail.document.title)}
                      </span>
                      <span>·</span>
                      <span>{String(docDetail.document.original_filename)}</span>
                      <span>·</span>
                      <span className="tabular-nums">
                        {formatBytes(Number(docDetail.document.byte_size || 0))}
                      </span>
                      <span>·</span>
                      <span>
                        {Number(docDetail.document.is_scanned) ? "Scanned / OCR" : "Native Digital PDF"}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {hasPermission("documents:write") && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!selectedDocId) return;
                            const res = await api.json<{ ok: boolean; jobId: string }>(
                              `/api/v1/documents/${selectedDocId}/analyze`,
                              { method: "POST", body: JSON.stringify({ enableOcr: true }) }
                            );
                            setActiveJob({
                              id: res.jobId,
                              document_id: selectedDocId,
                              job_type: "full_analysis",
                              stage: "queued",
                              progress_pct: 5,
                              status: "queued",
                              attempts: 1,
                              created_at: new Date().toISOString(),
                            });
                            setActiveNav("convert");
                          }}
                          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100"
                        >
                          Re-Analyze
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveNav("editor")}
                        className="rounded bg-emerald-900 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-800"
                      >
                        Edit Fields
                      </button>
                      {hasPermission("documents:delete") &&
                        !String(docDetail.document.source_storage_key || "").startsWith("src/") && (
                          <button
                            type="button"
                            onClick={async () => {
                              if (!selectedDocId) return;
                              await api.json(`/api/v1/documents/${selectedDocId}`, {
                                method: "DELETE",
                              });
                              setSelectedDocId(null);
                              await refreshCoreLists();
                            }}
                            className="rounded border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                          >
                            Delete
                          </button>
                        )}
                    </div>
                  </div>

                  {/* Page Geometry Table */}
                  <div className="rounded-lg border border-slate-200 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="px-3 py-2 font-medium">Page</th>
                          <th className="px-3 py-2 font-medium">Paper</th>
                          <th className="px-3 py-2 font-medium">Dimensions (pt)</th>
                          <th className="px-3 py-2 font-medium">Rotation</th>
                          <th className="px-3 py-2 font-medium">Words / Drawings</th>
                          <th className="px-3 py-2 font-medium">OCR</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 tabular-nums">
                        {docDetail.pages.map((p) => (
                          <tr key={String(p.id)}>
                            <td className="px-3 py-2 font-medium text-slate-900">
                              #{Number(p.page_index) + 1}
                            </td>
                            <td className="px-3 py-2 text-slate-700">
                              {String(p.paper_size)} ({String(p.orientation)})
                            </td>
                            <td className="px-3 py-2 font-mono text-slate-700">
                              {Number(p.width_pt).toFixed(1)} × {Number(p.height_pt).toFixed(1)}
                            </td>
                            <td className="px-3 py-2">{String(p.rotation)}°</td>
                            <td className="px-3 py-2">
                              {String(p.word_count)}w · {String(p.drawing_count)} vec
                            </td>
                            <td className="px-3 py-2">
                              {Number(p.ocr_applied)
                                ? `OCR applied (${Number(p.deskew_angle || 0).toFixed(1)}° deskew)`
                                : "Native text"}
                            </td>
                          </tr>
                        ))}
                        {docDetail.pages.length === 0 && docDetail.manifest?.pages && (
                          docDetail.manifest.pages.map((mp: DocumentPageInfo) => (
                            <tr key={mp.pageIndex}>
                              <td className="px-3 py-2 font-medium">#{mp.pageIndex + 1}</td>
                              <td className="px-3 py-2">
                                {mp.paperSize} ({mp.orientation})
                              </td>
                              <td className="px-3 py-2 font-mono">
                                {mp.widthPt.toFixed(1)} × {mp.heightPt.toFixed(1)}
                              </td>
                              <td className="px-3 py-2">{mp.rotation}°</td>
                              <td className="px-3 py-2">
                                {mp.wordCount}w · {mp.drawingCount} vec
                              </td>
                              <td className="px-3 py-2">
                                {mp.ocrApplied ? "OCR applied" : "Native text"}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {docDetail.manifest?.detectionSummary && (
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                      <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                        <p className="text-slate-500">Detected Fields</p>
                        <p className="text-lg font-semibold text-slate-900 tabular-nums mt-0.5">
                          {docDetail.manifest.detectionSummary.totalDetectedFields}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                          {docDetail.manifest.detectionSummary.engineMode}
                        </p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                        <p className="text-slate-500">Character Grids / Comb</p>
                        <p className="text-lg font-semibold text-slate-900 tabular-nums mt-0.5">
                          {docDetail.manifest.detectionSummary.charGridGroupCount} grids ·{" "}
                          {docDetail.manifest.detectionSummary.combFieldCount} comb
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Native AcroForm Comb preserved
                        </p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                        <p className="text-slate-500">Confidence Tiers</p>
                        <p className="text-sm font-semibold text-slate-900 tabular-nums mt-1">
                          {docDetail.manifest.detectionSummary.confidenceBreakdown.high} high ·{" "}
                          {docDetail.manifest.detectionSummary.confidenceBreakdown.medium} med ·{" "}
                          {docDetail.manifest.detectionSummary.confidenceBreakdown.low} low
                        </p>
                      </div>
                      <div
                        className={`rounded-lg border p-3.5 ${
                          docDetail.manifest.detectionSummary.reviewRecommendedCount > 0
                            ? "border-amber-200 bg-amber-50/70"
                            : "border-emerald-200 bg-emerald-50/60"
                        }`}
                      >
                        <p className="text-slate-700 font-medium">Review Queue</p>
                        <p className="text-lg font-semibold text-slate-900 tabular-nums mt-0.5">
                          {docDetail.manifest.detectionSummary.reviewRecommendedCount} flagged
                        </p>
                        <p className="text-[11px] text-slate-600 mt-0.5">
                          {docDetail.manifest.detectionSummary.reviewRecommendedCount > 0
                            ? "Open Edit Fields to confirm unlabeled or low-confidence items"
                            : "All fields paired with printed labels"}
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 4. FIELD EDITOR */}
          {activeNav === "editor" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">
                  Visual PDF Field Editor
                </h2>
                <select
                  aria-label="Choose document to edit"
                  value={selectedDocId || ""}
                  onChange={(e) => setSelectedDocId(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                >
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} ({d.latest_field_count ?? 0} fields)
                    </option>
                  ))}
                </select>
              </div>
              {selectedDocId ? (
                <PdfFieldEditor
                  api={api}
                  documentId={selectedDocId}
                  documentTitle={selectedDoc?.title || "Document"}
                  canEdit={hasPermission("fields:edit")}
                  onManifestSaved={() => void refreshCoreLists()}
                  onAcroFormGenerated={() => void refreshCoreLists()}
                  onTemplateCreated={(tplId) => {
                    setSelectedTemplateId(tplId);
                    void refreshCoreLists();
                    setActiveNav("validation");
                  }}
                />
              ) : (
                <p className="text-xs text-slate-500">Upload a document first.</p>
              )}
            </div>
          )}

          {/* 5. TEMPLATE LIBRARY */}
          {activeNav === "templates" && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Template Library</h2>
                  <p className="text-xs text-slate-500">
                    Manage approved forms, version history, manifest exports, and protected master AcroForms.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      value={tplSearch}
                      onChange={(e) => setTplSearch(e.target.value)}
                      placeholder="Search templates..."
                      className="rounded-md border border-slate-300 pl-8 pr-3 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                  <select
                    aria-label="Filter template status"
                    value={tplStatusFilter}
                    onChange={(e) => setTplStatusFilter(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
                  >
                    <option value="">All Statuses</option>
                    <option value="approved">Approved</option>
                    <option value="in_review">In Review</option>
                    <option value="draft">Draft</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                <div className="lg:col-span-6 space-y-2.5">
                  {filteredTemplates.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => {
                        setSelectedTemplateId(t.id);
                        if (t.document_id) setSelectedDocId(t.document_id);
                      }}
                      className={`cursor-pointer rounded-lg border p-4 transition-colors ${
                        selectedTemplateId === t.id
                          ? "border-emerald-800 bg-emerald-50/40"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">
                            {t.name}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                            {t.description || t.category}
                          </p>
                        </div>
                        <span
                          className={`text-[11px] font-semibold uppercase shrink-0 ${
                            t.status === "approved"
                              ? "text-emerald-800"
                              : t.status === "archived"
                              ? "text-slate-400"
                              : "text-amber-700"
                          }`}
                        >
                          {t.status}
                        </span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 tabular-nums">
                        <span>{t.category}</span>
                        <span>·</span>
                        <span>v{t.current_version_number}</span>
                        <span>·</span>
                        <span>{t.field_count ?? 0} fields</span>
                        <span>·</span>
                        <span>Policy: {t.output_policy}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Selected Template Inspector */}
                <div className="lg:col-span-6 rounded-lg border border-slate-200 bg-white p-5 space-y-4">
                  {!tplDetail?.template ? (
                    <p className="text-xs text-slate-500">
                      Select a template on the left to inspect versions, diff changes, or export assets.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2 pb-3 border-b border-slate-100">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-900">
                            {tplDetail.template.name}
                          </h3>
                          <p className="text-xs text-slate-500 font-mono">
                            ID: {tplDetail.template.id} · v{tplDetail.template.current_version_number}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {tplDetail.template.status === "approved" && (
                            <button
                              type="button"
                              onClick={() => {
                                setGenTemplateId(tplDetail.template.id);
                                setActiveNav("generation");
                              }}
                              className="rounded bg-emerald-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-800"
                            >
                              Use in Engine B
                            </button>
                          )}
                          {tplDetail.template.document_id && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedDocId(tplDetail.template.document_id);
                                setActiveNav("validation");
                              }}
                              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
                            >
                              Preview & Approve
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Template Actions */}
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {hasPermission("templates:write") &&
                          tplDetail.template.is_system_integration === 0 && (
                            <button
                              type="button"
                              onClick={async () => {
                                await api.json(
                                  `/api/v1/templates/${tplDetail.template.id}/versions`,
                                  { method: "POST", body: JSON.stringify({ changelog: "Updated from latest manifest" }) }
                                );
                                await refreshCoreLists();
                                setNotice("Created new template version.");
                              }}
                              className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                            >
                              New Version
                            </button>
                          )}
                        {hasPermission("templates:write") && (
                          <button
                            type="button"
                            onClick={async () => {
                              await api.json(
                                `/api/v1/templates/${tplDetail.template.id}/duplicate`,
                                { method: "POST" }
                              );
                              await refreshCoreLists();
                              setNotice("Duplicated template.");
                            }}
                            className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Duplicate
                          </button>
                        )}
                        {user.role !== "read_only_user" && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleDownloadProtectedBlob(
                                `/api/v1/templates/${tplDetail.template.id}/download-acroform`,
                                `${tplDetail.template.slug}-acroform-master.pdf`
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Master AcroForm
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await api.json<{ manifest: FieldManifest }>(
                              `/api/v1/templates/${tplDetail.template.id}/manifest`
                            );
                            const blob = new Blob([JSON.stringify(res.manifest, null, 2)], {
                              type: "application/json",
                            });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${tplDetail.template.slug}-manifest.json`;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 2000);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <FileCode2 className="h-3.5 w-3.5" />
                          Export JSON
                        </button>
                      </div>

                      {/* Version Diff Summary */}
                      {versionDiff && (
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
                          <p className="font-semibold text-slate-800">
                            Diff: v{versionDiff.fromVersion} → v{versionDiff.toVersion}
                          </p>
                          <p className="text-slate-600 tabular-nums">
                            Added: {versionDiff.added.length} · Modified:{" "}
                            {versionDiff.modified.length} · Removed: {versionDiff.removed.length}
                          </p>
                        </div>
                      )}

                      {/* Versions Table */}
                      <div>
                        <h4 className="text-xs font-semibold text-slate-800 mb-2">
                          Version History
                        </h4>
                        <div className="divide-y divide-slate-100 border border-slate-200 rounded-md text-xs">
                          {(tplDetail.versions || []).map((v) => (
                            <div
                              key={v.id}
                              className="px-3 py-2 flex items-center justify-between gap-2"
                            >
                              <div>
                                <p className="font-medium text-slate-900">
                                  v{v.version_number} · {v.changelog}
                                </p>
                                <p className="text-[11px] text-slate-500 tabular-nums">
                                  {v.field_count} fields · {v.widget_count ?? 0} widgets
                                </p>
                              </div>
                              <span className="text-[11px] font-medium text-slate-600">
                                {v.is_approved ? "Approved (Locked)" : "Unapproved"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 6. PDF PREVIEW & 7. TEST & VALIDATION */}
          {(activeNav === "preview" || activeNav === "validation") && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">
                  {activeNav === "preview"
                    ? "Side-by-Side PDF Preview"
                    : "Test, Structural Validation & Approval"}
                </h2>
                <select
                  aria-label="Choose document to preview"
                  value={selectedDocId || ""}
                  onChange={(e) => setSelectedDocId(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                >
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </div>
              {selectedDocId ? (
                <DocumentPreviewAndValidation
                  api={api}
                  documentId={selectedDocId}
                  documentTitle={selectedDoc?.title || "Document"}
                  templateId={
                    templates.find((t) => t.document_id === selectedDocId)?.id ||
                    selectedTpl?.id
                  }
                  templateStatus={
                    templates.find((t) => t.document_id === selectedDocId)?.status ||
                    selectedTpl?.status
                  }
                  canApprove={hasPermission("templates:approve")}
                  onApproved={() => void refreshCoreLists()}
                />
              ) : (
                <p className="text-xs text-slate-500">Select a document first.</p>
              )}
            </div>
          )}

          {/* 8. DOCUMENT GENERATION (ENGINE B) */}
          {activeNav === "generation" && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    Engine B — Customer Document Generation
                  </h2>
                  <p className="text-xs text-slate-500">
                    Dynamically render approved templates into flattened customer-safe PDFs (or authorised fillable PDFs) and capture signed returns.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                {/* Dynamic Form from Manifest */}
                <form
                  onSubmit={handleEngineBRender}
                  className="lg:col-span-6 rounded-lg border border-slate-200 p-5 space-y-4"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">
                        Approved Template
                      </label>
                      <select
                        aria-label="Approved template"
                        value={genTemplateId}
                        onChange={(e) => setGenTemplateId(e.target.value)}
                        className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-slate-900"
                      >
                        {approvedTemplates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.field_count ?? 0} fields)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">
                        Output Mode
                      </label>
                      <select
                        aria-label="Output mode"
                        value={genOutputMode}
                        onChange={(e) =>
                          setGenOutputMode(e.target.value as "flattened" | "fillable")
                        }
                        className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-slate-900"
                      >
                        <option value="flattened">Flattened Customer PDF (Default)</option>
                        <option value="fillable">Fillable AcroForm PDF (If Permitted)</option>
                      </select>
                    </div>
                  </div>

                  {genManifest && (
                    <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1 border-t border-slate-100 pt-3">
                      {genManifest.fields.map((f: DetectedFormField) => (
                        <div key={f.id} className="text-xs">
                          <label className="block font-medium text-slate-700 mb-1">
                            {f.label}
                            {f.required && <span className="text-rose-700 ml-0.5">*</span>}
                          </label>
                          {f.type === "checkbox" ? (
                            <label className="inline-flex items-center gap-2 text-slate-700">
                              <input
                                type="checkbox"
                                checked={Boolean(genValues[f.name])}
                                onChange={(e) =>
                                  setGenValues((v) => ({ ...v, [f.name]: e.target.checked }))
                                }
                              />
                              <span>Select</span>
                            </label>
                          ) : f.type === "multiline" || f.multiline ? (
                            <textarea
                              rows={2}
                              required={f.required}
                              value={String(genValues[f.name] ?? "")}
                              onChange={(e) =>
                                setGenValues((v) => ({ ...v, [f.name]: e.target.value }))
                              }
                              className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-slate-900"
                            />
                          ) : (f.type === "dropdown" || f.type === "radio") && f.options.length > 0 ? (
                            <select
                              required={f.required}
                              value={String(genValues[f.name] ?? "")}
                              onChange={(e) =>
                                setGenValues((v) => ({ ...v, [f.name]: e.target.value }))
                              }
                              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-slate-900"
                            >
                              <option value="">-- Choose --</option>
                              {f.options.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={f.type === "email" ? "email" : "text"}
                              required={f.required}
                              maxLength={f.maxLength}
                              value={String(genValues[f.name] ?? "")}
                              onChange={(e) =>
                                setGenValues((v) => ({ ...v, [f.name]: e.target.value }))
                              }
                              className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-slate-900"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!genManifest || !hasPermission("render:write")}
                    className="w-full rounded-md bg-emerald-900 px-4 py-2.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    Generate Customer PDF
                  </button>
                </form>

                {/* Rendered Output + Signed Return Upload */}
                <div className="lg:col-span-6 space-y-4">
                  {latestRendered && (
                    <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            Rendered Reference: {latestRendered.reference}
                          </p>
                          <p className="text-xs text-slate-500 tabular-nums">
                            {latestRendered.outputMode} · {latestRendered.populatedWidgets} widgets populated ·{" "}
                            {formatBytes(latestRendered.byteSize)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void handleDownloadProtectedBlob(
                              `/api/v1/rendered/${latestRendered.generatedDocumentId}/download?disposition=attachment`,
                              `${latestRendered.reference}.pdf`
                            )
                          }
                          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download PDF
                        </button>
                      </div>

                      {renderedPreviewUrl && (
                        <iframe
                          title="Rendered Engine B PDF Preview"
                          src={renderedPreviewUrl}
                          className="w-full h-80 rounded border border-slate-200"
                        />
                      )}

                      <div className="border-t border-slate-100 pt-3">
                        <label className="block text-xs font-medium text-slate-700 mb-1.5">
                          Upload Signed Copy (.pdf)
                        </label>
                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleUploadSignedRendered(f);
                          }}
                          className="block w-full text-xs text-slate-600"
                        />
                        {signedUploadMsg && (
                          <p className="mt-1.5 text-xs font-medium text-emerald-800">
                            {signedUploadMsg}
                          </p>
                        )}
                      </div>

                      <div className="border-t border-slate-100 pt-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <label className="block text-xs font-medium text-slate-700">
                            Supporting Documents (PDF, PNG, JPEG, WebP)
                          </label>
                          {supportingBusy && (
                            <span className="text-[11px] text-slate-500">Processing...</span>
                          )}
                        </div>
                        {hasPermission("documents:write") && (
                          <input
                            type="file"
                            multiple
                            accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
                            onChange={(e) => {
                              void handleUploadSupportingFiles(e.target.files);
                              e.target.value = "";
                            }}
                            className="block w-full text-xs text-slate-600"
                          />
                        )}
                        {supportingDocs.length > 0 && (
                          <div className="divide-y divide-slate-100 rounded border border-slate-200 text-xs">
                            {supportingDocs.map((sd) => (
                              <div
                                key={sd.id}
                                className="px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                              >
                                <div className="min-w-0">
                                  <p className="font-medium text-slate-900 truncate">
                                    {sd.original_filename}
                                  </p>
                                  <p className="text-[11px] text-slate-500">
                                    {sd.mime_type} · {formatBytes(sd.byte_size)}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleDownloadProtectedBlob(
                                        `/api/v1/supporting-documents/${sd.id}/download`,
                                        sd.original_filename,
                                        sd.mime_type
                                      )
                                    }
                                    className="text-emerald-900 hover:underline font-medium"
                                  >
                                    Download
                                  </button>
                                  {hasPermission("documents:write") && (
                                    <label className="text-slate-700 hover:underline cursor-pointer font-medium">
                                      Replace
                                      <input
                                        type="file"
                                        accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
                                        className="hidden"
                                        onChange={(e) => {
                                          const f = e.target.files?.[0];
                                          if (f) void handleReplaceSupportingFile(sd.id, f);
                                          e.target.value = "";
                                        }}
                                      />
                                    </label>
                                  )}
                                  {hasPermission("documents:delete") && (
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteSupportingFile(sd.id)}
                                      className="text-rose-700 hover:underline font-medium"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
                      <h3 className="text-xs font-semibold text-slate-900">
                        Generated Documents Log
                      </h3>
                    </div>
                    <div className="divide-y divide-slate-100 text-xs max-h-60 overflow-y-auto">
                      {renderedHistory.map((g) => (
                        <div
                          key={String(g.id)}
                          className="px-4 py-2 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="font-mono font-medium text-slate-900">
                              {String(g.reference_code)}
                            </p>
                            <p className="text-[11px] text-slate-500 truncate">
                              {String(g.template_name || g.template_id)} · {String(g.output_mode)}
                              {g.signed_reference ? ` · Signed (${String(g.signed_reference)})` : ""}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              void handleDownloadProtectedBlob(
                                `/api/v1/rendered/${String(g.id)}/download?disposition=attachment`,
                                `${String(g.reference_code)}.pdf`
                              )
                            }
                            className="text-xs font-medium text-emerald-900 hover:underline shrink-0"
                          >
                            Download
                          </button>
                        </div>
                      ))}
                      {renderedHistory.length === 0 && (
                        <p className="p-4 text-slate-500">No documents generated yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 9. API & INTEGRATIONS */}
          {activeNav === "api" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  API Keys & REST Integrations
                </h2>
                <p className="text-xs text-slate-500">
                  Authenticate external portals and backend integrations against /api/v1/* endpoints.
                </p>
              </div>

              {hasPermission("api_keys:manage") && (
                <div className="rounded-lg border border-slate-200 p-5 space-y-4">
                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-emerald-900" />
                    API Keys
                  </h3>

                  {createdKeySecret && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 space-y-1">
                      <p className="font-semibold">
                        Copy your new API key now — it will not be shown again:
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded bg-white px-2 py-1 font-mono text-[11px] border border-amber-200 break-all">
                          {createdKeySecret}
                        </code>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard?.writeText(createdKeySecret)}
                          className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-amber-100"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const res = await api.json<{
                        ok: boolean;
                        apiKey: { secretKey: string };
                      }>("/api/v1/api-keys", {
                        method: "POST",
                        body: JSON.stringify({ name: newKeyName, scopes: newKeyScopes }),
                      });
                      setCreatedKeySecret(res.apiKey.secretKey);
                      setNewKeyName("");
                      const list = await api.json<{
                        ok: boolean;
                        apiKeys: Array<Record<string, unknown>>;
                      }>("/api/v1/api-keys");
                      setApiKeys(list.apiKeys);
                    }}
                    className="flex flex-wrap items-end gap-3 text-xs"
                  >
                    <div className="flex-1 min-w-[200px]">
                      <label className="block font-medium text-slate-700 mb-1">Key Label</label>
                      <input
                        type="text"
                        required
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        placeholder="Production Customer Portal"
                        className="w-full rounded border border-slate-300 px-3 py-1.5 text-slate-900"
                      />
                    </div>
                    <div className="flex flex-wrap gap-3 py-1.5">
                      {(
                        [
                          "documents:read",
                          "documents:write",
                          "templates:read",
                          "render:write",
                          "signed:write",
                        ] as const
                      ).map((sc) => (
                        <label key={sc} className="inline-flex items-center gap-1 text-slate-700">
                          <input
                            type="checkbox"
                            checked={newKeyScopes.includes(sc)}
                            onChange={(e) =>
                              setNewKeyScopes((prev) =>
                                e.target.checked
                                  ? [...prev, sc]
                                  : prev.filter((x) => x !== sc)
                              )
                            }
                          />
                          <span className="font-mono text-[11px]">{sc}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      type="submit"
                      className="rounded-md bg-emerald-900 px-3.5 py-1.5 font-medium text-white hover:bg-emerald-800"
                    >
                      Generate Key
                    </button>
                  </form>

                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-md text-xs">
                    {apiKeys.map((k) => (
                      <div key={String(k.id)} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <p className="font-medium text-slate-900">
                            {String(k.name)}{" "}
                            <span className="font-mono text-slate-500">
                              ({String(k.key_prefix)}...)
                            </span>
                          </p>
                          <p className="text-[11px] text-slate-500 font-mono">
                            {String(k.scopes_json)}
                          </p>
                        </div>
                        {k.revoked_at ? (
                          <span className="text-[11px] text-rose-700">Revoked</span>
                        ) : (
                          <button
                            type="button"
                            onClick={async () => {
                              await api.json(`/api/v1/api-keys/${String(k.id)}`, {
                                method: "DELETE",
                              });
                              const list = await api.json<{
                                ok: boolean;
                                apiKeys: Array<Record<string, unknown>>;
                              }>("/api/v1/api-keys");
                              setApiKeys(list.apiKeys);
                            }}
                            className="text-xs text-rose-700 hover:underline"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* OpenAPI Endpoints Reference */}
              <div className="rounded-lg border border-slate-200 p-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  OpenAPI 3.1 Endpoints (/api/v1/openapi.json)
                </h3>
                <div className="divide-y divide-slate-100 text-xs font-mono">
                  {openApiSpec &&
                    Object.entries(
                      (openApiSpec.paths as Record<string, Record<string, { summary?: string }>>) ||
                        {}
                    ).map(([routePath, methods]) =>
                      Object.entries(methods).map(([m, meta]) => (
                        <div key={`${m}-${routePath}`} className="py-2 flex items-center gap-3">
                          <span className="w-14 uppercase font-semibold text-emerald-900">
                            {m}
                          </span>
                          <span className="text-slate-900 flex-1">/api/v1{routePath}</span>
                          <span className="font-sans text-slate-500">{meta.summary}</span>
                        </div>
                      ))
                    )}
                </div>
              </div>
            </div>
          )}

          {/* 10. PROCESSING HISTORY */}
          {activeNav === "history" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">
                  Processing History & Job Queue
                </h2>
                <button
                  type="button"
                  onClick={() => void refreshCoreLists()}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              </div>
              <div className="rounded-lg border border-slate-200 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 font-medium">Document</th>
                      <th className="px-3 py-2 font-medium">Stage</th>
                      <th className="px-3 py-2 font-medium">Progress</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Error / Notes</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {jobs.map((j) => (
                      <tr key={j.id}>
                        <td className="px-3 py-2 font-medium text-slate-900">
                          {j.document_title || j.document_id}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-700">{j.stage}</td>
                        <td className="px-3 py-2">{j.progress_pct}%</td>
                        <td className="px-3 py-2 font-medium">{j.status}</td>
                        <td className="px-3 py-2 text-rose-700">
                          {j.error_message || "-"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedDocId(j.document_id);
                                setActiveNav("editor");
                              }}
                              className="text-emerald-900 hover:underline"
                            >
                              Inspect
                            </button>
                            {j.status === "failed" && hasPermission("documents:write") && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await api.json(`/api/v1/jobs/${j.id}/retry`, { method: "POST" });
                                  await refreshCoreLists();
                                }}
                                className="text-amber-800 hover:underline"
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 11. SETTINGS */}
          {activeNav === "settings" && (
            <div className="max-w-2xl space-y-5">
              <h2 className="text-lg font-semibold text-slate-900">
                Workspace & Retention Settings
              </h2>
              {!hasPermission("settings:manage") ? (
                <p className="text-xs text-slate-500">
                  Administrator permission is required to modify tenant retention settings.
                </p>
              ) : settingsData ? (
                <div className="rounded-lg border border-slate-200 p-5 space-y-4 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Organisation Name
                    </label>
                    <input
                      type="text"
                      value={settingsData.name}
                      onChange={(e) =>
                        setSettingsData({ ...settingsData, name: e.target.value })
                      }
                      className="w-full rounded border border-slate-300 px-3 py-2 text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Document Retention Window (Days)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={settingsData.retentionDays}
                      onChange={(e) =>
                        setSettingsData({
                          ...settingsData,
                          retentionDays: Number(e.target.value) || 30,
                        })
                      }
                      className="w-40 rounded border border-slate-300 px-3 py-2 text-slate-900 tabular-nums"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                    <span className="text-slate-600 tabular-nums">
                      Current storage footprint: {formatBytes(settingsData.storageBytes)}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await api.json<{
                            ok: boolean;
                            deletedDocuments: number;
                            deletedGenerated: number;
                          }>("/api/v1/retention/purge", { method: "POST" });
                          setNotice(
                            `Purged ${res.deletedDocuments} expired documents and ${res.deletedGenerated} expired renders.`
                          );
                        }}
                        className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50"
                      >
                        Run Retention Purge
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.json("/api/v1/settings", {
                            method: "PATCH",
                            body: JSON.stringify({
                              name: settingsData.name,
                              retentionDays: settingsData.retentionDays,
                            }),
                          });
                          setNotice("Settings saved.");
                        }}
                        className="rounded bg-emerald-900 px-4 py-1.5 font-medium text-white hover:bg-emerald-800"
                      >
                        Save Settings
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* 12. USER MANAGEMENT & RBAC */}
          {activeNav === "users" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  User Management, RBAC & Audit Log
                </h2>
                <p className="text-xs text-slate-500">
                  Six role profiles enforcing strict least-privilege access across Conversion Studio and Engine B.
                </p>
              </div>

              {/* Roles Matrix */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {rolesList.map((r) => (
                  <div key={r.name} className="rounded-lg border border-slate-200 p-3.5 text-xs">
                    <p className="font-semibold text-slate-900">{r.label}</p>
                    <p className="text-slate-500 mt-0.5">{r.description}</p>
                    <p className="mt-2 font-mono text-[10px] text-slate-600">
                      {r.permissions.join(", ")}
                    </p>
                  </div>
                ))}
              </div>

              {hasPermission("users:manage") && (
                <>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setStudioError(null);
                      try {
                        await api.json("/api/v1/users", {
                          method: "POST",
                          body: JSON.stringify({
                            email: newUserEmail,
                            fullName: newUserName,
                            role: newUserRole,
                            password: newUserPassword,
                          }),
                        });
                        setNewUserEmail("");
                        setNewUserName("");
                        setNewUserPassword("");
                        const uRes = await api.json<{
                          ok: boolean;
                          users: Array<Record<string, unknown>>;
                        }>("/api/v1/users");
                        setUsersList(uRes.users);
                        setNotice("User account created.");
                      } catch (err) {
                        setStudioError(err instanceof Error ? err.message : "Failed to create user");
                      }
                    }}
                    className="rounded-lg border border-slate-200 p-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end text-xs"
                  >
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        value={newUserName}
                        onChange={(e) => setNewUserName(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Email</label>
                      <input
                        type="email"
                        required
                        value={newUserEmail}
                        onChange={(e) => setNewUserEmail(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Role</label>
                      <select
                        value={newUserRole}
                        onChange={(e) => setNewUserRole(e.target.value as RoleName)}
                        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5"
                      >
                        {rolesList.map((r) => (
                          <option key={r.name} value={r.name}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Password</label>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={newUserPassword}
                        onChange={(e) => setNewUserPassword(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5"
                      />
                    </div>
                    <button
                      type="submit"
                      className="rounded-md bg-emerald-900 px-3 py-1.5 font-medium text-white hover:bg-emerald-800"
                    >
                      Add User
                    </button>
                  </form>

                  {/* Users Table */}
                  <div className="rounded-lg border border-slate-200 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="px-3 py-2 font-medium">User</th>
                          <th className="px-3 py-2 font-medium">Role</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {usersList.map((u) => (
                          <tr key={String(u.id)}>
                            <td className="px-3 py-2">
                              <p className="font-medium text-slate-900">{String(u.full_name)}</p>
                              <p className="text-[11px] text-slate-500">{String(u.email)}</p>
                            </td>
                            <td className="px-3 py-2 font-mono">{String(u.role_name)}</td>
                            <td className="px-3 py-2">
                              {Number(u.is_active) ? "Active" : "Disabled"}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={async () => {
                                  await api.json(`/api/v1/users/${String(u.id)}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({ isActive: !Number(u.is_active) }),
                                  });
                                  const uRes = await api.json<{
                                    ok: boolean;
                                    users: Array<Record<string, unknown>>;
                                  }>("/api/v1/users");
                                  setUsersList(uRes.users);
                                }}
                                className="text-emerald-900 hover:underline"
                              >
                                {Number(u.is_active) ? "Disable" : "Enable"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Active Sessions */}
                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="px-4 py-2 border-b border-slate-100 bg-slate-50">
                      <h3 className="text-xs font-semibold text-slate-900">Active Sessions</h3>
                    </div>
                    <div className="divide-y divide-slate-100 text-xs">
                      {sessionsList.map((s) => (
                        <div key={String(s.id)} className="px-4 py-2 flex items-center justify-between gap-2">
                          <span>
                            {String(s.email)} ({String(s.role_name)}) · expires {String(s.expires_at).slice(0, 10)}
                          </span>
                          {s.revoked_at ? (
                            <span className="text-slate-400">Revoked</span>
                          ) : (
                            <button
                              type="button"
                              onClick={async () => {
                                await api.json(`/api/v1/auth/sessions/${String(s.id)}`, {
                                  method: "DELETE",
                                });
                                const sRes = await api.json<{
                                  ok: boolean;
                                  sessions: Array<Record<string, unknown>>;
                                }>("/api/v1/auth/sessions");
                                setSessionsList(sRes.sessions);
                              }}
                              className="text-rose-700 hover:underline"
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
