import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    // Short-lived so a "saved" message does not sit over the bottom of a table; errors stay longer.
    <ToastProvider duration={3500} label="Notification">
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} duration={props.variant === "destructive" ? 7000 : undefined} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
