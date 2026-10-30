import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;
function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) { return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", className)} {...props}>{children}<SelectPrimitive.Icon><ChevronDownIcon className="size-4 opacity-50" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>; }
function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) { return <SelectPrimitive.Portal><SelectPrimitive.Positioner sideOffset={4} className="z-50"><SelectPrimitive.Popup data-slot="select-content" className={cn("min-w-(--anchor-width) overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none", className)} {...props}><SelectPrimitive.List>{children}</SelectPrimitive.List></SelectPrimitive.Popup></SelectPrimitive.Positioner></SelectPrimitive.Portal>; }
function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) { return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50", className)} {...props}><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator className="absolute right-2"><CheckIcon className="size-4" /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>; }
export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
