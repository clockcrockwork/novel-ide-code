import { memo, useMemo, useState } from 'react';
import { VList } from 'virtua';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function reconcileIds(prevItems, paras, counter) {
  const idsByText = new Map();
  for (const { id, text } of prevItems) {
    const ids = idsByText.get(text);
    if (ids) ids.push(id);
    else idsByText.set(text, [id]);
  }

  const cursorByText = new Map();
  let c = counter;
  const items = paras.map((text) => {
    const ids = idsByText.get(text);
    const cursor = cursorByText.get(text) ?? 0;
    cursorByText.set(text, cursor + 1);
    if (ids && cursor < ids.length) {
      return { id: ids[cursor], text };
    }
    return { id: `p${c++}`, text };
  });
  return { items, counter: c };
}

const SortableParaBlock = memo(function SortableParaBlock({ id, p }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="para-block">
      <span className="drag-handle" {...attributes} {...listeners}>
        ⠿
      </span>
      <div className="para-text">
        {p.slice(0, 140)}
        {p.length > 140 ? '…' : ''}
      </div>
    </div>
  );
});

function ParaBlockOverlay({ p }) {
  return (
    <div className="para-block dragging">
      <span className="drag-handle">⠿</span>
      <div className="para-text">
        {p.slice(0, 140)}
        {p.length > 140 ? '…' : ''}
      </div>
    </div>
  );
}

const StructureMode = memo(function StructureMode({ paras, onReorder }) {
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const [idState, setIdState] = useState(() => {
    const { items, counter } = reconcileIds([], paras, 0);
    return { items, counter, src: paras };
  });
  let parasWithIds = idState.items;
  if (idState.src !== paras) {
    const { items, counter } = reconcileIds(idState.items, paras, idState.counter);
    setIdState({ items, counter, src: paras });
    parasWithIds = items;
  }
  const itemIds = useMemo(() => parasWithIds.map((p) => p.id), [parasWithIds]);
  const activeParaIndex = (() => {
    if (activeId == null) return null;
    const i = parasWithIds.findIndex((p) => p.id === activeId);
    return i >= 0 ? i : null;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '.07em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: 'var(--tx3)',
          marginBottom: 14,
        }}
      >
        構成モード — ドラッグで段落を並び替え
      </div>
      {paras.length === 0 && (
        <div style={{ color: 'var(--tx3)', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
          段落がありません
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveId(active.id)}
        onDragEnd={({ active, over }) => {
          setActiveId(null);
          if (over && active.id !== over.id) {
            const fromIdx = parasWithIds.findIndex((p) => p.id === active.id);
            const toIdx = parasWithIds.findIndex((p) => p.id === over.id);
            if (fromIdx !== -1 && toIdx !== -1) {
              onReorder(fromIdx, toIdx);
            }
          }
        }}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <VList style={{ height: '100%' }}>
              {parasWithIds.map(({ id, text }) => (
                <SortableParaBlock key={id} id={id} p={text} />
              ))}
            </VList>
          </div>
        </SortableContext>
        <DragOverlay>
          {activeParaIndex != null && <ParaBlockOverlay p={parasWithIds[activeParaIndex].text} />}
        </DragOverlay>
      </DndContext>
    </div>
  );
});

export default StructureMode;
