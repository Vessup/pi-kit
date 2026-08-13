import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/utils";

export function TooltipProvider({ delayDuration = 250, children }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, sideOffset = 6, children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn("z-[90] max-w-72 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 shadow-xl shadow-black/50", className)}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-zinc-700" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
