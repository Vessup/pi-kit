import { X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";
import { Button } from "./button";

type DialogContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
  restoreFocusRef: React.MutableRefObject<HTMLElement | null>;
} | null;
const DialogContext = React.createContext<DialogContextValue>(null);

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
  return elements.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio")
      return true;
    const radioGroup = elements.filter(
      (candidate): candidate is HTMLInputElement =>
        candidate instanceof HTMLInputElement &&
        candidate.type === "radio" &&
        candidate.name === element.name &&
        candidate.form === element.form,
    );
    const checked = radioGroup.find((radio) => radio.checked);
    return element === (checked ?? radioGroup[0]);
  });
}

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const id = React.useId();
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  React.useInsertionEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
  }, [open]);
  const context = React.useMemo(
    () => ({
      open,
      setOpen: onOpenChange,
      titleId: `${id}-title`,
      descriptionId: `${id}-description`,
      restoreFocusRef,
    }),
    [id, onOpenChange, open],
  );
  return (
    <DialogContext.Provider value={context}>{children}</DialogContext.Provider>
  );
}

export function DialogTrigger({
  children,
  asChild,
}: {
  children: React.ReactNode;
  asChild?: boolean;
}) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return <>{children}</>;
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      onClick: () => ctx.setOpen(true),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          ctx.setOpen(true);
        }
      },
    } as Record<string, unknown>);
  }
  return (
    <button
      type="button"
      className="appearance-none bg-transparent p-0 text-inherit"
      onClick={() => ctx.setOpen(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          ctx.setOpen(true);
        }
      }}
    >
      {children}
    </button>
  );
}

export function DialogContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(DialogContext);
  const [mounted, setMounted] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = ctx?.restoreFocusRef;
  React.useEffect(() => setMounted(true), []);
  React.useEffect(() => {
    if (!mounted || !ctx?.open || !restoreFocusRef) return;
    const content = contentRef.current;
    if (!content) return;
    if (!restoreFocusRef.current) {
      const active = document.activeElement;
      restoreFocusRef.current =
        active instanceof HTMLElement && !content.contains(active)
          ? active
          : null;
    }
    return () => {
      const restoreFocus = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (!restoreFocus?.isConnected) return;
      requestAnimationFrame(() => {
        if (restoreFocus.isConnected)
          restoreFocus.focus({ preventScroll: true });
      });
    };
  }, [ctx?.open, mounted, restoreFocusRef]);
  React.useEffect(() => {
    const setOpen = ctx?.setOpen;
    if (!mounted || !ctx?.open || !setOpen) return;
    const content = contentRef.current;
    if (!content) return;
    const focusInitialElement = () => {
      if (content.contains(document.activeElement)) return;
      const focusable = focusableElements(content);
      (focusable[0] ?? content).focus();
    };
    focusInitialElement();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(content);
      if (focusable.length === 0) {
        event.preventDefault();
        content.focus();
        return;
      }
      const active = document.activeElement;
      const activeIndex =
        active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (activeIndex < 0) {
        event.preventDefault();
        (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      } else if (
        (!event.shiftKey && activeIndex === focusable.length - 1) ||
        (event.shiftKey && activeIndex === 0)
      ) {
        event.preventDefault();
        (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctx?.open, ctx?.setOpen, mounted]);
  if (!mounted || !ctx?.open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
        onClick={() => ctx.setOpen(false)}
      />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ctx.titleId}
        aria-describedby={ctx.descriptionId}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogHeader({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("border-b border-zinc-800 px-5 py-4", className)}>
      {children}
    </div>
  );
}

export function DialogTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(DialogContext);
  return (
    <h2
      id={ctx?.titleId}
      className={cn("text-base font-semibold text-zinc-100", className)}
    >
      {children}
    </h2>
  );
}

export function DialogDescription({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(DialogContext);
  return (
    <p
      id={ctx?.descriptionId}
      className={cn("mt-1 text-sm text-zinc-400", className)}
    >
      {children}
    </p>
  );
}

export function DialogBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DialogClose({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const ctx = React.useContext(DialogContext);
  return (
    <Button
      variant="ghost"
      className={cn("text-zinc-400", className)}
      onClick={() => ctx?.setOpen(false)}
    >
      {children ?? <X className="h-4 w-4" />}
    </Button>
  );
}

export { Button as DialogAction };
