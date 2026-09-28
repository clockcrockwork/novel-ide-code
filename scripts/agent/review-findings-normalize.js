// 生 finding（各観点レビュアーが出力した未検証オブジェクト）を review-finding-contract.js の
// REVIEW_RAW_FINDING_SCHEMA に沿って検証し、正規化済み finding オブジェクトへ変換する。
// このモジュールは純粋関数のみを export する: fs も CLI 副作用も持たず、同じ入力に対して
// 常に同じ結果を返す（決定論的）。語彙（scope_relation / severity / evidence / Actionable
// 判定式）は review-finding-contract.js からのみ import し、このファイル自身では列挙値を
// ハードコードしない。正規化後の finding オブジェクトは検証済みフィールドを個別に列挙して
// 組み立て、動的キー（`target[key] = value` のようなループ）への代入は一切行わない —
// JSON.parse が生成しうる `__proto__` / `constructor` / `prototype` 等の own property を
// プロトタイプ汚染へ繋げない。

import { isAbsolute, normalize as normalizePath, relative, sep } from 'node:path';

import {
  ACTIONABLE_BASE_RULE,
  EVIDENCE_LEVELS,
  REVIEW_RAW_FINDING_SCHEMA,
  SCOPE_RELATIONS,
  SEVERITIES,
  SEVERITY_RANK,
} from './review-finding-contract.js';

// additionalProperties:false の許容キー集合をスキーマから導出する（手書き複製しない）。
const ALLOWED_TOP_LEVEL_KEYS = new Set(Object.keys(REVIEW_RAW_FINDING_SCHEMA.properties));
const ALLOWED_PROVENANCE_KEYS = new Set(
  Object.keys(REVIEW_RAW_FINDING_SCHEMA.properties.provenance.properties),
);

// `typeof null === 'object'` / `typeof [] === 'object'` という JS の古典的な落とし穴を
// 踏まないための明示ヘルパー。
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// file・provenance.angle・provenance.anchor_class は契約スキーマの minLength:1 と同じ意味で
// 「生の長さが1以上」を要求する（trim はしない）。
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length >= 1;
}

// summary・failure_scenario は空白のみの文字列も拒否する（契約上明示された trim 対象）。
function isNonEmptyAfterTrim(value) {
  return typeof value === 'string' && value.trim().length >= 1;
}

// line は null か 1 以上の整数。上限は意図的に設けない —
// 巨大な行番号（生成ファイル等）も正当でありうるため、恣意的な上限で拒否しない。
function isValidLine(value) {
  return value === null || (Number.isInteger(value) && value >= 1);
}

// angle_fields の直列化後サイズ上限。capForStorage() の既定 maxChars と同じ値を共有する
// （どちらか一方だけ変えると「保存直前に切り詰められる invalid record」と「そもそも受理されない
// 巨大 angle_fields」の閾値が乖離するため、単一の定数を正本にする）。
export const MAX_SERIALIZED_CHARS = 20000;

// angle_fields のネスト深さの上限。契約上の「angle 固有の分類データ」は小さな構造化
// オブジェクトであり、数十階層のネストを必要とする正当なユースケースは存在しない
// （現実的な必要性を大きく上回りつつ、エンジンのスタック上限は大きく下回る値）。
export const MAX_ANGLE_FIELDS_DEPTH = 20;

/**
 * `value` が `maxDepth` を超えてネストした object/array を含むか、循環参照を含む場合に
 * true を返す。`depth` が `maxDepth` を超えた時点で即座に打ち切るため、`value` が実際に
 * どれだけ深くネストしていても、この関数自身の再帰がスタックオーバーフローを起こすことは
 * ない（JSON.stringify 自身の、インデント有無やエンジンに依存するスタック上限には頼らない）。
 */
function exceedsSafeNesting(value, maxDepth, seen = new Set(), depth = 0) {
  if (depth > maxDepth) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true; // 循環参照
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (exceedsSafeNesting(child, maxDepth, seen, depth + 1)) return true;
  }
  seen.delete(value); // backtrack: 祖先ではなく兄弟パス経由で同じオブジェクトに到達する DAG は
  // 循環参照ではないため、誤って弾いてはいけない
  return false;
}

