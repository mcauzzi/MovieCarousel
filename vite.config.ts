import { defineConfig } from 'vite';

export default defineConfig({
  // Sviluppo locale in modalità DB (docs/scanner-dvd.md §10.2): /api va all'API
  // .NET in esecuzione (`dotnet run`, porta 5080), così il sito su :5173 resta
  // same-origin come in produzione (cookie di sessione, niente CORS). Vale anche
  // per `vite preview` (preview.proxy eredita server.proxy). Senza `apiBase` in
  // config.json il frontend non chiama mai /api: in modalità .tc il proxy è inerte.
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5080' },
    },
  },
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
