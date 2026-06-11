import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Font self-hostati in assets/fonts/, il resto (JS/CSS) resta in assets/.
        // Vite riscrive automaticamente gli url() nel CSS bundlato.
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? info.name ?? '';
          if (/\.(woff2?|ttf|otf|eot)$/i.test(name)) {
            return 'assets/fonts/[name]-[hash][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