// provenance（トップレベルから渡された場合）の検証。トップレベルと同じ「未知キー拒否」方式を
// 許容キー集合（スキーマ由来）に対して行う。
function validateProvenance(raw) {
  if (!isPlainObject(raw)) {
    return { errors: ['provenance は object である必要があります'] };
  }
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PROVENANCE_KEYS.has(key)) {
      errors.push(truncateForMessage(`provenance: 未知のフィールドです: ${key}`));
    }
  }
  if (!isNonEmptyString(raw.angle)) {
    errors.push('provenance.angle は非空文字列である必要があります');
  }
  if (!isNonEmptyString(raw.anchor_class)) {
    errors.push('provenance.anchor_class は非空文字列である必要があります');
  }
  if (errors.length > 0) return { errors };
  return { value: { angle: raw.angle, anchor_class: raw.anchor_class } };
}

// file の正規化（issue #647「machine にやらせてよいもの: file / line normalization」）。
// cwd 配下を指す絶対パスはリポジトリ相対パスへ変換し、相対パスは `./`・`..`・重複区切りを
// 正規化する。これにより、同じ箇所を指す finding が reviewer ごとの path 表記の違い
// （絶対 vs 相対、`./` の有無等）だけで exact-duplicate / same-location grouping から
// 漏れる問題を防ぐ（review-spec F1で実証: 本セッション自身のレビュアー分散呼び出しでも
// 絶対パス・相対パスが混在する）。cwd 配下でない絶対パス（別リポジトリ・システムファイル等）
// は変換すると却って分かりにくくなるため、そのまま保持する。
function normalizeFile(file, cwd) {
  let candidate = file;
  if (isAbsolute(candidate) && typeof cwd === 'string' && isAbsolute(cwd)) {
    const rel = relative(cwd, candidate);
    // `rel.startsWith('..')` だけで判定すると、`..hidden/a.js` のような「`..` で始まるが
    // 実際には親ディレクトリへ脱出しない正当なファイル名」まで「リポジトリ外」と誤判定して
    // しまう（`relative('/repo','/repo/..hidden/a.js')` は `'..hidden/a.js'` を返すが、これは
    // 脱出ではない）。真に親ディレクトリへ脱出する場合（`rel === '..'` そのもの、または
    // `rel` が `..` + セパレータで始まる場合）だけを除外する。
    const escapesCwd = rel === '..' || rel.startsWith(`..${sep}`);
    if (!escapesCwd && !isAbsolute(rel)) {
      candidate = rel;
    }
  }
  return isAbsolute(candidate) ? candidate : normalizePath(candidate);
}

/**
 * 生 finding を検証し、正規化済み finding へ変換する。データ形状の問題では throw しない
 * （常に `{status:'invalid', errors}` を返す）。`finding_id` はここでは付与しない
 * （呼び出し側 review-findings.js が artifact 全体の連番から採番する）。
 */
