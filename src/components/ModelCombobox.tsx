import { useState, useRef, useEffect, useCallback } from "react";
import type { ModelInfo } from "../audio/customModelService";

interface Props {
  value: string;
  onChange: (v: string) => void;
  models: ModelInfo[];
  formatHint: (m: ModelInfo) => string | null;
  onFocus?: () => void;
  placeholder?: string;
}

export function ModelCombobox({ value, onChange, models, formatHint, onFocus, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Prevents blur from closing the dropdown when the user clicks an option
  const suppressBlur = useRef(false);

  const filtered = models.filter((m) =>
    m.id.toLowerCase().includes(value.toLowerCase()),
  );

  const select = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
      setActiveIdx(-1);
    },
    [onChange],
  );

  // Scroll the highlighted item into view when keyboard navigation changes it
  useEffect(() => {
    if (!open || activeIdx < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIdx(-1);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      select(filtered[activeIdx].id);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIdx(-1);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          setOpen(true);
          setActiveIdx(-1);
          onFocus?.();
        }}
        onBlur={() => {
          if (!suppressBlur.current) {
            setOpen(false);
            setActiveIdx(-1);
          }
          suppressBlur.current = false;
        }}
        onKeyDown={handleKeyDown}
      />
      {open && filtered.length > 0 && (
        <ul ref={listRef} className="absolute z-10 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-dark-400 border border-white/10 rounded-lg shadow-lg">
          {filtered.map((m, i) => {
            const hint = formatHint(m);
            return (
              <li
                key={m.id}
                className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer ${
                  i === activeIdx ? "bg-primary-500 text-white" : "text-white/80 hover:bg-white/10"
                }`}
                onMouseDown={() => { suppressBlur.current = true; }}
                onClick={() => select(m.id)}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span className="truncate">{m.id}</span>
                {hint && (
                  <span className={`ml-3 shrink-0 text-xs ${i === activeIdx ? "text-white/70" : "text-white/40"}`}>
                    {hint}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
