import { Node, InputRule } from '@tiptap/core';

const SlashCommentExtension = Node.create({
  name: 'slashComment',
  group: 'block',
  content: 'inline*',

  parseHTML() {
    return [{ tag: 'div[data-type="slash-comment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-type': 'slash-comment', class: 'hl-comment', ...HTMLAttributes }, 0];
  },

  addInputRules() {
    // Convert "// " typed at start of an empty paragraph into a slashComment node
    return [
      new InputRule({
        find: /^\/\/ $/,
        handler: ({ state, range }) => {
          const { tr } = state;
          const node = this.type.create(null, []);
          tr.replaceWith(range.from - 1, range.to, node);
        },
      }),
    ];
  },
});

export default SlashCommentExtension;
