export type FormifyFieldType =
  | "text"
  | "multiline"
  | "numeric"
  | "currency"
  | "date"
  | "email"
  | "phone"
  | "address"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "listbox"
  | "signature"
  | "initials"
  | "table_cell"
  | "char_cells"
  | "repeating_group";

export type ConfidenceTier = "high" | "medium" | "low";
export type ReviewStatus = "pending" | "accepted" | "edited" | "rejected";
export type DetectionSource =
  | "pdf_structural"
  | "vector_underline"
  | "vector_box"
  | "vector_char_cells"
  | "vector_comb_grid"
  | "vector_checkbox"
  | "vector_radio"
  | "glyph_symbol"
  | "table_cell"
  | "existing_acroform"
  | "cv_contour"
  | "cv_circle"
  | "ocr_region"
  | "paddleocr"
  | "ai_semantic_fusion"
  | "manual";

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CharGridMetadata {
  cellCount: number;
  cellWidthPt: number;
  cellHeightPt: number;
  spacingPt: number;
  readingDirection: "ltr" | "rtl";
  acroformStrategy: "comb" | "individual_cells";
}

export interface DocumentPageInfo {
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  rotation: 0 | 90 | 180 | 270;
  orientation: "portrait" | "landscape";
  paperSize: "A4" | "A3" | "A5" | "Letter" | "Legal" | "Custom";
  mediaBox: PdfPageBox;
  cropBox: PdfPageBox;
  textSpanCount: number;
  wordCount: number;
  drawingCount: number;
  existingWidgetCount: number;
  needsOcr: boolean;
  ocrApplied: boolean;
  deskewAngle?: number;
}

export interface FieldValidationRule {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  dateFormat?: string;
}

export interface DetectedFormField {
  id: string;
  name: string;
  label: string;
  type: FormifyFieldType;
  page: number;
  rect: PdfRect;
  /** Original raw detected bounding box before clamping/snapping */
  originalDetectedRect?: PdfRect;
  /** Final PDF user-space [x0, y0, x1, y1] bottom-left coordinates */
  pdfBottomLeftRect?: [number, number, number, number];
  /** Optional individual character-cell bounding boxes in PDF points when type === "char_cells" */
  cellRects?: PdfRect[];
  /** Metadata describing detected character-entry grid geometry and AcroForm strategy */
  charGridMeta?: CharGridMetadata;
  /** Optional per-option bounding boxes in PDF points for radio/selection groups */
  optionRects?: Record<string, PdfRect>;
  coordinateSpace: "top_left_pdf_pt";
  originalLabelText: string;
  detectionSource: DetectionSource;
  /** All contributing detection engines/sources merged by the fusion stage */
  detectionSources?: DetectionSource[];
  confidence: number;
  confidenceTier: ConfidenceTier;
  confidenceEvidence: string[];
  required: boolean;
  defaultValue: string;
  maxLength?: number;
  multiline: boolean;
  options: string[];
  validation: FieldValidationRule;
  groupId?: string;
  radioGroupName?: string;
  relatedFieldIds?: string[];
  tooltip?: string;
  fontSize?: number;
  alignment?: "left" | "center" | "right";
  reviewStatus: ReviewStatus;
  /** Explicit flag reason when a low-confidence or ambiguous detection requires review */
  reviewFlagReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DetectionSummary {
  totalDetectedFields: number;
  countsByType: Record<string, number>;
  countsBySource: Record<string, number>;
  confidenceBreakdown: {
    high: number;
    medium: number;
    low: number;
  };
  reviewRecommendedCount: number;
  charGridGroupCount: number;
  combFieldCount: number;
  engineMode: "python_multi_engine" | "node_vector_fusion" | "node_cv_ocr_fusion";
}

export interface FieldManifest {
  documentId: string;
  schemaVersion: "1.0";
  templateName?: string;
  totalPages: number;
  pages: DocumentPageInfo[];
  fields: DetectedFormField[];
  detectionSummary?: DetectionSummary;
  generatedAt: string;
  engineVersion: string;
  hasExistingAcroForm: boolean;
  isScanned: boolean;
  securityFlags: {
    hasEmbeddedJavaScript: boolean;
    wasEncrypted: boolean;
    sanitizedActions: boolean;
  };
}

export type RoleName =
  | "administrator"
  | "template_manager"
  | "editor"
  | "reviewer"
  | "api_integration_user"
  | "read_only_user";

export type OutputPolicy = "flattened" | "fillable" | "both";
export type TemplateStatus = "draft" | "in_review" | "approved" | "archived";

export type JobStage =
  | "queued"
  | "uploading"
  | "inspecting_pdf"
  | "extracting_content"
  | "running_ocr"
  | "analysing_layout"
  | "detecting_fields"
  | "classifying_fields"
  | "generating_manifest"
  | "generating_acroform"
  | "validating_output"
  | "completed"
  | "failed";

export interface VisualAlignmentIssue {
  fieldId: string;
  fieldName: string;
  page: number;
  issue: "misplaced" | "oversized" | "undersized" | "missing";
  iou: number;
  areaRatio: number;
  centerOffsetPt: number;
  detail: string;
}

export interface VisualOverlapWarning {
  fieldA: string;
  fieldB: string;
  page: number;
  iou: number;
}

export interface VisualVerificationReport {
  checkedWidgets: number;
  alignedCount: number;
  meanIoU: number;
  minIoU: number;
  combFieldCount: number;
  misplacedFields: VisualAlignmentIssue[];
  oversizedFields: VisualAlignmentIssue[];
  undersizedFields: VisualAlignmentIssue[];
  missingFields: string[];
  overlappingWidgetPairs: VisualOverlapWarning[];
  duplicateWidgetNames: string[];
  passed: boolean;
  summary: string;
}

export interface AcroFormValidationReport {
  validPdf: boolean;
  hasAcroFormDict: boolean;
  widgetCount: number;
  expectedFieldCount: number;
  missingFields: string[];
  appearanceStreamsVerified: boolean;
  roundTripWriteReadOk: boolean;
  pageCount: number;
  warnings: string[];
  visualVerification?: VisualVerificationReport;
}
