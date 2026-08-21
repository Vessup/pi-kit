import * as React from "react";
import { AnchoredPopover } from "./anchored-popover";
import { Input } from "./ui/input";

export type AutocompleteSuggestion = { value: string; label?: string };

function filterSuggestions(
  suggestions: readonly AutocompleteSuggestion[],
  query: string,
): AutocompleteSuggestion[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...suggestions];
  return suggestions.filter(
    (suggestion) =>
      suggestion.value.toLowerCase().includes(trimmed) ||
      (suggestion.value.split(/[\\/]/).pop() ?? "")
        .toLowerCase()
        .includes(trimmed),
  );
}

/** Text input with an anchored autocomplete list driven by caller-provided suggestions. */
export function AutocompleteInput({
  id,
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  hint,
  acceptSuffix,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly AutocompleteSuggestion[];
  placeholder?: string;
  hint?: string;
  /** Appended to accepted values, e.g. "/" for directories so the menu keeps drilling down. */
  acceptSuffix?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const filtered = React.useMemo(
    () => filterSuggestions(suggestions, value),
    [suggestions, value],
  );
  React.useEffect(() => {
    setActiveIndex((index) => Math.min(index, filtered.length - 1));
  }, [filtered.length]);
  const popoverOpen = open && filtered.length > 0;
  const accept = (suggestion: AutocompleteSuggestion) => {
    const completed = suggestion.value.endsWith(acceptSuffix ?? "")
      ? suggestion.value
      : suggestion.value + (acceptSuffix ?? "");
    onChange(completed);
    // With a completion suffix the next segment's suggestions load next; keep
    // the menu up so repeated Tab presses drill down the path.
    if (!acceptSuffix) setOpen(false);
    inputRef.current?.focus();
  };
  return (
    <div className="space-y-2">
      <label
        className="text-xs uppercase tracking-wider text-zinc-500"
        htmlFor={id}
      >
        {label}
      </label>
      <Input
        id={id}
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (!popoverOpen) return;
          // Let the form-level handler submit Cmd/Ctrl+Enter. In particular,
          // do not accept the highlighted suggestion for that shortcut.
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey
          )
            return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" || event.key === "Tab") {
            // Tab accepts the highlighted option instead of moving focus; the
            // menu closes, so a second Tab advances to the next field as usual.
            const suggestion = filtered[activeIndex];
            if (suggestion) {
              event.preventDefault();
              accept(suggestion);
            }
          } else if (event.key === "Escape") {
            // Consume Escape while the menu is up so it dismisses the menu
            // instead of bubbling to the dialog and closing the whole modal.
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <AnchoredPopover
        open={popoverOpen}
        onOpenChange={setOpen}
        anchorRef={inputRef}
        placement="below"
        matchAnchorWidth
        className="max-h-64 overflow-y-auto text-sm"
      >
        <ul id={`${id}-listbox`}>
          {filtered.map((suggestion, index) => (
            <li key={suggestion.value}>
              <button
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left ${
                  index === activeIndex
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-300"
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => accept(suggestion)}
              >
                <span className="truncate">{suggestion.value}</span>
                {suggestion.label ? (
                  <span className="shrink-0 text-xs text-zinc-500">
                    {suggestion.label}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </AnchoredPopover>
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}
