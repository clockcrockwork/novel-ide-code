import { Mark, InputRule } from '@tiptap/core';

const InlineCommentMark = Mark.create({
  name: 'inlineComment',

  parseHTML() {
    return [{ tag: 'span[data-type="inline-comment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-type': 'inline-comment', class: 'hl-comment', ...HTMLAttributes }, 0];
  },

  addInputRules() {
    // Apply mark when user types /*text*/
    return [
      new InputRule({
        find: /\/\*([^*\n]*?)\*\/$/,
        handler: ({ state, range, match }) => {
          const [, innerText] = match;
          if (!innerText) return null;
          const { tr, schema } = state;
          const mark = schema.marks.inlineComment.create();
          const node = schema.text(innerText, [mark]);
          tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },
});

export default InlineCommentMark;
