import ModuleWrapper from '../common/ModuleWrapper';
import { useApp, DEFAULT_SETTINGS } from '../../context/AppContext';
import { toSiteText, RUBY_PRESETS, NAME_TAG_PRESETS } from '../../lib/plainText';
import { downloadFile } from '../../lib/download';

function genId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function applyReplacements(content, rows, siteId) {
  let result = content;
  for (const row of rows) {
    const rep = row.patterns?.[siteId];
    if (!row.original || rep === undefined) continue;
    result = result.replaceAll(row.original, () => rep);
  }
  return result;
}

const TH = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--tx3)',
  padding: '3px 4px',
  textAlign: 'left',
  borderBottom: '1px solid var(--bd)',
  whiteSpace: 'nowrap',
};
const TD = { padding: '2px 2px', verticalAlign: 'middle' };
const DEL_BTN = {
  fontSize: 10,
  color: 'var(--tx3)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '0 3px',
  fontFamily: 'inherit',
};
const CELL_INPUT = { fontSize: 11, padding: '2px 4px', width: '100%', minWidth: 52 };

function MultiReplaceBody({ profiles, setProfiles, currentFile }) {
  const { sites, rows } = profiles;

  const addSite = () => {
    const name = window.prompt('サイト名を入力してください');
    if (!name?.trim()) return;
    setProfiles((p) => ({
      ...p,
      sites: [...p.sites, { id: genId(), name: name.trim(), rubyFormat: 'none' }],
    }));
  };

  const deleteSite = (siteId) => {
    if (!window.confirm('このサイト設定を削除しますか？')) return;
    setProfiles((p) => ({
      ...p,
      sites: p.sites.filter((s) => s.id !== siteId),
      rows: p.rows.map((r) => {
        const { [siteId]: _removed, ...rest } = r.patterns || {};
        return { ...r, patterns: rest };
      }),
    }));
  };

  const renameSite = (siteId, name) =>
    setProfiles((p) => ({
      ...p,
      sites: p.sites.map((s) => (s.id === siteId ? { ...s, name } : s)),
    }));

  const setRubyFormat = (siteId, format) =>
    setProfiles((p) => ({
      ...p,
      sites: p.sites.map((s) => (s.id === siteId ? { ...s, rubyFormat: format } : s)),
    }));

  const setCustomRuby = (siteId, value) =>
    setProfiles((p) => ({
      ...p,
      sites: p.sites.map((s) => (s.id === siteId ? { ...s, customRuby: value } : s)),
    }));

  const setNameTag = (siteId, value) =>
    setProfiles((p) => ({
      ...p,
      sites: p.sites.map((s) => (s.id === siteId ? { ...s, nameTag: value } : s)),
    }));

  const addNameTagRow = () => {
    if (!sites.some((s) => s.nameTag?.trim())) {
      window.alert(
        '名前タグが設定されているサイトがありません。先に各サイトの設定で「名前タグ」を入力してください。',
      );
      return;
    }
    const original = window.prompt('原稿内のプレースホルダを入力してください（例: △△、主人公）');
    if (!original?.trim()) return;
    const patterns = {};
    for (const s of sites) {
      const trimmedTag = s.nameTag?.trim();
      if (trimmedTag) patterns[s.id] = trimmedTag;
    }
    setProfiles((p) => ({
      ...p,
      rows: [...p.rows, { id: genId(), original: original.trim(), patterns }],
    }));
  };

  const addRow = () =>
    setProfiles((p) => ({ ...p, rows: [...p.rows, { id: genId(), original: '', patterns: {} }] }));

  const deleteRow = (rowId) => {
    if (!window.confirm('この行を削除しますか？')) return;
    setProfiles((p) => ({ ...p, rows: p.rows.filter((r) => r.id !== rowId) }));
  };

  const setOriginal = (rowId, value) =>
    setProfiles((p) => ({
      ...p,
      rows: p.rows.map((r) => (r.id === rowId ? { ...r, original: value } : r)),
    }));

  const setPattern = (rowId, siteId, value) =>
    setProfiles((p) => ({
      ...p,
      rows: p.rows.map((r) =>
        r.id === rowId ? { ...r, patterns: { ...r.patterns, [siteId]: value } } : r,
      ),
    }));

  const handleCopy = (siteId) => {
    const site = sites.find((s) => s.id === siteId);
    const replaced = applyReplacements(currentFile?.content || '', rows, siteId);
    const converted = toSiteText(replaced, site?.rubyFormat, site?.customRuby);
    navigator.clipboard?.writeText(converted)?.catch((err) => {
      console.error('コピーに失敗しました:', err);
      window.alert('コピーに失敗しました。');
    });
  };

  const handleDownload = (siteId) => {
    const site = sites.find((s) => s.id === siteId);
    const replaced = applyReplacements(currentFile?.content || '', rows, siteId);
    const converted = toSiteText(replaced, site?.rubyFormat, site?.customRuby);
    const base = (currentFile?.name || 'novel').replace(/\.md$/, '');
    const siteName = (site?.name || siteId).replace(/[/\\:*?"<>|]/g, '_').trim() || siteId;
    downloadFile(converted, `${base}_${siteName}.txt`);
  };

  const hasContent = sites.length > 0 || rows.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hasContent && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={TH}>変換前</th>
                {sites.map((s) => (
                  <th key={s.id} style={{ ...TH, minWidth: 80 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <input
                        className="text-input"
                        value={s.name}
                        onChange={(e) => renameSite(s.id, e.target.value)}
                        style={{ ...CELL_INPUT, fontWeight: 600 }}
                      />
                      <button
                        type="button"
                        onClick={() => deleteSite(s.id)}
                        style={DEL_BTN}
                        title="この列を削除"
                        aria-label="この列を削除"
                      >
                        ×
                      </button>
                    </div>
                  </th>
                ))}
                <th style={{ width: 18 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={TD}>
                    <input
                      className="text-input"
                      value={row.original}
                      onChange={(e) => setOriginal(row.id, e.target.value)}
                      placeholder="変換前"
                      style={CELL_INPUT}
                    />
                  </td>
                  {sites.map((s) => (
                    <td key={s.id} style={TD}>
                      <input
                        className="text-input"
                        value={row.patterns?.[s.id] || ''}
                        onChange={(e) => setPattern(row.id, s.id, e.target.value)}
                        placeholder="変換後"
                        style={CELL_INPUT}
                      />
                    </td>
                  ))}
                  <td style={{ ...TD, textAlign: 'center' }}>
                    <button
                      type="button"
                      onClick={() => deleteRow(row.id)}
                      style={DEL_BTN}
                      title="この行を削除"
                      aria-label="この行を削除"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={addRow}
        >
          ＋ 行追加
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={addSite}
        >
          ＋ サイト追加
        </button>
        {sites.length > 0 && (
          <button
            type="button"
            className="btn-ghost"
            style={{ fontSize: 11, padding: '3px 8px' }}
            onClick={addNameTagRow}
            title="プレースホルダを入力し、各サイトの名前タグを自動入力した行を追加します"
          >
            ＋ 名前タグ行
          </button>
        )}
      </div>

      {!hasContent && (
        <div style={{ fontSize: 11, color: 'var(--tx3)', lineHeight: 1.7 }}>
          「＋ サイト追加」でサイト列を追加し、「＋ 行追加」で変換ワードを登録できます。
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
              主要サイトの名前タグ形式
            </summary>
            <table
              style={{ fontSize: 10, marginTop: 4, borderCollapse: 'collapse', width: '100%' }}
            >
              <tbody>
                {NAME_TAG_PRESETS.map((p) => (
                  <tr key={p.id}>
                    <td
                      style={{ padding: '1px 4px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}
                    >
                      {p.tag}
                    </td>
                    <td style={{ padding: '1px 4px', color: 'var(--tx3)' }}>{p.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 4, color: 'var(--tx3)' }}>
              サイトに「名前タグ」を設定後、「＋ 名前タグ行」でプレースホルダ行を一括追加できます。
            </div>
          </details>
        </div>
      )}

      {sites.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--bd)',
            paddingTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {sites.map((s) => (
            <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--tx2)',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.name}
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => handleCopy(s.id)}
                >
                  コピー
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => handleDownload(s.id)}
                >
                  ↓DL
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                  ルビ
                </span>
                <select
                  className="text-input"
                  value={s.rubyFormat || 'none'}
                  onChange={(e) => setRubyFormat(s.id, e.target.value)}
                  style={{ fontSize: 11, padding: '2px 4px', flex: 1 }}
                >
                  {Object.entries(RUBY_PRESETS).map(([key, { label }]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {s.rubyFormat === 'custom' && (
                <input
                  className="text-input"
                  value={s.customRuby || ''}
                  onChange={(e) => setCustomRuby(s.id, e.target.value)}
                  placeholder="例: ｜{base}《{reading}》"
                  style={{ fontSize: 11, padding: '2px 4px' }}
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                  名前タグ
                </span>
                <input
                  className="text-input"
                  list="nametag-presets"
                  value={s.nameTag || ''}
                  onChange={(e) => setNameTag(s.id, e.target.value)}
                  placeholder="例: ##NAME##（空欄で無効）"
                  style={{ fontSize: 11, padding: '2px 4px', flex: 1 }}
                />
              </div>
            </div>
          ))}
          <datalist id="nametag-presets">
            {NAME_TAG_PRESETS.map((p) => (
              <option key={p.id} value={p.tag}>
                {p.label}
              </option>
            ))}
          </datalist>
        </div>
      )}
    </div>
  );
}

export default function MultiReplaceMod() {
  const { settings, setSettings, currentFile } = useApp();

  const profiles = settings?.replacementProfiles || DEFAULT_SETTINGS.replacementProfiles;

  const setProfiles = (updater) =>
    setSettings((s) => ({
      ...s,
      replacementProfiles:
        typeof updater === 'function'
          ? updater(s?.replacementProfiles || DEFAULT_SETTINGS.replacementProfiles)
          : updater,
    }));

  return (
    <ModuleWrapper title="サイト別置換出力" icon="🔄">
      <MultiReplaceBody profiles={profiles} setProfiles={setProfiles} currentFile={currentFile} />
    </ModuleWrapper>
  );
}
