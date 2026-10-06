import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    // Three lanes, one `npx vitest run`.
    //
    //   unit      every test the app has always had: no canvas, and the stand-in
    //             metric (`chars x size x 0.55`) wherever a test grants one.
    //   realfont  `*.realfont.test.js` only. Its setup file registers the fonts
    //             in src/test/fonts with @napi-rs/canvas and gives measure.js a
    //             `document` to make its canvas from, so text is measured with
    //             real advances, kerning and vertical metrics. See
    //             src/test/fonts/README.md.
    //   dom       `*.dom.test.js` only: tests that mount a component. They need
    //             a document (jsdom) and Svelte's browser build - vitest
    //             resolves with node conditions and hands back the server
    //             build, where `mount()` throws. The file-level
    //             `@vitest-environment` pragma cannot change resolve
    //             conditions, so the suffix is what selects the lane.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.js'],
          exclude: ['**/node_modules/**', 'src/**/*.realfont.test.js', 'src/**/*.dom.test.js'],
        },
      },
      {
        extends: true,
        resolve: { conditions: ['browser'] },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.js'],
        },
      },
      {
        extends: true,
        test: {
          name: 'realfont',
          include: ['src/**/*.realfont.test.js'],
          setupFiles: ['src/test/real-fonts.js'],
        },
      },
    ],
  },
})
