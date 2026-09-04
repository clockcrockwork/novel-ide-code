import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jestDom from 'eslint-plugin-jest-dom';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

// テストから個別ルールを参照できるよう export する（tests/security/*）。
// 既存の default export（config 配列）は変更しない。
export const localPlugin = {
  rules: {
    // e2e/: evaluate() コールバック内で classList を参照するパターンを禁止。
    // クラス名実装への依存を避け、isVisible() 等の auto-wait 付き API に誘導する。
    // 適用範囲: e2e/**（eslint.config.js 末尾の files 指定で限定）
    'no-evaluate-classlist': {
      meta: {
        type: 'suggestion',
        messages: {
          useIsVisible:
            'evaluate() コールバックで classList を参照しています。' +
            'isVisible() など Playwright の auto-wait 付き API に置き換えてください（クラス名実装への依存が減り堅牢になります）。',
        },
        schema: [],
      },
      create(context) {
        return {
          'CallExpression[callee.property.name="evaluate"] > :matches(ArrowFunctionExpression, FunctionExpression) MemberExpression[property.name="classList"]'(
            node,
          ) {
            context.report({ node, messageId: 'useIsVisible' });
          },
        };
      },
    },

    // e2e/: allTextContents() は auto-wait が働かないため禁止。
    // filter({ hasText }).toBeVisible() など auto-wait 付きアサーションへの置き換えを促す。
    // 適用範囲: e2e/**（eslint.config.js 末尾の files 指定で限定）
    'no-allTextContents': {
      meta: {
        type: 'suggestion',
        messages: {
          useFilter:
            'allTextContents() は Playwright の auto-wait が働きません。' +
            'filter({ hasText }).toBeVisible() など auto-wait 付きアサーションに置き換えてください。',
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee?.type === 'MemberExpression' &&
              node.callee?.property?.name === 'allTextContents' &&
              node.arguments.length === 0
            ) {
              context.report({ node, messageId: 'useFilter' });
            }
          },
        };
      },
    },

    // e2e/: locator.count() は Playwright の auto-wait が働かない。
    // expect().toHaveCount() または expect.poll(() => locator.count()) を使うこと。
    // 適用範囲: e2e/**（eslint.config.js 末尾の files 指定で限定）
    // 根拠: PR#154 で count() による不安定テストが複数件指摘。
    'no-locator-count': {
      meta: {
        type: 'suggestion',
        messages: {
          useToHaveCount:
            'count() は Playwright の auto-wait が働きません。' +
            'expect(locator).toHaveCount(n) または expect.poll(() => locator.count()) に置き換えてください。',
        },
        schema: [],
      },
      create(context) {
        function isInsidePollCallback(node) {
          let cur = node.parent;
          while (cur) {
            if (
              cur.type === 'CallExpression' &&
              cur.callee?.type === 'MemberExpression' &&
              cur.callee?.object?.name === 'expect' &&
              cur.callee?.property?.name === 'poll'
            )
              return true;
            cur = cur.parent;
          }
          return false;
        }
        return {
          CallExpression(node) {
            if (
              node.callee?.type === 'MemberExpression' &&
              node.callee?.property?.name === 'count' &&
              node.callee?.object?.name !== 'console' &&
              node.arguments.length === 0 &&
              !isInsidePollCallback(node)
            ) {
              context.report({ node, messageId: 'useToHaveCount' });
            }
          },
        };
      },
    },

    // .catch(cb) のコールバックが空ブロックの場合にエラーを握りつぶしていることを警告。
    // IDB fire-and-forget は .catch(console.warn) に統一済み（Issue#169）。
    'no-empty-catch-callback': {
      meta: {
        type: 'problem',
        messages: {
          emptyBody:
            '.catch() のコールバックが空です。エラーが握りつぶされます。' +
            '.catch(console.warn) を使うか、明示的なエラー処理を追加してください。',
        },
        schema: [],
      },
      create(context) {
        return {
          'CallExpression[callee.property.name="catch"] > :matches(ArrowFunctionExpression, FunctionExpression)'(
            node,
          ) {
            if (node.body.type === 'BlockStatement' && node.body.body.length === 0) {
              context.report({ node, messageId: 'emptyBody' });
            }
          },
        };
      },
    },

    // [...str].slice() は文字列全体を O(n) で配列化してからスライスする。
    // 大容量テキスト（本文・外部データ）で呼ばれると配列がメモリを圧迫する。
    // 反復は for...of、コードポイント単位スライスは codePointAt インデックスループを使うこと。
    // PR#180 で同一パターンへの指摘が 3 回重複したことを契機に追加。
    'no-spread-string-slice': {
      meta: {
        type: 'suggestion',
        messages: {
          spreadSlice:
            '`[...str].slice()` は文字列全体を O(n) で配列化します。' +
            'コードポイント単位スライスが必要なら `codePointAt` インデックスループを使ってください。' +
            '単純な事前截断（DoS ガード等）なら `String.prototype.slice()` で十分です。',
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type === 'MemberExpression' &&
              node.callee.property.name === 'slice' &&
              !node.callee.computed &&
              node.callee.object.type === 'ArrayExpression' &&
              node.callee.object.elements.length === 1 &&
              node.callee.object.elements[0]?.type === 'SpreadElement'
            ) {
              context.report({ node, messageId: 'spreadSlice' });
            }
          },
        };
      },
    },

    // JSX の <button> に type 属性がない場合に警告。
    // フォーム内でのデフォルト type="submit" による意図しない送信を防ぐ。
    // eslint-plugin-react の react/button-has-type に相当するが、
    // 同プラグインは ESLint 10 未対応のため local ルールで代替する。
    'jsx-button-type': {
      meta: {
        type: 'suggestion',
        messages: {
          missingType:
            '<button> に type 属性がありません。' +
            'フォーム内でのデフォルト submit 挙動を防ぐために ' +
            'type="button" / type="submit" / type="reset" を明示してください。',
        },
        schema: [],
      },
      create(context) {
        return {
          JSXOpeningElement(node) {
            if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'button') return;
            const hasType = node.attributes.some(
              (attr) => attr.type === 'JSXAttribute' && attr.name?.name === 'type',
            );
            if (!hasType) context.report({ node, messageId: 'missingType' });
          },
        };
      },
    },

    // IDB/ユーザー入力由来の動的キーを使うオブジェクトには Object.create(null) が必要。
    // `{}` は __proto__ キーでプロトタイプ汚染を受ける。
    // 対象: Object.fromEntries() の裸呼び出し + normalize/serialize/hydrate 関数内の空 {}。
    // 根拠: PR#207 で 5 コミットにわたり同パターンが修正された（#86, #106, #107, #111, #112）
    'no-plain-object-dict': {
      meta: {
        type: 'suggestion',
        messages: {
          fromEntries:
            '`Object.fromEntries()` は __proto__ キーでプロトタイプ汚染を受けます。' +
            '`Object.assign(Object.create(null), Object.fromEntries(...))` でラップしてください。',
          emptyInit:
            '`{}` は __proto__ キーでプロトタイプ汚染を受けます。' +
            'IDB/ユーザー入力由来のキーを動的に追加するオブジェクトには `Object.create(null)` を使ってください。',
        },
        schema: [],
      },
      create(context) {
        const NORMALIZE_RE = /^(normalize|serialize|hydrate|sanitize|buildId)/;
        function getEnclosingFuncName(node) {
          let cur = node.parent;
          while (cur) {
            if (cur.type === 'FunctionDeclaration' && cur.id?.name) return cur.id.name;
            if (
              (cur.type === 'FunctionExpression' || cur.type === 'ArrowFunctionExpression') &&
              cur.parent?.type === 'VariableDeclarator' &&
              cur.parent?.id?.name
            )
              return cur.parent.id.name;
            cur = cur.parent;
          }
          return '';
        }
        function isObjectCreateNull(n) {
          return (
            n?.type === 'CallExpression' &&
            n?.callee?.type === 'MemberExpression' &&
            n?.callee?.object?.name === 'Object' &&
            n?.callee?.property?.name === 'create' &&
            n?.arguments?.[0]?.type === 'Literal' &&
            n?.arguments?.[0]?.value === null
          );
        }
        return {
          // Object.fromEntries() が Object.assign(Object.create(null), ...) でラップされていない
          CallExpression(node) {
            if (
              node.callee?.type !== 'MemberExpression' ||
              node.callee?.object?.name !== 'Object' ||
              node.callee?.property?.name !== 'fromEntries'
            )
              return;
            const parent = node.parent;
            // Object.assign(Object.create(null), fromEntries(...)) のみ安全。
            // Object.assign({}, fromEntries(...)) は {} がプロトタイプ汚染を受けるため NG。
            if (
              parent?.type === 'CallExpression' &&
              parent?.callee?.type === 'MemberExpression' &&
              parent?.callee?.object?.name === 'Object' &&
              parent?.callee?.property?.name === 'assign' &&
              isObjectCreateNull(parent.arguments?.[0])
            )
              return;
            context.report({ node, messageId: 'fromEntries' });
          },
          // normalize/serialize/hydrate/sanitize 関数内の `const x = {}` 空オブジェクトリテラル
          VariableDeclarator(node) {
            if (node.init?.type !== 'ObjectExpression' || node.init.properties.length !== 0) return;
            if (!NORMALIZE_RE.test(getEnclosingFuncName(node))) return;
            context.report({ node: node.init, messageId: 'emptyInit' });
          },
          // `return {}` パターンも検出（VariableDeclarator より漏れやすい）
          ReturnStatement(node) {
            if (node.argument?.type !== 'ObjectExpression' || node.argument.properties.length !== 0)
              return;
            if (!NORMALIZE_RE.test(getEnclosingFuncName(node))) return;
            context.report({ node: node.argument, messageId: 'emptyInit' });
          },
        };
      },
    },

    // パスの禁止文字列チェックを startsWith() 単独で行うパターンを検出。
    // startsWith('.github') は subfolder/.github をバイパスする。
    // セグメント単位チェック（split('/').some(...)）を使うこと。
    // 根拠: PR#207 で 4 ラウンドにわたり同パターンが指摘された（#50, #72, #89, #108）
    'no-path-startswith-segment': {
      meta: {
        type: 'problem',
        messages: {
          useSegmentCheck:
            '`startsWith()` はパス先頭しか検査しません。' +
            '`subfolder/.github` 等のネストをバイパスできます。' +
            "`path.split('/').some(seg => FORBIDDEN.has(seg))` でセグメント単位チェックを行ってください。",
        },
        schema: [],
      },
      create(context) {
        return {
          'CallExpression[callee.property.name="startsWith"]'(node) {
            const arg = node.arguments[0];
            if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
            if (!arg.value.startsWith('.')) return; // ドットファイル/フォルダ以外は対象外
            // seg / segment 変数への呼び出しはスプリット済みセグメントへのチェックなので除外
            const receiver = node.callee.object;
            if (receiver?.type === 'Identifier' && /^seg(ment)?s?$/i.test(receiver.name)) return;
            context.report({ node, messageId: 'useSegmentCheck' });
          },
        };
      },
    },

    // JSX の href / src に GitHub API 由来（EXTERNAL）の URL を検証なしで渡すのを検出。
    // 対象は GitHub API 固有の URL プロパティ（html_url / avatar_url とその camelCase）に限定し
    // false positive を最小化する（`.url` 等の汎用名は対象外）。
    // 許可 validator（validateUrl / sanitizeUrlForExport、および validateUrl ベースの薄い
    // ラッパー safeExternalHref）の引数になっていれば skip。
    // React は `javascript:` を href でブロックしないため、EXTERNAL URL は検証してから描画する。
    // 根拠: EXTERNAL URL の href/src 描画検証。適用範囲: src/**（末尾 files 指定で限定）。
    'no-unvalidated-external-url-prop': {
      meta: {
        type: 'problem',
        messages: {
          validateUrl:
            'GitHub API 由来（EXTERNAL）の URL（{{prop}}）を検証なしで {{attr}} に渡しています。' +
            'validateUrl() ベースの検証（safeExternalHref() 等）を通してください。' +
            'React は javascript: スキームを href でブロックしません。',
        },
        schema: [],
      },
      create(context) {
        const TARGET_ATTRS = new Set(['href', 'src']);
        // GitHub API レスポンス固有の URL プロパティ名。汎用名（url 等）は FP 回避のため含めない。
        const SUSPECT_PROPS = new Set(['html_url', 'avatar_url', 'htmlUrl', 'avatarUrl']);
        const ALLOWED_WRAPPERS = new Set([
          'safeExternalHref',
          'sanitizeUrlForExport',
          'validateUrl',
        ]);

        // dot 記法（obj.prop）と固定文字列の bracket 記法（obj['prop']）の両方で
        // プロパティ名を取得する。computed で Literal 以外（動的キー）は null（対象外）。
        function getPropertyName(memberNode) {
          if (memberNode.computed) {
            return memberNode.property?.type === 'Literal'
              ? String(memberNode.property.value)
              : null;
          }
          return memberNode.property?.name;
        }

        function isAllowedWrapperCall(node) {
          if (node?.type !== 'CallExpression') return false;
          const callee = node.callee;
          if (callee?.type === 'Identifier' && ALLOWED_WRAPPERS.has(callee.name)) return true;
          if (callee?.type === 'MemberExpression') {
            const name = getPropertyName(callee);
            return name !== null && ALLOWED_WRAPPERS.has(name);
          }
          return false;
        }

        // ObjectExpression の Property キー名（`{ href: ... }` の href）を取得する。
        function getPropertyKeyName(propNode) {
          const key = propNode.key;
          if (propNode.computed) return key?.type === 'Literal' ? String(key.value) : null;
          if (key?.type === 'Identifier') return key.name;
          if (key?.type === 'Literal') return String(key.value);
          return null;
        }

        // suspect member 起点のボトムアップ判定（レビュー #373 対応）。
        // 個々の GitHub URL プロパティアクセスごとに「対象 JSX 属性（href/src、または inline
        // object spread の href/src）配下か」と「その経路上で許可 validator の引数になっているか」を
        // member ごとに独立判定する。これにより `href={safeExternalHref(a.html_url) || b.html_url}`
        // のような検証済み・未検証が混在する式でも未検証側（b.html_url）を確実に検出する。
        // String() / テンプレートリテラル等の非検証ラッパーは経路上の validator と見なさない。
        // 制限: `validateUrl(x.html_url) === null ? x.html_url : ...` の「検証後に生値を描画」する
        // パターンは consequent の生 `x.html_url` を検出する（誤検知ではなく仕様）。
        // データフロー解析はせず、`safeExternalHref(x.html_url)` の使用を推奨する。
        return {
          MemberExpression(node) {
            const prop = getPropertyName(node);
            if (prop === null || !SUSPECT_PROPS.has(prop)) return;
            // 別 suspect member の一部（例: a.html_url の a 側）を二重報告しないよう、
            // 親が「同じく SUSPECT を末尾に持つ MemberExpression の object」の場合はスキップ。
            if (node.parent?.type === 'MemberExpression' && node.parent.object === node) {
              const parentProp = getPropertyName(node.parent);
              if (parentProp !== null && SUSPECT_PROPS.has(parentProp)) return;
            }

            let current = node.parent;
            let child = node;
            let validated = false;
            let reportNode = null;
            let attrName = null;
            while (current) {
              // 許可 validator の「引数」として渡されている場合のみ検証済みとみなす
              // （callee 位置の一致は対象外）。
              if (isAllowedWrapperCall(current) && current.arguments.includes(child)) {
                validated = true;
              }
              // 三項の条件式（test）・論理積(&&)の左辺は「描画される値」ではなくガードなので
              // 検証済み扱いにする（FP 防止、レビュー #373）。`||` の左辺は truthy 時に描画されるため対象外。
              if (current.type === 'ConditionalExpression' && current.test === child) {
                validated = true;
              }
              if (
                current.type === 'LogicalExpression' &&
                current.operator === '&&' &&
                current.left === child
              ) {
                validated = true;
              }
              if (current.type === 'JSXAttribute') {
                if (TARGET_ATTRS.has(current.name?.name)) {
                  reportNode = current;
                  attrName = current.name.name;
                }
                break;
              }
              // inline object spread: `<a {...{ href: member }}>` は Property(key href/src) →
              // ObjectExpression → JSXSpreadAttribute。通常属性を spread に書き換えた回避を検出する
              // （レビュー #373）。動的な `{...props}` は静的解析不能のため対象外。
              if (
                current.type === 'Property' &&
                current.value === child &&
                current.parent?.type === 'ObjectExpression' &&
                current.parent.parent?.type === 'JSXSpreadAttribute'
              ) {
                const key = getPropertyKeyName(current);
                if (key !== null && TARGET_ATTRS.has(key)) {
                  reportNode = current;
                  attrName = key;
                }
                break;
              }
              // JSX 属性/spread の外（通常の文・変数宣言等）に出たら対象外。
              if (
                current.type === 'JSXExpressionContainer' &&
                current.parent?.type !== 'JSXAttribute'
              ) {
                break;
              }
              child = current;
              current = current.parent;
            }

            if (reportNode && !validated) {
              context.report({
                node: reportNode,
                messageId: 'validateUrl',
                data: { prop, attr: attrName },
              });
            }
          },
        };
      },
    },

    // JSX の onChange/onInput/onBlur ハンドラ内の Number(e.target.value) 裸呼び出しを検出。
    // Number('') = 0 のため、未入力が 0 として送信される。
    // `e.target.value === '' ? undefined : Number(e.target.value)` を使うこと。
    // 根拠: PR#207 で 3 ファイルにわたり同バグが独立発生（#1, #2, #36）
    'no-number-coerce-input-value': {
      meta: {
        type: 'problem',
        messages: {
          useEmptyGuard:
            '`Number(e.target.value)` は空欄を `0` に変換します。未入力は `undefined` になりません。' +
            "`e.target.value === '' ? undefined : Number(e.target.value)` を使ってください。",
        },
        schema: [],
      },
      create(context) {
        function hasTargetValue(argNode) {
          // e.target.value / event.target.value のような .value メンバアクセスを含む
          if (!argNode) return false;
          if (
            argNode.type === 'MemberExpression' &&
            argNode.property?.name === 'value' &&
            argNode.object?.type === 'MemberExpression' &&
            argNode.object?.property?.name === 'target'
          )
            return true;
          return false;
        }
        function isInsideJsxHandler(node) {
          const HANDLERS = new Set(['onChange', 'onInput', 'onBlur', 'onKeyDown', 'onKeyUp']);
          let cur = node.parent;
          while (cur) {
            if (
              cur.type === 'JSXExpressionContainer' &&
              cur.parent?.type === 'JSXAttribute' &&
              HANDLERS.has(cur.parent?.name?.name)
            )
              return true;
            cur = cur.parent;
          }
          return false;
        }
        return {
          'CallExpression[callee.name="Number"]'(node) {
            if (!hasTargetValue(node.arguments[0])) return;
            if (!isInsideJsxHandler(node)) return;
            context.report({ node, messageId: 'useEmptyGuard' });
          },
        };
      },
    },

    // normalize/hydrate/serialize/sanitize 関数内での Boolean(x) / !!x を検出。
    // Boolean("false") = true のため、IDB 文字列値が true に coerce される。
    // `typeof value === 'boolean' ? value : defaultBool` を使うこと。
    // 根拠: PR#207 で 2 ラウンドにわたり同パターンが指摘された（#59, #92）
    'no-boolean-coerce-in-normalize': {
      meta: {
        type: 'suggestion',
        messages: {
          useTypeofCheck:
            '`Boolean(x)` / `!!x` は文字列 "false" を `true` に変換します。' +
            "IDB 値の boolean 正規化は `typeof value === 'boolean' ? value : false` を使ってください。",
        },
        schema: [],
      },
      create(context) {
        const NORMALIZE_RE = /^(normalize|serialize|hydrate|sanitize)/;
        function getEnclosingFuncName(node) {
          let cur = node.parent;
          while (cur) {
            if (cur.type === 'FunctionDeclaration' && cur.id?.name) return cur.id.name;
            if (
              (cur.type === 'FunctionExpression' || cur.type === 'ArrowFunctionExpression') &&
              cur.parent?.type === 'VariableDeclarator' &&
              cur.parent?.id?.name
            )
              return cur.parent.id.name;
            cur = cur.parent;
          }
          return '';
        }
        function isInNormalizeFunc(node) {
          return NORMALIZE_RE.test(getEnclosingFuncName(node));
        }
        return {
          'CallExpression[callee.name="Boolean"]'(node) {
            if (!isInNormalizeFunc(node)) return;
            context.report({ node, messageId: 'useTypeofCheck' });
          },
          // !!x パターン（UnaryExpression[!] > UnaryExpression[!]）
          'UnaryExpression[operator="!"] > UnaryExpression[operator="!"]'(node) {
            if (!isInNormalizeFunc(node)) return;
            context.report({ node, messageId: 'useTypeofCheck' });
          },
        };
      },
    },

    // 配列フィルタや ID 検証での Number.isFinite() 使用を検出。
    // Number.isFinite(1.5) = true のため、整数 ID に小数が通過する。
    // 整数 ID の検証には Number.isInteger() を使うこと。
    // 根拠: PR#207 で 4 件の指摘（#29, #30, #104, #105）
    'no-number-is-finite-for-id': {
      meta: {
        type: 'suggestion',
        messages: {
          useIsInteger:
            '`Number.isFinite()` は小数を通します。' +
            '整数 ID・配列インデックスの検証には `Number.isInteger()` を使ってください。',
        },
        schema: [],
      },
      create(context) {
        return {
          'CallExpression[callee.object.name="Number"][callee.property.name="isFinite"]'(node) {
            // filter コールバック内、変数名・関数パラメータ名・関数名に id/Id/ID を含む文脈
            let cur = node.parent;
            while (cur) {
              if (cur.type === 'CallExpression' && cur.callee?.property?.name === 'filter') {
                context.report({ node, messageId: 'useIsInteger' });
                return;
              }
              if (cur.type === 'VariableDeclarator' && /[Ii][Dd]s?$/.test(cur.id?.name || '')) {
                context.report({ node, messageId: 'useIsInteger' });
                return;
              }
              if (
                cur.type === 'FunctionDeclaration' ||
                cur.type === 'FunctionExpression' ||
                cur.type === 'ArrowFunctionExpression'
              ) {
                const hasIdParam = cur.params?.some((p) => {
                  const check = (n) => {
                    if (!n) return false;
                    if (n.type === 'Identifier') return /[Ii][Dd]s?$/.test(n.name);
                    if (n.type === 'AssignmentPattern') return check(n.left);
                    if (n.type === 'RestElement') return check(n.argument);
                    return false;
                  };
                  return check(p);
                });
                let funcName = cur.id?.name || '';
                if (
                  !funcName &&
                  (cur.type === 'FunctionExpression' || cur.type === 'ArrowFunctionExpression')
                ) {
                  if (
                    cur.parent?.type === 'VariableDeclarator' &&
                    cur.parent.id?.type === 'Identifier'
                  ) {
                    funcName = cur.parent.id?.name ?? '';
                  }
                }
                const hasIdFuncName = funcName && /[Ii][Dd]s?$/.test(funcName);
                if (hasIdParam || hasIdFuncName) {
                  context.report({ node, messageId: 'useIsInteger' });
                }
                break;
              }
              cur = cur.parent;
            }
          },
        };
      },
    },

    // normalize/serialize/hydrate/sanitize 関数内で Object.entries(x) の前に
    // Array.isArray(x) ガードがないパターンを検出。
    // Array を渡すと数値インデックスがキーになり、意図しない結果になる。
    // normalize 系関数に限定することで静的定数・内部マップへの誤検知を排除する。
    // 根拠: PR#207 #85（metadata.custom が Array の場合のバグ）
    'no-object-entries-without-array-guard': {
      meta: {
        type: 'suggestion',
        messages: {
          addArrayGuard:
            '`Object.entries()` に Array を渡すと数値インデックスがキーになります。' +
            '`!Array.isArray(x)` ガードを先に行ってください。',
        },
        schema: [],
      },
      create(context) {
        const NORMALIZE_RE = /^(normalize|serialize|hydrate|sanitize|buildId)/;
        function getEnclosingFuncName(node) {
          let cur = node.parent;
          while (cur) {
            if (cur.type === 'FunctionDeclaration' && cur.id?.name) return cur.id.name;
            if (
              (cur.type === 'FunctionExpression' || cur.type === 'ArrowFunctionExpression') &&
              cur.parent?.type === 'VariableDeclarator' &&
              cur.parent?.id?.name
            )
              return cur.parent.id.name;
            cur = cur.parent;
          }
          return '';
        }
        function hasArrayIsArrayGuardInScope(varName, node) {
          let block = node.parent;
          while (block && block.type !== 'BlockStatement') {
            block = block.parent;
          }
          if (!block) return false;
          let found = false;
          function traverse(n) {
            if (!n || found) return;
            if (
              n.type === 'CallExpression' &&
              n.callee?.type === 'MemberExpression' &&
              n.callee?.object?.name === 'Array' &&
              n.callee?.property?.name === 'isArray' &&
              n.arguments?.[0]?.type === 'Identifier' &&
              n.arguments?.[0]?.name === varName &&
              n.range[0] < node.range[0]
            ) {
              found = true;
              return;
            }
            for (const key in n) {
              if (key === 'parent' || key === 'loc' || key === 'range') continue;
              const child = n[key];
              if (child && typeof child === 'object') {
                if (Array.isArray(child)) {
                  child.forEach(traverse);
                } else if (typeof child.type === 'string') {
                  traverse(child);
                }
              }
            }
          }
          traverse(block);
          return found;
        }
        return {
          'CallExpression[callee.object.name="Object"][callee.property.name="entries"]'(node) {
            const arg = node.arguments[0];
            if (!arg || arg.type !== 'Identifier') return;
            // 静的定数・内部マップへの誤検知を防ぐため normalize 系関数に限定
            if (!NORMALIZE_RE.test(getEnclosingFuncName(node))) return;
            if (!hasArrayIsArrayGuardInScope(arg.name, node)) {
              context.report({ node, messageId: 'addArrayGuard' });
            }
          },
        };
      },
    },

    // typeof x === 'string' で型ガード済みの変数に String(x) を呼ぶパターンを検出。
    // 型ガード後は String() ラップは不要で、直接 .slice() 等を呼べる。
    // 根拠: PR#207 #62, #63
    'no-redundant-string-cast-after-typeof': {
      meta: {
        type: 'suggestion',
        messages: {
          redundantCast:
            "`typeof x === 'string'` で型確認済みの変数に `String()` は不要です。" +
            '`x.slice(0, n)` など直接呼び出してください。',
        },
        schema: [],
      },
      create(context) {
        function getTypeofStringGuardedVars(node) {
          const guarded = new Set();
          let block = node.parent;
          while (block && block.type !== 'BlockStatement') block = block.parent;
          if (!block) return guarded;
          function visit(n) {
            if (!n || typeof n !== 'object') return;
            if (
              n.type === 'BinaryExpression' &&
              n.operator === '===' &&
              n.left?.type === 'UnaryExpression' &&
              n.left?.operator === 'typeof' &&
              n.left?.argument?.type === 'Identifier' &&
              n.right?.type === 'Literal' &&
              n.right?.value === 'string'
            ) {
              guarded.add(n.left.argument.name);
            }
            for (const key of Object.keys(n)) {
              if (key === 'parent') continue;
              const child = n[key];
              if (child && typeof child === 'object' && child.type) visit(child);
              if (Array.isArray(child)) child.forEach(visit);
            }
          }
          visit(block);
          return guarded;
        }
        return {
          'CallExpression[callee.name="String"]'(node) {
            const arg = node.arguments[0];
            if (arg?.type !== 'Identifier') return;
            const guarded = getTypeofStringGuardedVars(node);
            if (guarded.has(arg.name)) {
              context.report({ node, messageId: 'redundantCast' });
            }
          },
        };
      },
    },

    // `new Date(...).toISOString().slice(0, 10)` 等で UTC 基準の日付を抽出するパターンを検出。
    // JST など非 UTC 環境では深夜帯に日付が前日へずれる（コミットメッセージ・ファイル名で実害）。
    // 表示・命名用のローカル日付は getFullYear()/getMonth()+1/getDate() で組み立てること。
    // 日付文字列のラウンドトリップ検証など UTC が意図的な場合のみ eslint-disable で明示する。
    // 根拠: PR#168 / #207 / #210 / #226 で同一の UTC 日付ずれが 4 回繰り返し指摘された。
    'no-utc-date-slice': {
      meta: {
        type: 'suggestion',
        messages: {
          utcDate:
            '`.toISOString().slice(0, 10)` は UTC 基準の日付を抽出します。' +
            'JST 等のユーザーでは深夜帯に日付が前日へずれます。' +
            '表示・ファイル名・コミットメッセージ用のローカル日付は ' +
            '`getFullYear()/getMonth()+1/getDate()` で組み立ててください。' +
            '日付文字列のラウンドトリップ検証など UTC が意図的な場合は eslint-disable で明示してください。',
        },
        schema: [],
      },
      create(context) {
        const DATE_SLICERS = new Set(['slice', 'substring', 'substr']);
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee?.type !== 'MemberExpression' ||
              callee.computed ||
              !DATE_SLICERS.has(callee.property?.name)
            )
              return;
            // 引数 (0, 10) — YYYY-MM-DD（日付）部分の抽出に限定
            const [a, b] = node.arguments;
            if (a?.type !== 'Literal' || a.value !== 0 || b?.type !== 'Literal' || b.value !== 10)
              return;
            // レシーバが .toISOString() 呼び出しであること（完全な ISO 文字列の sync 用途は対象外）
            const recv = callee.object;
            if (
              recv?.type === 'CallExpression' &&
              recv.callee?.type === 'MemberExpression' &&
              recv.callee?.property?.name === 'toISOString'
            ) {
              context.report({ node, messageId: 'utcDate' });
            }
          },
        };
      },
    },

    'drag-leave-contains-check': {
      meta: {
        type: 'suggestion',
        messages: {
          missingCheck:
            'onDragLeave のインラインハンドラに currentTarget.contains(...) チェックがありません。子要素をまたぐと dragleave が誤発火します。',
        },
        schema: [],
      },
      create(context) {
        function hasCurrentTargetContains(node) {
          let found = false;
          const visited = new WeakSet();
          const visit = (n) => {
            if (!n || found || visited.has(n)) return;
            visited.add(n);
            if (
              n.type === 'CallExpression' &&
              n.callee?.type === 'MemberExpression' &&
              n.callee?.property?.name === 'contains' &&
              ((n.callee?.object?.type === 'MemberExpression' &&
                n.callee?.object?.property?.name === 'currentTarget') ||
                (n.callee?.object?.type === 'Identifier' &&
                  n.callee?.object?.name === 'currentTarget'))
            ) {
              found = true;
              return;
            }
            for (const key of context.sourceCode.visitorKeys[n.type] || []) {
              const child = n[key];
              if (child) {
                if (Array.isArray(child)) child.forEach(visit);
                else if (child.type) visit(child);
              }
            }
          };
          visit(node);
          return found;
        }
        return {
          // インライン関数（アロー or 関数式）のみ対象。named 参照は対象外
          'JSXAttribute[name.name="onDragLeave"] > JSXExpressionContainer > :matches(ArrowFunctionExpression, FunctionExpression)'(
            node,
          ) {
            if (!hasCurrentTargetContains(node)) {
              context.report({ node, messageId: 'missingCheck' });
            }
          },
        };
      },
    },
  },
};

