/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        brand: { 50: '#eef4ff', 100: '#dbe6fe', 500: '#3b6cf6', 600: '#2c55e0', 700: '#2443b5' },
      },
    },
  },
  plugins: [],
};
