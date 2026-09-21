import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';

export const metadata: Metadata = {
  title: 'Incident Command Center',
  description: 'Operational readiness for Northstar Market',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
