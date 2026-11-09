import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const control =
  "rounded-md border border-border-strong bg-surface-2 px-2.5 text-[13px] text-text placeholder:text-faint transition-colors hover:border-surface-4 focus:border-accent focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-60";

/** Full width unless the caller sets its own width. */
const width = (className?: string) => (className && /(^|\s)w-/.test(className) ? "" : "w-full");

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, width(className), "h-8", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, width(className), "min-h-20 py-2 leading-relaxed", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(control, width(className), "h-8 appearance-none pr-7", className)} style={{ backgroundImage: "linear-gradient(45deg,transparent 50%,var(--text-faint) 50%),linear-gradient(135deg,var(--text-faint) 50%,transparent 50%)", backgroundPosition: "calc(100% - 13px) 55%, calc(100% - 9px) 55%", backgroundSize: "4px 4px", backgroundRepeat: "no-repeat" }} {...rest} />;
});

export function Field({ label, htmlFor, error, hint, children, className }: { label: string; htmlFor: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
      {message}
    </div>
  );
}