export function validateAndNormalizeFinding(raw, { defaultAngle, defaultAnchorClass, cwd } = {}) {
  if (!isPlainObject(raw)) {
    return { status: 'invalid', errors: ['finding は object である必要があります'] };
  }

  const errors = [];

  // `Object.keys(raw)`（`for...in` ではない）で列挙する。これにより JSON.parse が生成した
  // own property の `__proto__` / `constructor` / `prototype` は、許容集合に無い「未知の
  // フィールド」として自然に拒否される（特別扱い不要）。
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(truncateForMessage(`未知のフィールドです: ${key}`));
    }
  }

  if (!isNonEmptyString(raw.file)) {
    errors.push('file は非空文字列である必要があります');
  }
  if (!isValidLine(raw.line)) {
    errors.push('line は null または 1 以上の整数である必要があります');
  }
  if (!isNonEmptyAfterTrim(raw.summary)) {
    errors.push('summary は非空文字列である必要があります');
  }
  if (!isNonEmptyAfterTrim(raw.failure_scenario)) {
    errors.push('failure_scenario は非空文字列である必要があります');
  }
  if (!SCOPE_RELATIONS.includes(raw.scope_relation)) {
    errors.push(
      `scope_relation は次のいずれかである必要があります: ${SCOPE_RELATIONS.join(' / ')}`,
    );
  }
  if (!SEVERITIES.includes(raw.severity)) {
    errors.push(`severity は次のいずれかである必要があります: ${SEVERITIES.join(' / ')}`);
  }
  if (!EVIDENCE_LEVELS.includes(raw.evidence)) {
    errors.push(`evidence は次のいずれかである必要があります: ${EVIDENCE_LEVELS.join(' / ')}`);
  }

  let angleFields;
  if (Object.hasOwn(raw, 'angle_fields')) {
    if (!isPlainObject(raw.angle_fields)) {
      errors.push('angle_fields は object である必要があります');
    } else if (exceedsSafeNesting(raw.angle_fields, MAX_ANGLE_FIELDS_DEPTH)) {
      // 深すぎるネスト・循環参照は、JSON.stringify（このモジュール内の直列化チェックにも、
      // ingest 側の writeJson がインデント付きで artifact 全体を書き込む時点にも）がスタックを
      // 使い切る前に、エンジン非依存の深さチェックで拒否する。インデント有無やエンジンによる
      // 閾値の違いに関わらず安全に倒すため、現実的な必要性を大きく上回る余裕を持たせている。
      errors.push(`angle_fields のネストが深すぎます（上限 ${MAX_ANGLE_FIELDS_DEPTH} 階層）`);
    } else {
      // 深さは上のチェックで保証済みのため、ここで JSON.stringify が RangeError を投げることは
      // 実質的に無いはずだが、捕捉できない直列化エラーに対する安価な防御として残す。
      let serialized;
      try {
        serialized = JSON.stringify(raw.angle_fields);
      } catch {
        errors.push('angle_fields を保存用に直列化できません（深すぎるか循環参照を含みます）');
      }
      if (serialized !== undefined) {
        if (serialized.length > MAX_SERIALIZED_CHARS) {
          errors.push(`angle_fields が大きすぎます（上限 ${MAX_SERIALIZED_CHARS} 文字）`);
        } else {
          angleFields = raw.angle_fields;
        }
      }
    }
  }

  let provenance;
  if (Object.hasOwn(raw, 'provenance')) {
    const result = validateProvenance(raw.provenance);
    if (result.errors) {
      errors.push(...result.errors);
    } else {
      provenance = result.value;
    }
  } else if (isNonEmptyString(defaultAngle) && isNonEmptyString(defaultAnchorClass)) {
    provenance = { angle: defaultAngle, anchor_class: defaultAnchorClass };
  } else {
    errors.push('provenance が指定されておらず、既定値（angle/anchor_class）もありません');
  }

  if (errors.length > 0) {
    return { status: 'invalid', errors };
  }

  // 検証済みフィールドを個別に列挙して組み立てる（動的キーのループ代入はしない）。
  // これにより、途中の検査を生き延びたキーが万一あっても、対象オブジェクトへの
  // プロトタイプ汚染は構造的に起こり得ない。
  const finding = {
    file: normalizeFile(raw.file, cwd),
    line: raw.line,
    summary: raw.summary,
    failure_scenario: raw.failure_scenario,
    scope_relation: raw.scope_relation,
    severity: raw.severity,
    evidence: raw.evidence,
    provenance,
    ...(angleFields !== undefined ? { angle_fields: angleFields } : {}),
  };

  return { status: 'normalized', finding };
}

/** 正規化済み finding が Actionable（対応必須）かを判定する。 */
export function isActionable(finding) {
  return (
    ACTIONABLE_BASE_RULE.scopeRelations.includes(finding.scope_relation) &&
    SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[ACTIONABLE_BASE_RULE.minimumSeverity] &&
    ACTIONABLE_BASE_RULE.evidenceLevels.includes(finding.evidence)
  );
}

