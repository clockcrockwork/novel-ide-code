import { Node, InputRule } from '@tiptap/core';
import { setRubyEditPopupDirect } from '../rubyUtils';

const RubyNode = Node.create({
  name: 'ruby',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      base: { default: '' },
      reading: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'ruby[data-base]',
        getAttrs: (el) => ({
          base: el.getAttribute('data-base') || '',
          reading: el.querySelector('rt')?.textContent || '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      'ruby',
      { 'data-base': node.attrs.base },
      node.attrs.base,
      ['rt', {}, node.attrs.reading],
    ];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\{([^|}\n]+)\|([^}\n]*)\}$/,
        handler: ({ state, range, match }) => {
          const [, base, reading] = match;
          const node = this.type.create({ base, reading });
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let currentNode = node;
      const dom = document.createElement('ruby');
      dom.setAttribute('data-base', currentNode.attrs.base);
      dom.style.cursor = 'pointer';

      const baseText = document.createTextNode(currentNode.attrs.base);
      const rt = document.createElement('rt');
      rt.textContent = currentNode.attrs.reading;

      dom.appendChild(baseText);
      dom.appendChild(rt);

      dom.addEventListener('click', (e) => {
        if (!editor.isEditable) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = getPos();
        if (pos === undefined) return;
        setRubyEditPopupDirect(pos, currentNode.attrs.base, currentNode.attrs.reading, dom);
      });

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'ruby') return false;
          currentNode = updatedNode;
          baseText.textContent = currentNode.attrs.base;
          rt.textContent = currentNode.attrs.reading;
          dom.setAttribute('data-base', currentNode.attrs.base);
          return true;
        },
      };
    };
  },
});

export default RubyNode;
