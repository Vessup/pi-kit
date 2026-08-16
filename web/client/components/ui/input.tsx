import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        // 16px on mobile: iOS Safari auto-zooms any focused input below 16px.
        "flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-base text-zinc-100 outline-none ring-offset-zinc-950 placeholder:text-zinc-500 focus:border-white/70 focus:ring-2 focus:ring-white/20 disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
});
