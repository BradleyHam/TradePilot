"use client"

import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          // px-4/pb-4 are the sheet's default gutters. Sheet bodies are
          // authored as bare divs, so without a gutter here every form
          // field runs edge-to-edge — worst on the md+ right-drawer where
          // the sheet meets the window edge. Declared BEFORE `className`
          // so consumers still win: `px-4 pb-10` widens the bottom gutter,
          // and `p-0` (full-bleed sheets like job/bill detail, which own
          // their internal padding) strips it entirely — twMerge resolves
          // the p-vs-px/pb conflict in the consumer's favour.
          "fixed z-50 flex flex-col gap-4 px-4 pb-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          // Desktop (md+): bottom sheets become a right-side drawer. The app's
          // forms are all authored as `side="bottom"` phone sheets; full-width
          // form fields on a wide monitor are unusable, and a drawer keeps the
          // calendar/list visible behind the form. These overrides are scoped
          // to md+ so phones keep the bottom-sheet behaviour untouched.
          // Width is a CSS var so content-heavy sheets (job detail, bill
          // detail) can widen themselves via `[--desktop-sheet-w:44rem]`.
          // The md+data-attr selectors out-specify per-usage classes like
          // `h-[85vh]` / `rounded-t-2xl`, so consumers don't need edits.
          "md:data-[side=bottom]:top-0 md:data-[side=bottom]:left-auto md:data-[side=bottom]:h-full md:data-[side=bottom]:max-h-none md:data-[side=bottom]:w-[var(--desktop-sheet-w,30rem)] md:data-[side=bottom]:max-w-[calc(100vw-3rem)] md:data-[side=bottom]:border-l md:data-[side=bottom]:border-t-0 md:data-[side=bottom]:rounded-l-2xl md:data-[side=bottom]:rounded-r-none md:data-[side=bottom]:shadow-xl md:data-[side=bottom]:data-starting-style:translate-y-0 md:data-[side=bottom]:data-ending-style:translate-y-0 md:data-[side=bottom]:data-starting-style:translate-x-[2.5rem] md:data-[side=bottom]:data-ending-style:translate-x-[2.5rem]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      // No horizontal padding: SheetContent now owns the side gutter, so
      // the title lines up with the body instead of sitting 16px further in.
      className={cn("flex flex-col gap-0.5 py-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 py-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