export default defineConfig([
  // '.github/actions/**/dist' は ncc 生成物（Artifacts Gate の bundled action #428）。
  // 生成コードのため lint 対象外にする（source は src/ 側を lint する）。
  globalIgnores([
    'dist',
    '.github/actions/**/dist',
    'worker/.wrangler',
    '.claude',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { local: localPlugin },
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'local/drag-leave-contains-check': 'warn',
      // error に昇格（セキュリティ上許容できない）
      'local/no-empty-catch-callback': 'error',
      'local/no-spread-string-slice': 'warn',
      'local/jsx-button-type': 'warn',
      'linebreak-style': ['error', 'unix'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'no-irregular-whitespace': 'off',
      'no-console': ['warn', { allow: ['warn', 'error', 'debug'] }],
      // XSS 系は error に昇格（warn では見落とされる実績あり）
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'dangerouslySetInnerHTML を使う場合は escapeHtml() 等でサニタイズ済みであることを確認し、eslint-disable コメントで意図を明示してください。',
        },
        {
          selector:
            "AssignmentExpression[left.property.name='innerHTML'], AssignmentExpression[left.computed=true][left.property.value='innerHTML']",
          message:
            'innerHTML への直接代入は XSS リスクがあります。textContent を使うか、escapeHtml() でサニタイズしてください。',
        },
        {
          selector:
            "CallExpression[callee.property.name='insertAdjacentHTML'], CallExpression[callee.computed=true][callee.property.value='insertAdjacentHTML']",
          message:
            'insertAdjacentHTML は XSS リスクがあります。insertAdjacentText を使うか、escapeHtml() でサニタイズしてください。',
        },
      ],
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              regex: 'hooks/useLs',
              message:
                '旧来のラッパーです。Zustand store または IndexedDB (src/lib/db.js) を使用してください。',
            },
          ],
        },
      ],
    },
  },
  {
    // PR#207 で繰り返し指摘されたセキュリティパターンを lint 強制（issue #145 補強）。
    // src/** に限定（eslint.config.js・e2e・bench・scripts の誤検知を防ぐ）。
    files: ['src/**/*.{js,jsx}'],
    rules: {
      'local/no-plain-object-dict': 'warn',
      'local/no-path-startswith-segment': 'warn',
      'local/no-unvalidated-external-url-prop': 'warn',
      'local/no-number-coerce-input-value': 'warn',
      'local/no-boolean-coerce-in-normalize': 'warn',
      'local/no-number-is-finite-for-id': 'warn',
      'local/no-object-entries-without-array-guard': 'warn',
      'local/no-redundant-string-cast-after-typeof': 'warn',
      'local/no-utc-date-slice': 'warn',
      // PR#207 #23: async 関数内に await がない場合に warn
      'require-await': 'warn',
      // PR#207 #86: Object.hasOwnProperty → Object.hasOwn への誘導
      'prefer-object-has-own': 'warn',
    },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: [
      'src/hooks/useLs.js',
      'src/lib/lsCache.js',
      'src/stores/lsStorage.js',
      // ローカルデータ全削除（#279）は localStorage の直接走査・削除が目的
      'src/lib/clearLocalData.js',
      'src/lib/clearLocalData.test.js',
    ],
    rules: {
      'no-restricted-globals': [
        'warn',
        {
          name: 'localStorage',
          message:
            'localStorage を直接操作しないでください。Zustand ストア（src/stores/）または IndexedDB (src/lib/db.js) を使用してください。',
        },
        {
          name: 'confirm',
          message:
            'window.confirm はブロッキング UI で UX を損ないます。モーダルコンポーネントに置き換えてください。',
        },
        {
          name: 'prompt',
          message:
            'window.prompt はブロッキング UI で UX を損ないます。モーダルコンポーネントに置き換えてください。',
        },
        {
          name: 'alert',
          message:
            'window.alert はブロッキング UI で UX を損ないます。トースト通知またはモーダルに置き換えてください。',
        },
      ],
    },
  },
  {
    // アクセシビリティ静的解析（issue #135）。初回は全て warn で導入し、誤検知を確認してから error 昇格する。
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/interactive-supports-focus': 'warn',
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
    },
  },
  {
    // セキュリティ静的解析（issue #157 + #145 補強）。
    // 繰り返し指摘された eval/regexp は error 昇格。detect-object-injection を追加。
    files: ['src/**/*.{js,jsx}'],
    plugins: { security, sonarjs },
    rules: {
      // error 昇格: eval は実行コードインジェクションで許容できない
      'security/detect-eval-with-expression': 'error',
      // warn 維持: escapeRegExp() 済みの正当なユーザー入力 RegExp が誤検知を出すため
      // FindReplaceMod.jsx 等の意図的な使用箇所は既存コードで安全
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'warn',
      // obj[variable] アクセスの検出（プロトタイプ汚染の読み出しベクター）
      // PR#207 #86 相当。誤検知が多い可能性があるため初期は warn
      'security/detect-object-injection': 'warn',
      'sonarjs/no-duplicate-string': 'warn',
      'sonarjs/cognitive-complexity': ['warn', 20],
      'sonarjs/no-identical-conditions': 'warn',
      'sonarjs/no-identical-expressions': 'warn',
      'sonarjs/no-all-duplicated-branches': 'warn',
    },
  },
  {
    // ファイル・関数・コンポーネントの肥大化を可視化（issue #253 / docs/maintenance/code-cleanup.md 2.1・2.2）。
    // sonarjs/cognitive-complexity（warn=20）と整合。初期は warn・現状の肥大化のみを照らす閾値で導入し、
    // error 化・閾値引き下げ・違反箇所の分割は別 Issue（skill /code-cleanup）。
    files: ['src/**/*.{js,jsx}'],
    // テストコードはアサーション・モックで行数が伸びがちで、肥大化の対象ではないため除外（PR#265）。
    ignores: ['src/__tests__/**/*.{js,jsx}', 'src/**/*.test.{js,jsx}'],
    rules: {
      complexity: ['warn', 20],
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/__tests__/**/*.{js,jsx}'],
    plugins: { 'jest-dom': jestDom },
    rules: {
      'jest-dom/prefer-in-document': 'error',
    },
  },
  {
    files: [
      'scripts/**/*.js',
      'tests/**/*.js',
      'e2e/teardown/**/*.js',
      // Artifacts Gate local action の source（#428）。Node 環境で実行される（dist は globalIgnores）。
      '.github/actions/**/src/*.js',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Cloudflare Worker（worker/src/**/*.ts）を lint 対象化。
    // PR履歴分析で worker/src はどの config にも該当せず lint 空白地帯だったことが判明。
    // 同一ファイル群にセキュリティ指摘が集中再発していた（PR#314 禁止セグメント正規化 ×9 /
    // PR#319 catch{} が HTTPException を握りつぶし 200 を返す / PR#317・#321 型チェック欠落）。
    files: ['worker/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { local: localPlugin },
    rules: {
      // PR#319: `catch { }` が認証エラーを握りつぶす実害。Worker（信頼境界の外側）では
      // 空 catch を禁止し、意図的な場合は理由コメントを catch 内に書く（コメント付きは可）。
      'no-empty': ['error', { allowEmptyCatch: false }],
      'local/no-empty-catch-callback': 'error',
      // PR#207/#314: validation.ts の禁止パス判定はセグメント単位で行う（INVARIANTS.md #12）
      'local/no-path-startswith-segment': 'warn',
      // 動的キー辞書（JSON body 由来）は Object.create(null) で初期化（INVARIANTS.md #11）
      'local/no-plain-object-dict': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Playwright E2E テスト専用ルール。本番コードへの誤検知を防ぐため e2e/ に限定する。
    files: ['e2e/**/*.{js,ts}'],
    rules: {
      'local/no-evaluate-classlist': 'warn',
      'local/no-allTextContents': 'warn',
      'local/no-locator-count': 'warn',
    },
  },
  // 整形系ルールを Prettier に委譲し ESLint と責務を分離（issue #254）。
  // linebreak-style 等の整形ルールを off にする。必ず末尾に置く（後勝ち）。
  eslintConfigPrettier,
]);
