"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function ComposerModelPopover({
  isMobile,
  className,
  id,
  headingId,
  onClose,
  children,
}: {
  isMobile: boolean;
  className: string;
  id: string;
  headingId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const startedOnBackdropRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isMobile && dialog && !dialog.open) dialog.showModal();
  }, [isMobile]);

  if (!isMobile) {
    return (
      <div className={className} id={id} role="dialog" aria-labelledby={headingId}>
        {children}
      </div>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className={`${className} composer-model-sheet`}
      id={id}
      aria-labelledby={headingId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        startedOnBackdropRef.current = event.target === event.currentTarget && (
          event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom
        );
      }}
      onClick={(event) => {
        // Dragging a slider or list outside the sheet is not a backdrop tap.
        if (event.target !== event.currentTarget) return;
        if (startedOnBackdropRef.current) onClose();
      }}
    >
      {children}
      <div className="composer-model-sheet-footer">
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
