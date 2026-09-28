// <!-- agent-commons:generated source=review-finding-contract version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->
// Structured review finding / verification contract shared across consumers.
//
// This module is intentionally data-only: consumer-specific routing, path classification,
// runtime state, aggregation policy, and model selection do not belong here.
// It is staged independently from the current review workflow so consumers can adopt it
// explicitly without changing the legacy review contract by merely advancing their lock.

export const REVIEW_FINDING_CONTRACT_VERSION = 1;

export const SCOPE_RELATIONS = Object.freeze([
  'introduced',
  'worsened',
  'newly_exposed',
  'pre_existing',
  'unrelated',
]);

export const SEVERITIES = Object.freeze(['blocker', 'high', 'med', 'low']);
export const SEVERITY_RANK = Object.freeze({
  low: 0,
  med: 1,
  high: 2,
  blocker: 3,
});
export const EVIDENCE_LEVELS = Object.freeze(['verified', 'strong', 'weak']);
export const VERIFICATION_VERDICTS = Object.freeze([
  'confirmed',
  'refuted_evidence',
  'unresolved_concern',
]);

const provenanceSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['angle', 'anchor_class'],
  properties: {
    angle: { type: 'string', minLength: 1 },
    anchor_class: { type: 'string', minLength: 1 },
  },
});

const rawFindingProperties = Object.freeze({
  file: { type: 'string', minLength: 1 },
  line: {
    anyOf: [
      { type: 'integer', minimum: 1 },
      { type: 'null' },
    ],
  },
  summary: { type: 'string', minLength: 1 },
  failure_scenario: { type: 'string', minLength: 1 },
  scope_relation: { enum: SCOPE_RELATIONS },
  severity: { enum: SEVERITIES },
  evidence: { enum: EVIDENCE_LEVELS },
  provenance: provenanceSchema,
  // Angle-specific classifications belong under this namespace rather than extending
  // the common top level. This keeps aggregation and later schema evolution deterministic.
  angle_fields: {
    type: 'object',
    additionalProperties: true,
  },
});

export const REVIEW_RAW_FINDING_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:agent-commons:review-raw-finding:v1',
  title: 'Agent Commons raw review finding',
  type: 'object',
  additionalProperties: false,
  required: [
    'file',
    'line',
    'summary',
    'failure_scenario',
    'scope_relation',
    'severity',
    'evidence',
    'provenance',
  ],
  properties: rawFindingProperties,
});

export const REVIEW_FINDING_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:agent-commons:review-finding:v1',
  title: 'Agent Commons normalized review finding',
  type: 'object',
  additionalProperties: false,
  required: ['finding_id', ...REVIEW_RAW_FINDING_SCHEMA.required],
  properties: Object.freeze({
    // Aggregator-assigned opaque join key. It is required to be unique within one
    // aggregation artifact so verification/metrics can reference the same finding.
    // It is deliberately NOT a cross-run identity or semantic-dedup fingerprint.
    finding_id: {
      type: 'string',
      minLength: 1,
      description:
        'Opaque aggregator-assigned key, unique within one aggregation artifact; not a cross-run semantic identity.',
    },
    ...rawFindingProperties,
  }),
});

const verificationEvidenceSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['source', 'locator', 'detail'],
  properties: {
    // Examples: code, test, runtime, canonical-doc. Kept open so consumers do not need
    // a commons release merely to introduce a new evidence source class.
    source: { type: 'string', minLength: 1 },
    // Stable locator such as path:line, test name, command/result id, or document section.
    locator: { type: 'string', minLength: 1 },
    detail: { type: 'string', minLength: 1 },
  },
});

export const REVIEW_VERIFICATION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:agent-commons:review-verification:v1',
  title: 'Agent Commons finding verification result',
  type: 'object',
  additionalProperties: false,
  required: ['finding_id', 'verdict', 'rationale', 'evidence'],
  properties: {
    finding_id: { type: 'string', minLength: 1 },
    verdict: { enum: VERIFICATION_VERDICTS },
    rationale: { type: 'string', minLength: 1 },
    evidence: {
      type: 'array',
      items: verificationEvidenceSchema,
      minItems: 1,
    },
  },
});

// Current Actionable rule expressed as data. Verification is deliberately not part of this
// rule yet: introducing the verifier as an authority gate is a separate consumer migration.
export const ACTIONABLE_BASE_RULE = Object.freeze({
  scopeRelations: Object.freeze(['introduced', 'worsened', 'newly_exposed']),
  minimumSeverity: 'med',
  evidenceLevels: Object.freeze(['verified', 'strong']),
});
