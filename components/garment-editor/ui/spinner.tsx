interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  tone?: "brand" | "light" | "neutral";
  className?: string;
}

const sizeClasses = {
  sm: "h-3.5 w-3.5 border-2",
  md: "h-5 w-5 border-2",
  lg: "h-7 w-7 border-[2.5px]",
};

const toneClasses = {
  brand: "border-brand-200 border-t-brand-600",
  light: "border-white/40 border-t-white",
  neutral: "border-gray-200 border-t-gray-500",
};

/** 全站唯一的加载 spinner；列表加载请优先用 Skeleton。 */
export default function Spinner({ size = "md", tone = "brand", className = "" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="加载中"
      className={`inline-block animate-spin rounded-full ${sizeClasses[size]} ${toneClasses[tone]} ${className}`}
    />
  );
}
