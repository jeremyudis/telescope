import type { CodeSegment, SegmentType } from "./types";

interface PatternDef {
  type: SegmentType;
  pattern: RegExp;
  contextLines: number; // lines of surrounding context to include
}

// Language-agnostic patterns that work across most languages
const UNIVERSAL_PATTERNS: PatternDef[] = [
  // Metric definitions
  {
    type: "metric_definition",
    pattern:
      /(?:new\s+(?:Counter|Histogram|Gauge|Summary|Timer|Meter)|prom_client\.|statsd\.|metrics\.|StatsD|prometheus\.|metric[_.](?:counter|histogram|gauge|summary)|\.(?:increment|decrement|gauge|timing|histogram|set)\s*\(|registerMetric|MeterProvider|createCounter|createHistogram|createUpDownCounter|createObservableGauge)/,
    contextLines: 3,
  },
  // Span/trace creation
  {
    type: "span_creation",
    pattern:
      /(?:tracer\.(?:startSpan|startActiveSpan)|trace\.(?:get_tracer|StartSpan)|@Trace|@traced|with_span|start_span|currentSpan|activeSpan|SpanKind|TracerProvider|opentracing\.|zipkin\.|jaeger\.|dd-trace|ddtrace|newrelic\.agent|new_span|create_span)/,
    contextLines: 3,
  },
  // Logger setup
  {
    type: "logger_setup",
    pattern:
      /(?:pino\s*\(|winston\.create|bunyan\.create|log4j|log4js|logging\.getLogger|logger\.(?:setup|configure|init)|structlog\.|zerolog\.|slog\.New|zap\.New|logrus\.|tracing_subscriber|env_logger|fern::|flexi_logger|LogManager\.getLogger|SLF4J|NLog|Serilog|createLogger)/,
    contextLines: 3,
  },
  // Middleware/interceptor registration
  {
    type: "middleware",
    pattern:
      /(?:app\.use\s*\(\s*(?:morgan|helmet|cors|express-prom|prom-bundle|otel|trace|meter|instrument|sentry|newrelic|datadog|dd-trace)|router\.use|@app\.middleware|httpHandler|otelhttp|negroni|gin\.Default|actix.web.*middleware|tower.*layer|interceptor|HttpClientModule|HttpInterceptor)/,
    contextLines: 4,
  },
  // Error handling with telemetry
  {
    type: "error_handler",
    pattern:
      /(?:Sentry\.(?:captureException|captureMessage|init)|Bugsnag\.|Rollbar\.|errorHandler|captureError|reportError|\.on\s*\(\s*['"](?:error|uncaughtException|unhandledRejection)['"]|process\.on.*error|window\.onerror|ErrorBoundary|@error_handler|panic::set_hook)/,
    contextLines: 4,
  },
];

// Language-specific patterns
const LANGUAGE_PATTERNS: Record<string, PatternDef[]> = {
  typescript: [
    {
      type: "metric_definition",
      pattern: /(?:@(?:Counter|Histogram|Gauge|Metric)|meter\.create)/,
      contextLines: 3,
    },
    {
      type: "span_creation",
      pattern: /(?:@WithSpan|api\.trace\.getTracer)/,
      contextLines: 3,
    },
  ],
  javascript: [
    {
      type: "metric_definition",
      pattern: /(?:@(?:Counter|Histogram|Gauge|Metric)|meter\.create)/,
      contextLines: 3,
    },
  ],
  python: [
    {
      type: "metric_definition",
      pattern:
        /(?:from\s+prometheus_client|from\s+opentelemetry\.metrics|datadog\.statsd)/,
      contextLines: 3,
    },
    {
      type: "span_creation",
      pattern:
        /(?:from\s+opentelemetry\s+import\s+trace|@tracer\.start_as_current_span|ddtrace\.tracer)/,
      contextLines: 3,
    },
    {
      type: "logger_setup",
      pattern: /(?:import\s+logging|structlog\.configure|loguru)/,
      contextLines: 3,
    },
  ],
  go: [
    {
      type: "metric_definition",
      pattern:
        /(?:promauto\.New|prometheus\.New|prometheus\.MustRegister|otel.*metric)/,
      contextLines: 3,
    },
    {
      type: "span_creation",
      pattern: /(?:otel.*trace\.NewTracerProvider|tracer\.Start)/,
      contextLines: 3,
    },
    {
      type: "middleware",
      pattern: /(?:otelhttp\.NewHandler|otelgin\.|otelecho\.|promhttp\.)/,
      contextLines: 4,
    },
  ],
  rust: [
    {
      type: "span_creation",
      pattern:
        /(?:tracing::(?:info_span|debug_span|warn_span|error_span|trace_span|instrument|span!)|#\[instrument\])/,
      contextLines: 3,
    },
    {
      type: "metric_definition",
      pattern: /(?:prometheus::(?:Counter|Histogram|Gauge|register)|metrics::)/,
      contextLines: 3,
    },
    {
      type: "logger_setup",
      pattern:
        /(?:tracing_subscriber::(?:fmt|registry|EnvFilter)|env_logger::init|log::(?:info|warn|error|debug|trace)!)/,
      contextLines: 3,
    },
  ],
  java: [
    {
      type: "span_creation",
      pattern:
        /(?:@WithSpan|Span\.current\(\)|GlobalOpenTelemetry|@Traced|@NewSpan)/,
      contextLines: 3,
    },
    {
      type: "metric_definition",
      pattern:
        /(?:MeterRegistry|@Timed|@Counted|micrometer\.|Metrics\.counter|Metrics\.gauge|Metrics\.timer)/,
      contextLines: 3,
    },
    {
      type: "logger_setup",
      pattern:
        /(?:LoggerFactory\.getLogger|@Slf4j|Log4j2|Logger\.getLogger)/,
      contextLines: 3,
    },
  ],
};

// Config file patterns (matched by filename, not content)
const CONFIG_FILE_PATTERNS: RegExp[] = [
  /otel[-_]?collector/i,
  /prometheus\.ya?ml/i,
  /datadog\.ya?ml/i,
  /logging\.(?:conf|ini|ya?ml|json)/i,
  /log4[j2]?\.(?:xml|properties|ya?ml|json)/i,
  /sentry\.(?:properties|ya?ml|json)/i,
  /newrelic\.(?:ya?ml|js|json)/i,
  /tracing\.(?:ya?ml|json|toml)/i,
  /fluent(?:bit|d)\.conf/i,
];

export function extractSegments(
  filename: string,
  content: string,
  language: string
): CodeSegment[] {
  const segments: CodeSegment[] = [];

  // Check if this is a telemetry config file by filename
  if (CONFIG_FILE_PATTERNS.some((p) => p.test(filename))) {
    segments.push({
      filePath: filename,
      lineStart: 1,
      lineEnd: content.split("\n").length,
      segmentType: "config",
      language,
      content: content.length > 5000 ? content.slice(0, 5000) : content,
    });
    return segments;
  }

  const lines = content.split("\n");

  // Combine universal + language-specific patterns
  const patterns = [
    ...UNIVERSAL_PATTERNS,
    ...(LANGUAGE_PATTERNS[language] || []),
  ];

  // Track which line ranges we've already captured to avoid duplicates
  const captured = new Set<string>();

  for (const patternDef of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (patternDef.pattern.test(lines[i])) {
        const lineStart = Math.max(0, i - patternDef.contextLines);
        const lineEnd = Math.min(
          lines.length - 1,
          i + patternDef.contextLines
        );

        // Deduplicate overlapping segments of the same type
        const key = `${patternDef.type}:${lineStart}-${lineEnd}`;
        if (captured.has(key)) continue;
        captured.add(key);

        const segmentContent = lines.slice(lineStart, lineEnd + 1).join("\n");

        segments.push({
          filePath: filename,
          lineStart: lineStart + 1, // 1-indexed
          lineEnd: lineEnd + 1,
          segmentType: patternDef.type,
          language,
          content: segmentContent,
        });
      }
    }
  }

  return segments;
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  rb: "ruby",
  cs: "csharp",
  cpp: "cpp",
  c: "c",
  swift: "swift",
  php: "php",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  json: "json",
  xml: "xml",
  properties: "properties",
  conf: "config",
  ini: "config",
};

export function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return LANGUAGE_EXTENSIONS[ext] || "unknown";
}

// Files to skip during indexing
const SKIP_PATTERNS = [
  /node_modules\//,
  /vendor\//,
  /\.git\//,
  /dist\//,
  /build\//,
  /target\//,
  /\.next\//,
  /\.nuxt\//,
  /coverage\//,
  /__pycache__\//,
  /\.pytest_cache\//,
  /\.tox\//,
  /\.venv\//,
  /venv\//,
  /\.mypy_cache\//,
  /\.cargo\//,
  /\.idea\//,
  /\.vscode\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.lock$/,
  /lock\.json$/,
  /\.sum$/,
  /\.svg$/,
  /\.png$/,
  /\.jpg$/,
  /\.gif$/,
  /\.ico$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
];

const INDEXABLE_EXTENSIONS = new Set(Object.keys(LANGUAGE_EXTENSIONS));

export function shouldIndexFile(filename: string): boolean {
  if (SKIP_PATTERNS.some((p) => p.test(filename))) return false;
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return INDEXABLE_EXTENSIONS.has(ext);
}
