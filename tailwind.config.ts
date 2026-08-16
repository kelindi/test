import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './packages/**/*.{ts,tsx}'],
  theme: { extend: {} },
} satisfies Config;