// capForStorage 専用: `value` のうち `maxDepth` を超えてネストする部分木だけをプレースホルダ
// 文字列へ置き換える（value 全体は捨てない——angle_fields だけが深すぎる finding でも
// file/line/summary 等の浅いフィールドを artifact から追跡できるようにするため）。
//
// `result[key] = value` のような動的キー代入をせず `Object.keys` + `Object.fromEntries` を
// 使う理由: このファイル冒頭の方針と同じく、JSON.parse が生成しうる `__proto__` 等の own
// property が、動的キー代入だと継承した setter を経由してプロトタイプ汚染に繋がりうるが、
// `Object.fromEntries` は内部的に CreateDataPropertyOrThrow を使うため setter を経由しない。
//
// `exceedsSafeNesting` と異なり `seen` による循環検出を持たない理由: 深さの上限だけで
// 再帰が必ず停止する——循環参照があっても depth が単調増加するため maxDepth+1 回で必ず
// 打ち切られる。`seen` はあくまで早期終了の最適化であり正当性には不要。
function redactDeepParts(value, maxDepth, depth = 0) {
  if (depth > maxDepth) return '[nested value omitted: too deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((child) => redactDeepParts(child, maxDepth, depth + 1));
  }
  const entries = Object.keys(value).map((key) => [
    key,
    redactDeepParts(value[key], maxDepth, depth + 1),
  ]);
  return Object.assign(Object.create(null), Object.fromEntries(entries));
}

/**
 * 入力由来の値（未知フィールド名・未知の観点名等）をテンプレートリテラルへ埋め込んで組み立てた
 * エラーメッセージ文字列を、`maxChars` を超える場合は切り詰める。`capForStorage` が `raw`
 * フィールド（値そのものの直列化）の肥大化を防ぐのと対になる仕組みで、こちらは1本の
 * メッセージ文字列を対象にする単純な切り詰めにすぎない——巨大な入力由来文字列がエラー
 * メッセージ経由で `errors[]`（artifact に保存され、CLI の stdout/stderr にも出力される）を
 * 無制限に肥大化させるのを防ぐ。
 */
export function truncateForMessage(message, maxChars = 500) {
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars)}...(truncated)`;
}

/**
 * invalid record の生ペイロードを保存する前に肥大化を抑える。汎用的なセキュリティ機構では
 * なく、壊れた/敵対的な巨大入力が artifact を無制限に太らせないための簡易な上限にすぎない。
 *
 * 文字数だけでなく深さも見る: ネストした配列は `[` `]` の反復だけで直列化後の文字数が
 * 小さく収まりうる（キー名を持たないため）。angle_fields のネスト超過で invalid になった
 * finding（や、angle_fields 以外の未知フィールド経由で深いネストを持ち込む finding）の raw
 * ペイロードを文字数の上限だけで判定すると、こうした「短いが極端に深い」値をそのまま
 * 素通ししてしまう。素通しした場合、この値自体は個々の JSON.stringify では問題なくても、
 * artifact 全体をインデント付きで書き出す ingestFindings の writeJson が、この値を
 * `records[i].raw` 配下にもう一段ネストさせた状態で直列化することになり、スタック消費量に
 * 余裕がない環境では RangeError を引き起こしうる（indent 有無・呼び出し時点のスタック残量に
 * 依存するため、閾値ぎりぎりの深さは環境によって安全だったり危険だったりする）。
 */
export function capForStorage(value, maxChars = MAX_SERIALIZED_CHARS) {
  // ここでの `value` は finding 全体（`{ ..., angle_fields }`）であり、angle_fields 自体より
  // 1階層深いラッパーになる。境界ちょうど（MAX_ANGLE_FIELDS_DEPTH 階層）の正当な angle_fields
  // を持つ finding が、angle_fields 以外の理由で invalid になった場合にまで誤って redact
  // しないよう、その1階層分を許容差として加える。
  const safeValue = redactDeepParts(value, MAX_ANGLE_FIELDS_DEPTH + 1);
  const json = JSON.stringify(safeValue);
  if (json.length <= maxChars) return safeValue;
  return { truncated: true, originalLength: json.length, preview: json.slice(0, 2000) };
}
