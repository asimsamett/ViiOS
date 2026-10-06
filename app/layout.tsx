import type { Metadata } from 'next';
import { publicAsset } from '@/lib/public-mode';
import { AppearanceTheme } from './appearance';
import './globals.css';
import './desktop.css';
import './launcher.css';
import './resources.css';
import './taskbar-preview.css';
import './file-properties.css';
import './versioning.css';
import './repo-center.css';
import './git-tree-panel.css';
import './ops-panel.css';
import './project-apps.css';
import './ui-theme.css';
import './team.css';
import './project-team.css';
import './model-connections.css';
import './model-catalog.css';
import './model-benchmark.css';
import './desktop-dock.css';
import './app-credentials.css';
import './storage-panel.css';
import './onboarding.css';
import './vii-theme.css';
export const metadata: Metadata = {
  title: 'ViiOS · Visual Infrastructure Intelligence',
  description:
    'Sunucu uygulamalarını, portlarını ve ekran önizlemelerini tek bir yerden görüntüleyin.',
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: publicAsset('/brand/viios-icon-32.png'), sizes: '32x32', type: 'image/png' },
      { url: publicAsset('/brand/viios-icon-192.png'), sizes: '192x192', type: 'image/png' },
    ],
    shortcut: publicAsset('/favicon.ico'),
    apple: [{ url: publicAsset('/apple-touch-icon.png'), sizes: '180x180', type: 'image/png' }],
  },
  manifest: publicAsset('/site.webmanifest'),
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{const t=localStorage.getItem('management-theme');document.documentElement.classList.toggle('dark',t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches));const p=localStorage.getItem('viios-wallpaper-desktop');document.documentElement.dataset.viiosPalette=['aurora','ocean','forest','sunset'].includes(p)?p:'ocean'}catch{document.documentElement.dataset.viiosPalette='ocean'}",
          }}
        />
      </head>
      <body><AppearanceTheme/>{children}</body>
    </html>
  );
}
