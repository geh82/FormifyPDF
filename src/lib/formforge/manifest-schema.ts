import { z } from "zod";

export const PdfRectSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const FormForgeFieldTypeSchema = z.enum([
  "text",
  "multiline",
  "numeric",
  "currency",
  "date",
  "email",
  "phone",
  "address",
  "checkbox",
  "radio",
  "dropdown",
  "signature",
  "initials",
  "table_cell",
  "char_cells",
  "repeating_group",
]);

export const DetectedFormFieldSchema = z.object({
  id: z.string().min(1).max(80),
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Field name may only contain letters, digits, _, ., -"),
  label: z.string().min(1).max(200),
  type: FormForgeFieldTypeSchema,
  page: z.number().int().min(0),
  rect: PdfRectSchema,
  cellRects: z
    .array(PdfRectSchema)
    .nullish()
    .transform((v) => v ?? undefined),
  coordinateSpace: z.literal("top_left_pdf_pt").default("top_left_pdf_pt"),
  originalLabelText: z
    .string()
    .max(300)
    .nullish()
    .transform((v) => v ?? ""),
  detectionSource: z
    .enum([
      "vector_underline",
      "vector_box",
      "vector_char_cells",
      "vector_checkbox",
      "vector_radio",
      "table_cell",
      "existing_acroform",
      "cv_contour",
      "ocr_region",
      "manual",
    ])
    .default("manual"),
  confidence: z.number().min(0).max(1),
  confidenceTier: z.enum(["high", "medium", "low"]),
  confidenceEvidence: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  required: z.boolean().default(false),
  defaultValue: z
    .string()
    .max(1000)
    .nullish()
    .transform((v) => v ?? ""),
  maxLength: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .nullish()
    .transform((v) => v ?? undefined),
  multiline: z.boolean().default(false),
  options: z
    .array(z.string().max(200))
    .nullish()
    .transform((v) => v ?? []),
  validation: z
    .object({
      pattern: z
        .string()
        .max(300)
        .nullish()
        .transform((v) => v ?? undefined),
      minLength: z
        .number()
        .int()
        .min(0)
        .nullish()
        .transform((v) => v ?? undefined),
      maxLength: z
        .number()
        .int()
        .min(1)
        .nullish()
        .transform((v) => v ?? undefined),
      min: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
      max: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
      dateFormat: z
        .string()
        .max(40)
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? {}),
  groupId: z
    .string()
    .max(80)
    .nullish()
    .transform((v) => v ?? undefined),
  radioGroupName: z
    .string()
    .max(80)
    .nullish()
    .transform((v) => v ?? undefined),
  relatedFieldIds: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? undefined),
  tooltip: z
    .string()
    .max(300)
    .nullish()
    .transform((v) => v ?? undefined),
  fontSize: z
    .number()
    .min(5)
    .max(36)
    .nullish()
    .transform((v) => v ?? undefined),
  alignment: z
    .enum(["left", "center", "right"])
    .nullish()
    .transform((v) => v ?? undefined),
  reviewStatus: z.enum(["pending", "accepted", "edited", "rejected"]).default("pending"),
  createdAt: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  updatedAt: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

export const FieldManifestUpdateSchema = z.object({
  fields: z.array(DetectedFormFieldSchema).max(2000),
  templateName: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => v ?? undefined),
});
