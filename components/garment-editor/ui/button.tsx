import { forwardRef, type ButtonHTMLAttributes } from "react";
import Spinner from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger" | "outlineDanger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800",
  secondary: "border border-border bg-white text-ink-2 hover:bg-canvas hover:text-ink",
  soft: "bg-brand-50 text-brand-700 hover:bg-brand-100",
  ghost: "text-ink-2 hover:bg-black/5 hover:text-ink",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
  outlineDanger: "border border-red-300 bg-white text-red-600 hover:bg-red-50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-9 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-6 text-sm",
};

export function buttonClasses({ variant = "primary", size = "md" }: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return [
    "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-1",
    "disabled:cursor-not-allowed disabled:opacity-50",
    variantClasses[variant],
    sizeClasses[size],
  ].join(" ");
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingText?: string;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, loadingText, disabled, children, className = "", type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`${buttonClasses({ variant, size })} ${className}`}
      {...rest}
    >
      {loading && <Spinner size="sm" tone={variant === "primary" || variant === "danger" ? "light" : "brand"} />}
      {loading && loadingText ? loadingText : children}
    </button>
  );
});

export default Button;
