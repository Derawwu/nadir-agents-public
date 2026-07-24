/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0f0f14',
          100: '#1a1a24',
          200: '#242433',
          300: '#2e2e42',
        },
        accent: {
          DEFAULT: '#7c6af7',
          hover: '#9b8df9',
          muted: '#4a3fa8',
        },
        border: '#2e2e42',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
