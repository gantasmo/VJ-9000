import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Bind to all interfaces (0.0.0.0) so a phone/tablet on the same
      // LAN can reach the VJ output via the host machine's LAN IP. The
      // SA3 backend (/api/vj/url) advertises that LAN URL for QR/mobile.
      host: true,
      // Don't reject requests whose Host header is a LAN IP or hostname.
      // Vite blocks unknown hosts by default for DNS-rebind protection;
      // `true` disables that check so mobile devices aren't blocked.
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },

  };
});
