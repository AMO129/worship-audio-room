/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#121214',
        gold: '#D4AF37',
        plum: '#241a2d',
        rose: '#5d354c',
      },
      boxShadow: {
        glow: '0 0 30px rgba(212, 175, 55, 0.16)',
      },
    },
  },
  plugins: [],
};
