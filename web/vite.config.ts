import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

const target = process.env.LIM_SERVER_URL ?? 'http://127.0.0.1:7400'
const proxy = { '/rpc': target, '/v1/': target }

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  server: { proxy },
  preview: { proxy },
})
