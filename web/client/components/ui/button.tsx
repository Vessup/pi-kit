import * as React from "react";
import { cn } from "../../lib/utils";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "destructive" | "outline";
  size?: "default" | "sm" | "lg" | "icon";
};

const variantClasses: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default: "bg-zinc-100 text-zinc-950 hover:bg-white shadow-sm",
  secondary: "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700",
  ghost: "bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white",
  destructive: "bg-red-500/90 text-white hover:bg-red-500",
  outline: "border border-zinc-700 bg-transparent text-zinc-100 hover:bg-zinc-800",
};

const sizeClasses: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-10 px-4 py-2",
  sm: "h-8 px-3 text-xs",
  lg: "h-11 px-5",
  icon: "h-9 w-9 p-0",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400/70 disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});
