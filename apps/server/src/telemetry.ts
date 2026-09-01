import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { NextFunction, Request, Response } from "express";
import type { DatabaseConnection } from "./database.js";

export interface StoredSpan {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  status: "unset" | "ok" | "error";
  status_message: string | null;
  started_at: string;
  duration_ms: number;
  attributes: Attributes;
  instrumentation_scope: string;
}

function milliseconds(value: [number, number]): number {
  return value[0] * 1000 + value[1] / 1_000_000;
}

function statusLabel(code: SpanStatusCode): StoredSpan["status"] {
  if (code === SpanStatusCode.ERROR) return "error";
  if (code === SpanStatusCode.OK) return "ok";
  return "unset";
}

class SqliteSpanExporter implements SpanExporter {
  constructor(private readonly db: DatabaseConnection) {}

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    try {
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO telemetry_spans
        (span_id, trace_id, parent_span_id, name, kind, status, status_message, started_at, duration_ms, attributes_json, instrumentation_scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const persist = this.db.transaction(() => {
        for (const span of spans) {
          const spanContext = span.spanContext();
          insert.run(
            spanContext.spanId,
            spanContext.traceId,
            span.parentSpanContext?.spanId ?? null,
            span.name,
            span.kind,
            statusLabel(span.status.code),
            span.status.message ?? null,
            new Date(milliseconds(span.startTime)).toISOString(),
            milliseconds(span.duration),
            JSON.stringify(span.attributes),
            span.instrumentationScope.name,
          );
        }
        this.db.exec(`DELETE FROM telemetry_spans WHERE span_id NOT IN (
          SELECT span_id FROM telemetry_spans ORDER BY started_at DESC LIMIT 500
        )`);
      });
      persist();
      callback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      callback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class Telemetry {
  private readonly provider: NodeTracerProvider;
  private readonly tracer;
  readonly otlpEnabled: boolean;

  constructor(private readonly db: DatabaseConnection) {
    const processors: SpanProcessor[] = [new SimpleSpanProcessor(new SqliteSpanExporter(db))];
    this.otlpEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
    if (this.otlpEnabled) processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "project-bridge", [ATTR_SERVICE_VERSION]: "0.9.0" }),
      spanProcessors: processors,
    });
    this.tracer = this.provider.getTracer("project-bridge.server", "0.9.0");
  }

  middleware() {
    return (request: Request, response: Response, next: NextFunction) => {
      const span = this.tracer.startSpan(`${request.method} ${request.path}`, {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": request.method,
          "url.path": request.path,
          "server.address": request.hostname,
        },
      });
      response.locals.telemetryContext = trace.setSpan(context.active(), span);
      const current = span.spanContext();
      response.setHeader("traceparent", `00-${current.traceId}-${current.spanId}-${current.traceFlags.toString(16).padStart(2, "0")}`);
      response.on("finish", () => {
        span.setAttribute("http.response.status_code", response.statusCode);
        span.setStatus(response.statusCode >= 500
          ? { code: SpanStatusCode.ERROR, message: `HTTP ${response.statusCode}` }
          : { code: SpanStatusCode.OK });
        span.end();
      });
      next();
    };
  }

  withSpan<T>(name: string, attributes: Attributes, operation: (span: Span) => T, parent?: Context): T {
    const span = this.tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes }, parent);
    try {
      const result = operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  }

  recent(limit = 30): StoredSpan[] {
    const rows = this.db.prepare(`
      SELECT * FROM telemetry_spans
      WHERE NOT (name = 'outbox.publish' AND attributes_json LIKE '%\"outbox.pending\":0%')
      ORDER BY started_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      span_id: String(row.span_id),
      trace_id: String(row.trace_id),
      parent_span_id: row.parent_span_id ? String(row.parent_span_id) : null,
      name: String(row.name),
      kind: Number(row.kind),
      status: row.status as StoredSpan["status"],
      status_message: row.status_message ? String(row.status_message) : null,
      started_at: String(row.started_at),
      duration_ms: Number(row.duration_ms),
      attributes: JSON.parse(String(row.attributes_json)) as Attributes,
      instrumentation_scope: String(row.instrumentation_scope),
    }));
  }

  summary() {
    const stats = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             AVG(duration_ms) AS average_duration_ms
      FROM telemetry_spans
      WHERE NOT (name = 'outbox.publish' AND attributes_json LIKE '%\"outbox.pending\":0%')
    `).get() as { total: number; errors: number | null; average_duration_ms: number | null };
    return {
      service_name: "project-bridge",
      sdk: "OpenTelemetry JS",
      local_exporter: "SQLite",
      otlp_enabled: this.otlpEnabled,
      total_spans: stats.total,
      error_spans: stats.errors ?? 0,
      average_duration_ms: stats.average_duration_ms ?? 0,
      retention: 500,
      recent_spans: this.recent(),
    };
  }

  async close(): Promise<void> {
    await this.provider.forceFlush();
    await this.provider.shutdown();
  }
}
