import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      {...props}
    >
      {children}
    </button>
  );
}
