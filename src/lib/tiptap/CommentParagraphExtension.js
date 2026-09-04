import { Node } from '@tiptap/core';

// Block-level paragraph node for text inside multi-paragraph /* */ block comments.
// Consecutive commentParagraph nodes are serialized back to /* ... */ by textSerializer.js.
const CommentParagraphExtension = Node.create({
  name: 'commentParagraph',
  group: 'block',
  content: 'inline*',

  parseHTML() {
    return [{ tag: 'p[data-type="comment-paragraph"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['p', { 'data-type': 'comment-paragraph', class: 'hl-comment', ...HTMLAttributes }, 0];
  },
});

export default CommentParagraphExtension;
