import { describe, expect, it } from 'vitest';
import { createProcessDiagnosticsSample } from './process-sample.js';

const VALID_ENDPOINT = 'http://127.0.0.1:4318';

describe('App Diagnostics process sample', () => {
  it('projects nested process.telemetry flags from admitted configuration', () => {
    const observedAt = new Date('2026-09-09T12:00:00.000Z');
    const sample = createProcessDiagnosticsSample({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT, OTEL_SDK_DISABLED: 'true' },
      memory: {
        arrayBuffers: 0,
        external: 0,
        heapTotal: 30,
        heapUsed: 20,
        rss: 10,
      },
      nodeVersion: 'v24.0.0',
      now: observedAt,
      uptimeSeconds: 1.5,
    });

    expect(sample).toEqual({
      observedAt: '2026-09-09T12:00:00.000Z',
      nodeVersion: 'v24.0.0',
      uptimeSeconds: 1.5,
      memory: {
        rssBytes: 10,
        heapUsedBytes: 20,
        heapTotalBytes: 30,
      },
      telemetry: {
        enabled: false,
        exportConfigured: true,
      },
    });
    expect(sample).not.toHaveProperty('hostHealthy');
    expect(sample).not.toHaveProperty('buildId');
  });

  it('keeps exportConfigured when unsupported exporter headers disable telemetry', () => {
    const sample = createProcessDiagnosticsSample({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT,
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=secret-token',
      },
      memory: {
        arrayBuffers: 0,
        external: 0,
        heapTotal: 1,
        heapUsed: 1,
        rss: 1,
      },
      nodeVersion: 'v24.0.0',
      now: new Date('2026-09-09T12:00:00.000Z'),
      uptimeSeconds: 1,
    });
    expect(sample.telemetry).toEqual({ enabled: false, exportConfigured: true });
  });
});
