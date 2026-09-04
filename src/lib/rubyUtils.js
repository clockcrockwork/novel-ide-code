import { useUIStore } from '../stores/uiStore';

function getPopupRect(domNode) {
  return domNode instanceof Element
    ? domNode.getBoundingClientRect()
    : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0 };
}

function setRubyEditPopupWithRect(pos, base, reading, rect) {
  useUIStore.getState().setRubyEditPopup({
    pos,
    base,
    reading,
    x: rect.left + rect.width / 2,
    y: rect.top,
  });
}

export function openRubyEditPopup(editor, pos) {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== 'ruby') return;

  const { base, reading } = node.attrs;
  const domNode = editor.view.nodeDOM(pos);
  const rect = getPopupRect(domNode);
  setRubyEditPopupWithRect(pos, base, reading, rect);
}

export function setRubyEditPopupDirect(pos, base, reading, domElement) {
  const rect = getPopupRect(domElement);
  setRubyEditPopupWithRect(pos, base, reading, rect);
}
