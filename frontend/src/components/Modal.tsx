/** Generic modal: dark panel over a fixed overlay; Esc / overlay click close. */
import { useEffect, type ReactNode } from "react";

export function Modal(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className={`flex max-h-[85vh] w-full flex-col rounded-xl border border-neutral-800 bg-[#11141b] shadow-2xl ${
          props.wide ? "max-w-3xl" : "max-w-lg"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">{props.title}</h2>
          <button
            className="rounded px-2 text-neutral-500 transition-colors hover:text-neutral-200"
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-neutral-300">
          {props.children}
        </div>
        {props.footer && (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-3">
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}
