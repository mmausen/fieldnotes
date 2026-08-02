import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built output is served by FastAPI (see README), so keep asset paths relative.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173 },
})
