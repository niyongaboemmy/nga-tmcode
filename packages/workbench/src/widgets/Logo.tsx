import { useId } from "react";

/**
 * The TMCode mark: code brackets around a checkmark ("write code, get it
 * checked"), on the NGA blue gradient. `mono` draws it in currentColor for
 * watermarks.
 */
export function Logo({ size = 16, mono = false, className = "" }: { size?: number; mono?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={`tm-logo ${className}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="TMCode">
      {!mono && (
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#0a84ff" />
            <stop offset="1" stopColor="#00b4d8" />
          </linearGradient>
        </defs>
      )}
      <rect x="2" y="2" width="60" height="60" rx="15" fill={mono ? "currentColor" : `url(#g${id})`} opacity={mono ? 0.14 : 1} />
      <g fill="none" stroke={mono ? "currentColor" : "#ffffff"} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" opacity={mono ? 0.5 : 1}>
        <path d="M21 20 L11 32 L21 44" />
        <path d="M43 20 L53 32 L43 44" />
        <path d="M25.5 32.5 L30.5 37.5 L39 26.5" />
      </g>
    </svg>
  );
}
