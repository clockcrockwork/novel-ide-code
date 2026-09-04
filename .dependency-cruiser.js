export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment: '循環依存を検出（report のみ）',
      from: {},
      to: { circular: true },
    },
    {
      name: 'lib-no-react-layer',
      severity: 'warn',
      comment: 'src/lib は React 非依存（docs/maintenance/code-cleanup.md 2.3）',
      from: { path: '^src/lib/' },
      to: { path: '^src/(components|hooks|stores|context)/|^node_modules/react(-dom)?/' },
    },
    {
      name: 'hooks-no-components',
      severity: 'warn',
      comment: 'src/hooks は描画層 components に依存しない',
      from: { path: '^src/hooks/' },
      to: { path: '^src/components/' },
    },
    {
      name: 'stores-no-ui',
      severity: 'warn',
      comment: 'src/stores は components/hooks に依存しない',
      from: { path: '^src/stores/' },
      to: { path: '^src/(components|hooks)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/|^node_modules/react(-dom)?/',
    exclude: { path: '\\.test\\.(js|jsx)$|^src/__tests__/' },
    tsPreCompilationDeps: false,
  },
};
