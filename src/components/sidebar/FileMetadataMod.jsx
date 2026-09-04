import { useState } from 'react';
import { useFileMetadataStore } from '../../stores/fileMetadataStore';
import { useApp } from '../../context/AppContext';
import ModuleWrapper from '../common/ModuleWrapper';

function KindSelect({ kindId, kindDefinitions, onChange, id }) {
  const active = kindDefinitions.filter((d) => !d.archived || d.id === kindId);
  return (
    <select
      id={id}
      className="text-input"
      style={{ width: '100%' }}
      value={kindId ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    >
      {active.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

function StatusSelect({ statusId, statusDefinitions, onChange, id }) {
  const active = statusDefinitions.filter((d) => !d.archived || d.id === statusId);
  return (
    <select
      id={id}
      className="text-input"
      style={{ width: '100%' }}
      value={statusId ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    >
      {active.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

function NumberInput({ value, onChange, id }) {
  const [draft, setDraft] = useState(() => (value != null ? String(value) : ''));
  const [prevValue, setPrevValue] = useState(value);

  // Derived state: sync when external value changes (React render-time pattern)
  if (prevValue !== value) {
    setPrevValue(value);
    const isIntermediate = draft === '-' || draft === '.' || draft === '-.';
    if (!isIntermediate) {
      const draftNum = Number(draft);
      if (!(Number.isFinite(draftNum) && draftNum === value)) {
        setDraft(value != null ? String(value) : '');
      }
    }
  }

  return (
    <input
      id={id}
      className="text-input"
      style={{ width: '100%' }}
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => {
        const val = e.target.value;
        setDraft(val);
        if (val === '' || val === '-' || val === '.' || val === '-.') {
          onChange(undefined);
          return;
        }
        const n = Number(val);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => {
        if (draft === '') {
          onChange(undefined); // React が再描画する前に blur が来ても消去を確定させる
          return;
        }
        const n = Number(draft);
        if (!Number.isFinite(n) || draft === '-' || draft === '.' || draft === '-.') {
          setDraft(value != null ? String(value) : '');
        } else {
          setDraft(String(n));
        }
      }}
    />
  );
}

function CustomFieldRow({ fieldDef, value, onChange, id }) {
  switch (fieldDef.type) {
    case 'text':
      return (
        <input
          id={id}
          className="text-input"
          style={{ width: '100%' }}
          value={typeof value === 'string' ? value : ''}
          maxLength={2000}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return <NumberInput id={id} value={value} onChange={onChange} />;
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
      );
    case 'date':
      return (
        <input
          id={id}
          className="text-input"
          style={{ width: '100%' }}
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'url':
      return (
        <input
          id={id}
          className="text-input"
          style={{ width: '100%' }}
          type="url"
          value={typeof value === 'string' ? value : ''}
          maxLength={2000}
          placeholder="https://"
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'select': {
      const options = Array.isArray(fieldDef.options)
        ? fieldDef.options.filter((o) => typeof o === 'string')
        : [];
      return (
        <select
          id={id}
          className="text-input"
          style={{ width: '100%' }}
          value={typeof value === 'string' && options.includes(value) ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    case 'multi-select': {
      const options = Array.isArray(fieldDef.options)
        ? fieldDef.options.filter((o) => typeof o === 'string')
        : [];
      const selected = Array.isArray(value) ? value : [];
      return (
        <div
          role="group"
          aria-label={fieldDef.label}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
        >
          {options.map((opt) => (
            <label
              key={opt}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, opt]
                    : selected.filter((v) => v !== opt);
                  onChange(options.filter((o) => next.includes(o)));
                }}
              />
              {opt}
            </label>
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

const LABEL_STYLE = { fontSize: 10, color: 'var(--tx3)', display: 'block', marginBottom: 3 };

function FileMetadataBody() {
  const { currentFile, updateFileMetadata } = useApp();
  const kindDefinitions = useFileMetadataStore((s) => s.kindDefinitions);
  const statusDefinitions = useFileMetadataStore((s) => s.statusDefinitions);
  const customFieldDefs = useFileMetadataStore((s) => s.customFieldDefs);
  const isLoaded = useFileMetadataStore((s) => s.isLoaded);
  const fileMetadataMap = useFileMetadataStore((s) => s.fileMetadataMap);

  const meta = currentFile ? fileMetadataMap[currentFile.id] : undefined;
  const [titleDraft, setTitleDraft] = useState(meta?.title ?? '');
  const [prevSyncKey, setPrevSyncKey] = useState(`${currentFile?.id ?? null}:${!!meta}`);

  const syncKey = `${currentFile?.id ?? null}:${!!meta}`;
  if (prevSyncKey !== syncKey) {
    setPrevSyncKey(syncKey);
    setTitleDraft(meta?.title ?? '');
  }

  if (!isLoaded) {
    return <div style={{ fontSize: 11, color: 'var(--tx3)' }}>読み込み中…</div>;
  }

  if (!currentFile) {
    return <div style={{ fontSize: 11, color: 'var(--tx3)' }}>ファイルを選択してください</div>;
  }

  if (!meta) {
    return <div style={{ fontSize: 11, color: 'var(--tx3)' }}>メタデータ未設定</div>;
  }

  const activeDefs = customFieldDefs.filter((d) => !d.archived);

  return (
    <div key={currentFile.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <label htmlFor="meta-title" style={LABEL_STYLE}>
          タイトル
        </label>
        <input
          id="meta-title"
          className="text-input"
          style={{ width: '100%' }}
          value={titleDraft}
          maxLength={500}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={(e) => {
            if (e.target.value !== meta.title) {
              updateFileMetadata(currentFile.id, { title: e.target.value });
            }
          }}
        />
      </div>

      {kindDefinitions.length > 0 && (
        <div>
          <label htmlFor="meta-kind" style={LABEL_STYLE}>
            種別
          </label>
          <KindSelect
            id="meta-kind"
            kindId={meta.kindId}
            kindDefinitions={kindDefinitions}
            onChange={(kindId) => updateFileMetadata(currentFile.id, { kindId })}
          />
        </div>
      )}

      {statusDefinitions.length > 0 && (
        <div>
          <label htmlFor="meta-status" style={LABEL_STYLE}>
            ステータス
          </label>
          <StatusSelect
            id="meta-status"
            statusId={meta.statusId}
            statusDefinitions={statusDefinitions}
            onChange={(statusId) => updateFileMetadata(currentFile.id, { statusId })}
          />
        </div>
      )}

      {activeDefs.map((fieldDef) => {
        const isMultiSelect = fieldDef.type === 'multi-select';
        const fieldId = `meta-field-${fieldDef.id}`;
        return (
          <div key={fieldDef.id}>
            {isMultiSelect ? (
              <div style={LABEL_STYLE}>{fieldDef.label}</div>
            ) : (
              <label htmlFor={fieldId} style={LABEL_STYLE}>
                {fieldDef.label}
              </label>
            )}
            <CustomFieldRow
              id={isMultiSelect ? undefined : fieldId}
              fieldDef={fieldDef}
              value={meta.custom?.[fieldDef.id]}
              onChange={(val) =>
                updateFileMetadata(currentFile.id, {
                  custom: Object.assign(Object.create(null), meta.custom, { [fieldDef.id]: val }),
                })
              }
            />
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 2 }}>
        更新: {new Date(meta.updatedAt).toLocaleString('ja-JP')}
      </div>
    </div>
  );
}

export default function FileMetadataMod() {
  return (
    <ModuleWrapper title="ファイル情報">
      <FileMetadataBody />
    </ModuleWrapper>
  );
}
