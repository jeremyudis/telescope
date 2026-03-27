import { z } from "zod";

export const recommendationSchema = z.object({
  file: z.string().describe("File path where the issue was found"),
  line: z.number().optional().describe("Line number if applicable"),
  category: z.enum([
    "missing-telemetry",
    "high-cardinality",
    "instrumentation",
    "logging",
    "error-tracking",
    "naming",
    "best-practice",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string().describe("Short title for the recommendation"),
  description: z.string().describe("Detailed explanation of the issue"),
  suggestion: z
    .string()
    .optional()
    .describe("Concrete code suggestion or action to take"),
});

export const analysisResultSchema = z.object({
  recommendations: z.array(recommendationSchema),
  summary: z
    .string()
    .describe(
      "2-3 sentence overall assessment of the PR's observability posture"
    ),
});
