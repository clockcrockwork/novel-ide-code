import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import { localPlugin } from '../../eslint.config.js';

// custom lint ルール no-unvalidated-external-url-prop の検証（audit M2 / R9）。
// RuleTester を node:test に配線する（ESLint 10 flat config 形式）。
RuleTester.describe = describe;
RuleTester.it = it;

const rule = localPlugin.rules['no-unvalidated-external-url-prop'];

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run('no-unvalidated-external-url-prop', rule, {
  valid: [
    // 許可 validator の「引数」としてラップ済み
    { code: 'const a = <a href={safeExternalHref(pr.html_url)}>x</a>;' },
    { code: 'const b = <img src={sanitizeUrlForExport(u.avatar_url)} />;' },
    // 論理式でも、対象 member 自身がラッパー引数なら検証済み
    { code: 'const c = <a href={safeExternalHref(pr.html_url) || fallbackStaticUrl}>x</a>;' },
    // 文字列・テンプレート・素の identifier・imported asset（外部でない / GitHub 固有名でない）
    { code: 'const d = <a href="/static/path">x</a>;' },
    { code: 'const e = <a href={`#${id}`}>x</a>;' },
    { code: 'const f = <img src={logoPng} />;' },
    { code: 'const g = <a href={localUrl}>x</a>;' },
    // 汎用プロパティ名（url）は FP 回避のため対象外
    { code: 'const h = <a href={prCreateSuccess.url}>x</a>;' },
    // href / src 以外の属性は対象外
    { code: 'const i = <div data-x={ghUser.avatar_url} />;' },
    // JSX 外の通常コードは対象外（href/src に流していない）
    { code: 'const j = pr.html_url;' },
    // computed で bracket 内が動的（非 Literal）→ 静的に GitHub URL と判定できないため対象外
    { code: 'const k = <a href={pr[dynamicKey]}>x</a>;' },
    // computed の suspect member も許可 validator でラップされていれば検証済み
    { code: "const l = <img src={safeExternalHref(ghUser['avatar_url'])} />;" },
    // 三項の条件式（test）としてのみ使用 → 描画されるのは検証済み側。FP にしない（レビュー #373）
    { code: "const m = <a href={ghUser.html_url ? safeExternalHref(ghUser.html_url) : '#'}>x</a>;" },
    // 論理積(&&)の左辺（ガード）として使用 → 描画されるのは右辺。FP にしない（レビュー #373）
    { code: 'const n = <a href={ghUser.html_url && safeExternalHref(ghUser.html_url)}>x</a>;' },
    // inline object spread でも許可 validator でラップされていれば検証済み
    { code: 'const o = <a {...{ href: safeExternalHref(pr.html_url) }}>x</a>;' },
  ],
  invalid: [
    {
      code: 'const a = <img src={ghUser.avatar_url} />;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      code: 'const b = <a href={pr.html_url}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // ネストした member（result.commit.html_url）でも property 名一致で検出（1 件のみ）
      code: 'const c = <a href={result.commit.html_url}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // camelCase 変種
      code: 'const d = <img src={user.avatarUrl} />;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // 三項: 検証側と未検証側の混在。未検証側（alternate の pr.html_url）を検出（レビュー #373）
      code: 'const e = <a href={isOk ? safeExternalHref(pr.html_url) : pr.html_url}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // 論理式: 別 URL だけ検証し対象 URL を生でフォールバック → 未検証側を検出（レビュー #373）
      code: 'const f = <a href={safeExternalHref(other.html_url) || pr.html_url}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // String() は URL 検証ではない → バイパスさせない（レビュー #373）
      code: 'const g = <a href={String(pr.html_url)}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // テンプレートリテラル経由も検出（レビュー #373）
      code: 'const h = <a href={`${pr.html_url}`}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // 固定文字列の bracket 記法（computed property）もバイパスさせない（レビュー #373）
      code: "const i = <img src={ghUser['avatar_url']} />;",
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      code: 'const j = <a href={pr["html_url"]}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // 論理和(||)の左辺は truthy 時に描画される → &&と異なり検証済み扱いにしない（レビュー #373）
      code: "const k = <a href={pr.html_url || '#'}>x</a>;",
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      // inline object spread による回避も検出（レビュー #373）
      code: 'const l = <a {...{ href: pr.html_url }}>x</a>;',
      errors: [{ messageId: 'validateUrl' }],
    },
    {
      code: 'const m = <img {...{ src: ghUser.avatar_url }} />;',
      errors: [{ messageId: 'validateUrl' }],
    },
  ],
});
