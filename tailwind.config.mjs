/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./src/**/*.{html,js}"],
  theme: {
    extend: {
      colors: {
        primary: "#1f618c", // Azul del logo
        secondary: "#65a7db", // Azul claro
        tertiary: "#58ac52", // Verde logo
        accent: "#E98324", // Naranja del logo

        "logo-blue-light": "#6FA8DC", // Lighter blue for the 'S2' part
      },
      fontFamily: {
        display: ["Plus Jakarta Sans", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "12px",
        "2xl": "24px",
        "3xl": "32px",
      },
    },
  },
  plugins: [],
}
