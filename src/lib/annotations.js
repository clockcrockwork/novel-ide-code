const MAX_SELECTED_TEXT = 2000; // not-a-threshold
const MAX_NOTE_LENGTH = 5000; // not-a-threshold

export const MARKER_COLORS = [
  { color: 'oklch(.86 .14 80/.52)', label: '黄' },
  { color: 'oklch(.78 .1  200/.5)', label: '青' },
  { color: 'oklch(.78 .12 155/.5)', label: '緑' },
];
export const ALLOWED_MARKER_COLORS = new Set(MARKER_COLORS.map((c) => c.color));

export function safeColor(c) {
  return ALLOWED_MARKER_COLORS.has(c) ? c : 'oklch(.86 .14 80/.52)';
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeId(id) {
  const s = typeof id === 'string' ? id : '';
  if (/^[A-Za-z0-9_-]{1,128}$/.test(s)) return s;
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function safePosition(value, docSize) {
  if (!Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  if (n < 0) return null;
  if (Number.isFinite(docSize) && n > docSize) return null;
  return n;
}

export function normalizeAnnotation(anno, docSize) {
  if (!anno || typeof anno !== 'object') return null;
  if (anno.type !== 'marker' && anno.type !== 'memo') return null;

  const selectedText = safeText(anno.selectedText).slice(0, MAX_SELECTED_TEXT);
  if (!selectedText.trim()) return null;

  const normalized = {
    id: safeId(anno.id),
    type: anno.type,
    selectedText,
    createdAt: Number.isFinite(anno.createdAt) ? anno.createdAt : Date.now(),
    occurrenceIdx:
      Number.isFinite(anno.occurrenceIdx) && anno.occurrenceIdx >= 0
        ? Math.trunc(anno.occurrenceIdx)
        : 0,
  };

  const from = safePosition(anno.from, docSize);
  const to = safePosition(anno.to, docSize);
  if (from != null && to != null && from < to) {
    normalized.from = from;
    normalized.to = to;
  }

  if (anno.type === 'marker') normalized.color = safeColor(anno.color);
  else normalized.note = safeText(anno.note).slice(0, MAX_NOTE_LENGTH);

  return normalized;
}

export function normalizeAnnotations(annos, docSize) {
  if (!Array.isArray(annos)) return [];
  return annos.map((anno) => normalizeAnnotation(anno, docSize)).filter(Boolean);
}
